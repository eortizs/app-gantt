// Demo GanttTimesheet (offline fallback): a handful of deterministic
// entries across two actors so the «Parte de horas» panel has material
// without a backend. Runtime-pure imports like every sibling builder.
import type { PlanJSON } from "../lib/plan-types.ts"
import { buildTimesheetEntity, type TimesheetPayload, type UmeTimesheetEntity } from "../lib/umejson/timesheet.ts"

const DAY_MS = 86_400_000

/** Monday 12:00 UTC of the week containing `now`. */
function mondayOf(now: Date): number {
  const day = now.getUTCDay()
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
  monday.setUTCHours(12, 0, 0, 0)
  return monday.getTime()
}

export function buildDemoTimesheet(
  plan: PlanJSON,
  planEntityId: string,
): UmeTimesheetEntity {
  const weekMs = mondayOf(new Date())
  const weekOf = new Date(weekMs).toISOString()
  const events = plan.events.filter((e) => e.kind !== "milestone")
  const pick = (i: number) => events[i % Math.max(events.length, 1)]?.id ?? ""
  const entries: TimesheetPayload["entries"] =
    events.length === 0
      ? []
      : [
          { id: "demo-ts-1", actor: "Residencia", date: new Date(weekMs).toISOString(), eventId: pick(0), hours: 8, status: "submitted" as const },
          { id: "demo-ts-2", actor: "Residencia", date: new Date(weekMs + DAY_MS).toISOString(), eventId: pick(1 % events.length), hours: 7.5, status: "draft" as const },
          { id: "demo-ts-3", actor: "Ing. Ríos", date: new Date(weekMs + DAY_MS).toISOString(), eventId: pick(2 % events.length), hours: 8, status: "submitted" as const },
        ]
  return buildTimesheetEntity({
    id: "00000000-0000-4000-8000-0000000000f1",
    planEntityId,
    planAnchor: plan.anchor,
    timesheet: { schemaVersion: 1, weekOf, entries },
  })
}
