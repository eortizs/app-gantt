// Critical Path Method over the plan's dependency graph. Runtime-pure
// (relative `.ts` imports, no `@/` alias) so `pnpm verify` loads it under
// `node --experimental-strip-types` and the backend can import it
// verbatim, same as every other contract module.
//
// Conventions (documented, deliberate):
// - WORKING days when a resolver is supplied, corrido when not (byte-equal
//   to the pre-calendar math). Each edge's lag runs on the SUCCESSOR's
//   calendar (`earliestStart` shares the seat with the cascade); an
//   event's own durations and floats count its OWN calendar's working
//   days.
// - Forward pass: an event's ES is the LATEST of its own planned start
//   and every instant its constraints demand (`earliestStart`, shared
//   with the cascade) — an as-planned CPM. A constraint violated by the
//   schedule pushes ES past the planned date; slack the scheduler banked
//   by starting later than the network demands is NOT float (the bar
//   cannot slip from where it actually sits without consequences).
// - Backward pass: LF defaults to the project finish (max EF) and is
//   tightened by each outgoing edge (the seat mirrored backwards with a
//   negative `addWorkingDays`); LS = LF − duration (preserved).
// - Total float = LS − ES counted in the event's own working days, with
//   the same rounding rule the bitácora panel uses; the critical set is
//   float === 0. An isolated event is its own critical path.
// - FREE float = the tightest bound the outgoing edges impose on THIS
//   event's finish minus its EF (0 when nothing binds it and the project
//   finish is unknown; clamped at 0 — out-of-sequence live dates never
//   read as negative slack).
// - Status-date conventions ride ON THE PLAN (`statusDate` +
//   `schedulingOptions.outOfSequence`), mirroring cascadeSchedule: under
//   progress override, work NOT yet started floors its ES at the cutoff,
//   while frozen actuals (progress > 0 started before it) keep their
//   planned instants. Without a status date the pass is byte-equal to the
//   classic behavior.
// - Cycles cannot occur (the decoder rejects them); nodes left out of the
//   topological order are processed defensively with their planned dates.
import type { PlanDependency, PlanJSON } from "../plan-types.ts"
import { earliestStart } from "./schedule.ts"
import { addWorkingDays, workingDaysBetween, type WorkingCalendar } from "./working-time.ts"

export interface CpmResult {
  /** Earliest start instants (ms) by event id. */
  es: Map<string, number>
  /** Earliest finish instants (ms) by event id. */
  ef: Map<string, number>
  /** Latest start instants (ms) by event id. */
  ls: Map<string, number>
  /** Latest finish instants (ms) by event id. */
  lf: Map<string, number>
  /** Total float in whole working days (LS − ES; corrido without calendar). */
  floatDays: Map<string, number>
  /**
   * Free float in whole working days: the tightest bound the outgoing
   * edges impose on this event's finish minus EF; without successors the
   * project finish stands in. Clamped at 0.
   */
  freeFloatDays: Map<string, number>
  /** Events with zero total float — the critical set. */
  critical: Set<string>
  /** Project finish = max EF; null on a plan with no events. */
  projectEnd: number | null
}

/** Optional per-event calendar source (null-endowed = corrido). Same
 *  structural type as CalendarResolver — kept here only as documentation;
 *  callers pass CalendarResolver (cpmSchedule accepts it structurally). */
type CpmResolver = (eventId: string) => WorkingCalendar | null

export function cpmSchedule(plan: PlanJSON, resolve?: CpmResolver): CpmResult {
  const events = new Map(plan.events.map((e) => [e.id, e]))
  const deps = (plan.dependencies ?? []).filter(
    (d) => events.has(d.fromEventId) && events.has(d.toEventId),
  )

  const predsOf = new Map<string, PlanDependency[]>()
  const succsOf = new Map<string, PlanDependency[]>()
  const indegree = new Map<string, number>()
  for (const dep of deps) {
    const preds = predsOf.get(dep.toEventId)
    if (preds) preds.push(dep)
    else predsOf.set(dep.toEventId, [dep])
    const succs = succsOf.get(dep.fromEventId)
    if (succs) succs.push(dep)
    else succsOf.set(dep.fromEventId, [dep])
    indegree.set(dep.toEventId, (indegree.get(dep.toEventId) ?? 0) + 1)
    if (!indegree.has(dep.fromEventId)) indegree.set(dep.fromEventId, 0)
  }

  // Kahn topological order (same shape as cascadeSchedule).
  const queue: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id)
  const order: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    order.push(id)
    for (const dep of succsOf.get(id) ?? []) {
      const next = (indegree.get(dep.toEventId) ?? 0) - 1
      indegree.set(dep.toEventId, next)
      if (next === 0) queue.push(dep.toEventId)
    }
  }
  // Cycle members (impossible post-decode) still get a result: planned
  // dates forward, project-end backward.
  const ordered = new Set(order)
  for (const id of events.keys()) if (!ordered.has(id)) order.push(id)

  const startOf = new Map<string, number>()
  const durOf = new Map<string, number>()
  for (const e of plan.events) {
    const s = Date.parse(e.start)
    startOf.set(e.id, s)
    durOf.set(e.id, Math.max(Date.parse(e.end) - s, 0))
  }

  // Forward pass.
  const statusMs = plan.statusDate ? Date.parse(plan.statusDate) : null
  const overrideMode =
    plan.schedulingOptions?.outOfSequence === "progressOverride"
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  for (const id of order) {
    const planned = startOf.get(id)!
    const dur = durOf.get(id)!
    let earliest = planned
    for (const dep of predsOf.get(id) ?? []) {
      // Predecessors are final in topo order; the fallback to their
      // planned dates only fires for cycle members (defensive).
      const predEs = es.get(dep.fromEventId) ?? startOf.get(dep.fromEventId)!
      const predEf = ef.get(dep.fromEventId) ?? predEs + durOf.get(dep.fromEventId)!
      // The edge's lag and seat run on the successor's (this event's) calendar.
      const bound = earliestStart(
        predEs,
        predEf,
        dur,
        dep.type,
        dep.lagDays ?? 0,
        resolve?.(id) ?? null,
      )
      if (bound > earliest) earliest = bound
    }
    // PROGRESS OVERRIDE: unstarted work cannot begin before the cutoff;
    // frozen actuals (started before it, carrying progress) keep their
    // planned instant — their ES IS history.
    if (overrideMode && statusMs !== null && earliest < statusMs) {
      const ev = events.get(id)
      const frozen =
        ev !== undefined && (ev.progress ?? 0) > 0 && planned < statusMs
      if (!frozen) earliest = statusMs
    }
    es.set(id, earliest)
    ef.set(id, earliest + dur)
  }

  let projectEnd: number | null = null
  for (const finish of ef.values()) {
    if (projectEnd === null || finish > projectEnd) projectEnd = finish
  }

  // Backward pass, reverse topological order: successors are final.
  const ls = new Map<string, number>()
  const lf = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!
    const dur = durOf.get(id)!
    // FS/FF bound the predecessor's finish; SS/SF bound its start (which
    // caps the finish at bound + duration). The project finish caps all.
    let latestFinish = projectEnd ?? startOf.get(id)! + dur
    for (const dep of succsOf.get(id) ?? []) {
      // The forward seat mirrored backwards: the successor's calendar
      // owns the lag in both directions (negative working-day move).
      // Successors outside the topological order (cycle members) carry
      // no final dates yet, so their bounds are skipped.
      const succCal = resolve?.(dep.toEventId) ?? null
      const lag = dep.lagDays ?? 0
      if (dep.type === "FS") {
        const succLs = ls.get(dep.toEventId)
        if (succLs !== undefined) {
          const bound = addWorkingDays(succCal, succLs, -lag)
          if (bound < latestFinish) latestFinish = bound
        }
      } else if (dep.type === "FF") {
        const succLf = lf.get(dep.toEventId)
        if (succLf !== undefined) {
          const bound = addWorkingDays(succCal, succLf, -lag)
          if (bound < latestFinish) latestFinish = bound
        }
      } else {
        const succBound =
          dep.type === "SS" ? ls.get(dep.toEventId) : lf.get(dep.toEventId)
        if (succBound !== undefined) {
          const bound = addWorkingDays(succCal, succBound, -lag) + dur
          if (bound < latestFinish) latestFinish = bound
        }
      }
    }
    lf.set(id, latestFinish)
    ls.set(id, latestFinish - dur)
  }

  const floatDays = new Map<string, number>()
  const critical = new Set<string>()
  for (const id of order) {
    // Float counts the event's OWN working days (corrido without calendar).
    const float = workingDaysBetween(resolve?.(id) ?? null, es.get(id)!, ls.get(id)!)
    floatDays.set(id, float)
    if (float === 0) critical.add(id)
  }

  // Free float: how far THIS event can slip without pushing any successor
  // past ITS latest dates. Every edge type reduces to one slack number
  // against THIS event's EF: (the successor's LATEST date at the end the
  // edge constrains) − lag − myEF, where FS/SS constrain the successor's
  // START (succ.LS) and FF/SF its FINISH (succ.LF). Successor LS/LF are
  // final here (backward pass ran first). Without successors the project
  // finish stands in; clamped at 0, counted on the event's own calendar.
  const freeFloatDays = new Map<string, number>()
  for (const id of order) {
    const myEf = ef.get(id)!
    let free: number | null = null
    for (const dep of succsOf.get(id) ?? []) {
      const succLs = ls.get(dep.toEventId)
      const succLf = lf.get(dep.toEventId)
      if (succLs === undefined || succLf === undefined) continue
      const succBound =
        dep.type === "FS" || dep.type === "SS" ? succLs : succLf
      const slack = succBound - (dep.lagDays ?? 0) - myEf
      if (free === null || slack < free) free = slack
    }
    if (free === null && projectEnd !== null) free = projectEnd - myEf
    const clampedMs = myEf + Math.max(free ?? 0, 0)
    freeFloatDays.set(
      id,
      workingDaysBetween(resolve?.(id) ?? null, myEf, clampedMs),
    )
  }

  return { es, ef, ls, lf, floatDays, freeFloatDays, critical, projectEnd }
}
