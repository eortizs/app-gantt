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
  type UpdateResourceOp,
} from "@/lib/umejson/codec"
import {
  addWorkingDays,
  workingDaysBetween,
} from "@/lib/umejson/working-time"
import {
  cascadeSchedule,
  snapToDependency,
  wouldCreateCycle,
  type DependencyCause,
  type ScheduleAdjustment,
  type ScheduleResolver,
} from "@/lib/umejson/schedule"

export type {
  ChangeOp,
  UpdateOp,
  CreateOp,
  DeleteOp,
  AddDependencyOp,
  UpdateDependencyOp,
  RemoveDependencyOp,
  UpdateResourceOp,
  UpdatePlanSettingsOp,
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
  /**
   * Registra avance físico (% 0..100) como UpdateOp auditable —
   * patch.progress, aditivo exactamente como kind. Nunca mueve fechas:
   * sin cascada. False cuando el evento no existe en el plan vivo.
   */
  setEventProgress(eventId: string, progress: number): boolean
  /**
   * Edición inline del título de una fila (vive en PlanResource, no en el
   * evento): viaja como UpdateResourceOp auditable. Rechaza títulos
   * vacíos/blank. False = rechazada (sin cambios).
   */
  updateResourceTitle(resourceId: string, title: string): boolean
  /**
   * Cambia la duración de una tarea por teclado: el fin se reasienta con
   * addWorkingDays sobre el calendario DEL EVENTO (`n` días laborables
   * desde el inicio vivo); hitos vetados (duración 0). La cascada que el
   * nuevo fin dispara se QUEUA como la del drag (consumePendingCascade).
   * Devuelve las fechas comprometidas, o false cuando el evento no existe,
   * es hito, o la duración es inválida (< 1 día laborable).
   */
  setEventDuration(
    eventId: string,
    durationDays: number,
  ): { start: string; end: string } | false
  onEventDelete(eventId: string): void
  canSelectSlot(slot: GanttSlotDraft): boolean
  onSelectSlot(slot: GanttSlotDraft): void
  /**
   * Incorpora ops YA COMPUTADOS (la salida de un kernel como la
   * nivelación) al changeset con la misma disciplina fold-by-key y
   * snapshot de historial que cualquier gesto. Un op cuyo target no existe
   * en el plan vivo se descarta silenciosamente (defensiva idéntica a la
   * del borde del servidor).
   */
  recordOps(ops: ChangeOp[]): void
  /**
   * Records an edge and cascades its constraints immediately (an FS edge
   * onto a too-early successor pushes it in the same changeset). Returns
   * the produced adjustments for the host to mirror into its events state,
   * or false when the edge is rejected (self-loop or would close a cycle).
   */
  addDependency(dependency: PlanDependency): false | ScheduleAdjustment[]
  /**
   * Records an edit of one edge's SHAPE (type and/or lag) and RE-SEATS the
   * successor exactly at the new constraint's bound (FS → predecessor's
   * end, SS → starts aligned, FF/SF → ends aligned; lag applied, duration
   * preserved). Unlike the cascade this move is bidirectional — the user
   * chose the constraint, so the bar snaps on both sides; the transitive
   * cascade that follows stays forward-only (tightened dependents push,
   * relaxed ones stay). Returns the produced adjustments for the host to
   * mirror, or false when the edge doesn't exist in the live plan
   * (defensive: the panel derives from livePlan).
   */
  updateDependency(dependency: PlanDependency): false | ScheduleAdjustment[]
  /**
   * Records the removal of one edge. Relaxing never moves any date.
   */
  removeDependency(depId: string): void
  /**
   * Restores the PREVIOUS ops snapshot (whole-array undo: the fold-by-key
   * makes per-op reversal impossible). Returns the ops in force after the
   * restore — the host rebuilds its event mirror from them.
   */
  undo(): ChangeOp[]
  /** The undo counterpart; empty future is a no-op returning current ops. */
  redo(): ChangeOp[]
  /** True when there is at least one snapshot to undo into. */
  canUndo(): boolean
  /** True when an undo has already happened and can be redone. */
  canRedo(): boolean
  /**
   * Memoized flags for `useSyncExternalStore`: same object identity between
   * changes so React skips re-renders.
   */
  getUndoRedoFlags(): { canUndo: boolean; canRedo: boolean }
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
  /**
   * Per-event working calendar. Cascades and edge snaps seat successors on
   * THEIR working days; absent/null = corrido arithmetic throughout.
   */
  resolve?: ScheduleResolver
}

export function createChangesetRecorder(
  apiRef: RefObject<GanttApi<EventData> | null>,
  opts: ChangesetRecorderOpts = {},
): ChangesetRecorder {
  const opsMap = new Map<string, ChangeOp>()
  const listeners = new Set<() => void>()
  let snapshot: ChangeOp[] = []
  let pendingCascade: ScheduleAdjustment[] = []

  // ----- undo/redo: snapshots del ARRAY de ops -----
  // The fold-by-key (one op per event/edge) makes per-op reversal
  // impossible — a drag MERGES into its event's op, so undoing "the drag"
  // means undoing whatever that op carried. History is therefore a stack
  // of whole opsMap snapshots; every mutation pushes the PREVIOUS state
  // and kills the redo branch.
  const HISTORY_CAP = 50
  const history: ChangeOp[][] = []
  const future: ChangeOp[][] = []
  let flags = { canUndo: false, canRedo: false }

  /** The map key an op was recorded under (events by id, edges by `dep:`,
   *  resources by `res:` — namespaces never collide). */
  const keyOf = (op: ChangeOp): string => {
    switch (op.op) {
      case "addDependency":
      case "updateDependency":
        return `dep:${op.dependency.id}`
      case "removeDependency":
        return `dep:${op.id}`
      case "updateResource":
        return `res:${op.id}`
      case "updatePlanSettings":
        return "plan-settings"
      case "create":
        return op.event.id
      default:
        return op.id
    }
  }

  const restore = (ops: ChangeOp[]) => {
    opsMap.clear()
    for (const op of ops) opsMap.set(keyOf(op), op)
    snapshot = [...ops]
    pendingCascade = []
    flags = { canUndo: history.length > 0, canRedo: future.length > 0 }
    for (const l of listeners) l()
  }

  const notify = () => {
    history.push(snapshot)
    if (history.length > HISTORY_CAP) history.shift()
    future.length = 0
    snapshot = Array.from(opsMap.values())
    flags = { canUndo: true, canRedo: false }
    for (const l of listeners) l()
  }

  /** The plan as the ops recorded so far describe it. */
  const currentPlan = (): PlanJSON | null => {
    const base = opts.getBasePlan?.()
    return base ? applyOps(base, Array.from(opsMap.values())) : null
  }

  /**
   * Records a date move on one event as the op its history demands: a
   * create op swallows the dates (an update would orphan the creation),
   * anything else becomes an update that MERGES a previously recorded
   * kind conversion. The cause documents the binding constraint — shared
   * by the drag cascade and the edge-edit snap.
   */
  const recordDateOp = (
    eventId: string,
    start: string,
    end: string,
    cause: DependencyCause,
  ) => {
    const existing = opsMap.get(eventId)
    if (existing?.op === "create") {
      opsMap.set(eventId, {
        ...existing,
        event: { ...existing.event, start, end },
        cause,
      })
    } else {
      // Merge, not replace: a cascade move on a converted bar keeps its
      // conversion; one after «Registrar avance» keeps the progress.
      opsMap.set(eventId, {
        op: "update",
        id: eventId,
        patch: { start, end, ...mergePatchExtras(eventId) },
        cause,
      })
    }
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
    const adjustments = cascadeSchedule(plan, seedIds, opts.resolve)
    if (!adjustments.length) return []
    for (const adj of adjustments) {
      recordDateOp(adj.eventId, adj.start, adj.end, adj.cause)
    }
    if (queueForEngine) pendingCascade = adjustments
    return adjustments
  }

  const liveDeps = (): PlanDependency[] => currentPlan()?.dependencies ?? []

  /**
   * Campos ya grabados para el evento en ESTE changeset que un gesto nuevo
   * debe CONSERVAR (riesgo conocido del fold-by-key: la op se reemplaza,
   * no se acumula). Un drag después de «Registrar avance» preserva el
   * progress; una conversión después de un drag preserva el kind.
   */
  const mergePatchExtras = (
    eventId: string,
  ): { kind?: "task" | "milestone"; progress?: number } => {
    const existing = opsMap.get(eventId)
    if (existing?.op !== "update") return {}
    return {
      ...(existing.patch.kind !== undefined
        ? { kind: existing.patch.kind }
        : {}),
      ...(existing.patch.progress !== undefined
        ? { progress: existing.patch.progress }
        : {}),
    }
  }

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
      // «Reiniciar plan» wipes EVERYTHING, undo history included — it is
      // the all-or-nothing escape hatch, not a step in the stack.
      opsMap.clear()
      pendingCascade = []
      history.length = 0
      future.length = 0
      snapshot = []
      flags = { canUndo: false, canRedo: false }
      for (const l of listeners) l()
    },
    undo() {
      const prev = history.pop()
      if (!prev) return snapshot
      future.push(snapshot)
      restore(prev)
      return snapshot
    },
    redo() {
      const next = future.pop()
      if (!next) return snapshot
      history.push(snapshot)
      restore(next)
      return snapshot
    },
    canUndo() {
      return flags.canUndo
    },
    canRedo() {
      return flags.canRedo
    },
    getUndoRedoFlags() {
      return flags
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
        // merge, not replace: a drag on a converted bar keeps the
        // conversion, one after «Registrar avance» keeps the progress.
        ...mergePatchExtras(event.id),
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
        // task (counted in the event's OWN working days); a milestone born
        // as one (or an event born in this changeset) gets the 1-day
        // fallback. The end seats with addWorkingDays so it lands on a
        // working day.
        const base = opts
          .getBasePlan?.()
          .events.find((e) => e.id === eventId)
        const cal = opts.resolve?.(eventId) ?? null
        const durDays =
          base && base.kind !== "milestone"
            ? Math.max(
                1,
                workingDaysBetween(
                  cal,
                  Date.parse(base.start),
                  Date.parse(base.end),
                ),
              )
            : 1
        startIso = live.start
        endIso = new Date(addWorkingDays(cal, Date.parse(live.start), durDays)).toISOString()
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
          // The gesture's kind wins over a recorded one; a recorded
          // progress survives the conversion untouched.
          patch: { ...mergePatchExtras(eventId), start: startIso, end: endIso, kind },
        })
      }
      // Both directions can bind dependents: → milestone jumps the START to
      // the end (SS violations), → task moves the END (FS pushes). The
      // adjustments are queued for the host, exactly like the drag flow.
      runCascade([eventId], true)
      notify()
      return { start: startIso, end: endIso, kind }
    },
    setEventProgress(eventId, progress) {
      const plan = currentPlan()
      const live = plan?.events.find((e) => e.id === eventId)
      if (!plan || !live) return false
      const clamped = Math.min(100, Math.max(0, progress))
      const existing = opsMap.get(eventId)
      if (existing?.op === "create") {
        // Born in this changeset: fold the progress into its create op.
        opsMap.set(eventId, {
          ...existing,
          event: { ...existing.event, progress: clamped },
        })
      } else {
        opsMap.set(eventId, {
          op: "update",
          id: eventId,
          // Progress never moves dates, so the patch carries the LIVE
          // dates (required fields) plus whatever was already recorded.
          patch: {
            start: live.start,
            end: live.end,
            ...mergePatchExtras(eventId),
            progress: clamped,
          },
        })
      }
      notify()
      return true
    },
    updateResourceTitle(resourceId, title) {
      const trimmed = title.trim()
      if (!trimmed) return false
      const key = `res:${resourceId}`
      const existing = opsMap.get(key)
      if (existing?.op === "updateResource") {
        // Same fold-by-key story as repeated event edits: one op per
        // resource tells the net story of this changeset.
        opsMap.set(key, {
          ...existing,
          patch: { ...existing.patch, title: trimmed },
        })
      } else {
        const op: UpdateResourceOp = {
          op: "updateResource",
          id: resourceId,
          patch: { title: trimmed },
        }
        opsMap.set(key, op)
      }
      notify()
      return true
    },
    setEventDuration(eventId, durationDays) {
      // A fresh gesture invalidates any cascade the previous one queued.
      pendingCascade = []
      const plan = currentPlan()
      const live = plan?.events.find((e) => e.id === eventId)
      if (!plan || !live) return false
      // A milestone IS duration 0: resizing it is a contradiction (the
      // conversion gesture owns that transition).
      if (live.kind === "milestone") return false
      const n = Math.floor(durationDays)
      if (!(n >= 1)) return false
      // The end seats on the EVENT'S OWN working days from the live start;
      // corrido when no calendar resolves. Zero ms<->days math here - all
      // of it lives in working-time.ts.
      const cal = opts.resolve?.(eventId) ?? null
      const endIso = new Date(
        addWorkingDays(cal, Date.parse(live.start), n),
      ).toISOString()
      const existing = opsMap.get(eventId)
      if (existing?.op === "create") {
        opsMap.set(eventId, {
          ...existing,
          event: { ...existing.event, start: live.start, end: endIso },
        })
      } else {
        opsMap.set(eventId, {
          op: "update",
          id: eventId,
          patch: {
            start: live.start,
            end: endIso,
            ...mergePatchExtras(eventId),
          },
        })
      }
      // The new end can bind dependents: queued for the host, exactly like
      // the drag flow (an engine events emission follows the commit).
      runCascade([eventId], true)
      notify()
      return { start: live.start, end: endIso }
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
    recordOps(ops) {
      const live = currentPlan()
      if (!live) return
      const eventIds = new Set(live.events.map((e) => e.id))
      const resourceIds = new Set(live.resources.map((r) => r.id))
      for (const op of ops) {
        switch (op.op) {
          case "update":
            if (!eventIds.has(op.id)) continue
            opsMap.set(op.id, op)
            break
          case "updateResource":
            if (!resourceIds.has(op.id)) continue
            opsMap.set(`res:${op.id}`, op)
            break
          default:
            // Leveling only ever emits date/resource updates; anything
            // else would need the gesture-specific folding done above.
            opsMap.set(keyOf(op), op)
        }
      }
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
    updateDependency(dependency) {
      const current = liveDeps()
      if (!current.some((d) => d.id === dependency.id)) return false
      // Endpoints never change from the panel, but the op carries them: a
      // defensive veto keeps the graph acyclic no matter who calls. The
      // edge's own (old) shape is excluded - it is what gets replaced.
      if (
        wouldCreateCycle(
          current.filter((d) => d.id !== dependency.id),
          dependency.fromEventId,
          dependency.toEventId,
        )
      ) {
        return false
      }
      // Canonical form: lagDays 0 is the field's ABSENCE (same
      // destructure-drop criterion as kind/dependencies).
      const { lagDays, ...shape } = dependency
      const canonical: PlanDependency = lagDays
        ? { ...shape, lagDays }
        : shape
      const existing = opsMap.get(`dep:${dependency.id}`)
      if (existing?.op === "addDependency") {
        // Create+edit folds into the single add: one op tells the whole
        // story (same criterion as create+drag on events).
        opsMap.set(`dep:${dependency.id}`, { ...existing, dependency: canonical })
      } else if (existing?.op === "removeDependency") {
        // Unreachable from the panel (the edge would be gone), but the
        // net story of remove-then-edit is "the edge exists, shaped".
        opsMap.set(`dep:${dependency.id}`, {
          op: "addDependency",
          dependency: canonical,
        })
      } else {
        opsMap.set(`dep:${dependency.id}`, {
          op: "updateDependency",
          dependency: canonical,
        })
      }
      // Seat the successor AT the new bound (bidirectional: the user chose
      // the constraint's shape). Recorded BEFORE the cascade so the seeded
      // forward pass reads the seated dates; if ANOTHER predecessor binds
      // later, the cascade's own adjustment wins downstream (both in the
      // opsMap - same key, last write - and in the host's event mirror).
      const adjustments: ScheduleAdjustment[] = []
      // Without a base plan there is nothing to snap against (same guard
      // the cascade uses); the op alone still records the edge's new shape.
      const plan = currentPlan()
      const snap = plan ? snapToDependency(plan, canonical, opts.resolve) : null
      if (snap) {
        recordDateOp(snap.eventId, snap.start, snap.end, snap.cause)
        adjustments.push(snap)
      }
      // Transitive dependents of the seated bar: forward-only as always -
      // a tightened edge pushes them, a relaxed one leaves them put.
      adjustments.push(...runCascade([dependency.toEventId], false))
      notify()
      return adjustments
    },
    consumePendingCascade() {
      const out = pendingCascade
      pendingCascade = []
      return out
    },
  }
}
