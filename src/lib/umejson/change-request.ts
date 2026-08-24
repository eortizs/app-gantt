// Change-request contract: the umeJSON surface a future approval-workflow
// module consumes. This module PREPARES the document - types, pure
// builders, legal transitions, encode/decode - and deliberately ships no
// UI and no persistence; that is the CR module's job, not the plan's.
//
// Design decisions (see AGENTS.md):
// - A CR is its OWN umeJSON entity ("GanttChangeRequest"), not a field of
//   PlanJSON: the plan schema stays frozen at v2 and the CR references it
//   by entity id + revision anchor.
// - A CR binds to a plan REVISION (`planEntityId` + `planAnchor`).
//   Applying an approved CR to a plan whose anchor moved on is a contract
//   drift; `decodeChangeRequest` flags it whenever the plan is supplied.
// - Actors and instants are RESERVED_FOR_SYSTEM until the backend owns
//   identity - the same convention `encodeUpdatedPlan` uses for
//   `updatedAt`. The CR's own statusLog accepts SENTINEL timestamps
//   because a pre-persist proposal legitimately carries them (the
//   envelope's lifecycle, in contrast, rejects SENTINEL: that means the
//   document was never finalized).
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` alongside the codec.
import { applyOps, type ChangeOp } from "./codec.ts"
import type { PlanJSON } from "../plan-types.ts"
import { dependentClosure } from "./schedule.ts"
import { vigenteBaseline, driftDays } from "./baselines.ts"
import {
  SENTINEL,
  UME_STATUSES,
  err,
  isIsoDate,
  isObject,
  type UmeJsonEntity,
  type UmeJsonLifecycle,
  type UmeJsonState,
  type UmeJsonStatus,
  type ValidationError,
} from "./schema.ts"

export const ENTITY_NAME_CHANGE_REQUEST = "GanttChangeRequest"
export const CR_SCHEMA_VERSION = 1

export type ChangeRequestStatus = "proposed" | "approved" | "rejected" | "applied"

const CR_STATUSES: readonly ChangeRequestStatus[] = [
  "proposed",
  "approved",
  "rejected",
  "applied",
]

/**
 * proposed → approved | rejected; approved → applied. rejected and applied
 * are terminal: a rejected CR is re-proposed as a NEW document, never
 * resurrected.
 */
const LEGAL_TRANSITIONS: Record<
  ChangeRequestStatus,
  readonly ChangeRequestStatus[]
> = {
  proposed: ["approved", "rejected"],
  approved: ["applied"],
  rejected: [],
  applied: [],
}

export interface ImpactEntry {
  eventId: string
  /** Proposed (post-ops) dates. */
  start: string
  end: string
  /**
   * Drift reference at proposal time: the vigente baseline when the
   * bitácora has one, else the base plan's own dates (same policy as
   * `driftReference`). Absent for events with no anchor - a brand-new
   * task has no original to drift from.
   */
  reference?: { start: string; end: string }
  /** Whole-day Δ of the proposed end vs the reference (positive = later). */
  driftDays?: number
}

export interface ImpactSnapshot {
  /**
   * Frozen at proposal time: an approver decides on THIS, never on a live
   * recomputation that can silently change under review. The decoder
   * never cross-checks it against the ops - it is evidence, not a cache.
   */
  entries: ImpactEntry[]
}

export interface ChangeRequestStatusEntry {
  status: ChangeRequestStatus
  /** RESERVED_FOR_SYSTEM until the backend stamps the real instant. */
  timestamp: string
  reason?: string
}

export interface ChangeRequestPayload {
  schemaVersion: 1
  /** The GanttPlan entity this CR targets (mirrored in relations[0]). */
  planEntityId: string
  /** Anchor of the plan revision this CR was proposed against. */
  planAnchor: string
  ops: ChangeOp[]
  status: ChangeRequestStatus
  impact: ImpactSnapshot
  /** Append-only: one entry per legal transition, head = "proposed". */
  statusLog: ChangeRequestStatusEntry[]
  /** RESERVED_FOR_SYSTEM until the host provides session identity. */
  requestedBy?: string
  /** Set on approve/reject; RESERVED_FOR_SYSTEM until identity exists. */
  decidedBy?: string
}

export interface UmeChangeRequestEntity {
  id: string
  entityName: typeof ENTITY_NAME_CHANGE_REQUEST
  dynamicProperties: { changeRequest: ChangeRequestPayload; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  markdownDocumentation: string
  relations?: UmeJsonEntity["relations"]
}

/**
 * Blast radius of a set of ops, frozen as data: the events the ops
 * directly touch plus their transitive dependents along the POST-ops
 * graph (an added edge binds its successor immediately). Each entry
 * carries the proposed dates and the drift against the reference the
 * BASE plan provides - the approver sees what the change does at
 * proposal time, not a recomputation at decision time.
 */
export function buildImpactSnapshot(
  basePlan: PlanJSON,
  ops: readonly ChangeOp[],
): ImpactSnapshot {
  const next = applyOps(basePlan, [...ops])
  const baseById = new Map(basePlan.events.map((e) => [e.id, e]))
  const nextById = new Map(next.events.map((e) => [e.id, e]))
  const seeds = ops.flatMap((op) => {
    if (op.op === "update" || op.op === "delete") return [op.id]
    if (op.op === "create") return [op.event.id]
    if (op.op === "addDependency") return [op.dependency.toEventId]
    return []
  })
  const affected = [
    ...new Set([
      ...seeds,
      ...dependentClosure(next.dependencies ?? [], seeds),
    ]),
  ]
  const entries: ImpactEntry[] = []
  for (const id of affected) {
    const nextEv = nextById.get(id)
    if (!nextEv) continue // deleted by the ops: gone, not "impacted"
    const baseEv = baseById.get(id)
    const vigente = vigenteBaseline(baseEv?.baselines)
    const reference = vigente
      ? { start: vigente.start, end: vigente.end }
      : baseEv
        ? { start: baseEv.start, end: baseEv.end }
        : null
    entries.push(
      reference
        ? {
            eventId: id,
            start: nextEv.start,
            end: nextEv.end,
            reference,
            driftDays: driftDays(nextEv.end, reference.end),
          }
        : { eventId: id, start: nextEv.start, end: nextEv.end },
    )
  }
  return { entries }
}

/**
 * A proposal born coherent by construction: the impact snapshot is
 * computed from the SAME plan the CR binds to, so a hand-built stale
 * snapshot can never be attached.
 */
export function createChangeRequest(input: {
  planEntityId: string
  planAnchor: string
  basePlan: PlanJSON
  ops: readonly ChangeOp[]
}): ChangeRequestPayload {
  const ops = [...input.ops]
  return {
    schemaVersion: CR_SCHEMA_VERSION,
    planEntityId: input.planEntityId,
    planAnchor: input.planAnchor,
    ops,
    status: "proposed",
    impact: buildImpactSnapshot(input.basePlan, ops),
    statusLog: [{ status: "proposed", timestamp: SENTINEL }],
    requestedBy: SENTINEL,
  }
}

export function canTransition(
  from: ChangeRequestStatus,
  to: ChangeRequestStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

/**
 * Legal state transition as data: returns the NEXT payload (append-only
 * log, decidedBy stamped on the decision) or null when the transition is
 * illegal - the caller never gets to write an impossible history.
 */
export function transitionChangeRequest(
  cr: ChangeRequestPayload,
  to: ChangeRequestStatus,
  reason?: string,
): ChangeRequestPayload | null {
  if (!canTransition(cr.status, to)) return null
  return {
    ...cr,
    status: to,
    statusLog: [...cr.statusLog, { status: to, timestamp: SENTINEL, reason }],
    ...(to === "approved" || to === "rejected"
      ? { decidedBy: cr.decidedBy ?? SENTINEL }
      : {}),
  }
}

/**
 * Same envelope discipline as `encodeUpdatedPlan`: deep-clone, stamp the
 * system-reserved updatedAt, append one statusLog entry describing the
 * CR's state. The output is FOR THE BACKEND - like the plan codec, the
 * sentinel updatedAt makes it non-decodable by this same client.
 */
export function encodeChangeRequest(
  base: UmeChangeRequestEntity,
  cr: ChangeRequestPayload,
): UmeChangeRequestEntity {
  const cloned = structuredClone(base)
  cloned.dynamicProperties = { ...cloned.dynamicProperties, changeRequest: cr }
  cloned.lifecycle = { ...cloned.lifecycle, updatedAt: SENTINEL }
  cloned.state = {
    ...cloned.state,
    statusLog: [
      ...cloned.state.statusLog,
      {
        status: cloned.state.current,
        timestamp: SENTINEL,
        reason: `change-request: ${cr.status}`,
      },
    ],
  }
  return cloned
}

export type DecodeChangeRequestResult =
  | { ok: true; entity: UmeChangeRequestEntity; cr: ChangeRequestPayload }
  | { ok: false; errors: ValidationError[] }

const DEP_TYPES = ["FS", "SS", "FF", "SF"] as const

const validateCause = (
  v: unknown,
  path: string,
  errors: ValidationError[],
): void => {
  if (v === undefined) return
  if (!isObject(v)) {
    errors.push(err(path, "type", "cause must be an object"))
    return
  }
  if (v.kind !== "dependency-cascade") {
    errors.push(err(`${path}.kind`, "enum", 'cause.kind must be "dependency-cascade"'))
  }
  if (typeof v.sourceEventId !== "string" || v.sourceEventId === "") {
    errors.push(err(`${path}.sourceEventId`, "type", "cause.sourceEventId must be a non-empty string"))
  }
  if (typeof v.type !== "string" || !DEP_TYPES.includes(v.type as (typeof DEP_TYPES)[number])) {
    errors.push(err(`${path}.type`, "enum", "cause.type must be one of FS, SS, FF, SF"))
  }
  if (typeof v.shiftDays !== "number" || !Number.isInteger(v.shiftDays)) {
    errors.push(err(`${path}.shiftDays`, "type", "cause.shiftDays must be an integer"))
  }
}

const validateOps = (
  ops: unknown,
  basePath: string,
  errors: ValidationError[],
): void => {
  if (!Array.isArray(ops)) {
    errors.push(err(basePath, "type", "ops must be an array"))
    return
  }
  ops.forEach((op, i) => {
    const p = `${basePath}[${i}]`
    if (!isObject(op)) {
      errors.push(err(p, "type", "op must be an object"))
      return
    }
    switch (op.op) {
      case "update": {
        if (typeof op.id !== "string" || op.id === "") {
          errors.push(err(`${p}.id`, "type", "op.id must be a non-empty string"))
        }
        if (!isObject(op.patch)) {
          errors.push(err(`${p}.patch`, "type", "op.patch must be an object"))
        } else {
          if (!isIsoDate(op.patch.start)) {
            errors.push(err(`${p}.patch.start`, "iso", "op.patch.start must be ISO date string"))
          }
          if (!isIsoDate(op.patch.end)) {
            errors.push(err(`${p}.patch.end`, "iso", "op.patch.end must be ISO date string"))
          }
        }
        validateCause(op.cause, `${p}.cause`, errors)
        break
      }
      case "create": {
        if (!isObject(op.event)) {
          errors.push(err(`${p}.event`, "type", "op.event must be an object"))
          break
        }
        const ev = op.event
        if (typeof ev.id !== "string" || ev.id === "") {
          errors.push(err(`${p}.event.id`, "type", "event.id must be a non-empty string"))
        }
        if (typeof ev.resourceId !== "string" || ev.resourceId === "") {
          errors.push(err(`${p}.event.resourceId`, "type", "event.resourceId must be a non-empty string"))
        }
        if (!isIsoDate(ev.start)) {
          errors.push(err(`${p}.event.start`, "iso", "event.start must be ISO date string"))
        }
        if (!isIsoDate(ev.end)) {
          errors.push(err(`${p}.event.end`, "iso", "event.end must be ISO date string"))
        }
        if (typeof ev.progress !== "number" || ev.progress < 0 || ev.progress > 100) {
          errors.push(err(`${p}.event.progress`, "range", "event.progress must be 0..100"))
        }
        if (typeof ev.title !== "string") {
          errors.push(err(`${p}.event.title`, "type", "event.title must be a string"))
        }
        if (ev.color !== undefined && typeof ev.color !== "string") {
          errors.push(err(`${p}.event.color`, "type", "event.color must be a string"))
        }
        if (!isObject(ev.data)) {
          errors.push(err(`${p}.event.data`, "type", "event.data must be an object"))
        } else {
          for (const field of ["responsable", "fase", "status"] as const) {
            if (typeof ev.data[field] !== "string") {
              errors.push(err(`${p}.event.data.${field}`, "type", `event.data.${field} must be a string`))
            }
          }
        }
        validateCause(op.cause, `${p}.cause`, errors)
        break
      }
      case "delete": {
        if (typeof op.id !== "string" || op.id === "") {
          errors.push(err(`${p}.id`, "type", "op.id must be a non-empty string"))
        }
        break
      }
      case "addDependency": {
        if (!isObject(op.dependency)) {
          errors.push(err(`${p}.dependency`, "type", "op.dependency must be an object"))
          break
        }
        const d = op.dependency
        for (const side of ["id", "fromEventId", "toEventId"] as const) {
          if (typeof d[side] !== "string" || d[side] === "") {
            errors.push(err(`${p}.dependency.${side}`, "type", `dependency.${side} must be a non-empty string`))
          }
        }
        if (typeof d.type !== "string" || !DEP_TYPES.includes(d.type as (typeof DEP_TYPES)[number])) {
          errors.push(err(`${p}.dependency.type`, "enum", "dependency.type must be one of FS, SS, FF, SF"))
        }
        if (d.lagDays !== undefined && (typeof d.lagDays !== "number" || !Number.isInteger(d.lagDays))) {
          errors.push(err(`${p}.dependency.lagDays`, "type", "dependency.lagDays must be an integer"))
        }
        break
      }
      case "removeDependency": {
        if (typeof op.id !== "string" || op.id === "") {
          errors.push(err(`${p}.id`, "type", "op.id must be a non-empty string"))
        }
        break
      }
      default:
        errors.push(err(`${p}.op`, "enum", "op must be one of update, create, delete, addDependency, removeDependency"))
    }
  })
}

/**
 * Hand-rolled validator in the decodeUmePlan style: envelope (own entity
 * name), payload (ops, impact, append-only statusLog with legal
 * transitions), and - when the plan is supplied - revision binding: same
 * anchor, same entity id, and every op target resolvable against the
 * plan (ops that create events widen the known set for later ops).
 */
export function decodeChangeRequest(
  input: unknown,
  plan?: PlanJSON,
  planEntityId?: string,
): DecodeChangeRequestResult {
  const errors: ValidationError[] = []
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }

  // Capa 1: envelope.
  for (const req of ["id", "entityName", "dynamicProperties", "lifecycle", "state", "markdownDocumentation"]) {
    if (!(req in input)) errors.push(err(req, "missing", `field "${req}" is required`))
  }
  if (typeof input.id !== "string" || input.id === "") {
    errors.push(err("id", "type", "id must be a non-empty string"))
  } else if (input.id === SENTINEL) {
    errors.push(err("id", "sentinel", "id must not be RESERVED_FOR_SYSTEM (document not finalized)"))
  }
  if (input.entityName !== ENTITY_NAME_CHANGE_REQUEST) {
    errors.push(err("entityName", "enum", `entityName must be "${ENTITY_NAME_CHANGE_REQUEST}"`))
  }
  if (typeof input.markdownDocumentation !== "string") {
    errors.push(err("markdownDocumentation", "type", "markdownDocumentation must be a string"))
  }
  if (!isObject(input.dynamicProperties)) {
    errors.push(err("dynamicProperties", "type", "dynamicProperties must be an object"))
  }
  if (!isObject(input.lifecycle)) {
    errors.push(err("lifecycle", "type", "lifecycle must be an object"))
  } else {
    const lc = input.lifecycle
    if (!isIsoDate(lc.createdAt)) errors.push(err("lifecycle.createdAt", "iso", "createdAt must be ISO date string"))
    else if (lc.createdAt === SENTINEL) errors.push(err("lifecycle.createdAt", "sentinel", "createdAt must not be RESERVED_FOR_SYSTEM"))
    if (!isIsoDate(lc.updatedAt)) errors.push(err("lifecycle.updatedAt", "iso", "updatedAt must be ISO date string"))
    else if (lc.updatedAt === SENTINEL) errors.push(err("lifecycle.updatedAt", "sentinel", "updatedAt must not be RESERVED_FOR_SYSTEM"))
    if (typeof lc.version !== "number" || !Number.isInteger(lc.version) || lc.version < 1) {
      errors.push(err("lifecycle.version", "type", "version must be integer >= 1"))
    }
  }
  if (!isObject(input.state)) {
    errors.push(err("state", "type", "state must be an object"))
  } else {
    if (!UME_STATUSES.includes(input.state.current as UmeJsonStatus)) {
      errors.push(err("state.current", "enum", `current must be one of ${UME_STATUSES.join(", ")}`))
    }
    if (!Array.isArray(input.state.statusLog)) {
      errors.push(err("state.statusLog", "type", "statusLog must be an array"))
    }
  }

  // Capa 2: payload.
  const cr = isObject(input.dynamicProperties)
    ? input.dynamicProperties.changeRequest
    : undefined
  const P = "dynamicProperties.changeRequest"
  if (!isObject(cr)) {
    errors.push(err(P, "type", "changeRequest must be an object"))
  } else {
    if (cr.schemaVersion !== CR_SCHEMA_VERSION) {
      errors.push(err(`${P}.schemaVersion`, "enum", `schemaVersion must be ${CR_SCHEMA_VERSION}`))
    }
    if (typeof cr.planEntityId !== "string" || cr.planEntityId === "") {
      errors.push(err(`${P}.planEntityId`, "type", "planEntityId must be a non-empty string"))
    }
    if (!isIsoDate(cr.planAnchor)) {
      errors.push(err(`${P}.planAnchor`, "iso", "planAnchor must be ISO date string"))
    }
    validateOps(cr.ops, `${P}.ops`, errors)
    if (!CR_STATUSES.includes(cr.status as ChangeRequestStatus)) {
      errors.push(err(`${P}.status`, "enum", `status must be one of ${CR_STATUSES.join(", ")}`))
    }
    if (!isObject(cr.impact)) {
      errors.push(err(`${P}.impact`, "type", "impact must be an object"))
    } else if (!Array.isArray(cr.impact.entries)) {
      errors.push(err(`${P}.impact.entries`, "type", "impact.entries must be an array"))
    } else {
      cr.impact.entries.forEach((entry: unknown, i: number) => {
        const ep = `${P}.impact.entries[${i}]`
        if (!isObject(entry)) {
          errors.push(err(ep, "type", "impact entry must be an object"))
          return
        }
        if (typeof entry.eventId !== "string" || entry.eventId === "") {
          errors.push(err(`${ep}.eventId`, "type", "impact.eventId must be a non-empty string"))
        }
        if (!isIsoDate(entry.start)) errors.push(err(`${ep}.start`, "iso", "impact.start must be ISO date string"))
        if (!isIsoDate(entry.end)) errors.push(err(`${ep}.end`, "iso", "impact.end must be ISO date string"))
        if (entry.reference !== undefined) {
          if (!isObject(entry.reference)) {
            errors.push(err(`${ep}.reference`, "type", "impact.reference must be an object"))
          } else {
            if (!isIsoDate(entry.reference.start)) errors.push(err(`${ep}.reference.start`, "iso", "reference.start must be ISO date string"))
            if (!isIsoDate(entry.reference.end)) errors.push(err(`${ep}.reference.end`, "iso", "reference.end must be ISO date string"))
          }
        }
        if (entry.driftDays !== undefined && (typeof entry.driftDays !== "number" || !Number.isInteger(entry.driftDays))) {
          errors.push(err(`${ep}.driftDays`, "type", "impact.driftDays must be an integer"))
        }
      })
    }
    // Append-only audit log: head is the proposal, every step is a legal
    // transition, and the tail mirrors the payload status. SENTINEL
    // timestamps are legal here (pre-persist proposal; see header).
    if (!Array.isArray(cr.statusLog) || cr.statusLog.length === 0) {
      errors.push(err(`${P}.statusLog`, "type", "statusLog must be a non-empty array"))
    } else {
      let prev: ChangeRequestStatus | null = null
      cr.statusLog.forEach((entry: unknown, i: number) => {
        const lp = `${P}.statusLog[${i}]`
        if (!isObject(entry)) {
          errors.push(err(lp, "type", "statusLog entry must be an object"))
          prev = null
          return
        }
        const status = entry.status as ChangeRequestStatus
        if (!CR_STATUSES.includes(status)) {
          errors.push(err(`${lp}.status`, "enum", `status must be one of ${CR_STATUSES.join(", ")}`))
          prev = null
          return
        }
        // SENTINEL timestamps are legal here: a pre-persist proposal
        // carries them until the backend stamps the real instants (see
        // header). The envelope's lifecycle, in contrast, rejects them.
        if (entry.timestamp !== SENTINEL && !isIsoDate(entry.timestamp)) {
          errors.push(err(`${lp}.timestamp`, "iso", "timestamp must be ISO date string"))
        }
        if (entry.reason !== undefined && typeof entry.reason !== "string") {
          errors.push(err(`${lp}.reason`, "type", "reason must be a string"))
        }
        if (prev !== null && !canTransition(prev, status)) {
          errors.push(err(`${lp}.status`, "transition", `illegal transition ${prev} -> ${status}`))
        }
        prev = status
      })
      const head = cr.statusLog[0]
      if (isObject(head) && head.status !== "proposed") {
        errors.push(err(`${P}.statusLog[0].status`, "transition", 'statusLog must begin at "proposed"'))
      }
      const tail = cr.statusLog[cr.statusLog.length - 1]
      if (
        isObject(tail) &&
        CR_STATUSES.includes(tail.status as ChangeRequestStatus) &&
        CR_STATUSES.includes(cr.status as ChangeRequestStatus) &&
        tail.status !== cr.status
      ) {
        errors.push(err(`${P}.status`, "transition", `statusLog tail "${tail.status}" does not match payload status "${cr.status}"`))
      }
    }
    if (cr.requestedBy !== undefined && typeof cr.requestedBy !== "string") {
      errors.push(err(`${P}.requestedBy`, "type", "requestedBy must be a string"))
    }
    if (cr.decidedBy !== undefined && typeof cr.decidedBy !== "string") {
      errors.push(err(`${P}.decidedBy`, "type", "decidedBy must be a string"))
    }

    // Capa 3: revision binding (only when the plan is supplied).
    if (plan) {
      if (isIsoDate(cr.planAnchor) && cr.planAnchor !== plan.anchor) {
        errors.push(err(`${P}.planAnchor`, "ref", `CR binds plan revision "${cr.planAnchor}" but the plan's anchor is "${plan.anchor}"`))
      }
      if (planEntityId !== undefined && cr.planEntityId !== planEntityId) {
        errors.push(err(`${P}.planEntityId`, "ref", `CR targets plan "${cr.planEntityId}" but the supplied plan entity is "${planEntityId}"`))
      }
      const known = new Set(plan.events.map((e) => e.id))
      const rawOps = Array.isArray(cr.ops) ? cr.ops : []
      for (const op of rawOps) {
        if (
          isObject(op) && op.op === "create" &&
          isObject(op.event) && typeof op.event.id === "string"
        ) {
          known.add(op.event.id)
        }
      }
      rawOps.forEach((op: unknown, i: number) => {
        if (!isObject(op)) return // already reported by validateOps
        const p = `${P}.ops[${i}]`
        if (op.op === "update" || op.op === "delete") {
          if (typeof op.id === "string" && !known.has(op.id)) {
            errors.push(err(p, "ref", `op targets unknown event "${op.id}"`))
          }
        } else if (op.op === "addDependency" && isObject(op.dependency)) {
          for (const side of ["fromEventId", "toEventId"] as const) {
            const v = op.dependency[side]
            if (typeof v === "string" && !known.has(v)) {
              errors.push(err(`${p}.dependency.${side}`, "ref", `dependency endpoint "${v}" is not an event of the bound plan`))
            }
          }
        }
      })
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeChangeRequestEntity,
    cr: cr as unknown as ChangeRequestPayload,
  }
}
