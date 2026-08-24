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

export type PutOutcome = "ok" | "conflict"

export interface PutEntityArgs {
  entityName: string
  /** Decoded, sentinel-stamped entity. `id` and `lifecycle.version` are authoritative. */
  entity: { id: string; lifecycle: { version: number }; state: { current: string } }
  document: unknown
  planEntityId: string | null
  /** Seed mode: never overwrite an existing row (ON CONFLICT DO NOTHING). */
  ifNotExists?: boolean
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
  const { entityName, entity, document, planEntityId, expectedRevision, ifNotExists } = args
  const existing = await pool.query<{ revision: number }>(
    "SELECT revision FROM ume_entities WHERE id = $1",
    [entity.id],
  )
  if (existing.rowCount === 0 && expectedRevision !== 0) return "conflict"
  if (existing.rowCount === 1 && existing.rows[0]!.revision !== expectedRevision) {
    return "conflict"
  }
  const result = await pool.query(
    `INSERT INTO ume_entities (id, entity_name, document, plan_entity_id, status, revision)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) ${ifNotExists ? "DO NOTHING" : `DO UPDATE
       SET document = EXCLUDED.document,
           entity_name = EXCLUDED.entity_name,
           plan_entity_id = EXCLUDED.plan_entity_id,
           status = EXCLUDED.status,
           revision = EXCLUDED.revision,
           updated_at = now()
       WHERE ume_entities.revision = $7`}`,
    ifNotExists
      ? [entity.id, entityName, JSON.stringify(document), planEntityId, entity.state.current, entity.lifecycle.version]
      : [
          entity.id,
          entityName,
          JSON.stringify(document),
          planEntityId,
          entity.state.current,
          entity.lifecycle.version,
          expectedRevision,
        ],
  )
  // DO NOTHING on an existing id (seed over a seeded row) is a no-op, not a conflict.
  if (result.rowCount === 0 && !ifNotExists) return "conflict"
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

export async function currentRevision(pool: Pool, id: string): Promise<number | null> {
  const { rows } = await pool.query<{ revision: number }>(
    "SELECT revision FROM ume_entities WHERE id = $1",
    [id],
  )
  return rows[0]?.revision ?? null
}
