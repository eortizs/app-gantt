import type {
  GanttEvent,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import type { EventData, PlanJSON, PlanResource } from "@/lib/plan-types"
import { APP_STRINGS_ES } from "@/lib/i18n-es"

export function toGanttEvents(plan: PlanJSON): GanttEvent<EventData>[] {
  const byId = new Map(plan.resources.map((r) => [r.id, r]))
  const phaseColorById = new Map(plan.phases.map((p) => [p.id, p.color]))
  const statusFor = (progress: number): string => {
    if (progress >= 100) return "Terminado"
    if (progress > 0) return "En curso"
    return "Pendiente"
  }
  return plan.events.map((e) => {
    const phaseId = resolvePhaseId(e.resourceId, byId) ?? ""
    const resource = byId.get(e.resourceId)
    // Load-time snapshot: every event carries at least LB1, the plan AS
    // LOADED. Events with a persisted history keep theirs (their LB1 was
    // captured when the document was authored); the rest get one synthesized
    // from their own dates. This is what makes the first explicit capture a
    // TWO-entry log - the default line plus the new one.
    const baselines =
      e.baselines && e.baselines.length > 0
        ? e.baselines
        : [
            {
              version: 1,
              start: e.start,
              end: e.end,
              capturedAt: plan.anchor,
              reason: APP_STRINGS_ES.baselineOriginalReason,
            },
          ]
    return {
      id: e.id,
      title: resource?.title ?? titleize(e.resourceId),
      start: new Date(e.start),
      end: new Date(e.end),
      allDay: true,
      progress: e.progress,
      resourceId: e.resourceId,
      color: phaseColorById.get(phaseId),
      data: {
        responsable: resource?.responsable ?? "—",
        fase: phaseId,
        status: statusFor(e.progress),
        baselines,
      },
    }
  })
}

export function toGanttResources(plan: PlanJSON): GanttResource[] {
  const byId = new Map(plan.resources.map((r) => [r.id, r]))

  // A node hangs from its parent ONLY if its ancestor chain terminates at a
  // real parentless root (no missing parentId, no cycle). Parentless nodes,
  // orphans, and cycle members become roots, so every resource stays
  // reachable exactly once.
  const isRoot = (r: PlanResource): boolean => {
    if (!r.parentId) return true
    const seen = new Set<string>()
    let cur: PlanResource | undefined = r
    while (cur?.parentId) {
      if (seen.has(cur.id)) return true // walked into a cycle
      seen.add(cur.id)
      const parent = byId.get(cur.parentId)
      if (!parent) return true // orphaned parentId
      cur = parent
    }
    return false
  }

  // child index in declaration order (sibling order)
  const childIds = new Map<string, string[]>()
  const rootIds: string[] = []
  for (const r of plan.resources) {
    if (isRoot(r)) rootIds.push(r.id)
    else {
      const list = childIds.get(r.parentId!)
      if (list) list.push(r.id)
      else childIds.set(r.parentId!, [r.id])
    }
  }

  const buildNode = (id: string): GanttResource => {
    const r = byId.get(id)!
    const kids = childIds.get(id)
    return {
      id: r.id,
      title: r.title,
      ...(kids?.length ? { children: kids.map(buildNode) } : {}),
    }
  }

  return rootIds.map(buildNode)
}

function resolvePhaseId(
  resourceId: string,
  byId: Map<string, PlanResource>,
): string | undefined {
  const visiting = new Set<string>()
  let current: string | undefined = resourceId
  while (current) {
    if (visiting.has(current)) return undefined
    visiting.add(current)
    const r: PlanResource | undefined = byId.get(current)
    if (!r) return undefined
    if (r.phaseId) return r.phaseId
    current = r.parentId
  }
  return undefined
}

function titleize(id: string): string {
  return id
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ")
}
