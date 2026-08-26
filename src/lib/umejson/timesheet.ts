// GanttTimesheet v1 — field hour capture (parte de horas), the timesheet
// sibling of the plan. Runtime-pure like every module in this tree:
// relative `.ts` imports, loadable by verify + tsc + Node strip-types +
// Vite verbatim (the backend imports it).
//
// Shape: one document per (actor, week): `weekOf` anchors the week and
// `entries` carry per-event hours. Approval mirrors the CR lifecycle
// discipline: draft → submitted → approved | rejected, approved terminal,
// illegal transitions return null (same contract as
// `transitionChangeRequest`).
//
// Merge-to-actuals (the SERVER's job on approval, not this module):
// AC per event = Σ approved hours × crew dayRate / 8, cutoff = newest
// approved entry date. This module only supplies the validated payload.
import {
  err,
  isIsoDate,
  isObject,
  validateUmeEnvelope,
  type ValidationError,
} from "./schema.ts"
import type { PlanJSON } from "../plan-types.ts"
import type { WorkforcePayload } from "./workforce.ts"

export const ENTITY_NAME_TIMESHEET = "GanttTimesheet"
export const TIMESHEET_SCHEMA_VERSION = 1

/** How far an entry's date may sit from its week anchor. */
const DATE_WINDOW_DAYS = 90

export type TimesheetStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"

export interface TimesheetEntry {
  id: string
  /** Who logged the hours (actor name, same identity CRs stamp). */
  actor: string
  /** The worked day (ISO instant; UTC day key is what matters). */
  date: string
  eventId: string
  /** Hours in (0, 24]. */
  hours: number
  note?: string
  status: TimesheetStatus
}

export interface TimesheetPayload {
  schemaVersion: 1
  /** Week anchor (ISO); entries must sit within ±90 days of it. */
  weekOf: string
  entries: TimesheetEntry[]
}

export interface UmeTimesheetEntity {
  id: string
  entityName: string
  dynamicProperties: { timesheet: TimesheetPayload }
  lifecycle: { createdAt: string; updatedAt: string; deletedAt?: string | null; version: number }
  relations: Array<{
    targetEntity: string
    targetId: string
    type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
    context?: string
  }>
  state: { current: string; statusLog: Array<{ status: string; timestamp: string; reason?: string }> }
  markdownDocumentation: string
}

/**
 * Legal transitions: draft → submitted; submitted → approved | rejected;
 * approved/rejected terminal. Returns null when illegal (mirrors
 * `transitionChangeRequest`).
 */
export function transitionEntry(
  entry: TimesheetEntry,
  to: Exclude<TimesheetStatus, "draft">,
): TimesheetEntry | null {
  const ok =
    (entry.status === "draft" && to === "submitted") ||
    (entry.status === "submitted" && (to === "approved" || to === "rejected"))
  if (!ok) return null
  return { ...entry, status: to }
}

const DAY_MS = 86_400_000

export function decodeTimesheet(
  input: unknown,
  plan?: PlanJSON,
  _planEntityId?: string,
  workforce?: WorkforcePayload,
): { ok: true; entity: UmeTimesheetEntity; timesheet: TimesheetPayload } | { ok: false; errors: ValidationError[] } {
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }
  const errors = validateUmeEnvelope(input, ENTITY_NAME_TIMESHEET)
  if (!isObject(input.dynamicProperties)) {
    return { ok: false, errors }
  }
  const ts = (input.dynamicProperties as Record<string, unknown>).timesheet
  const P = "dynamicProperties.timesheet"
  if (!isObject(ts)) {
    errors.push(err(P, "type", "timesheet must be an object"))
    return { ok: false, errors }
  }
  if (ts.schemaVersion !== TIMESHEET_SCHEMA_VERSION) {
    errors.push(err(`${P}.schemaVersion`, "enum", "timesheet.schemaVersion must be 1"))
  }
  if (!isIsoDate(ts.weekOf)) {
    errors.push(err(`${P}.weekOf`, "iso", "timesheet.weekOf must be ISO date string"))
  }
  if (!Array.isArray(ts.entries)) {
    errors.push(err(`${P}.entries`, "type", "timesheet.entries must be an array"))
    return { ok: false, errors }
  }

  // Ref targets resolve only against SUPPLIED siblings; without them the
  // structural pass still runs (border trust mirrors the other decoders).
  const eventIds = new Set((plan?.events ?? []).map((e) => e.id))
  const rateByCrew = new Map(
    (workforce?.crews ?? []).map((c) => [c.id, c.dayRate]),
  )
  const assignment = workforce?.assignmentByEvent ?? {}
  const weekMs = isIsoDate(ts.weekOf) ? Date.parse(ts.weekOf) : NaN

  const seenIds = new Set<string>()
  ts.entries.forEach((raw, i) => {
    const ep = `${P}.entries[${i}]`
    if (!isObject(raw)) {
      errors.push(err(ep, "type", "entry must be an object"))
      return
    }
    if (typeof raw.id !== "string" || raw.id === "") {
      errors.push(err(`${ep}.id`, "type", "entry.id must be a non-empty string"))
    } else if (seenIds.has(raw.id)) {
      errors.push(err(`${ep}.id`, "unique", `duplicate entry id "${raw.id}"`))
    } else {
      seenIds.add(raw.id)
    }
    if (typeof raw.actor !== "string" || raw.actor === "") {
      errors.push(err(`${ep}.actor`, "type", "entry.actor must be a non-empty string"))
    }
    if (!isIsoDate(raw.date)) {
      errors.push(err(`${ep}.date`, "iso", "entry.date must be ISO date string"))
    } else if (Number.isFinite(weekMs)) {
      const delta = Math.abs(Date.parse(raw.date) - weekMs)
      if (delta > DATE_WINDOW_DAYS * DAY_MS) {
        errors.push(err(`${ep}.date`, "range", `entry.date must sit within ±${DATE_WINDOW_DAYS}d of weekOf`))
      }
    }
    if (typeof raw.eventId !== "string") {
      errors.push(err(`${ep}.eventId`, "type", "entry.eventId must be a string"))
    } else if (plan && !eventIds.has(raw.eventId)) {
      errors.push(err(`${ep}.eventId`, "ref", `entry references unknown event "${raw.eventId}"`))
    }
    if (
      typeof raw.hours !== "number" ||
      !Number.isFinite(raw.hours) ||
      raw.hours <= 0 ||
      raw.hours > 24
    ) {
      errors.push(err(`${ep}.hours`, "range", "entry.hours must be a number in (0, 24]"))
    }
    if (
      raw.note !== undefined &&
      raw.note !== null &&
      typeof raw.note !== "string"
    ) {
      errors.push(err(`${ep}.note`, "type", "entry.note must be a string"))
    }
    if (
      raw.status !== "draft" &&
      raw.status !== "submitted" &&
      raw.status !== "approved" &&
      raw.status !== "rejected"
    ) {
      errors.push(err(`${ep}.status`, "enum", 'entry.status must be draft | submitted | approved | rejected'))
    }
    // Crew-rate ref (advisory cross-check): an assigned event whose crew
    // is unknown to the supplied workforce fails loudly — the merge to
    // actuals would otherwise silently price it at zero.
    if (
      workforce &&
      typeof raw.eventId === "string" &&
      assignment[raw.eventId] !== undefined
    ) {
      const crewId = assignment[raw.eventId]?.crewId
      if (crewId !== undefined && !rateByCrew.has(crewId)) {
        errors.push(err(`${ep}.eventId`, "ref", `assigned crew "${crewId}" is unknown to the workforce`))
      }
    }
  })

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeTimesheetEntity,
    timesheet: ts as unknown as TimesheetPayload,
  }
}

export function buildTimesheetEntity(input: {
  id: string
  planEntityId: string
  planAnchor: string
  timesheet: TimesheetPayload
}): UmeTimesheetEntity {
  const now = new Date().toISOString()
  return {
    id: input.id,
    entityName: ENTITY_NAME_TIMESHEET,
    dynamicProperties: { timesheet: input.timesheet },
    lifecycle: {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    },
    relations: [
      {
        targetEntity: "GanttPlan",
        targetId: input.planEntityId,
        type: "many-to-one",
        context: `timesheet anchored to plan ${input.planEntityId} (anchor ${input.planAnchor})`,
      },
    ],
    // El ESTADO del envelope es umeJSON ("active"); los estados del parte
    // (draft/submitted/...) viven en cada ENTRY del payload.
    state: {
      current: "active",
      statusLog: [{ status: "active", timestamp: now, reason: "timesheet created" }],
    },
    markdownDocumentation:
      `# Parte de horas\n\nSemana ${input.timesheet.weekOf} del plan ${input.planEntityId}: ` +
      `${input.timesheet.entries.length} entrada(s).`,
  }
}
