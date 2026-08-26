/**
 * Immutable snapshot of a task's committed dates. Entries are append-only
 * (never mutate a captured one); the LIVE `PlanEvent.start/end` is the plan,
 * the last entry of `baselines` is the baseline in force before the current
 * drift. Re-baselining is an explicit action, never a side effect of dragging.
 */
export interface PlanBaseline {
  /** 1-based, unique within the event, ascending in capture order. */
  version: number
  start: string
  end: string
  /** When this snapshot was taken (audit trail). */
  capturedAt: string
  reason?: string
}

export interface PlanEvent {
  id: string
  resourceId: string
  start: string
  end: string
  progress: number
  /** Bitácora de baselines; optional so older documents stay valid. */
  baselines?: PlanBaseline[]
  /**
   * Finish milestone: `start === end` (duration 0). Absent = task (the
   * canonical form — the codec drops the field when converting back, so
   * events that never were milestones round-trip byte-identical).
   */
  kind?: "task" | "milestone"
  /**
   * Leveling priority (1..1000, higher = leveled first). Additive-optional
   * (schema stays v2); absent = default middle priority. Consumed by the
   * leveling kernel; never affects paint or scheduling by itself.
   */
  priority?: number
}

/**
 * Scheduling constraint between two events. `from` is the predecessor,
 * `to` the successor. Types follow the PM standard: FS (finish-to-start,
 * the default), SS, FF, SF. `lagDays` is calendar days (may be negative
 * for a lead) — the plan carries no working-calendar, so lag counts every
 * day including off days.
 */
export type DependencyType = "FS" | "SS" | "FF" | "SF"

export interface PlanDependency {
  /** Unique within the plan; doubles as the connector's stable identity. */
  id: string
  fromEventId: string
  toEventId: string
  type: DependencyType
  lagDays?: number
}

export interface PlanResource {
  id: string
  title: string
  parentId?: string
  phaseId?: string
  responsable?: string
}

export interface PlanPhase {
  id: string
  title: string
  color: string
}

export interface PlanJSON {
  schemaVersion: 2
  anchor: string
  resources: PlanResource[]
  phases: PlanPhase[]
  events: PlanEvent[]
  /** Scheduling constraints; optional so older documents stay valid. */
  dependencies?: PlanDependency[]
  /**
   * Status-date cutoff for field progress; additive-optional (schema stays
   * v2). When present, cascades treat started-before-cutoff work as frozen
   * actuals and the convention below decides how successors re-seat.
   */
  statusDate?: string
  /**
   * Scheduling conventions; additive-optional. `retainedLogic` (default):
   * successors of in-progress predecessors seat from their LIVE finish.
   * `progressOverride`: seating floors at the status date and an
   * in-progress successor keeps only its remaining fraction of duration.
   */
  schedulingOptions?: {
    outOfSequence: "retainedLogic" | "progressOverride"
  }
}

export type EventData = {
  responsable: string
  fase: string
  status: string
  /**
   * Dates the event had when the plan was mapped. Hidden anchor for the
   * "modified vs original" signal: tasks without a captured baseline
   * measure drift against these. NOT a bitácora entry — it never renders
   * as a baseline mark.
   */
  initialStart?: string
  initialEnd?: string
  /** Baseline history carried through to the gantt engine's event data. */
  baselines?: PlanBaseline[]
}
