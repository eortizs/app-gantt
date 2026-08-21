import type { RefObject } from "react"
import type { GanttApi } from "@/components/reui/gantt/gantt"
import type {
  GanttEvent,
  GanttProposedUpdate,
  GanttSlotDraft,
  GanttUpdateResult,
} from "@/components/reui/gantt/gantt-types"
import { RESPONSABLES, type EventData } from "@/data/plan-departamento"

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
    data: EventData
  }
}

export type ChangeOp = UpdateOp | CreateOp

export interface ChangesetRecorder {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChangeOp[]
  getOps(): ChangeOp[]
  reset(): void
  onEventUpdate(p: GanttProposedUpdate<EventData>): GanttUpdateResult
  canSelectSlot(slot: GanttSlotDraft): boolean
  onSelectSlot(slot: GanttSlotDraft): void
}

export function createChangesetRecorder(
  apiRef: RefObject<GanttApi<EventData> | null>,
): ChangesetRecorder {
  const opsMap = new Map<string, ChangeOp>()
  const listeners = new Set<() => void>()
  let snapshot: ChangeOp[] = []

  const notify = () => {
    snapshot = Array.from(opsMap.values())
    for (const l of listeners) l()
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
      opsMap.clear()
      notify()
    },
    onEventUpdate(p) {
      const { event, start, end } = p
      if (end.getTime() <= start.getTime()) return false
      opsMap.set(event.id, {
        op: "update",
        id: event.id,
        patch: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
      })
      notify()
      return true
    },
    canSelectSlot(slot) {
      return Boolean(slot.resourceId)
    },
    onSelectSlot(slot) {
      if (!slot.resourceId) return
      const id = `tmp-${crypto.randomUUID()}`
      const event: GanttEvent<EventData> = {
        id,
        title: titleize(slot.resourceId),
        start: slot.start,
        end: slot.end,
        allDay: true,
        resourceId: slot.resourceId,
        color: "var(--color-indigo-500)",
        data: {
          responsable: RESPONSABLES[slot.resourceId] ?? "—",
          fase: slot.resourceId,
          status: "Programado",
        },
      }
      apiRef.current?.addEvent(event)
      opsMap.set(id, {
        op: "create",
        event: {
          id,
          resourceId: slot.resourceId,
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          progress: 0,
          title: event.title,
          color: event.color,
          data: event.data!,
        },
      })
      notify()
    },
  }
}

function titleize(id: string): string {
  return id
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}
