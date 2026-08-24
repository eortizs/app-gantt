// Demo sibling entities (budget + actuals) for the demo plan: synthetic
// but realistic amounts, same spirit as the seeded baselines in
// plan-departamento. Shared by the App fallback and the backend seed so
// both sides produce the same documents. Runtime-pure imports (relative
// `.ts`) so server/scripts/seed.ts can load this under node.
import { PLAN } from "./plan-departamento.ts"
import type { PlanJSON } from "../lib/plan-types.ts"
import {
  buildBudgetEntity,
  type UmeBudgetEntity,
} from "../lib/umejson/budget.ts"
import {
  buildActualsEntity,
  type UmeActualsEntity,
} from "../lib/umejson/actuals.ts"
import { vigenteBaseline } from "../lib/umejson/baselines.ts"
import { DEMO_PLAN_ID } from "./demo-entity.ts"

export const DEMO_BUDGET_ID = "00000000-0000-4000-8000-000000000002"
export const DEMO_ACTUALS_ID = "00000000-0000-4000-8000-000000000003"

/** Synthetic daily burn rate per phase (MXN/día), Tailwind-plausible. */
const RATE_BY_PHASE: Record<string, number> = {
  preliminares: 6500,
  cimentacion: 22000,
  estructura: 30000,
  albanileria: 15000,
  instalaciones: 18000,
  acabados: 16000,
  entrega: 5000,
}
const DEFAULT_RATE = 12000

const DAY_MS = 86_400_000

/** phaseId is inheritable through the resource chain (schema v2 quirk). */
function resolvePhaseId(
  resourceId: string,
  byId: Map<string, { id: string; parentId?: string; phaseId?: string }>,
): string | undefined {
  let cursor: string | undefined = resourceId
  for (let depth = 0; cursor !== undefined && depth < 32; depth++) {
    const node = byId.get(cursor)
    if (!node) return undefined
    if (node.phaseId) return node.phaseId
    cursor = node.parentId
  }
  return undefined
}

/** Deterministic per-event wiggle in [0.85, 1.15] so AC ≠ EV × 1 always. */
const wiggleOf = (id: string): number => {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 0.85 + ((h % 31) / 100)
}

const round100 = (v: number): number => Math.round(v / 100) * 100

/** BAC por evento: duración × tarifa de fase, redondeado a centenas. */
export function buildDemoBudget(
  plan: PlanJSON = PLAN,
  planEntityId: string = DEMO_PLAN_ID,
): UmeBudgetEntity {
  const resources = new Map(plan.resources.map((r) => [r.id, r]))
  const bacByEvent: Record<string, number> = {}
  for (const event of plan.events) {
    const phaseId = resolvePhaseId(event.resourceId, resources)
    const rate = (phaseId && RATE_BY_PHASE[phaseId]) || DEFAULT_RATE
    const days = Math.max(
      1,
      Math.round((Date.parse(event.end) - Date.parse(event.start)) / DAY_MS),
    )
    bacByEvent[event.id] = round100(days * rate)
  }
  return buildBudgetEntity({
    id: DEMO_BUDGET_ID,
    planEntityId,
    planAnchor: plan.anchor,
    budget: { schemaVersion: 1, currency: "MXN", timePhasing: "uniform", bacByEvent },
  })
}

/**
 * AC por evento: BAC × avance × wiggle determinista (85%–115%), más el
 * ancla de baseline vigente por evento donde hay bitácora.
 */
export function buildDemoActuals(
  plan: PlanJSON = PLAN,
  budget: UmeBudgetEntity = buildDemoBudget(plan),
  planEntityId: string = DEMO_PLAN_ID,
  dataDate: string = new Date().toISOString(),
): UmeActualsEntity {
  const acByEvent: Record<string, number> = {}
  const baselineVersionByEvent: Record<string, number> = {}
  for (const event of plan.events) {
    const bac = budget.dynamicProperties.budget.bacByEvent[event.id] ?? 0
    if (event.progress > 0) {
      acByEvent[event.id] = round100(
        bac * (event.progress / 100) * wiggleOf(event.id),
      )
    }
    const vigente = vigenteBaseline(event.baselines)
    if (vigente) baselineVersionByEvent[event.id] = vigente.version
  }
  return buildActualsEntity({
    id: DEMO_ACTUALS_ID,
    planEntityId,
    actuals: {
      schemaVersion: 1,
      dataDate,
      planAnchor: plan.anchor,
      acByEvent,
      ...(Object.keys(baselineVersionByEvent).length
        ? { baselineVersionByEvent }
        : {}),
    },
  })
}
