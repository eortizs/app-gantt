// Entity store: the write path every umeJSON endpoint shares. The server
// is the ONLY writer of the promoted columns (single writer = no drift):
// they are extracted from the decoded document in the same transaction
// that persists it, so `document` stays the source of truth while
// `status` / `revision` / `plan_entity_id` remain queryable without
// cracking the JSON open.
import type { Pool } from "pg"
import { SENTINEL, isObject } from "../../src/lib/umejson/schema.ts"

export interface EntityRow {
  id: string
  entity_name: string
  document: unknown
  plan_entity_id: string | null
  status: string
  revision: number
  created_at: Date
  updated_at: Date
}

/**
 * Stamps RESERVED_FOR_SYSTEM slots with the real instant, in place on a
 * clone: `lifecycle.updatedAt` and every `statusLog[].timestamp` that
 * still carries the sentinel. Idempotent — already-clean timestamps pass
 * through untouched, so a client re-sending a finalized document changes
 * nothing.
 */
export function stampSentinels<T>(doc: T, now: string): T {
  const cloned: unknown = structuredClone(doc)
  if (!isObject(cloned)) return cloned as T
  const lc = cloned.lifecycle
  if (isObject(lc) && lc.updatedAt === SENTINEL) {
    cloned.lifecycle = { ...lc, updatedAt: now }
  }
  const st = cloned.state
  if (isObject(st) && Array.isArray(st.statusLog)) {
    cloned.state = {
      ...st,
      statusLog: st.statusLog.map((entry) =>
        isObject(entry) && entry.timestamp === SENTINEL
          ? { ...entry, timestamp: now }
          : entry,
      ),
    }
  }
  return cloned as T
}

/**
 * CR-specific finalization on top of `stampSentinels`: the PAYLOAD also
 * carries sentinels the generic pass doesn't know about —
 * `changeRequest.statusLog[].timestamp` (legal SENTINEL pre-persist, see
 * the contract header) and the `requestedBy`/`decidedBy` actor slots.
 * Idempotent for the timestamps; actor slots stamp once and then hold
 * (already-real actors pass through untouched).
 */
export function stampChangeRequestSentinels<T>(
  doc: T,
  now: string,
  actor: string,
): T {
  const base: unknown = stampSentinels(doc, now)
  if (!isObject(base)) return base as T
  const dp = base.dynamicProperties
  if (!isObject(dp) || !isObject(dp.changeRequest)) return base as T
  const cr = dp.changeRequest
  const next: Record<string, unknown> = { ...cr }
  if (Array.isArray(cr.statusLog)) {
    next.statusLog = cr.statusLog.map((entry) =>
      isObject(entry) && entry.timestamp === SENTINEL
        ? { ...entry, timestamp: now }
        : entry,
    )
  }
  if (cr.requestedBy === SENTINEL) next.requestedBy = actor
  if (cr.decidedBy === SENTINEL) next.decidedBy = actor
  base.dynamicProperties = { ...dp, changeRequest: next }
  return base as T
}

export type PutOutcome = "ok" | "conflict"

export interface PutEntityArgs {
  entityName: string
  /** Decoded, sentinel-stamped entity. `id` and `lifecycle.version` are authoritative. */
  entity: { id: string; lifecycle: { version: number }; state: { current: string } }
  document: unknown
  planEntityId: string | null
  /**
   * Promoted `status` override. Plans and siblings keep the default
   * (`state.current`); CRs promote their PAYLOAD status
   * ("proposed"/"approved"/...) so the queue index actually filters.
   */
  status?: string
  /** Seed mode: never overwrite an existing row (ON CONFLICT DO NOTHING). */
  ifNotExists?: boolean
  /**
   * Seed mode for regenerable demo siblings: ALWAYS overwrite (decided
   * policy — demo data is regenerable, clobbering PUT edits is accepted).
   * The PLAN keeps `ifNotExists`. `expectedRevision` is ignored here.
   */
  seedOverwrite?: boolean
}

/**
 * Upsert with optimistic locking: the UPDATE only fires when the stored
 * revision matches `expectedRevision` (0 = the row must not exist yet).
 * Zero affected rows means somebody else wrote first → "conflict".
 */
export async function putEntity(
  pool: Pool,
  args: PutEntityArgs & { expectedRevision: number },
): Promise<PutOutcome> {
  const { entityName, entity, document, planEntityId, expectedRevision, ifNotExists, seedOverwrite } = args
  const status = args.status ?? entity.state.current
  if (!ifNotExists && !seedOverwrite) {
    const existing = await pool.query<{ revision: number }>(
      "SELECT revision FROM ume_entities WHERE id = $1",
      [entity.id],
    )
    if (existing.rowCount === 0 && expectedRevision !== 0) return "conflict"
    if (existing.rowCount === 1 && existing.rows[0]!.revision !== expectedRevision) {
      return "conflict"
    }
  }
  const onConflict = ifNotExists
    ? "DO NOTHING"
    : seedOverwrite
      ? `DO UPDATE
        SET document = EXCLUDED.document,
            entity_name = EXCLUDED.entity_name,
            plan_entity_id = EXCLUDED.plan_entity_id,
            status = EXCLUDED.status,
            revision = EXCLUDED.revision,
            updated_at = now()`
      : `DO UPDATE
        SET document = EXCLUDED.document,
            entity_name = EXCLUDED.entity_name,
            plan_entity_id = EXCLUDED.plan_entity_id,
            status = EXCLUDED.status,
            revision = EXCLUDED.revision,
            updated_at = now()
        WHERE ume_entities.revision = $7`
  const result = await pool.query(
    `INSERT INTO ume_entities (id, entity_name, document, plan_entity_id, status, revision)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) ${onConflict}`,
    onConflict.includes("$7")
      ? [
          entity.id,
          entityName,
          JSON.stringify(document),
          planEntityId,
          status,
          entity.lifecycle.version,
          expectedRevision,
        ]
      : [entity.id, entityName, JSON.stringify(document), planEntityId, status, entity.lifecycle.version],
  )
  // DO NOTHING on an existing id (seed over a seeded row) is a no-op, not
  // a conflict; seedOverwrite clobbering an edited row is the documented
  // policy, also not a conflict.
  if (result.rowCount === 0 && !ifNotExists && !seedOverwrite) return "conflict"
  return "ok"
}

export async function getEntityById(
  pool: Pool,
  id: string,
  entityName: string,
): Promise<EntityRow | null> {
  const { rows } = await pool.query<EntityRow>(
    "SELECT * FROM ume_entities WHERE id = $1 AND entity_name = $2 AND deleted_at IS NULL",
    [id, entityName],
  )
  return rows[0] ?? null
}

/** Latest live sibling of a plan (budget / actuals), by update recency. */
export async function getLatestForPlan(
  pool: Pool,
  planEntityId: string,
  entityName: string,
): Promise<EntityRow | null> {
  const { rows } = await pool.query<EntityRow>(
    `SELECT * FROM ume_entities
     WHERE plan_entity_id = $1 AND entity_name = $2 AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [planEntityId, entityName],
  )
  return rows[0] ?? null
}

/** Cap on the CR queue listing: newest-first window, never unbounded. */
const CR_QUEUE_LIMIT = 200

/** CR queue of a plan, newest first (capped); optional promoted-status filter. */
export async function listChangeRequests(
  pool: Pool,
  planEntityId: string,
  status?: string,
): Promise<EntityRow[]> {
  const { rows } = await pool.query<EntityRow>(
    `SELECT * FROM ume_entities
     WHERE plan_entity_id = $1 AND entity_name = 'GanttChangeRequest' AND deleted_at IS NULL
       ${status ? "AND status = $2" : ""}
     ORDER BY created_at DESC
     LIMIT ${CR_QUEUE_LIMIT}`,
    status ? [planEntityId, status] : [planEntityId],
  )
  return rows
}

export async function currentRevision(pool: Pool, id: string): Promise<number | null> {
  const { rows } = await pool.query<{ revision: number }>(
    "SELECT revision FROM ume_entities WHERE id = $1",
    [id],
  )
  return rows[0]?.revision ?? null
}
