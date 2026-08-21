import type {
  GanttEvent,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import { PLAN, RESPONSABLES, type EventData, type PlanJSON } from "@/data/plan-departamento"

const phaseColorById = new Map(PLAN.phases.map((p) => [p.id, p.color]))

const statusFor = (eventId: string): string => {
  const ev = PLAN.events.find((e) => e.id === eventId)
  if (!ev) return "Sin programar"
  if (ev.progress >= 100) return "Terminado"
  if (ev.progress > 0) return "En curso"
  return "Pendiente"
}

export function toGanttEvents(plan: PlanJSON): GanttEvent<EventData>[] {
  return plan.events.map((e) => {
    const phaseId = findPhase(e.resourceId)
    return {
      id: e.id,
      title: titleize(e.resourceId),
      start: new Date(e.start),
      end: new Date(e.end),
      allDay: true,
      progress: e.progress,
      resourceId: e.resourceId,
      color: phaseColorById.get(phaseId),
      data: {
        responsable: RESPONSABLES[e.resourceId] ?? "—",
        fase: phaseId,
        status: statusFor(e.id),
      },
    }
  })
}

export function toGanttResources(plan: PlanJSON): GanttResource[] {
  return plan.phases.map((p) => ({
    id: p.id,
    title: p.title,
    color: p.color,
    children: p.resourceIds
      .filter((rid) => rid !== p.id)
      .map((rid) => ({
        id: rid,
        title: titleize(rid),
      })),
  }))
}

function findPhase(resourceId: string): string {
  return (
    PLAN.phases.find((p) => p.resourceIds.includes(resourceId))?.id ?? "entrega"
  )
}

function titleize(id: string): string {
  return id
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}
