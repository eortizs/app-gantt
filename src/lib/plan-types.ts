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
}

export type EventData = {
  responsable: string
  fase: string
  status: string
  /** Baseline history carried through to the gantt engine's event data. */
  baselines?: PlanBaseline[]
}
