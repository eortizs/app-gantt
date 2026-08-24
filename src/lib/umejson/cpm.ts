// Critical Path Method over the plan's dependency graph. Runtime-pure
// (relative `.ts` imports, no `@/` alias) so `pnpm verify` loads it under
// `node --experimental-strip-types` and the backend can import it
// verbatim, same as every other contract module.
//
// Conventions (documented, deliberate):
// - CALENDAR days: the plan carries no working calendar (a schema v3
//   decision), so durations, lags and floats count every day.
// - Forward pass: an event's ES is the LATEST of its own planned start
//   and every instant its constraints demand (`earliestStart`, shared
//   with the cascade) — an as-planned CPM. A constraint violated by the
//   schedule pushes ES past the planned date; slack the scheduler banked
//   by starting later than the network demands is NOT float (the bar
//   cannot slip from where it actually sits without consequences).
// - Backward pass: LF defaults to the project finish (max EF) and is
//   tightened by each outgoing edge; LS = LF − duration (preserved).
// - Total float = LS − ES, rounded to whole days with the same rule the
//   bitácora panel uses; the critical set is float === 0. An isolated
//   event is its own critical path.
// - Cycles cannot occur (the decoder rejects them); nodes left out of the
//   topological order are processed defensively with their planned dates.
import type { PlanDependency, PlanJSON } from "../plan-types.ts"
import { earliestStart } from "./schedule.ts"

const DAY_MS = 86_400_000

export interface CpmResult {
  /** Earliest start instants (ms) by event id. */
  es: Map<string, number>
  /** Earliest finish instants (ms) by event id. */
  ef: Map<string, number>
  /** Latest start instants (ms) by event id. */
  ls: Map<string, number>
  /** Latest finish instants (ms) by event id. */
  lf: Map<string, number>
  /** Total float in whole calendar days (LS − ES). */
  floatDays: Map<string, number>
  /** Events with zero total float — the critical set. */
  critical: Set<string>
  /** Project finish = max EF; null on a plan with no events. */
  projectEnd: number | null
}

const lagMs = (dep: PlanDependency): number => (dep.lagDays ?? 0) * DAY_MS

export function cpmSchedule(plan: PlanJSON): CpmResult {
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
      const bound = earliestStart(predEs, predEf, dur, dep.type, lagMs(dep))
      if (bound > earliest) earliest = bound
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
      const lag = lagMs(dep)
      // FS/FF bound the predecessor's finish; SS/SF bound its start (which
      // caps the finish at bound + duration). Successors outside the
      // topological order (cycle members) carry no final dates yet, so
      // their bounds are skipped rather than defaulted.
      if (dep.type === "FS") {
        const succLs = ls.get(dep.toEventId)
        if (succLs !== undefined && succLs - lag < latestFinish) latestFinish = succLs - lag
      } else if (dep.type === "FF") {
        const succLf = lf.get(dep.toEventId)
        if (succLf !== undefined && succLf - lag < latestFinish) latestFinish = succLf - lag
      } else {
        const succBound =
          dep.type === "SS" ? ls.get(dep.toEventId) : lf.get(dep.toEventId)
        if (succBound !== undefined && succBound - lag + dur < latestFinish) {
          latestFinish = succBound - lag + dur
        }
      }
    }
    lf.set(id, latestFinish)
    ls.set(id, latestFinish - dur)
  }

  const floatDays = new Map<string, number>()
  const critical = new Set<string>()
  for (const id of order) {
    const float = Math.round((ls.get(id)! - es.get(id)!) / DAY_MS)
    floatDays.set(id, float)
    if (float === 0) critical.add(id)
  }

  return { es, ef, ls, lf, floatDays, critical, projectEnd }
}
