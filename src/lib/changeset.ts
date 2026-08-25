import type { RefObject } from "react"
import type { GanttApi } from "@/components/reui/gantt/gantt"
import type {
  GanttEvent,
  GanttProposedUpdate,
  GanttSlotDraft,
  GanttUpdateResult,
} from "@/components/reui/gantt/gantt-types"
import type { EventData, PlanDependency, PlanJSON } from "@/lib/plan-types"
import {
  applyOps,
  type AddDependencyOp,
  type ChangeOp,
  type RemoveDependencyOp,
} from "@/lib/umejson/codec"
import { cascadeSchedule, wouldCreateCycle, type ScheduleAdjustment } from "@/lib/umejson/schedule"

export type {
  ChangeOp,
  UpdateOp,
  CreateOp,
  DeleteOp,
  AddDependencyOp,
  RemoveDependencyOp,
} from "@/lib/umejson/codec"

export interface ChangesetRecorder {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChangeOp[]
  getOps(): ChangeOp[]
  reset(): void
  onEventUpdate(p: GanttProposedUpdate<EventData>): GanttUpdateResult
  /**
   * Task ⇄ milestone conversion, recorded like any other edit (auditable,
   * reversible with «Reiniciar plan»). Returns the event's committed
   * dates + kind, or false when the event doesn't exist in the live plan.
   * Cascade adjustments the conversion triggers are QUEUED (same channel
   * as the drag flow): the host merges them after consuming
   * `consumePendingCascade()`.
   */
  setEventKind(
    eventId: string,
    kind: "task" | "milestone",
  ): { start: string; end: string; kind: "task" | "milestone" } | false
  onEventDelete(eventId: string): void
  canSelectSlot(slot: GanttSlotDraft): boolean
  onSelectSlot(slot: GanttSlotDraft): void
  /**
   * Records an edge and cascades its constraints immediately (an FS edge
   * onto a too-early successor pushes it in the same changeset). Returns
   * the produced adjustments for the host to mirror into its events state,
   * or false when the edge is rejected (self-loop or would close a cycle).
   */
  addDependency(dependency: PlanDependency): false | ScheduleAdjustment[]
  /** Records the removal of one edge. Relaxing never moves any date. */
  removeDependency(depId: string): void
  /**
   * Cascade adjustments produced by the LAST onEventUpdate, for the host to
   * merge into the engine's event array when it emits onEventsChange (the
   * engine's emission carries only the dragged bar; consuming here keeps the
   * ordering deterministic). Consumed on read.
   */
  consumePendingCascade(): ScheduleAdjustment[]
}

export interface ChangesetRecorderOpts {
  createDraft?: (slot: GanttSlotDraft) => GanttEvent<EventData> | null
  /**
   * The BASE plan (before uncommitted ops). Required for dependency
   * cascades; without it, update/delete still record but no cascade runs.
   */
  getBasePlan?: () => PlanJSON
}

export function createChangesetRecorder(
  apiRef: RefObject<GanttApi<EventData> | null>,
  opts: ChangesetRecorderOpts = {},
): ChangesetRecorder {
  const opsMap = new Map<string, ChangeOp>()
  const listeners = new Set<() => void>()
  let snapshot: ChangeOp[] = []
  let pendingCascade: ScheduleAdjustment[] = []

  const notify = () => {
    snapshot = Array.from(opsMap.values())
    for (const l of listeners) l()
  }

  /** The plan as the ops recorded so far describe it. */
  const currentPlan = (): PlanJSON | null => {
    const base = opts.getBasePlan?.()
    return base ? applyOps(base, Array.from(opsMap.values())) : null
  }

  /**
   * Pushes dependents of `seedIds` forward where constraints demand it.
   * Every moved event becomes its own documented update op (cause included),
   * so the JSON panel shows exactly what the engine adjusted and why.
   * `queueForEngine` parks the adjustments for consumePendingCascade - only
   * the drag flow uses it, because only that flow is followed by an engine
   * events emission that would otherwise wipe the cascade from view.
   */
  const runCascade = (
    seedIds: readonly string[],
    queueForEngine: boolean,
  ): ScheduleAdjustment[] => {
    if (!seedIds.length) return []
    const plan = currentPlan()
    if (!plan) return []
    const adjustments = cascadeSchedule(plan, seedIds)
    if (!adjustments.length) return []
    for (const adj of adjustments) {
      const existing = opsMap.get(adj.eventId)
      if (existing?.op === "create") {
        // A cascade push on an event born in this changeset rewrites its
        // create op in place; the cause documents the binding constraint.
        opsMap.set(adj.eventId, {
          ...existing,
          event: { ...existing.event, start: adj.start, end: adj.end },
          cause: adj.cause,
        })
      } else {
        opsMap.set(adj.eventId, {
          op: "update",
          id: adj.eventId,
          // keep a previously recorded conversion alive (merge, not replace)
          patch: {
            start: adj.start,
            end: adj.end,
            ...(recordedKind(adj.eventId)
              ? { kind: recordedKind(adj.eventId) }
              : {}),
          },
          cause: adj.cause,
        })
      }
    }
    if (queueForEngine) pendingCascade = adjustments
    return adjustments
  }

  const liveDeps = (): PlanDependency[] => currentPlan()?.dependencies ?? []

  /**
   * Kind already recorded for an event in this changeset: a later op on the
   * same event (drag after conversion, cascade after conversion) must MERGE
   * with it instead of replacing it - dropping the kind patch would undo
   * the conversion in the committed ops while the live UI still shows the
   * milestone.
   */
  const recordedKind = (
    eventId: string,
  ): "task" | "milestone" | undefined => {
    const existing = opsMap.get(eventId)
    if (existing?.op === "update") return existing.patch.kind
    if (existing?.op === "create") {
      return existing.event.kind === "milestone" ? "milestone" : undefined
    }
    return undefined
  }

  const DAY_MS = 86_400_000

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
    getOps() {
      return snapshot
    },
    reset() {
      opsMap.clear()
      pendingCascade = []
      notify()
    },
    onEventUpdate(p) {
      const { event, start, end } = p
      // A milestone is an instant: end === start is its legal shape and the
      // drag gesture preserves it. Everything else still needs a real span.
      if (end.getTime() < start.getTime()) return false
      if (end.getTime() === start.getTime() && !event.milestone) return false
      // A fresh gesture invalidates any cascade the previous one queued.
      pendingCascade = []
      const patch = {
        start: start.toISOString(),
        end: end.toISOString(),
        // merge, not replace: a drag on a converted bar keeps the conversion
        ...(recordedKind(event.id) ? { kind: recordedKind(event.id) } : {}),
      }
      const existing = opsMap.get(event.id)
      if (existing?.op === "create") {
        // The event was born in this changeset: fold the new dates into its
        // create op. Replacing it with an update would orphan the creation
        // (applyOps would find nothing to update and drop the task).
        opsMap.set(event.id, {
          ...existing,
          event: { ...existing.event, ...patch },
        })
      } else {
        opsMap.set(event.id, { op: "update", id: event.id, patch })
      }
      // The seed is already in opsMap, so the cascade reads the dragged
      // dates; only DEPENDENTS move here, never the dragged bar again.
      runCascade([event.id], true)
      notify()
      return true
    },
    setEventKind(eventId, kind) {
      // A fresh gesture invalidates any cascade the previous one queued.
      pendingCascade = []
      const plan = currentPlan()
      const live = plan?.events.find((e) => e.id === eventId)
      if (!plan || !live) return false
      let startIso: string
      let endIso: string
      if (kind === "milestone") {
        // Finish milestone: collapse onto the current end instant. The end
        // never moves, so FS dependents stay bound; the START jumps forward,
        // which the cascade below repairs for SS dependents.
        startIso = live.end
        endIso = live.end
      } else {
        // Back to a task: the milestone instant stays as the START and the
        // duration returns from the BASE plan when it knew the event as a
        // task; a milestone born as one (or an event born in this
        // changeset) gets the 1-day fallback.
        const base = opts
          .getBasePlan?.()
          .events.find((e) => e.id === eventId)
        const durDays =
          base && base.kind !== "milestone"
            ? Math.max(
                1,
                Math.round(
                  (Date.parse(base.end) - Date.parse(base.start)) / DAY_MS,
                ),
              )
            : 1
        startIso = live.start
        endIso = new Date(Date.parse(live.start) + durDays * DAY_MS).toISOString()
      }
      const existing = opsMap.get(eventId)
      if (existing?.op === "create") {
        // The event was born in this changeset: fold into its create op.
        const { kind: _drop, ...bornTask } = existing.event
        void _drop
        opsMap.set(eventId, {
          ...existing,
          event:
            kind === "milestone"
              ? { ...existing.event, start: startIso, end: endIso, kind }
              : { ...bornTask, start: startIso, end: endIso },
        })
      } else {
        opsMap.set(eventId, {
          op: "update",
          id: eventId,
          patch: { start: startIso, end: endIso, kind },
        })
      }
      // Both directions can bind dependents: → milestone jumps the START to
      // the end (SS violations), → task moves the END (FS pushes). The
      // adjustments are queued for the host, exactly like the drag flow.
      runCascade([eventId], true)
      notify()
      return { start: startIso, end: endIso, kind }
    },
    onEventDelete(eventId) {
      const existing = opsMap.get(eventId)
      if (existing?.op === "create") {
        opsMap.delete(eventId)
      } else {
        opsMap.set(eventId, { op: "delete", id: eventId })
      }
      // Incident edges die with their endpoint - as DOCUMENTED removals,
      // so reviewers see the graph change next to the date changes.
      for (const dep of liveDeps()) {
        if (dep.fromEventId === eventId || dep.toEventId === eventId) {
          opsMap.set(`dep:${dep.id}`, { op: "removeDependency", id: dep.id })
        }
      }
      // Relaxing constraints never pulls work back: no cascade by design.
      notify()
    },
    canSelectSlot(slot) {
      if (!slot.resourceId) return false
      return Boolean(opts.createDraft)
    },
    onSelectSlot(slot) {
      if (!slot.resourceId) return
      const draft = opts.createDraft?.(slot)
      if (!draft) return
      apiRef.current?.addEvent(draft)
      opsMap.set(draft.id, {
        op: "create",
        event: {
          id: draft.id,
          resourceId: draft.resourceId!,
          start: draft.start.toISOString(),
          end: draft.end.toISOString(),
          progress: 0,
          title: draft.title,
          color: draft.color,
          data: draft.data!,
        },
      })
      notify()
    },
    addDependency(dependency) {
      if (
        wouldCreateCycle(liveDeps(), dependency.fromEventId, dependency.toEventId)
      ) {
        return false
      }
      const op: AddDependencyOp = { op: "addDependency", dependency }
      opsMap.set(`dep:${dependency.id}`, op)
      // A new constraint may bind its successor immediately; that push is
      // part of THIS change, not a silent follow-up. Not queued for the
      // engine - no events emission follows, the host applies the returned
      // adjustments itself.
      const adjustments = runCascade([dependency.toEventId], false)
      notify()
      return adjustments
    },
    removeDependency(depId) {
      const op: RemoveDependencyOp = { op: "removeDependency", id: depId }
      opsMap.set(`dep:${depId}`, op)
      notify()
    },
    consumePendingCascade() {
      const out = pendingCascade
      pendingCascade = []
      return out
    },
  }
}
