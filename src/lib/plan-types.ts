export interface PlanEvent {
  id: string
  resourceId: string
  start: string
  end: string
  progress: number
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
}
