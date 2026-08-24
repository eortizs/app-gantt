import type {
  GanttDependencyMark,
  GanttEvent,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import type {
  EventData,
  PlanDependency,
  PlanJSON,
  PlanResource,
} from "@/lib/plan-types"

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
    // Baselines exist ONLY where a real capture happened: the seeded demo
    // history shipped in the plan, or an explicit «Fijar línea base». No
    // load-time LB1 is synthesized - a synthetic one anchored every bar's
    // original position, so each drag left a full-size colored remnant
    // pinned at the old dates (read as a useless ghost). Instead, the first
    // capture on a drifted bare task materializes LB1 lazily from these
    // initial dates (see captureBaseline in the viewer).
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
        // Original dates: the drift anchor for tasks that never captured
        // a baseline. Kept in EventData (not PlanEvent) so the bitácora
        // stays append-only and «Reiniciar plan» re-stamps fresh ones.
        initialStart: e.start,
        initialEnd: e.end,
        ...(e.baselines && e.baselines.length > 0
          ? { baselines: e.baselines }
          : {}),
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

const DAY_MS = 86_400_000

/**
 * A constraint is violated when the successor sits EARLIER than the
 * constraint demands (FS/SS bound the start; FF/SF bound the end). Only
 * forward violations count - extra slack is healthy float, not a problem.
 */
function isViolated(
  dep: PlanDependency,
  fromStartMs: number,
  fromEndMs: number,
  toStartMs: number,
  toEndMs: number,
): boolean {
  const lag = (dep.lagDays ?? 0) * DAY_MS
  switch (dep.type) {
    case "SS":
      return toStartMs < fromStartMs + lag
    case "FF":
      return toEndMs < fromEndMs + lag
    case "SF":
      return toEndMs < fromStartMs + lag
    case "FS":
    default:
      return toStartMs < fromEndMs + lag
  }
}

/**
 * Dependency marks for the engine's connector overlay. Dates come from the
 * LIVE event list (post-drag, post-cascade), so a violation lights up the
 * moment a drag creates one - before anything is committed to the document.
 * Edges with unknown endpoints are skipped; the validator rejects those at
 * decode time anyway.
 */
export function resolveDependencyMarks(
  dependencies: readonly PlanDependency[],
  events: readonly GanttEvent<EventData>[],
): GanttDependencyMark[] {
  if (!dependencies.length || !events.length) return []
  const byId = new Map(events.map((e) => [e.id, e]))
  const marks: GanttDependencyMark[] = []
  for (const dep of dependencies) {
    const from = byId.get(dep.fromEventId)
    const to = byId.get(dep.toEventId)
    if (!from || !to) continue
    marks.push({
      key: dep.id,
      fromEventId: dep.fromEventId,
      toEventId: dep.toEventId,
      type: dep.type,
      violated: isViolated(
        dep,
        from.start.getTime(),
        from.end.getTime(),
        to.start.getTime(),
        to.end.getTime(),
      ),
    })
  }
  return marks
}
