import type { RefObject } from "react"
import type { GanttApi } from "@/components/reui/gantt/gantt"
import type {
  GanttEvent,
  GanttProposedUpdate,
  GanttSlotDraft,
  GanttUpdateResult,
} from "@/components/reui/gantt/gantt-types"
import type { EventData } from "@/lib/plan-types"
import type { ChangeOp } from "@/lib/umejson/codec"

export type { ChangeOp, UpdateOp, CreateOp, DeleteOp } from "@/lib/umejson/codec"

export interface ChangesetRecorder {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChangeOp[]
  getOps(): ChangeOp[]
  reset(): void
  onEventUpdate(p: GanttProposedUpdate<EventData>): GanttUpdateResult
  canSelectSlot(slot: GanttSlotDraft): boolean
  onSelectSlot(slot: GanttSlotDraft): void
}

export interface ChangesetRecorderOpts {
  createDraft?: (slot: GanttSlotDraft) => GanttEvent<EventData> | null
}

export function createChangesetRecorder(
  apiRef: RefObject<GanttApi<EventData> | null>,
  opts: ChangesetRecorderOpts = {},
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
  }
}
