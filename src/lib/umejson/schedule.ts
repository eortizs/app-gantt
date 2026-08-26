// Dependency-aware cascade scheduling. Runtime-pure (relative `.ts`
// imports, no `@/` alias) so `pnpm verify` can load it under
// `node --experimental-strip-types` alongside the codec.
//
// The rule of the house: a cascade only ever pushes FORWARD. A successor
// starts no earlier than its constraints demand; when a predecessor moves
// earlier the successor stays put - pulling work back is a human decision,
// never a side effect. Every produced adjustment documents its own cause so
// the changeset can carry provenance for each rewritten date.
//
// Working time: every kernel takes an optional resolver
// `(eventId) => WorkingCalendar | null`. A successor's constraint bound is
// seated with `addWorkingDays` on ITS calendar (lag counts the successor's
// working days, the MS Project convention); null-endowed events reproduce
// the corrido math byte for byte.
import type { DependencyType, PlanDependency, PlanJSON } from "../plan-types.ts"
import { addWorkingDays, workingDaysBetween, type WorkingCalendar } from "./working-time.ts"

export interface DependencyCause {
  kind: "dependency-cascade"
  /** Predecessor whose constraint bound this event's new position. */
  sourceEventId: string
  type: DependencyType
  /**
   * Signed whole WORKING days of this move on the moved event's calendar
   * (positive = pushed forward by a cascade, negative = seated back by an
   * edge-shape edit snap). Corrido under a null calendar.
   */
  shiftDays: number
}

export interface ScheduleAdjustment {
  eventId: string
  start: string
  end: string
  cause: DependencyCause
}

/**
 * Optional per-event calendar source shared by every scheduling kernel.
 * Absent or null-returning = corrido (the pre-calendar behavior).
 */
export type ScheduleResolver = (eventId: string) => WorkingCalendar | null

/**
 * Earliest instant the successor's `start` may sit at, given the
 * predecessor's current range and the constraint type. FS/SS bound the
 * start directly; FF/SF bound the END, so the start backs off by the
 * successor's preserved duration. Exported for CPM's forward pass: both
 * computations must agree on what a constraint demands, byte for byte.
 *
 * `lagDays` counts WORKING days of `cal` — the successor's own calendar,
 * per the MS Project convention that a link's lag runs on its successor.
 * The bound is seated with `addWorkingDays`, so an FS off a Friday end
 * lands on Monday, never Saturday. null cal = corrido: exactly the old
 * `boundary + lag × 86_400_000` arithmetic.
 */
export function earliestStart(
  predStartMs: number,
  predEndMs: number,
  succDurationMs: number,
  type: DependencyType,
  lagDays: number,
  cal?: WorkingCalendar | null,
): number {
  switch (type) {
    case "SS":
      return addWorkingDays(cal ?? null, predStartMs, lagDays)
    case "FF":
      return addWorkingDays(cal ?? null, predEndMs, lagDays) - succDurationMs
    case "SF":
      return addWorkingDays(cal ?? null, predStartMs, lagDays) - succDurationMs
    case "FS":
    default:
      return addWorkingDays(cal ?? null, predEndMs, lagDays)
  }
}

/**
 * Push every transitive dependent forward so no constraint is violated.
 * `seedIds` are events whose dates just changed (a drag, an edit); their
 * CURRENT dates must already be in `plan`. Returns one adjustment per
 * moved event, empty when nothing is violated. Events not reachable from
 * the seeds are never touched; cycles (which the decoder rejects anyway)
 * are skipped, not followed forever.
 *
 * Status-date conventions ride ON THE PLAN (`statusDate` +
 * `schedulingOptions.outOfSequence`); a plan without them reproduces the
 * classic behavior byte for byte:
 * - FROZEN ACTUALS: an event with progress > 0 that started before the
 *   cutoff IS history — the cascade never reschedules it (its successors
 *   still re-evaluate when it seeds).
 * - RETAINED LOGIC (default): successors of in-progress predecessors seat
 *   from their live finish — the remaining logic stays respected as-is.
 * - PROGRESS OVERRIDE: a triggered seat floors at the status date and the
 *   successor keeps only its REMAINING fraction of duration
 *   ((100 − progress)/100), so in-progress work resumes where it stands.
 */
export function cascadeSchedule(
  plan: PlanJSON,
  seedIds: readonly string[],
  resolve?: ScheduleResolver,
): ScheduleAdjustment[] {
  const events = new Map(plan.events.map((e) => [e.id, e]))
  const deps = (plan.dependencies ?? []).filter(
    (d) => events.has(d.fromEventId) && events.has(d.toEventId),
  )
  if (!deps.length || !seedIds.length) return []

  const statusMs = plan.statusDate ? Date.parse(plan.statusDate) : null
  const overrideMode =
    plan.schedulingOptions?.outOfSequence === "progressOverride"

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
    // FROZEN ACTUALS: started before the cutoff with progress is history.
    // The cascade never moves it; as a seed it still dirties its succs.
    if (
      statusMs !== null &&
      (event.progress ?? 0) > 0 &&
      startMs < statusMs
    ) {
      if (seedSet.has(id)) {
        for (const dep of succsOf.get(id) ?? []) dirty.add(dep.toEventId)
      }
      continue
    }
    const durationMs = Math.max(Date.parse(event.end) - startMs, 0)
    let bestMs = startMs
    let cause: { dep: PlanDependency; boundMs: number } | null = null
    for (const dep of predsOf.get(id) ?? []) {
      const pred = events.get(dep.fromEventId)
      if (!pred) continue
      // The constraint's lag and seat run on the SUCCESSOR's calendar.
      const succCal = resolve?.(id) ?? null
      const boundMs = earliestStart(
        Date.parse(pred.start),
        Date.parse(pred.end),
        durationMs,
        dep.type,
        dep.lagDays ?? 0,
        succCal,
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
      const succCal = resolve?.(id) ?? null
      // PROGRESS OVERRIDE: a triggered seat floors at the cutoff and only
      // the REMAINING fraction of this event's duration survives it.
      let seatMs = bestMs
      let effDur = durationMs
      if (overrideMode && statusMs !== null) {
        seatMs = Math.max(seatMs, statusMs)
        const remaining =
          Math.min(Math.max(0, 100 - (event.progress ?? 0)), 100) / 100
        effDur = durationMs * remaining
      }
      const nextStart = new Date(seatMs)
      const nextEnd = new Date(Math.max(seatMs + effDur, seatMs))
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
          shiftDays: workingDaysBetween(succCal, startMs, seatMs),
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
 * Seats a successor EXACTLY at its constraint's bound: FS → start at the
 * predecessor's end (+lag), SS → starts aligned, FF → ends aligned, SF →
 * end at the predecessor's start. Duration is preserved; the move is
 * BIDIRECTIONAL by design — this is the edge-SHAPE-EDIT gesture (the user
 * chose the constraint, so the bar re-seats on both sides), distinct from
 * `cascadeSchedule`, which stays forward-only. Returns null when an
 * endpoint is missing from the plan or the bar already sits at the bound.
 */
export function snapToDependency(
  plan: PlanJSON,
  dep: PlanDependency,
  resolve?: ScheduleResolver,
): ScheduleAdjustment | null {
  const events = new Map(plan.events.map((e) => [e.id, e]))
  const pred = events.get(dep.fromEventId)
  const succ = events.get(dep.toEventId)
  if (!pred || !succ) return null
  const startMs = Date.parse(succ.start)
  const durationMs = Math.max(Date.parse(succ.end) - startMs, 0)
  const succCal = resolve?.(succ.id) ?? null
  const boundMs = earliestStart(
    Date.parse(pred.start),
    Date.parse(pred.end),
    durationMs,
    dep.type,
    dep.lagDays ?? 0,
    succCal,
  )
  const start = new Date(boundMs).toISOString()
  const end = new Date(Math.max(boundMs + durationMs, boundMs)).toISOString()
  if (start === succ.start && end === succ.end) return null
  return {
    eventId: succ.id,
    start,
    end,
    cause: {
      kind: "dependency-cascade",
      sourceEventId: pred.id,
      type: dep.type,
      shiftDays: workingDaysBetween(succCal, startMs, boundMs),
    },
  }
}

/**
 * Lag IMPLICIT in the two endpoints' live dates under the edge's type —
 * the read-side counterpart of `snapToDependency` (same rounding, inverse
 * convention: snap writes dates FROM a lag, impliedLag reads the lag FROM
 * dates). FS/SS measure start-to-X, FF/SF end-to-X per the constraint's
 * meaning. The dependency panel renders this so a manual drag of either
 * bar is reflected the moment it drops, without touching the stored op.
 */
export function impliedLagDays(
  dep: Pick<PlanDependency, "type">,
  pred: { start: string | Date; end: string | Date },
  succ: { start: string | Date; end: string | Date },
  cal?: WorkingCalendar | null,
): number {
  const ms = (v: string | Date): number =>
    typeof v === "number"
      ? v
      : v instanceof Date
        ? v.getTime()
        : Date.parse(v)
  const [from, to] =
    dep.type === "SS"
      ? [ms(pred.start), ms(succ.start)]
      : dep.type === "FF"
        ? [ms(pred.end), ms(succ.end)]
        : dep.type === "SF"
          ? [ms(pred.start), ms(succ.end)]
          : [ms(pred.end), ms(succ.start)] // FS
  return workingDaysBetween(cal ?? null, from, to)
}

/**
 * Transitive closure of successors reachable from `seedIds` along the
 * `fromEventId -> toEventId` direction. Excludes the seeds themselves; a
 * diamond (A->B, A->C, B->D, C->D) visits D once because of the visited
 * set. Cycles are defensive - the decoder rejects them, but a DFS over a
 * malformed plan would loop forever without it. Order is BFS, so the
 * caller gets a predictable, dependency-distance-ordered traversal.
 */
export function dependentClosure(
  dependencies: readonly PlanDependency[],
  seedIds: readonly string[],
): string[] {
  if (!seedIds.length) return []
  const succsOf = new Map<string, string[]>()
  for (const dep of dependencies) {
    const list = succsOf.get(dep.fromEventId)
    if (list) list.push(dep.toEventId)
    else succsOf.set(dep.fromEventId, [dep.toEventId])
  }
  const visited = new Set<string>(seedIds)
  const queue: string[] = []
  for (const seed of seedIds) {
    for (const next of succsOf.get(seed) ?? []) {
      if (!visited.has(next)) queue.push(next)
    }
  }
  const result: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (visited.has(id)) continue
    visited.add(id)
    result.push(id)
    for (const next of succsOf.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next)
    }
  }
  return result
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
