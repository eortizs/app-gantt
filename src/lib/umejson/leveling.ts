// Resource leveling kernel: overallocation detection + delay-based
// leveling (no splitting, the MS Project "resource delay" variant).
//
// - Demand is computed per CREW per UTC day key; an event occupies only
//   its own calendar's WORKING days inside [start, end) (a milestone
//   occupies nothing). Every ms<->day step goes through working-time.ts —
//   zero ad-hoc conversion here.
// - levelPlan pushes one victim at a time PAST an overloaded run and lets
//   cascadeSchedule re-seat its dependents, so constraints stay respected
//   by construction. Candidates order by (priority desc, total float asc,
//   start asc): the most important, least-slack task keeps its slot.
// - Milestones are never victims, but they ride their chain when it moves.
// - Everything folds into plain UpdateOps (pure date patches), so undo,
//   CR impact and mergePatchExtras work without touching any contract.
//
// Runtime-pure like every module in this tree: relative `.ts` imports,
// no `@/` alias, loadable by verify + tsc + Node strip-types + Vite.
import type { PlanEvent, PlanJSON } from "../plan-types.ts"
import { applyOps, type UpdateOp } from "./codec.ts"
import { cpmSchedule } from "./cpm.ts"
import {
  cascadeSchedule,
  type ScheduleResolver,
} from "./schedule.ts"
import {
  DAY_MS,
  addWorkingDays,
  isWorkingDay,
  utcDayKey,
  workingDaysBetween,
  type WorkingCalendar,
} from "./working-time.ts"
import type { WorkforcePayload } from "./workforce.ts"

/** Default priority for events without an explicit one (middle of 1..1000). */
export const DEFAULT_PRIORITY = 500

const priorityOf = (e: PlanEvent): number => e.priority ?? DEFAULT_PRIORITY

/** UTC-midnight instant of the day key an instant falls on. */
const dayStartOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/** One event's occupied WORKING days as UTC day keys (milestones: none).
 *  The day count uses the SAME whole-day rounding as every other kernel
 *  (`workingDaysBetween`'s corrido base): a [Mon 12:00, Thu 12:00] task
 *  occupies Mon/Tue/Wed, never Thursday. */
function occupiedDays(e: PlanEvent, cal: WorkingCalendar | null): string[] {
  if (e.kind === "milestone") return []
  const startMs = Date.parse(e.start)
  const endMs = Date.parse(e.end)
  const spanDays = Math.round((endMs - startMs) / DAY_MS)
  if (!(spanDays > 0)) return []
  const keys: string[] = []
  const startDay = dayStartOf(startMs)
  const cap = 3660
  for (let i = 0; i < cap && i < spanDays; i++) {
    const dayMs = startDay + i * DAY_MS
    if (isWorkingDay(cal, dayMs)) keys.push(utcDayKey(dayMs))
  }
  return keys
}

/**
 * Demand curve: crew id → (utc day key → assigned headcount that day).
 * Only events WITH an assignment contribute; absent entry = 0 demand.
 * Exported for tests/fixtures.
 */
export function crewDemand(
  plan: PlanJSON,
  workforce: WorkforcePayload,
  resolve?: ScheduleResolver,
): Map<string, Map<string, number>> {
  const curve = new Map<string, Map<string, number>>()
  const eventById = new Map(plan.events.map((e) => [e.id, e]))
  for (const [eventId, assignment] of Object.entries(
    workforce.assignmentByEvent,
  )) {
    const ev = eventById.get(eventId)
    if (!ev) continue
    const days = occupiedDays(ev, resolve?.(eventId) ?? null)
    if (!days.length) continue
    let bucket = curve.get(assignment.crewId)
    if (!bucket) {
      bucket = new Map()
      curve.set(assignment.crewId, bucket)
    }
    for (const key of days) {
      bucket.set(key, (bucket.get(key) ?? 0) + assignment.headcount)
    }
  }
  return curve
}

/** One contiguous stretch of days where a crew's demand beats its size. */
export interface OverallocationRun {
  crewId: string
  /** First overloaded day, ISO (UTC midnight). */
  from: string
  /** Last overloaded day, ISO (UTC midnight). */
  to: string
  /** Max demand inside the run. */
  peak: number
  /** Σ over run days of (demand − headcount), in person-days. */
  excessPersonDays: number
}

interface OpenRun {
  fromMs: number
  toMs: number
  peak: number
  excess: number
}

/** Contiguous over-threshold runs across every crew, chronological. */
export function overallocations(
  plan: PlanJSON,
  workforce: WorkforcePayload,
  resolve?: ScheduleResolver,
): OverallocationRun[] {
  const headByCrew = new Map(workforce.crews.map((c) => [c.id, c.headcount]))
  const curve = crewDemand(plan, workforce, resolve)
  const runs: OverallocationRun[] = []
  for (const [crewId, bucket] of curve) {
    const headcount = headByCrew.get(crewId) ?? 0
    const days = [...bucket.entries()]
      .filter(([, demand]) => demand > headcount)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    let open: OpenRun | null = null
    for (const [key, demand] of days) {
      const ms = Date.parse(`${key}T00:00:00.000Z`)
      if (!Number.isFinite(ms)) continue
      const over = demand - headcount
      if (open && ms === open.toMs + DAY_MS) {
        open.toMs = ms
        open.peak = Math.max(open.peak, demand)
        open.excess += over
      } else {
        if (open) pushRun(runs, crewId, open)
        open = { fromMs: ms, toMs: ms, peak: demand, excess: over }
      }
    }
    if (open) pushRun(runs, crewId, open)
  }
  return runs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

function pushRun(runs: OverallocationRun[], crewId: string, open: OpenRun) {
  runs.push({
    crewId,
    from: new Date(open.fromMs).toISOString(),
    to: new Date(open.toMs).toISOString(),
    peak: open.peak,
    excessPersonDays: open.excess,
  })
}

/**
 * Per-event count of days the event worked while ITS crew was over
 * capacity — the heatmap value behind the «Sobrecarga» tree column.
 */
export function eventOverloadDays(
  plan: PlanJSON,
  workforce: WorkforcePayload,
  resolve?: ScheduleResolver,
): Map<string, number> {
  const headByCrew = new Map(workforce.crews.map((c) => [c.id, c.headcount]))
  const curve = crewDemand(plan, workforce, resolve)
  const out = new Map<string, number>()
  const eventById = new Map(plan.events.map((e) => [e.id, e]))
  for (const [eventId, assignment] of Object.entries(
    workforce.assignmentByEvent,
  )) {
    const ev = eventById.get(eventId)
    const bucket = curve.get(assignment.crewId)
    if (!ev || !bucket) continue
    const headcount = headByCrew.get(assignment.crewId) ?? 0
    let count = 0
    for (const key of occupiedDays(ev, resolve?.(eventId) ?? null)) {
      if ((bucket.get(key) ?? 0) > headcount) count++
    }
    if (count > 0) out.set(eventId, count)
  }
  return out
}

export interface LevelingOptions {
  resolve?: ScheduleResolver
  /** Fail-safe against oscillation. Default 500. */
  maxIterations?: number
}

export interface LevelingReport {
  movedEvents: number
  projectEndBefore: string | null
  projectEndAfter: string | null
  resolvedRuns: number
  unresolvedRuns: number
  iterations: number
}

export interface LevelingResult {
  ops: UpdateOp[]
  report: LevelingReport
}

const projectEndOf = (plan: PlanJSON): string | null => {
  let max: number | null = null
  for (const e of plan.events) {
    const end = Date.parse(e.end)
    if (max === null || end > max) max = end
  }
  return max === null ? null : new Date(max).toISOString()
}

/**
 * Levels the plan by delaying one victim past each overloaded run at a
 * time. Returns pure date UpdateOps: victims carry no cause (the leveling
 * decision is theirs), dependents moved by the re-seat carry the documented
 * cascade cause. Applying the returned ops reproduces exactly what the
 * kernel simulated.
 */
export function levelPlan(
  plan: PlanJSON,
  workforce: WorkforcePayload,
  opts: LevelingOptions = {},
): LevelingResult {
  const resolve = opts.resolve
  const maxIterations = opts.maxIterations ?? 500
  const projectEndBefore = projectEndOf(plan)

  // One op per event id, folded like the recorder does.
  const opsById = new Map<string, UpdateOp>()
  const current = (): PlanJSON => applyOps(plan, [...opsById.values()])
  const unresolved = new Set<string>()
  /**
   * MS-Project semantics: a task is leveled AT MOST ONCE. Without this,
   * a chain whose constraints re-create the overload keeps offering the
   * same high-priority victim forever — each push slides it further
   * (years!), every later CPM pass gets more expensive (floats count
   * whole days across the grown span), and the "bounded" iteration cap
   * turns into minutes of frozen main thread.
   */
  const leveledOnce = new Set<string>()
  const runKey = (crewId: string, fromIso: string): string =>
    `${crewId}|${fromIso}`
  let iterations = 0
  let resolvedRuns = 0
  let unresolvedRuns = 0

  while (iterations < maxIterations) {
    const cur = current()
    const pending = overallocations(cur, workforce, resolve).filter(
      (r) => !unresolved.has(runKey(r.crewId, r.from)),
    )
    if (!pending.length) break
    const run = pending[0]

    // Delay-based leveling can ONLY spread concurrent work: a task whose
    // OWN assignment already beats the crew's capacity stays over wherever
    // it goes, so such runs park as unresolvable instead of oscillating.
    const crewCapacity =
      workforce.crews.find((c) => c.id === run.crewId)?.headcount ??
      Number.POSITIVE_INFINITY

    // Candidates: events of THIS crew occupying an overloaded day of THIS
    // run, never milestones. Order: priority desc, float asc, start asc.
    const cpm = cpmSchedule(cur, resolve)
    const fromMs = Date.parse(run.from)
    const toEndMs = Date.parse(run.to) + DAY_MS
    const candidates = cur.events.filter((ev) => {
      if (ev.kind === "milestone") return false
      const a = workforce.assignmentByEvent[ev.id]
      if (!a || a.crewId !== run.crewId) return false
      const cal = resolve?.(ev.id) ?? null
      return occupiedDays(ev, cal).some((key) => {
        const kMs = Date.parse(`${key}T00:00:00.000Z`)
        return kMs >= fromMs && kMs < toEndMs
      })
    })
    candidates.sort((x, y) => {
      const p = priorityOf(y) - priorityOf(x)
      if (p !== 0) return p
      const fx = cpm.floatDays.get(x.id) ?? Number.POSITIVE_INFINITY
      const fy = cpm.floatDays.get(y.id) ?? Number.POSITIVE_INFINITY
      if (fx !== fy) return fx - fy
      return Date.parse(x.start) - Date.parse(y.start)
    })
    // A candidate is unusable when its own draw already beats capacity
    // (moving can never fit it) or when it has ALREADY been leveled once
    // in this pass (the anti-oscillation rule above).
    const usable = candidates.filter(
      (ev) =>
        !leveledOnce.has(ev.id) &&
        (workforce.assignmentByEvent[ev.id]?.headcount ?? 0) <= crewCapacity,
    )

    const victim = usable[0]
    if (!victim) {
      // Nobody can give way (all milestones, no assigned events left, or
      // every candidate alone exceeds capacity): park the run and look
      // elsewhere instead of looping forever.
      unresolved.add(runKey(run.crewId, run.from))
      unresolvedRuns++
      continue
    }

    // Push the victim's START to the first working day AFTER the run,
    // preserving its duration on its OWN calendar (working when there is
    // one; corrido otherwise) AND its time-of-day. Zero ad-hoc ms<->days
    // math beyond the day-key alignment itself.
    const cal = resolve?.(victim.id) ?? null
    const durDays = Math.max(
      1,
      workingDaysBetween(cal, Date.parse(victim.start), Date.parse(victim.end)),
    )
    const seatDayStartMs = addWorkingDays(cal, Date.parse(run.to) + DAY_MS, 0)
    const timeOfDayOffset =
      Date.parse(victim.start) - dayStartOf(Date.parse(victim.start))
    const seatMs = seatDayStartMs + timeOfDayOffset
    opsById.set(victim.id, {
      op: "update",
      id: victim.id,
      patch: {
        start: new Date(seatMs).toISOString(),
        end: new Date(addWorkingDays(cal, seatMs, durDays)).toISOString(),
      },
    })
    leveledOnce.add(victim.id)
    iterations++

    // Re-seat dependents forward-only; their adjustments fold into the op
    // set with their documented cascade cause.
    const adjustments = cascadeSchedule(current(), [victim.id], resolve)
    for (const adj of adjustments) {
      opsById.set(adj.eventId, {
        op: "update",
        id: adj.eventId,
        patch: { start: adj.start, end: adj.end },
        cause: adj.cause,
      })
    }

    if (
      !overallocations(current(), workforce, resolve).some(
        (r) => r.crewId === run.crewId && r.from === run.from,
      )
    ) {
      resolvedRuns++
    }
  }

  if (iterations >= maxIterations) {
    // Fail-safe exit: whatever still overloads counts as unresolved.
    for (const r of overallocations(current(), workforce, resolve)) {
      if (!unresolved.has(runKey(r.crewId, r.from))) unresolvedRuns++
    }
  }

  const ops = [...opsById.values()]
  return {
    ops,
    report: {
      movedEvents: new Set(ops.map((o) => o.id)).size,
      projectEndBefore,
      projectEndAfter: projectEndOf(applyOps(plan, ops)),
      resolvedRuns,
      unresolvedRuns,
      iterations,
    },
  }
}
