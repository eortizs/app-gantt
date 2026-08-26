// Timesheet endpoints (Ola 3B): own semantics, NOT the registerEntity
// pipeline — same reasoning as change requests. One document per
// (actor, week); the PUT upserts the authenticated actor's week wholesale
// (REPLACE, like actuals); decisions are aprobador-only and an approval
// merges into GanttActuals IN THE SAME TRANSACTION (AC per event =
// Σ approved hours × crew dayRate / 8, cutoff = newest approved date).
//
// Storage id is a deterministic UUID over planId|actor|weekOf so clients
// and server agree where "my week" lives without a lookup round-trip.
import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool, PoolClient } from "pg"
import type { PlanJSON } from "../../src/lib/plan-types.ts"
import {
  buildTimesheetEntity,
  decodeTimesheet,
  transitionEntry,
  ENTITY_NAME_TIMESHEET,
  type TimesheetPayload,
  type TimesheetStatus,
  type TimesheetEntry,
} from "../../src/lib/umejson/timesheet.ts"
import {
  buildActualsEntity,
  decodeActuals,
} from "../../src/lib/umejson/actuals.ts"
import { decodeUmePlan, isObject } from "../../src/lib/umejson/schema.ts"
import { decodeWorkforce } from "../../src/lib/umejson/workforce.ts"
import { getEntityById, getLatestForPlan, putEntity, stampSentinels, type EntityRow } from "./entities.ts"
import { requireRole } from "./auth.ts"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function timesheetDocId(planId: string, actor: string, weekOf: string): string {
  const h = createHash("sha256").update(`${planId}|${actor}|${weekOf}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

interface StoredEntry extends Record<string, unknown> {
  id: string
  actor: string
  date: string
  eventId: string
  hours: number
  note?: string | null
  status: string
}

function entriesOf(row: EntityRow): StoredEntry[] {
  const dp = (row.document as Record<string, unknown>)?.dynamicProperties
  const ts = isObject(dp)
    ? (dp as Record<string, unknown>).timesheet
    : undefined
  return isObject(ts) && Array.isArray((ts as Record<string, unknown>).entries)
    ? ((ts as Record<string, unknown>).entries as StoredEntry[])
    : []
}

export function registerTimesheets(app: FastifyInstance, pool: Pool): void {
  // Cola del plan: documentos completos con filtros opcionales.
  app.get("/api/plans/:planId/timesheets", async (req, reply) => {
    const { planId } = req.params as { planId: string }
    if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
    const q = req.query as { weekOf?: unknown; actor?: unknown }
    const { rows } = await pool.query<EntityRow>(
      `SELECT * FROM ume_entities
       WHERE plan_entity_id = $1 AND entity_name = $2 AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
      [planId, ENTITY_NAME_TIMESHEET],
    )
    const docs = rows
      .map((row) => row.document)
      .filter((doc: unknown) => {
        if (!isObject(doc)) return false
        const ts = (doc as Record<string, unknown>).dynamicProperties
        const inner = isObject(ts)
          ? (ts as Record<string, unknown>).timesheet
          : undefined
        if (!isObject(inner)) return false
        const t = inner as Record<string, unknown>
        if (typeof q.weekOf === "string" && t.weekOf !== q.weekOf) return false
        if (typeof q.actor === "string") {
          const entries = Array.isArray(t.entries) ? t.entries : []
          if (!entries.some((e) => isObject(e) && (e as Record<string, unknown>).actor === q.actor)) {
            return false
          }
        }
        return true
      })
    void reply.header("x-ume-revision", "")
    return docs
  })

  // Upsert de LA SEMANA del actor autenticado: solo entradas propias y en
  // estado draft/submitted (el flujo de aprobación vive en el endpoint de
  // decisión). REPLACE semántico: el documento de la semana se sustituye.
  app.put("/api/plans/:planId/timesheets", async (req, reply) => {
    if (!requireRole(req, reply, "editor")) return reply
    const { planId } = req.params as { planId: string }
    if (!UUID_RE.test(planId)) return reply.code(404).send({ error: "not found" })
    const body = req.body as { timesheet?: unknown; expectedRevision?: unknown }
    const expectedRevision = body?.expectedRevision
    if (
      !isObject(body?.timesheet) ||
      typeof expectedRevision !== "number" ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return reply.code(400).send({ error: "body must be { timesheet: { weekOf, entries }, expectedRevision }" })
    }
    const planRow = await getEntityById(pool, planId, "GanttPlan")
    if (!planRow) return reply.code(404).send({ error: "not found" })
    const planDecoded = decodeUmePlan(planRow.document)
    if (!planDecoded.ok) return reply.code(422).send({ errors: planDecoded.errors })
    const workforceRow = await getLatestForPlan(pool, planId, "GanttWorkforce")
    const workforce = workforceRow
      ? (() => {
          const d = decodeWorkforce(workforceRow.document, planDecoded.plan, planId)
          return d.ok ? d.workforce : undefined
        })()
      : undefined

    const actor = req.actor!.name
    const rawTs = body.timesheet as Record<string, unknown>
    const weekOf = typeof rawTs.weekOf === "string" ? rawTs.weekOf : ""
    const rawEntries = Array.isArray(rawTs.entries) ? rawTs.entries : []
    const entries: TimesheetEntry[] = rawEntries.map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>
      const status: TimesheetStatus = e.status === "submitted" ? "submitted" : "draft"
      return {
        id: typeof e.id === "string" && e.id !== "" ? e.id : randomUUID(),
        actor,
        date: typeof e.date === "string" ? e.date : "",
        eventId: typeof e.eventId === "string" ? e.eventId : "",
        hours: typeof e.hours === "number" ? e.hours : NaN,
        ...(typeof e.note === "string" && e.note.trim() !== "" ? { note: e.note } : {}),
        status,
      }
    })
    const payload: TimesheetPayload = { schemaVersion: 1, weekOf, entries }

    const docId = timesheetDocId(planId, actor, weekOf)
    const existing = await getEntityById(pool, docId, ENTITY_NAME_TIMESHEET)
    const now = new Date().toISOString()
    const version = existing ? existing.revision + 1 : 1
    const entity = buildTimesheetEntity({
      id: docId,
      planEntityId: planId,
      planAnchor: planDecoded.plan.anchor,
      timesheet: payload,
    })
    entity.lifecycle.createdAt = existing
      ? (existing.document as { lifecycle?: { createdAt?: string } })?.lifecycle?.createdAt ?? entity.lifecycle.createdAt
      : entity.lifecycle.createdAt
    entity.lifecycle.updatedAt = now
    entity.lifecycle.version = version

    const stampedUnknown: unknown = stampSentinels(entity, now)
    const checked = decodeTimesheet(stampedUnknown, planDecoded.plan, planId, workforce)
    if (!checked.ok) return reply.code(422).send({ errors: checked.errors })

    const outcome = await putEntity(pool, {
      entityName: ENTITY_NAME_TIMESHEET,
      entity: checked.entity,
      document: stampedUnknown,
      planEntityId: planId,
      expectedRevision: existing ? existing.revision : 0,
    })
    if (outcome === "conflict") {
      return reply.code(409).send({
        error: "revision mismatch",
        currentRevision: existing?.revision ?? null,
      })
    }
    return reply.code(200).send({ id: docId, revision: version })
  })

  // Decisión por ENTRADA (aprobador): transición legal sobre la entrada
  // dentro de su semana; al aprobar, merge a actuals en UNA transacción.
  app.post("/api/timesheets/:entryId/decision", async (req, reply) => {
    if (!requireRole(req, reply, "aprobador")) return reply
    const { entryId } = req.params as { entryId: string }
    const body = req.body as { to?: unknown }
    const to = body?.to
    if (to !== "submitted" && to !== "approved" && to !== "rejected") {
      return reply.code(400).send({ error: "to must be one of submitted, approved, rejected" })
    }
    const { rows } = await pool.query<EntityRow>(
      `SELECT * FROM ume_entities
       WHERE entity_name = $1 AND deleted_at IS NULL AND document @> $2::jsonb
       LIMIT 1`,
      [ENTITY_NAME_TIMESHEET, JSON.stringify({ dynamicProperties: { timesheet: { entries: [{ id: entryId }] } } })],
    )
    const row = rows[0]
    if (!row) return reply.code(404).send({ error: "entry not found" })
    const planId = row.plan_entity_id
    if (!planId || !UUID_RE.test(planId)) return reply.code(404).send({ error: "bound plan not found" })
    const planRow = await getEntityById(pool, planId, "GanttPlan")
    if (!planRow) return reply.code(404).send({ error: "bound plan not found" })
    const planDecoded = decodeUmePlan(planRow.document)
    if (!planDecoded.ok) return reply.code(422).send({ errors: planDecoded.errors })
    const workforceRow = await getLatestForPlan(pool, planId, "GanttWorkforce")
    const workforce = workforceRow
      ? (() => {
          const d = decodeWorkforce(workforceRow.document, planDecoded.plan, planId)
          return d.ok ? d.workforce : undefined
        })()
      : undefined
    const decoded = decodeTimesheet(row.document, planDecoded.plan, planId, workforce)
    if (!decoded.ok) return reply.code(422).send({ errors: decoded.errors })

    const mapped = decoded.timesheet.entries.map((e) =>
      e.id === entryId ? transitionEntry(e, to) : e,
    )
    if (mapped.some((e) => e === null)) {
      return reply.code(422).send({ error: `illegal transition to ${to}` })
    }
    const nextPayload: TimesheetPayload = {
      ...decoded.timesheet,
      entries: mapped.filter((e): e is NonNullable<typeof e> => e !== null),
    }
    const now = new Date().toISOString()
    let nextVersion = row.revision + 1
    const entity = { ...decoded.entity, lifecycle: { ...decoded.entity.lifecycle, updatedAt: now, version: nextVersion } }
    entity.state.statusLog = [
      ...entity.state.statusLog,
      { status: entity.state.current, timestamp: now, reason: `timesheet decision: ${to}` },
    ]
    entity.dynamicProperties = { ...entity.dynamicProperties, timesheet: nextPayload }
    let document: unknown = stampSentinels(entity, now)
    const rechecked = decodeTimesheet(document, planDecoded.plan, planId, workforce)
    if (!rechecked.ok) return reply.code(422).send({ errors: rechecked.errors })

    // Aprobación → merge a actuals DENTRO de la misma transacción que
    // persiste la decisión (retry interno ante carrera aprobación×aprob).
    if (to === "approved") {
      const client = await pool.connect()
      try {
        // Carrera aprobacion x aprobacion: el guard de revision del merge
        // devuelve 409 y SE REINTENTA leyendo estado fresco (max 5).
        for (let attempt = 0; ; attempt++) {
          let committed = false
          try {
            await client.query("BEGIN")
            const tsUpdate = await client.query(
              `UPDATE ume_entities SET document = $1, revision = $2, updated_at = now()
               WHERE id = $3 AND entity_name = $4 AND revision = $5 AND deleted_at IS NULL`,
              [JSON.stringify(document), nextVersion, row.id, ENTITY_NAME_TIMESHEET, row.revision],
            )
            if (tsUpdate.rowCount === 0) throw Object.assign(new Error("timesheet revision mismatch"), { statusCode: 409 })
            await mergeApprovedToActuals(client, pool, planDecoded.plan, planId)
            await client.query("COMMIT")
            committed = true
            break
          } catch (err: unknown) {
            if (!committed) await client.query("ROLLBACK").catch(() => undefined)
            else throw err
            const isConflict =
              err instanceof Error && "statusCode" in err &&
              (err as { statusCode?: unknown }).statusCode === 409
            if (isConflict && attempt < 4) {
              // Fresh read of BOTH rows, rebuild the decision document and
              // go again - a concurrent approval moved actuals under us.
              const freshRow = await getEntityById(pool, row.id, ENTITY_NAME_TIMESHEET)
              const freshDecoded =
                freshRow !== null
                  ? decodeTimesheet(freshRow.document, planDecoded.plan, planId, workforce)
                  : null
              if (freshRow === null || freshDecoded === null || !freshDecoded.ok) {
                throw err
              }
              const freshEntry = freshDecoded.timesheet.entries.find((e) => e.id === entryId)
              if (!freshEntry) return reply.code(404).send({ error: "entry not found" })
              const retried = transitionEntry(freshEntry, to)
              if (!retried) {
                return reply.code(422).send({ error: "illegal transition to " + to })
              }
              row.revision = freshRow.revision
              nextVersion = freshRow.revision + 1
              entity.lifecycle = { ...freshDecoded.entity.lifecycle, updatedAt: now, version: nextVersion }
              const freshPayload: TimesheetPayload = {
                ...freshDecoded.timesheet,
                entries: freshDecoded.timesheet.entries.map((e) =>
                  e.id === entryId ? retried : e,
                ),
              }
              entity.state.statusLog = [
                ...freshDecoded.entity.state.statusLog,
                { status: freshDecoded.entity.state.current, timestamp: now, reason: "timesheet decision: " + to },
              ]
              entity.dynamicProperties = { ...entity.dynamicProperties, timesheet: freshPayload }
              document = stampSentinels(entity, now)
              const rechecked2 = decodeTimesheet(document, planDecoded.plan, planId, workforce)
              if (!rechecked2.ok) return reply.code(422).send({ errors: rechecked2.errors })
              continue
            }
            throw err
          }
        }
      } catch (err: unknown) {
        const statusCode =
          err instanceof Error && "statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500
        client.release()
        if (statusCode !== 500) {
          return reply.code(statusCode).send({ error: err instanceof Error ? err.message : "merge failed" })
        }
        throw err
      }
      client.release()
      return reply.code(200).send({ id: entryId, status: to, revision: nextVersion })
    }

    const outcome = await putEntity(pool, {
      entityName: ENTITY_NAME_TIMESHEET,
      entity: entity as never,
      document,
      planEntityId: planId,
      expectedRevision: row.revision,
    })
    if (outcome === "conflict") {
      return reply.code(409).send({ error: "revision mismatch", currentRevision: row.revision })
    }
    return reply.code(200).send({ id: entryId, status: to, revision: nextVersion })
  })
}

/**
 * Recomputa AC por evento desde TODAS las semanas aprobadas del plan y
 * reemplaza la hermana actuals (REPLACE) con guard de revisión. Debe
 * correr dentro de la transacción abierta por el llamador; una carrera
 * aprobación×aprobación se resuelve con el retry del llamador (409).
 */
async function mergeApprovedToActuals(
  client: PoolClient,
  pool: Pool,
  plan: PlanJSON,
  planId: string,
): Promise<void> {
  const { rows: tsRows } = await client.query<EntityRow>(
    `SELECT * FROM ume_entities
     WHERE plan_entity_id = $1 AND entity_name = $2 AND deleted_at IS NULL`,
    [planId, ENTITY_NAME_TIMESHEET],
  )
  const hoursByEvent = new Map<string, number>()
  let latestDate: string | null = null
  for (const row of tsRows) {
    for (const entry of entriesOf(row)) {
      if (entry.status !== "approved") continue
      hoursByEvent.set(entry.eventId, (hoursByEvent.get(entry.eventId) ?? 0) + (Number(entry.hours) || 0))
      if (!latestDate || entry.date > latestDate) latestDate = entry.date
    }
  }
  // Tarifa por cuadrilla asignada (insumo de lectura; sin workforce o sin
  // asignación el evento no aporta AC — el borde valida la tarifa cuando
  // hay hermana RRHH, esto solo protege planes sin ella).
  const wfRow = await getLatestForPlan(pool, planId, "GanttWorkforce")
  const rateByEvent = new Map<string, number>()
  if (wfRow) {
    const wf = decodeWorkforce(wfRow.document, plan, planId)
    if (wf.ok) {
      for (const [eventId, a] of Object.entries(wf.workforce.assignmentByEvent)) {
        const crew = wf.workforce.crews.find((c) => c.id === a.crewId)
        if (crew) rateByEvent.set(eventId, crew.dayRate)
      }
    }
  }
  const acByEvent: Record<string, number> = {}
  for (const [eventId, hours] of hoursByEvent) {
    const rate = rateByEvent.get(eventId)
    if (rate === undefined) continue
    acByEvent[eventId] = Math.round(((hours * rate) / 8) * 100) / 100
  }
  const dataDate = latestDate ?? new Date().toISOString()

  const current = await getLatestForPlan(pool, planId, "GanttActuals")
  const baseDecoded = current ? decodeActuals(current.document, plan, planId) : null
  const basePayload =
    baseDecoded !== null && baseDecoded.ok
      ? baseDecoded.actuals
      : { schemaVersion: 1 as const, dataDate, planAnchor: plan.anchor, acByEvent: {} }
  const nextRevision = (current?.revision ?? 0) + 1
  const docId =
    baseDecoded !== null && baseDecoded.ok
      ? baseDecoded.entity.id
      : timesheetDocId(planId, "actuals", "merged")

  const entity = buildActualsEntity({
    id: docId,
    planEntityId: planId,
    actuals: {
      schemaVersion: 1,
      dataDate,
      planAnchor: plan.anchor,
      acByEvent,
      ...(basePayload.baselineVersionByEvent
        ? { baselineVersionByEvent: basePayload.baselineVersionByEvent }
        : {}),
    },
  })
  const prevCreatedAt =
    baseDecoded !== null && baseDecoded.ok
      ? baseDecoded.entity.lifecycle.createdAt
      : null
  entity.lifecycle.createdAt = prevCreatedAt ?? entity.lifecycle.createdAt
  entity.lifecycle.updatedAt = new Date().toISOString()
  entity.lifecycle.version = nextRevision

  const stamped: unknown = stampSentinels(entity, entity.lifecycle.updatedAt)
  const checked = decodeActuals(stamped, plan, planId)
  if (!checked.ok) throw Object.assign(new Error("actuals merge invalid"), { statusCode: 422 })
  await client.query(
    `INSERT INTO ume_entities (id, entity_name, document, plan_entity_id, status, revision)
     VALUES ($1, 'GanttActuals', $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET document = EXCLUDED.document,
           revision = EXCLUDED.revision,
           updated_at = now()
     WHERE ume_entities.revision = $6`,
    [
      checked.entity.id,
      JSON.stringify(stamped),
      planId,
      checked.entity.state.current,
      nextRevision,
      current?.revision ?? 0,
    ],
  )
}
