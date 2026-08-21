import type { PlanJSON, PlanEvent } from "../plan-types.ts"
import { SENTINEL, type UmeJsonEntity } from "./schema.ts"

export type UpdateOp = {
  op: "update"
  id: string
  patch: { start: string; end: string }
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
    data: { responsable: string; fase: string; status: string }
  }
}

export type DeleteOp = {
  op: "delete"
  id: string
}

export type ChangeOp = UpdateOp | CreateOp | DeleteOp

export function applyOps(plan: PlanJSON, ops: ChangeOp[]): PlanJSON {
  let events: PlanEvent[] = plan.events
  for (const op of ops) {
    if (op.op === "update") {
      events = events.map((e) =>
        e.id === op.id ? { ...e, start: op.patch.start, end: op.patch.end } : e,
      )
    } else if (op.op === "create") {
      events = [
        ...events,
        {
          id: op.event.id,
          resourceId: op.event.resourceId,
          start: op.event.start,
          end: op.event.end,
          progress: op.event.progress,
        },
      ]
    } else {
      events = events.filter((e) => e.id !== op.id)
    }
  }
  return { ...plan, events }
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
