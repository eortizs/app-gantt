// gantt-api — Fastify service for the umeJSON plan store.
//
// Listens ONLY on 127.0.0.1:4600 (nginx proxies /api/ from the TLS vhost,
// same origin, no CORS). Runtime-pure contract modules are imported
// verbatim from the frontend tree (../../src/lib/umejson/*.ts) — the same
// files `pnpm verify` exercises — so the backend validates with the exact
// decoder the client uses. Node >= 22.18 runs them natively via
// type-stripping, no transpiler.
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify"
import type { Pool } from "pg"
import { loadConfig } from "./config.ts"
import { createPool } from "./db/pool.ts"
import { runMigrations } from "./db/migrate.ts"
import {
  currentRevision,
  getEntityById,
  getLatestForPlan,
  listChangeRequests,
  putEntity,
  stampChangeRequestSentinels,
  stampSentinels,
  type EntityRow,
} from "./entities.ts"
import { decodeUmePlan } from "../../src/lib/umejson/schema.ts"
import type { UmeJsonLifecycle, UmeJsonState, ValidationError } from "../../src/lib/umejson/schema.ts"
import { ENTITY_NAME_BUDGET, decodeBudget, type BudgetPayload } from "../../src/lib/umejson/budget.ts"
import { ENTITY_NAME_ACTUALS, decodeActuals } from "../../src/lib/umejson/actuals.ts"
import { ENTITY_NAME_WORKFORCE, decodeWorkforce } from "../../src/lib/umejson/workforce.ts"
import type { PlanJSON } from "../../src/lib/plan-types.ts"
import { applyOps, type ChangeOp } from "../../src/lib/umejson/codec.ts"
import {
  buildChangeRequestEntity,
  createChangeRequest,
  decodeChangeRequest,
  transitionChangeRequest,
  ENTITY_NAME_CHANGE_REQUEST,
  type ChangeRequestPayload,
} from "../../src/lib/umejson/change-request.ts"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Minimal structural contract every umeJSON entity the API stores satisfies. */
interface StorableEntity {
  id: string
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  relations?: { targetEntity: string; targetId: string; type: string }[]
}

type DecodeFn<T> = (input: unknown) =>
  | { ok: true; entity: T }
  | { ok: false; errors: ValidationError[] }

interface EntitySpec<T extends StorableEntity> {
  entityName: string
  decode: DecodeFn<T>
  /** Promoted `plan_entity_id`: relations[0].targetId for plan siblings, null for plans. */
  planEntityIdOf: (entity: T) => string | null
  /** Sibling mode: routes hang off /api/plans/:planId/<mount> and address the entity by its relation to the plan. */
  siblingMount?: string
}

/**
 * Shared PUT pipeline: stamp sentinels (idempotent), stamp
 * lifecycle.version = expectedRevision + 1 (the server is the single
 * writer of versions), decode at the boundary (422 on any contract
 * violation), verify route/document identity, then upsert under
 * optimistic locking (409 when the stored revision moved).
 */
async function handlePut<T extends StorableEntity>(
  spec: EntitySpec<T>,
  pool: Pool,
  routeId: string,
  body: unknown,
  reply: FastifyReply,
): Promise<void> {
  if (
    typeof body !== "object" || body === null ||
    typeof (body as { entity?: unknown }).entity !== "object" ||
    (body as { entity?: unknown }).entity === null
  ) {
    void reply.code(400).send({ error: "body must be { entity, expectedRevision }" })
    return
  }
  const { entity: rawEntity } = body as { entity: unknown }
  const expectedRevision = (body as { expectedRevision?: unknown }).expectedRevision
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    void reply.code(400).send({ error: "expectedRevision must be an integer >= 0" })
    return
  }

  const now = new Date().toISOString()
  const stamped = stampSentinels(rawEntity, now)
  if (typeof stamped !== "object" || stamped === null) {
    void reply.code(422).send({
      errors: [{ path: "", code: "type", message: "entity must be an object" }],
    })
    return
  }
  const versioned = stamped as Record<string, unknown>
  if (typeof versioned.lifecycle === "object" && versioned.lifecycle !== null) {
    versioned.lifecycle = { ...(versioned.lifecycle as object), version: expectedRevision + 1 }
  }

  const decoded = spec.decode(versioned)
  if (!decoded.ok) {
    void reply.code(422).send({ errors: decoded.errors })
    return
  }
  const { entity } = decoded

  if (spec.siblingMount) {
    const planEntityId = spec.planEntityIdOf(entity)
    if (planEntityId !== routeId) {
      void reply.code(422).send({
        errors: [{
          path: "relations",
          code: "ref",
          message: `entity must relate to plan "${routeId}" (got "${planEntityId ?? "none"}")`,
        }],
      })
      return
    }
  } else if (entity.id !== routeId) {
    void reply.code(422).send({
      errors: [{
        path: "id",
        code: "ref",
        message: `entity id "${entity.id}" does not match route "${routeId}"`,
      }],
    })
    return
  }

  const outcome = await putEntity(pool, {
    entityName: spec.entityName,
    entity,
    document: versioned,
    planEntityId: spec.planEntityIdOf(entity),
    expectedRevision,
  })
  if (outcome === "conflict") {
    void reply.code(409).send({
      error: "revision mismatch",
      currentRevision: await currentRevision(pool, entity.id),
    })
    return
  }
  void reply.code(200).send({ id: entity.id, revision: entity.lifecycle.version })
}

function registerEntity<T extends StorableEntity>(
  app: FastifyInstance,
  pool: Pool,
  spec: EntitySpec<T>,
): void {
  if (spec.siblingMount) {
    const base = `/api/plans/:planId/${spec.siblingMount}`
    app.get(base, async (req, reply) => {
      const { planId } = req.params as { planId: string }
      if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
      const row = await getLatestForPlan(pool, planId, spec.entityName)
      if (!row) return reply.code(404).send({ error: "not found" })
      return row.document
    })
    app.put(base, async (req, reply) => {
      const { planId } = req.params as { planId: string }
      if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
      await handlePut(spec, pool, planId, req.body, reply)
      return reply
    })
  } else {
    const base = "/api/plans/:id"
    app.get(base, async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: "not found" })
      const row = await getEntityById(pool, id, spec.entityName)
      if (!row) return reply.code(404).send({ error: "not found" })
      // Persisted documents are clean (sentinels were stamped on save);
      // the stored bytes are returned verbatim.
      return row.document
    })
    app.put(base, async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: "not found" })
      await handlePut(spec, pool, id, req.body, reply)
      return reply
    })
  }
}

// ---- change requests: own semantics, NOT the registerEntity pipeline ----
// A CR is proposed from ops (not a document), transitions through an
// approval lifecycle, and its apply writes TWO rows transactionally.

/** Decode a stored plan row's document into its payload (border trust). */
function decodePlanRow(row: EntityRow): { ok: true; plan: PlanJSON } | { ok: false; errors: ValidationError[] } {
  const decoded = decodeUmePlan(row.document)
  return decoded.ok ? { ok: true, plan: decoded.plan } : { ok: false, errors: decoded.errors }
}

/** Budget payload of the plan's vigente sibling, when one decodes. */
async function liveBudgetFor(pool: Pool, planId: string, plan: PlanJSON): Promise<BudgetPayload | undefined> {
  const row = await getLatestForPlan(pool, planId, ENTITY_NAME_BUDGET)
  if (!row) return undefined
  const decoded = decodeBudget(row.document, plan, planId)
  return decoded.ok ? decoded.budget : undefined
}

/** Next CR document: payload swapped, envelope bumped, statusLog appended. */
function withCrPayload(
  base: unknown,
  next: ChangeRequestPayload,
  now: string,
  version: number,
): Record<string, unknown> {
  const cloned = structuredClone(base) as Record<string, unknown>
  cloned.dynamicProperties = {
    ...(cloned.dynamicProperties as object),
    changeRequest: next,
  }
  cloned.lifecycle = {
    ...(cloned.lifecycle as object),
    updatedAt: now,
    version,
  }
  const state = cloned.state as { current: string; statusLog: unknown[] }
  cloned.state = {
    ...state,
    statusLog: [
      ...state.statusLog,
      { status: state.current, timestamp: now, reason: `change-request: ${next.status}` },
    ],
  }
  return cloned
}

/** Next plan document after an applied CR: payload swapped, envelope bumped. */
function withPlanPayload(
  base: unknown,
  nextPlan: PlanJSON,
  now: string,
  version: number,
  reason: string,
): Record<string, unknown> {
  const cloned = structuredClone(base) as Record<string, unknown>
  cloned.dynamicProperties = { ...(cloned.dynamicProperties as object), plan: nextPlan }
  cloned.lifecycle = { ...(cloned.lifecycle as object), updatedAt: now, version }
  const state = cloned.state as { current: string; statusLog: unknown[] }
  cloned.state = {
    ...state,
    statusLog: [...state.statusLog, { status: state.current, timestamp: now, reason }],
  }
  return cloned
}

function registerChangeRequests(app: FastifyInstance, pool: Pool, defaultActor: string): void {
  // Cola del plan: documentos completos, created_at DESC, filtro opcional
  // por estado promovido (alimenta el índice parcial ume_cr_queue).
  app.get("/api/plans/:planId/change-requests", async (req, reply) => {
    const { planId } = req.params as { planId: string }
    if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
    const status = (req.query as { status?: unknown })?.status
    if (status !== undefined && typeof status !== "string") {
      return reply.code(400).send({ error: "status must be a string" })
    }
    const rows = await listChangeRequests(pool, planId, status)
    return rows.map((row) => row.document)
  })

  // Proponer: el servidor es el único autor de CRs — construye el payload
  // contra el plan ALMACENADO (revisión vigente), decodifica el envelope
  // en el borde como check defensivo (ops con targets inexistentes de un
  // cliente con vista vencida → 422) y persiste con status "proposed".
  app.post("/api/plans/:planId/change-requests", async (req, reply) => {
    const { planId } = req.params as { planId: string }
    if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
    const body = req.body as { ops?: unknown; reason?: unknown }
    if (!Array.isArray(body?.ops)) {
      return reply.code(400).send({ error: "body must be { ops: ChangeOp[], reason? }" })
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim() === "")) {
      return reply.code(400).send({ error: "reason must be a non-empty string when present" })
    }
    const planRow = await getEntityById(pool, planId, "GanttPlan")
    if (!planRow) return reply.code(404).send({ error: "not found" })
    const decodedPlan = decodePlanRow(planRow)
    if (!decodedPlan.ok) {
      return reply.code(422).send({ errors: decodedPlan.errors })
    }
    const budget = await liveBudgetFor(pool, planId, decodedPlan.plan)
    const reason = typeof body.reason === "string" ? body.reason.trim() : undefined
    const cr = createChangeRequest({
      planEntityId: planId,
      planAnchor: decodedPlan.plan.anchor,
      planRevision: planRow.revision,
      basePlan: decodedPlan.plan,
      ops: body.ops as ChangeOp[],
      ...(budget ? { budget } : {}),
      ...(reason ? { reason } : {}),
    })
    const entity = buildChangeRequestEntity({ payload: cr })
    const checked = decodeChangeRequest(entity, decodedPlan.plan, planId)
    if (!checked.ok) return reply.code(422).send({ errors: checked.errors })
    const now = new Date().toISOString()
    const document = stampChangeRequestSentinels(entity, now, defaultActor)
    const outcome = await putEntity(pool, {
      entityName: ENTITY_NAME_CHANGE_REQUEST,
      entity: document as StorableEntity,
      document,
      planEntityId: planId,
      expectedRevision: 0,
      status: "proposed",
    })
    if (outcome === "conflict") {
      return reply.code(409).send({
        error: "revision mismatch",
        currentRevision: await currentRevision(pool, entity.id),
      })
    }
    return reply.code(201).send({ id: entity.id, revision: 1, impact: cr.impact })
  })

  // Decidir: approve/reject persisten la transición; apply verifica el
  // binding de revisión (mismatch → 409, la CR queda approved y hay que
  // re-proponer) y escribe plan + CR en UNA transacción.
  app.post("/api/change-requests/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "not found" })
    const body = req.body as { to?: unknown; reason?: unknown }
    const to = body?.to
    if (to !== "approved" && to !== "rejected" && to !== "applied") {
      return reply.code(400).send({ error: 'to must be one of approved, rejected, applied' })
    }
    if (body?.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim() === "")) {
      return reply.code(400).send({ error: "reason must be a non-empty string when present" })
    }
    const crRow = await getEntityById(pool, id, ENTITY_NAME_CHANGE_REQUEST)
    if (!crRow) return reply.code(404).send({ error: "not found" })
    const decoded = decodeChangeRequest(crRow.document)
    if (!decoded.ok) return reply.code(422).send({ errors: decoded.errors })
    const reason = typeof body?.reason === "string" ? body.reason.trim() : undefined
    const next = transitionChangeRequest(decoded.cr, to, reason)
    if (!next) {
      return reply.code(422).send({ error: `illegal transition ${decoded.cr.status} -> ${to}` })
    }
    const now = new Date().toISOString()
    const nextVersion = crRow.revision + 1

    if (to !== "applied") {
      const document = stampChangeRequestSentinels(
        withCrPayload(crRow.document, next, now, nextVersion),
        now,
        defaultActor,
      )
      const checked = decodeChangeRequest(document)
      if (!checked.ok) return reply.code(422).send({ errors: checked.errors })
      const outcome = await putEntity(pool, {
        entityName: ENTITY_NAME_CHANGE_REQUEST,
        entity: checked.entity as StorableEntity,
        document,
        planEntityId: decoded.cr.planEntityId,
        expectedRevision: crRow.revision,
        status: to,
      })
      if (outcome === "conflict") {
        return reply.code(409).send({
          error: "revision mismatch",
          currentRevision: await currentRevision(pool, id),
        })
      }
      return reply.code(200).send({ id, status: to, revision: nextVersion })
    }

    // apply: el binding de revisión es el que protege de verdad.
    const planRow = await getEntityById(pool, decoded.cr.planEntityId, "GanttPlan")
    if (!planRow) return reply.code(404).send({ error: "bound plan not found" })
    if (decoded.cr.planRevision !== planRow.revision) {
      return reply.code(409).send({
        error: "plan revision moved since this CR was proposed",
        currentRevision: planRow.revision,
        crPlanRevision: decoded.cr.planRevision,
      })
    }
    const decodedPlan = decodePlanRow(planRow)
    if (!decodedPlan.ok) return reply.code(422).send({ errors: decodedPlan.errors })
    // The next plan is built and validated BEFORE opening the
    // transaction; the transaction only guards the two writes.
    const nextPlan = applyOps(decodedPlan.plan, decoded.cr.ops)
    const planDoc = withPlanPayload(
      planRow.document,
      nextPlan,
      now,
      planRow.revision + 1,
      `CR aplicada: ${id}`,
    )
    const checkedPlan = decodeUmePlan(planDoc)
    if (!checkedPlan.ok) return reply.code(422).send({ errors: checkedPlan.errors })
    const crDoc = stampChangeRequestSentinels(
      withCrPayload(crRow.document, next, now, nextVersion),
      now,
      defaultActor,
    )
    const checkedCr = decodeChangeRequest(crDoc)
    if (!checkedCr.ok) return reply.code(422).send({ errors: checkedCr.errors })

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const planUpdate = await client.query(
        `UPDATE ume_entities
         SET document = $1, revision = $2, updated_at = now()
         WHERE id = $3 AND entity_name = 'GanttPlan' AND revision = $4 AND deleted_at IS NULL`,
        [JSON.stringify(planDoc), planRow.revision + 1, planRow.id, planRow.revision],
      )
      if (planUpdate.rowCount === 0) throw Object.assign(new Error("plan revision mismatch"), { statusCode: 409 })
      const crUpdate = await client.query(
        `UPDATE ume_entities
         SET document = $1, status = 'applied', revision = $2, updated_at = now()
         WHERE id = $3 AND entity_name = $4 AND revision = $5 AND deleted_at IS NULL`,
        [JSON.stringify(crDoc), nextVersion, id, ENTITY_NAME_CHANGE_REQUEST, crRow.revision],
      )
      if (crUpdate.rowCount === 0) throw Object.assign(new Error("CR revision mismatch"), { statusCode: 409 })
      await client.query("COMMIT")
    } catch (err: unknown) {
      await client.query("ROLLBACK")
      const statusCode =
        err instanceof Error && "statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500
      if (statusCode === 500) throw err
      return reply.code(statusCode).send({
        error: err instanceof Error ? err.message : "apply failed",
        currentRevision: await currentRevision(pool, planRow.id),
      })
    } finally {
      client.release()
    }
    return reply.code(200).send({
      id,
      status: "applied",
      revision: nextVersion,
      planRevision: planRow.revision + 1,
    })
  })
}

async function main(): Promise<void> {
  const config = loadConfig()
  const pool = createPool(config)
  await runMigrations(pool)

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } })
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error(err)
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500
    reply.code(status).send({ error: err.message })
  })

  app.get("/api/health", async (_req, reply) => {
    try {
      const { rows } = await pool.query<{ revision: string | number }>(
        "SELECT COALESCE(MAX(revision), 0) AS revision FROM ume_entities",
      )
      return { ok: true, db: true, revision: Number(rows[0]?.revision ?? 0) }
    } catch {
      return reply.code(503).send({ ok: true, db: false, revision: null })
    }
  })

  registerEntity(app, pool, {
    entityName: "GanttPlan",
    decode: (input) =>
      decodeUmePlan(input) as { ok: true; entity: StorableEntity } | { ok: false; errors: ValidationError[] },
    planEntityIdOf: () => null,
  })

  registerEntity(app, pool, {
    entityName: ENTITY_NAME_BUDGET,
    decode: (input) =>
      decodeBudget(input) as { ok: true; entity: StorableEntity } | { ok: false; errors: ValidationError[] },
    planEntityIdOf: (entity) => entity.relations?.[0]?.targetId ?? null,
    siblingMount: "budget",
  })

  registerEntity(app, pool, {
    entityName: ENTITY_NAME_ACTUALS,
    decode: (input) =>
      decodeActuals(input) as { ok: true; entity: StorableEntity } | { ok: false; errors: ValidationError[] },
    planEntityIdOf: (entity) => entity.relations?.[0]?.targetId ?? null,
    siblingMount: "actuals",
  })

  registerEntity(app, pool, {
    entityName: ENTITY_NAME_WORKFORCE,
    decode: (input) =>
      decodeWorkforce(input) as { ok: true; entity: StorableEntity } | { ok: false; errors: ValidationError[] },
    planEntityIdOf: (entity) => entity.relations?.[0]?.targetId ?? null,
    siblingMount: "workforce",
  })

  registerChangeRequests(app, pool, config.defaultActor)

  await app.listen({ port: config.port, host: config.host })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "shutting down")
      void app.close().then(() => pool.end()).then(() => process.exit(0))
    })
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
