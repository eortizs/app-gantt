// Deterministic stress-plan generator for virtualization benchmarks:
// 1k / 5k / 20k events with a realistic WBS tree (root → phase groups →
// tasks), one long FS chain across the whole plan so cascades and the
// dependency layer have real work, seeded priorities and 1:1
// resource↔event mapping like the demo. Same seed ⇒ byte-identical plan.
//
// Runtime-pure imports (relative `.ts`): this module is loaded by Vite
// (App `?stress=N`) AND by scripts/gen-stress-plan.mts under
// node --experimental-strip-types.
import type {
  PlanDependency,
  PlanEvent,
  PlanJSON,
  PlanPhase,
  PlanResource,
} from "../lib/plan-types.ts"
import { addWorkingDays, type WorkingCalendar } from "../lib/umejson/working-time.ts"
import type { UmeJsonEntity } from "../lib/umejson/schema.ts"

/** Tasks per phase group; keeps the WBS depth realistic at any scale. */
const PHASE_SIZE = 10

/** Concrete hexes cycled across phase groups (same rule as the demo). */
const PALETTE = [
  "#78716c",
  "#0ea5e9",
  "#3b82f6",
  "#f59e0b",
  "#14b8a6",
  "#8b5cf6",
  "#10b981",
  "#ef4444",
  "#ec4899",
  "#6366f1",
]

/** Mon–Fri working calendar, same shape the calendar sibling validates. */
const CAL: WorkingCalendar = {
  id: "stress-cal",
  title: "Lun–Vie",
  workWeek: [false, true, true, true, true, true, false],
  exceptions: {},
}

export const STRESS_PLAN_ID = "00000000-0000-4000-8000-0000000000ff"

/** Deterministic hash → [0, max) (same spirit as demo builders). */
const hashOf = (id: string, max: number): number => {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % max
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Builds a stress plan with exactly `count` task/milestone events. The
 * anchor is the Monday of the current week (demo convention); every event
 * derives its dates from `addWorkingDays` over the Mon–Fri calendar, so the
 * chain loads sitting exactly on its constraints (zero violations by
 * construction).
 */
export function buildStressPlan(count: number): PlanJSON {
  const n = Math.max(1, Math.floor(count))
  const anchorMs = (() => {
    const now = new Date()
    const day = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
    monday.setUTCHours(12, 0, 0, 0)
    return monday.getTime()
  })()

  const groupCount = Math.ceil(n / PHASE_SIZE)
  const phases: PlanPhase[] = Array.from({ length: groupCount }, (_, g) => ({
    id: `ph-${g}`,
    title: `Fase ${g + 1}`,
    color: PALETTE[g % PALETTE.length]!,
  }))

  const resources: PlanResource[] = [
    { id: "stress-root", title: `Plan de estrés (${n} eventos)` },
  ]
  for (let g = 0; g < groupCount; g++) {
    resources.push({
      id: `grp-${g}`,
      title: `Fase ${g + 1}`,
      parentId: "stress-root",
      phaseId: `ph-${g}`,
    })
  }

  const events: PlanEvent[] = []
  const dependencies: PlanDependency[] = []
  let prevEndMs: number | null = null
  for (let j = 0; j < n; j++) {
    const g = Math.floor(j / PHASE_SIZE)
    const slot = j % PHASE_SIZE
    const eventId = `t${j}`
    const isMilestone = j > 0 && j % 25 === 0
    const startMs: number =
      prevEndMs === null
        ? addWorkingDays(CAL, anchorMs, 0)
        : addWorkingDays(CAL, prevEndMs, 0)
    const durationDays = isMilestone ? 0 : 1 + hashOf(`dur-${eventId}`, 5)
    const endMs: number = isMilestone
      ? startMs
      : addWorkingDays(CAL, startMs, durationDays)
    const event: PlanEvent = {
      id: eventId,
      resourceId: eventId,
      start: iso(startMs),
      end: iso(endMs),
      progress: [0, 25, 50, 75, 100][hashOf(`pr-${eventId}`, 5)]!,
      ...(isMilestone ? { kind: "milestone" as const } : {}),
      priority: 1 + hashOf(`prio-${eventId}`, 1000),
    }
    events.push(event)
    resources.push({
      id: eventId,
      title: isMilestone
        ? `Hito ${j + 1} · Fase ${g + 1}`
        : `Tarea ${j + 1}.${slot + 1} · Fase ${g + 1}`,
      parentId: `grp-${g}`,
    })
    if (j > 0) {
      // Unconditional link (milestones included): duration 0 keeps the
      // chain continuous - every successor sits exactly at its bound.
      dependencies.push({
        id: `d${j}`,
        fromEventId: `t${j - 1}`,
        toEventId: eventId,
        type: "FS",
      })
    }
    prevEndMs = endMs
  }

  return {
    schemaVersion: 2,
    anchor: iso(anchorMs),
    resources,
    phases,
    events,
    dependencies,
  }
}

const nowIso = (): string => new Date().toISOString()

/**
 * Full umeJSON envelope around a stress plan (demo-entity shape), so the
 * App can swap the whole bundle for a generated one under `?stress=N`.
 */
export function buildStressEntity(count: number): UmeJsonEntity {
  const now = nowIso()
  return {
    id: STRESS_PLAN_ID,
    entityName: "GanttPlan",
    dynamicProperties: { plan: buildStressPlan(count) },
    lifecycle: {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    },
    state: {
      current: "active",
      statusLog: [
        { status: "draft", timestamp: now, reason: "stress generator" },
        {
          status: "active",
          timestamp: now,
          reason: `stress plan (${count} events)`,
        },
      ],
    },
    markdownDocumentation:
      `# Plan de estrés (${count} eventos)\n\n` +
      "Generado deterministicamente por `scripts/gen-stress-plan.mts` para " +
      "benchmark de virtualización. No persiste: vive solo en memoria.",
  }
}
