// Dependency-aware cascade scheduling. Runtime-pure (relative `.ts`
// imports, no `@/` alias) so `pnpm verify` can load it under
// `node --experimental-strip-types` alongside the codec.
//
// The rule of the house: a cascade only ever pushes FORWARD. A successor
// starts no earlier than its constraints demand; when a predecessor moves
// earlier the successor stays put - pulling work back is a human decision,
// never a side effect. Every produced adjustment documents its own cause so
// the changeset can carry provenance for each rewritten date.
import type { DependencyType, PlanDependency, PlanJSON } from "../plan-types.ts"

export interface DependencyCause {
  kind: "dependency-cascade"
  /** Predecessor whose constraint bound this event's new position. */
  sourceEventId: string
  type: DependencyType
  /** Whole calendar days the event was pushed forward by this cascade. */
  shiftDays: number
}

export interface ScheduleAdjustment {
  eventId: string
  start: string
  end: string
  cause: DependencyCause
}

const DAY_MS = 86_400_000

const lagMs = (dep: PlanDependency): number => (dep.lagDays ?? 0) * DAY_MS

/**
 * Earliest instant the successor's `start` may sit at, given the
 * predecessor's current range and the constraint type. FS/SS bound the
 * start directly; FF/SF bound the END, so the start backs off by the
 * successor's preserved duration.
 */
function earliestStart(
  predStartMs: number,
  predEndMs: number,
  succDurationMs: number,
  type: DependencyType,
  lag: number,
): number {
  switch (type) {
    case "SS":
      return predStartMs + lag
    case "FF":
      return predEndMs + lag - succDurationMs
    case "SF":
      return predStartMs + lag - succDurationMs
    case "FS":
    default:
      return predEndMs + lag
  }
}

/**
 * Push every transitive dependent forward so no constraint is violated.
 * `seedIds` are events whose dates just changed (a drag, an edit); their
 * CURRENT dates must already be in `plan`. Returns one adjustment per
 * moved event, empty when nothing is violated. Events not reachable from
 * the seeds are never touched; cycles (which the decoder rejects anyway)
 * are skipped, not followed forever.
 */
export function cascadeSchedule(
  plan: PlanJSON,
  seedIds: readonly string[],
): ScheduleAdjustment[] {
  const events = new Map(plan.events.map((e) => [e.id, e]))
  const deps = (plan.dependencies ?? []).filter(
    (d) => events.has(d.fromEventId) && events.has(d.toEventId),
  )
  if (!deps.length || !seedIds.length) return []

  // Predecessor lists + Kahn indegrees over ALL events touched by deps.
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

  // Topological order (Kahn). Leftover nodes are cycle members: dropped.
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

  // Forward pass in topo order: a node is evaluated once its predecessors
  // are final. Only seeds and pushed nodes participate; everything else
  // keeps its stored dates untouched.
  const seedSet = new Set(seedIds)
  const dirty = new Set<string>(seedIds)
  const adjustments: ScheduleAdjustment[] = []
  for (const id of order) {
    if (!dirty.has(id)) continue
    const event = events.get(id)
    if (!event) continue
    const startMs = Date.parse(event.start)
    const durationMs = Math.max(Date.parse(event.end) - startMs, 0)
    let bestMs = startMs
    let cause: { dep: PlanDependency; boundMs: number } | null = null
    for (const dep of predsOf.get(id) ?? []) {
      const pred = events.get(dep.fromEventId)
      if (!pred) continue
      const boundMs = earliestStart(
        Date.parse(pred.start),
        Date.parse(pred.end),
        durationMs,
        dep.type,
        lagMs(dep),
      )
      // The BINDING predecessor is the one demanding the latest start;
      // it owns the documented cause.
      if (boundMs > bestMs) {
        bestMs = boundMs
        cause = { dep, boundMs }
      }
    }
    let moved = false
    if (cause && bestMs > startMs) {
      const nextStart = new Date(bestMs)
      const nextEnd = new Date(Math.max(bestMs + durationMs, bestMs))
      const shifted: PlanJSON["events"][number] = {
        ...event,
        start: nextStart.toISOString(),
        end: nextEnd.toISOString(),
      }
      events.set(id, shifted)
      moved = true
      adjustments.push({
        eventId: id,
        start: shifted.start,
        end: shifted.end,
        cause: {
          kind: "dependency-cascade",
          sourceEventId: cause.dep.fromEventId,
          type: cause.dep.type,
          shiftDays: Math.round((bestMs - startMs) / DAY_MS),
        },
      })
    }
    // Successors are re-evaluated whenever this node's dates are NEW to
    // this pass: because it just shifted here, or because it is a SEED -
    // a seed moved OUTSIDE the pass (the committed drag), so without this
    // its dependents would never be examined and the cascade would die at
    // the first link. Evaluated-but-unmoved nodes propagate nothing: their
    // dates are unchanged, so no NEW violation can exist below them.
    if (moved || seedSet.has(id)) {
      for (const dep of succsOf.get(id) ?? []) dirty.add(dep.toEventId)
    }
  }
  return adjustments
}

/**
 * Edit-time veto: would adding `from -> to` close a cycle (or self-loop)?
 * DFS from the target following existing edges; reaching the proposed
 * source means the new edge points backwards into its own ancestry.
 */
export function wouldCreateCycle(
  dependencies: readonly PlanDependency[],
  fromEventId: string,
  toEventId: string,
): boolean {
  if (fromEventId === toEventId) return true
  const succsOf = new Map<string, string[]>()
  for (const dep of dependencies) {
    const list = succsOf.get(dep.fromEventId)
    if (list) list.push(dep.toEventId)
    else succsOf.set(dep.fromEventId, [dep.toEventId])
  }
  const seen = new Set<string>()
  const stack = [toEventId]
  while (stack.length) {
    const id = stack.pop()!
    if (id === fromEventId) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of succsOf.get(id) ?? []) stack.push(next)
  }
  return false
}
