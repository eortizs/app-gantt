// GanttCalendar: the plan's working-time data as a sibling umeJSON
// entity — day-granularity laborable calendars (weekly pattern + per-date
// exceptions) plus which calendar each event runs on. The plan schema
// stays frozen at v2, so calendario data lives in its OWN document bound
// to the plan via relations[] (one calendar set per plan), same pattern as
// GanttBudget/GanttActuals/GanttWorkforce.
//
// A plan WITHOUT this sibling (or an event without override) stays
// corrido — every kernel treats a missing resolver as today's 86_400_000
// math byte-for-byte. Hours/shifts are schemaVersion 2 material.
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` and the backend
// imports it verbatim, same as every other contract module.
import type { CalendarAssignment, CalendarPayload, WorkingCalendar } from "./working-time.ts"
import type { PlanJSON } from "../plan-types.ts"
import {
  ENTITY_NAME,
  err,
  isObject,
  validateUmeEnvelope,
  type UmeJsonEntity,
  type UmeJsonLifecycle,
  type UmeJsonState,
  type ValidationError,
} from "./schema.ts"

export type { CalendarAssignment, CalendarPayload, WorkingCalendar }

export const ENTITY_NAME_CALENDAR = "GanttCalendar"
export const CALENDAR_SCHEMA_VERSION = 1

export interface UmeCalendarEntity {
  id: string
  entityName: typeof ENTITY_NAME_CALENDAR
  dynamicProperties: { calendar: CalendarPayload; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  markdownDocumentation: string
  relations?: UmeJsonEntity["relations"]
}

export type DecodeCalendarResult =
  | { ok: true; entity: UmeCalendarEntity; calendar: CalendarPayload }
  | { ok: false; errors: ValidationError[] }

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

const validateWorkingCalendar = (
  cal: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void => {
  if (typeof cal.id !== "string" || cal.id === "") {
    errors.push(err(`${path}.id`, "type", "calendar.id must be a non-empty string"))
  }
  if (typeof cal.title !== "string" || cal.title === "") {
    errors.push(err(`${path}.title`, "type", "calendar.title must be a non-empty string"))
  }
  if (
    !Array.isArray(cal.workWeek) ||
    cal.workWeek.length !== 7 ||
    !cal.workWeek.every((d) => typeof d === "boolean")
  ) {
    errors.push(err(`${path}.workWeek`, "type", "workWeek must be an array of exactly 7 booleans (index = getDay)"))
  } else if (!cal.workWeek.some((d) => d === true)) {
    // A calendar that never works would hang addWorkingDays forever.
    errors.push(err(`${path}.workWeek`, "range", "workWeek must mark at least one weekday as working"))
  }
  if (cal.exceptions !== undefined && !isObject(cal.exceptions)) {
    errors.push(err(`${path}.exceptions`, "type", "exceptions must be an object keyed by yyyy-MM-dd"))
  } else if (isObject(cal.exceptions)) {
    for (const [key, value] of Object.entries(cal.exceptions)) {
      const ep = `${path}.exceptions["${key}"]`
      if (!DATE_KEY_RE.test(key) || !Number.isFinite(Date.parse(key))) {
        errors.push(err(ep, "iso", `exception key "${key}" must be a valid yyyy-MM-dd date`))
      }
      if (typeof value !== "boolean") {
        errors.push(err(ep, "type", "exception value must be a boolean (true = worked, false = closed)"))
      }
    }
  }
}

/**
 * Hand-rolled validator in the decodeWorkforce style: envelope via the
 * shared helper, payload (calendars with unique ids, default exists,
 * assignments referencing existing calendars), and — when the plan is
 * supplied — that every assigned event exists and the relation points at
 * that plan.
 *
 * Validation tier asymmetry: the registerEntity GET handler in the server
 * calls this WITHOUT a plan (the sibling route is unaware of the plan
 * row), so the binding checks (`assignmentByEvent` events + relation
 * target) are only run when an explicit plan is supplied — e.g. the
 * change-request buildImpactSnapshot path, where the sibling is decoded
 * together with its plan.
 */
export function decodeCalendar(
  input: unknown,
  plan?: PlanJSON,
  planEntityId?: string,
): DecodeCalendarResult {
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }
  const errors = validateUmeEnvelope(input, ENTITY_NAME_CALENDAR)

  const calendar = isObject(input.dynamicProperties)
    ? input.dynamicProperties.calendar
    : undefined
  const P = "dynamicProperties.calendar"
  let calendarIds: Set<string> | null = null
  if (!isObject(calendar)) {
    errors.push(err(P, "type", "calendar must be an object"))
  } else {
    if (calendar.schemaVersion !== CALENDAR_SCHEMA_VERSION) {
      errors.push(err(`${P}.schemaVersion`, "enum", `schemaVersion must be ${CALENDAR_SCHEMA_VERSION}`))
    }
    if (!Array.isArray(calendar.calendars)) {
      errors.push(err(`${P}.calendars`, "type", "calendars must be an array"))
    } else {
      calendarIds = new Set<string>()
      calendar.calendars.forEach((cal: unknown, i: number) => {
        const cp = `${P}.calendars[${i}]`
        if (!isObject(cal)) {
          errors.push(err(cp, "type", "calendar entry must be an object"))
          return
        }
        if (typeof cal.id !== "string" || cal.id === "") {
          errors.push(err(`${cp}.id`, "type", "calendar.id must be a non-empty string"))
        } else if (calendarIds!.has(cal.id)) {
          errors.push(err(`${cp}.id`, "unique", `duplicate calendar id "${cal.id}"`))
        } else {
          calendarIds!.add(cal.id)
        }
        validateWorkingCalendar(cal, cp, errors)
      })
    }
    if (calendar.defaultCalendarId !== undefined) {
      if (typeof calendar.defaultCalendarId !== "string" || calendar.defaultCalendarId === "") {
        errors.push(err(`${P}.defaultCalendarId`, "type", "defaultCalendarId must be a non-empty string when present"))
      } else if (calendarIds && !calendarIds.has(calendar.defaultCalendarId)) {
        errors.push(err(`${P}.defaultCalendarId`, "ref", `default calendar "${calendar.defaultCalendarId}" does not exist`))
      }
    }
    if (calendar.assignmentByEvent !== undefined && !isObject(calendar.assignmentByEvent)) {
      errors.push(err(`${P}.assignmentByEvent`, "type", "assignmentByEvent must be an object"))
    } else if (isObject(calendar.assignmentByEvent) && calendarIds) {
      for (const [eventId, assignment] of Object.entries(calendar.assignmentByEvent)) {
        const ap = `${P}.assignmentByEvent["${eventId}"]`
        if (!isObject(assignment)) {
          errors.push(err(ap, "type", "assignment must be an object"))
          continue
        }
        const { calendarId } = assignment as { calendarId?: unknown }
        if (typeof calendarId !== "string" || !calendarIds.has(calendarId)) {
          errors.push(err(`${ap}.calendarId`, "ref", `assignment references unknown calendar "${String(calendarId)}"`))
        }
      }
    }
  }

  // Binding: relations[0] must point at a GanttPlan; when the plan is
  // supplied, at THAT plan.
  if (input.relations !== undefined) {
    if (!Array.isArray(input.relations) || input.relations.length !== 1) {
      errors.push(err("relations", "type", "a calendar document carries exactly one relation (to its plan)"))
    } else {
      const rel = input.relations[0]
      if (!isObject(rel) || rel.targetEntity !== ENTITY_NAME) {
        errors.push(err("relations[0].targetEntity", "enum", `relation targetEntity must be "${ENTITY_NAME}"`))
      }
      if (!isObject(rel) || typeof rel.targetId !== "string" || rel.targetId === "") {
        errors.push(err("relations[0].targetId", "type", "relation targetId must be a non-empty string"))
      } else if (planEntityId !== undefined && rel.targetId !== planEntityId) {
        errors.push(err("relations[0].targetId", "ref", `calendars relate to plan "${rel.targetId}" but the supplied plan entity is "${planEntityId}"`))
      }
    }
  }

  if (plan && isObject(calendar) && isObject(calendar.assignmentByEvent)) {
    const known = new Set(plan.events.map((e) => e.id))
    for (const eventId of Object.keys(calendar.assignmentByEvent)) {
      if (!known.has(eventId)) {
        errors.push(err(`${P}.assignmentByEvent["${eventId}"]`, "ref", `assigned event "${eventId}" is not an event of the supplied plan`))
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeCalendarEntity,
    calendar: calendar as unknown as CalendarPayload,
  }
}

/** Envelope builder for programmatic construction (demo/seed). */
export function buildCalendarEntity(input: {
  id: string
  planEntityId: string
  planAnchor: string
  calendar: CalendarPayload
  markdownDocumentation?: string
}): UmeCalendarEntity {
  const now = new Date().toISOString()
  return {
    id: input.id,
    entityName: ENTITY_NAME_CALENDAR,
    dynamicProperties: { calendar: input.calendar },
    lifecycle: { createdAt: now, updatedAt: now, deletedAt: null, version: 1 },
    state: {
      current: "active",
      statusLog: [{ status: "active", timestamp: now, reason: "calendar created" }],
    },
    markdownDocumentation:
      input.markdownDocumentation ??
      `# Calendario laboral\n\nDías laborables del plan ${input.planEntityId} (ancla ${input.planAnchor}): ${input.calendar.calendars.length} calendario(s), granularidad día laborable.`,
    relations: [{
      targetEntity: ENTITY_NAME,
      targetId: input.planEntityId,
      type: "one-to-one",
      context: "calendar-for",
    }],
  }
}
