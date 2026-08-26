import type {
  PlanDependency,
  PlanJSON,
  PlanEvent,
  PlanResource,
} from "../plan-types.ts"
import { SENTINEL, type UmeJsonEntity } from "./schema.ts"
import type { DependencyCause } from "./schedule.ts"

export type UpdateOp = {
  op: "update"
  id: string
  patch: {
    start: string
    end: string
    /**
     * Task ⇄ milestone conversion rides the same op as the dates: a
     * milestone conversion collapses `start` onto `end`; converting back
     * restores a duration. Absent = dates-only edit (kind untouched).
     */
    kind?: "task" | "milestone"
    /**
     * Physical progress (% 0..100) captured from the field, additive and
     * auditable like `kind`: absent = the edit never touched progress.
     * Applying it overwrites `event.progress`; progress never moves
     * dates, so cascades ignore it.
     */
    progress?: number
  }
  /**
   * Why this date changed. Absent on manual edits; a dependency cascade
   * documents the binding predecessor, constraint type and shift so the
   * changeset is self-explaining.
   */
  cause?: DependencyCause
}

export type CreateOp = {
  op: "create"
  event: {
    id: string
    resourceId: string
    start: string
    end: string
    progress: number
    title: string
    color?: string
    /** Present when the event is born a milestone (duration 0). */
    kind?: "task" | "milestone"
    data: { responsable: string; fase: string; status: string }
  }
  /**
   * Present when a dependency cascade positioned (or repositioned) this new
   * event; same provenance contract as UpdateOp.cause.
   */
  cause?: DependencyCause
}

export type DeleteOp = {
  op: "delete"
  id: string
}

export type AddDependencyOp = {
  op: "addDependency"
  dependency: PlanDependency
}

export type UpdateDependencyOp = {
  op: "updateDependency"
  dependency: PlanDependency
}

export type RemoveDependencyOp = {
  op: "removeDependency"
  id: string
}

/**
 * Inline edit of a tree row's OWN metadata (the title lives on the
 * PlanResource, not on the event). Additive patch: absent keys never touch
 * the document, and applying an empty patch is a no-op that still counts as
 * an edit (same fold-by-key story as events).
 */
export type UpdateResourceOp = {
  op: "updateResource"
  id: string
  patch: {
    title?: string
    responsable?: string
  }
}

/**
 * Plan-level settings edit (status date, scheduling conventions). Same
 * lazy discipline as resources: documents without this op keep their
 * fields untouched; a `null` patch value DROPS the field (canonical
 * absence), an object value replaces it wholesale.
 */
export type UpdatePlanSettingsOp = {
  op: "updatePlanSettings"
  patch: {
    statusDate?: string | null
    schedulingOptions?: {
      outOfSequence: "retainedLogic" | "progressOverride"
    } | null
  }
}

export type ChangeOp =
  | UpdateOp
  | CreateOp
  | DeleteOp
  | AddDependencyOp
  | UpdateDependencyOp
  | RemoveDependencyOp
  | UpdateResourceOp
  | UpdatePlanSettingsOp

export function applyOps(plan: PlanJSON, ops: ChangeOp[]): PlanJSON {
  let events: PlanEvent[] = plan.events
  // Dependencies start from the plan's own graph and are rebuilt lazily:
  // only ops that touch edges replace the array (and a delete prunes it).
  let dependencies: PlanDependency[] | null = null
  const deps = () => dependencies ?? (dependencies = plan.dependencies ?? [])
  // Same lazy discipline for resources: documents without resource edits
  // round-trip byte-identical because the array is never rebuilt.
  let resources: PlanResource[] | null = null
  const res = () => resources ?? (resources = plan.resources)
  // Plan-level settings fold separately: null marks "field dropped".
  let statusDate: string | null | undefined = undefined // untouched
  let schedulingOptions:
    | PlanJSON["schedulingOptions"]
    | null
    | undefined = undefined
  for (const op of ops) {
    if (op.op === "update") {
      events = events.map((e) => {
        if (e.id !== op.id) return e
        const next: PlanEvent = { ...e, start: op.patch.start, end: op.patch.end }
        // Additive field, same criterion as `kind`: absent = untouched.
        if (op.patch.progress !== undefined) next.progress = op.patch.progress
        if (op.patch.kind === "milestone") return { ...next, kind: "milestone" }
        if (op.patch.kind === "task") {
          // Canonical form: a task carries NO kind field, so the document
          // round-trips identical for events that never were milestones
          // (same destructure-drop criterion as `dependencies`).
          const { kind: _drop, ...rest } = next
          void _drop
          return rest
        }
        return next
      })
    } else if (op.op === "create") {
      events = [
        ...events,
        {
          id: op.event.id,
          resourceId: op.event.resourceId,
          start: op.event.start,
          end: op.event.end,
          progress: op.event.progress,
          ...(op.event.kind === "milestone" ? { kind: "milestone" } : {}),
        },
      ]
    } else if (op.op === "delete") {
      events = events.filter((e) => e.id !== op.id)
      // Incident edges die with their endpoint: a dangling ref would fail
      // decodeUmePlan, so applyOps keeps the document valid by construction.
      dependencies = deps().filter(
        (d) => d.fromEventId !== op.id && d.toEventId !== op.id,
      )
    } else if (op.op === "addDependency") {
      const rest = deps().filter((d) => d.id !== op.dependency.id)
      dependencies = [...rest, op.dependency]
    } else if (op.op === "updateDependency") {
      // Replace by id only; an unknown id is a silent no-op (same
      // criterion as update on a ghost event). Adding a NEW edge is
      // addDependency's job - the create+edit story folds into one op
      // at the recorder, so applyOps never needs to synthesize edges.
      dependencies = deps().map((d) =>
        d.id === op.dependency.id ? op.dependency : d,
      )
    } else if (op.op === "updateResource") {
      // Replace by id only; an unknown id never touches the array at all
      // (lazy discipline: no-op ops must not even rebuild the list). The
      // patch applies key-by-key so absent keys never synthesize fields.
      const current = res()
      if (current.some((r) => r.id === op.id)) {
        resources = current.map((r) => {
          if (r.id !== op.id) return r
          const next = { ...r }
          if (op.patch.title !== undefined) next.title = op.patch.title
          if (op.patch.responsable !== undefined)
            next.responsable = op.patch.responsable
          return next
        })
      }
    } else if (op.op === "updatePlanSettings") {
      // Field-level fold: last write wins per field; a null patch value
      // drops the field (canonical absence), an object replaces wholesale.
      if (op.patch.statusDate !== undefined) {
        statusDate = op.patch.statusDate
      }
      if (op.patch.schedulingOptions !== undefined) {
        schedulingOptions = op.patch.schedulingOptions
      }
    } else {
      dependencies = deps().filter((d) => d.id !== op.id)
    }
  }
  // The field is only included when there are surviving edges: an empty
  // array would round-trip differently from "absent" and signal something
  // the original plan never said. Touching the field (any add/remove/delete)
  // always produces an explicit value - including the literal ABSENCE of
  // the key when the touched list becomes empty (delete on a plan with no
  // deps; delete of the last event that held the only incident edge, etc.).
  // Spread `...plan` would otherwise resurrect the original field verbatim
  // (including a `dependencies: undefined` property) and silently undo the
  // edit, so when the field was touched we rebuild the object without it.
  let result: PlanJSON = { ...plan, events }
  if (resources !== null) {
    // Resources is a REQUIRED field: a touch always writes the rebuilt
    // list back (reassigning an existing key preserves its position, so
    // byte-identical documents keep their key order).
    result = { ...result, resources }
  }
  if (statusDate !== undefined) {
    const { statusDate: _drop, ...rest } = result
    void _drop
    result = rest as PlanJSON
    if (statusDate !== null) result = { ...result, statusDate }
  }
  if (schedulingOptions !== undefined) {
    const { schedulingOptions: _drop, ...rest } = result
    void _drop
    result = rest as PlanJSON
    if (schedulingOptions !== null) {
      result = { ...result, schedulingOptions }
    }
  }
  if (dependencies !== null) {
    const { dependencies: _drop, ...rest } = result
    void _drop
    result = rest
    if (dependencies.length > 0) {
      result = { ...result, dependencies }
    }
  }
  return result
}

const deepClone = <T>(v: T): T => structuredClone(v)

export function encodeUpdatedPlan(
  base: UmeJsonEntity,
  plan: PlanJSON,
  opCount: number,
): UmeJsonEntity {
  const cloned = deepClone(base)
  cloned.dynamicProperties = { ...cloned.dynamicProperties, plan }
  cloned.lifecycle = { ...cloned.lifecycle, updatedAt: SENTINEL }
  const reason = `gantt: ${opCount} ${opCount === 1 ? "op" : "ops"}`
  cloned.state = {
    ...cloned.state,
    statusLog: [
      ...cloned.state.statusLog,
      { status: cloned.state.current, timestamp: SENTINEL, reason },
    ],
  }
  return cloned
}
