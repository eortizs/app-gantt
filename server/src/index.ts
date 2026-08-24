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
  putEntity,
  stampSentinels,
} from "./entities.ts"
import { decodeUmePlan } from "../../src/lib/umejson/schema.ts"
import type { UmeJsonLifecycle, UmeJsonState, ValidationError } from "../../src/lib/umejson/schema.ts"
import { ENTITY_NAME_BUDGET, decodeBudget } from "../../src/lib/umejson/budget.ts"
import { ENTITY_NAME_ACTUALS, decodeActuals } from "../../src/lib/umejson/actuals.ts"

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
