// Working-time arithmetic: day-granularity laborable calendars over the
// plan's corrido instants. The contract with the rest of the module tree:
//
// - A `WorkingCalendar | null` rides EVERY kernel as an optional argument.
//   null means "corrido" and reproduces today's 86_400_000 math BYTE FOR
//   BYTE — that is the regression net: `pnpm verify` passes untouched in
//   null mode. No ad-hoc ms↔days conversion is allowed anywhere else; all
//   of it lives here.
// - Granularity v1 is the WORKING DAY: each working day counts 1, so
//   durations and lags stay whole days. Hours/shifts are a v2 decision of
//   the calendar sibling, out of scope.
// - Days resolve on UTC (the plan stores every instant at one fixed
//   time-of-day offset from its anchor, so UTC day indices are stable and
//   DST-immune). `workWeek` is indexed by getUTCDay(): 0 = domingo …
//   6 = sábado; `exceptions` override per yyyy-MM-dd date (feriado = false,
//   worked rest day = true).
// - On a link, lag counts WORKING days of the SUCCESSOR's calendar (the MS
//   Project convention); resolution order for an event is assignment →
//   default → null (corrido).
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// loads it under `node --experimental-strip-types` and the backend imports
// it verbatim, same as every other contract module.

export const DAY_MS = 86_400_000

/** Day-granularity laborable calendar (schema v1 of the GanttCalendar sibling). */
export interface WorkingCalendar {
  id: string
  title: string
  /** Index = getUTCDay(): [domingo, lunes, … sábado]. Exactly 7 entries. */
  workWeek: readonly boolean[]
  /** yyyy-MM-dd → working override (false = feriado, true = día trabajado). */
  exceptions: Record<string, boolean>
}

/** Event id → calendar binding (the workforce-assignment pattern). */
export interface CalendarAssignment {
  calendarId: string
}

/** Payload of the GanttCalendar sibling entity. */
export interface CalendarPayload {
  schemaVersion: 1
  calendars: WorkingCalendar[]
  /** Events without an explicit assignment fall back to this calendar. */
  defaultCalendarId?: string
  /** Per-event overrides. Events absent carry no entry. */
  assignmentByEvent?: Record<string, CalendarAssignment>
}

/** `(eventId) => WorkingCalendar | null` — null = corrido for that event. */
export type CalendarResolver = (eventId: string) => WorkingCalendar | null

/** The plan's own anchor instant, used only by demo/seed builders. */
/** The canonical yyyy-MM-dd key of an instant, derived from its UTC day.
 *  Exported so siblings of the calendar module (demo builders, tests) can
 *  stamp identical keys without re-implementing the slice — this is the
 *  ONLY place that knows "the day boundary is UTC". */
export const utcDayKey = (instantMs: number): string =>
  new Date(instantMs).toISOString().slice(0, 10)

const weekdayOf = (instantMs: number): number =>
  new Date(instantMs).getUTCDay()

/**
 * Does `instantMs` fall on a working day under `cal`? null cal = corrido =
 * every day works. The per-date exception wins over the weekly pattern.
 */
export function isWorkingDay(
  cal: WorkingCalendar | null,
  instantMs: number,
): boolean {
  if (!cal) return true
  const exception = cal.exceptions[utcDayKey(instantMs)]
  if (exception !== undefined) return exception
  return cal.workWeek[weekdayOf(instantMs)] === true
}

/**
 * Moves `instantMs` by `n` WORKING days (signed), keeping the time-of-day.
 * n = 0 seats forward onto the next working day when the instant itself
 * falls on an off day (the seating convention — a task may never START on
 * a non-working day); a working instant passes through unchanged.
 * null cal = corrido: exactly `instant + n × DAY_MS`.
 */
export function addWorkingDays(
  cal: WorkingCalendar | null,
  instantMs: number,
  n: number,
): number {
  if (!cal) return instantMs + n * DAY_MS
  // Defensive cap (~10 years of steps): a degenerate calendar that never
  // works any day must not hang the cascade. The decoder rejects such
  // calendars; this keeps the pure helpers total anyway.
  const cap = 3660
  let cursor = instantMs
  if (n === 0) {
    for (let i = 0; i < cap && !isWorkingDay(cal, cursor); i++) {
      cursor += DAY_MS
    }
    return cursor
  }
  const step = n > 0 ? DAY_MS : -DAY_MS
  let remaining = Math.abs(n)
  for (let i = 0; i < cap && remaining > 0; i++) {
    cursor += step
    if (isWorkingDay(cal, cursor)) remaining--
  }
  return cursor
}

/**
 * Signed count of WORKING days between two instants (positive = b later),
 * half-day rounding identical to `driftDays`: the raw difference rounds to
 * whole days FIRST, then each of those day-steps counts only when it lands
 * on a working day. Thu→Fri = 1; Thu→Mon (over the weekend) = 2 — both
 * lost working days. null cal = `Math.round((b − a) / DAY_MS)`, byte-equal
 * to the corrido rounding every caller used before.
 */
export function workingDaysBetween(
  cal: WorkingCalendar | null,
  a: number,
  b: number,
): number {
  if (!cal) return Math.round((b - a) / DAY_MS)
  const whole = Math.round((b - a) / DAY_MS)
  if (whole === 0) return 0
  const dir = whole > 0 ? 1 : -1
  let count = 0
  let cursor = a
  for (let i = 0; i < Math.abs(whole); i++) {
    cursor += dir * DAY_MS
    if (isWorkingDay(cal, cursor)) count++
  }
  return dir * count
}

/**
 * Resolution chain for one event's effective calendar:
 * `assignmentByEvent[eventId] ?? defaultCalendarId ?? null`. Unknown ids
 * degrade to null (corrido) rather than throwing — the decoder rejects
 * dangling refs at the border, so runtime misses are already malformed
 * inputs and honest corrido math beats a crash mid-cascade.
 */
export function buildResolver(
  payload: CalendarPayload,
): CalendarResolver {
  const byId = new Map(payload.calendars.map((c) => [c.id, c]))
  const assignment = payload.assignmentByEvent ?? {}
  return (eventId) => {
    const assigned = assignment[eventId]?.calendarId
    if (assigned !== undefined) return byId.get(assigned) ?? null
    if (payload.defaultCalendarId !== undefined) {
      return byId.get(payload.defaultCalendarId) ?? null
    }
    return null
  }
}
