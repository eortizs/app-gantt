// Demo GanttCalendar for the demo plan: ONE obra calendar, lunes a viernes,
// plus synthetic holidays at FIXED corrido offsets from the plan's anchor
// (Fridays, so each one reads as a puente: the Thursday bar jumps to
// Monday). Deterministic despite the mobile anchor — the offsets travel
// with it. Shared by the App fallback and the backend seed, same spirit as
// demo-contables. Runtime-pure imports (relative `.ts`) so
// server/scripts/seed.ts can load this under node.
import {
  DAY_MS,
  utcDayKey,
  type CalendarPayload,
} from "../lib/umejson/working-time.ts"
import {
  buildCalendarEntity,
  type UmeCalendarEntity,
} from "../lib/umejson/calendar.ts"
import type { PlanJSON } from "../lib/plan-types.ts"

export const DEMO_CALENDAR_ID = "00000000-0000-4000-8000-000000000005"
export const DEMO_CALENDAR_KEY = "cal-obra"

/** Lun–Vie, indexed by getUTCDay(): [dom, lun, mar, mié, jue, vie, sáb]. */
export const DEMO_WORK_WEEK: readonly boolean[] = [
  false,
  true,
  true,
  true,
  true,
  true,
  false,
]

/**
 * Synthetic feriados, corrido offsets from the anchor. The anchor is a
 * Monday, so these land on Fridays — three long weekends across the demo
 * horizon where the working-time kernels visibly skip a day. Keys via
 * `utcDayKey` (canonical UTC-day derivation in working-time.ts) so this
 * module never reimplements the boundary rule.
 */
const HOLIDAY_OFFSETS: readonly number[] = [11, 25, 39]

/**
 * The demo payload, anchored to the plan's own anchor instant. BOTH the
 * plan generator (plan-departamento seats its dates with this same
 * payload) and the sibling document build from here, so what the API
 * serves and what generated the geometry can never disagree.
 */
export function buildDemoCalendarPayload(anchorMs: number): CalendarPayload {
  const exceptions: Record<string, boolean> = {}
  for (const offset of HOLIDAY_OFFSETS) {
    exceptions[utcDayKey(anchorMs + offset * DAY_MS)] = false
  }
  return {
    schemaVersion: 1,
    calendars: [
      {
        id: DEMO_CALENDAR_KEY,
        title: "Obra Mérida (lun–vie)",
        workWeek: DEMO_WORK_WEEK,
        exceptions,
      },
    ],
    defaultCalendarId: DEMO_CALENDAR_KEY,
  }
}

export function buildDemoCalendar(
  plan: PlanJSON,
  planEntityId: string,
): UmeCalendarEntity {
  const anchorMs = Date.parse(plan.anchor)
  return buildCalendarEntity({
    id: DEMO_CALENDAR_ID,
    planEntityId,
    planAnchor: plan.anchor,
    calendar: buildDemoCalendarPayload(anchorMs),
  })
}
