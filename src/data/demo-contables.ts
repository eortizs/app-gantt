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

/**
 * Labor/material base shares per phase; equipment absorbs the rest. Labor
 * stays within [0.45, 0.60] (per-event nudge) and material within its own
 * base, so the three parts always partition the BAC with margin.
 */
const SHARES_BY_PHASE: Record<string, { labor: number; material: number }> = {
  preliminares: { labor: 0.55, material: 0.35 },
  cimentacion: { labor: 0.45, material: 0.4 },
  estructura: { labor: 0.5, material: 0.35 },
  albanileria: { labor: 0.6, material: 0.3 },
  instalaciones: { labor: 0.55, material: 0.35 },
  acabados: { labor: 0.5, material: 0.4 },
  entrega: { labor: 0.5, material: 0.35 },
}
const DEFAULT_SHARES = { labor: 0.5, material: 0.375 }

/**
 * BAC por evento: duración × tarifa de fase, redondeado a centenas. Cada
 * BAC lleva además un desglose labor/material/equipo que suma EXACTO
 * (enteros; equipo absorbe el redondeo) — alimenta el modelo de costo
 * labor-burn de las solicitudes de cambio.
 */
export function buildDemoBudget(
  plan: PlanJSON = PLAN,
  planEntityId: string = DEMO_PLAN_ID,
): UmeBudgetEntity {
  const resources = new Map(plan.resources.map((r) => [r.id, r]))
  const bacByEvent: Record<string, number> = {}
  const breakdownByEvent: Record<
    string,
    { labor: number; material: number; equipment: number }
  > = {}
  for (const event of plan.events) {
    const phaseId = resolvePhaseId(event.resourceId, resources)
    const rate = (phaseId && RATE_BY_PHASE[phaseId]) || DEFAULT_RATE
    // A milestone books no work: BAC 0 with an exact 0/0/0 partition. Any
    // other zero-rounding artifact keeps the 1-day floor it always had.
    const floorDays = event.kind === "milestone" ? 0 : 1
    const days = Math.max(
      floorDays,
      Math.round((Date.parse(event.end) - Date.parse(event.start)) / DAY_MS),
    )
    const bac = round100(days * rate)
    bacByEvent[event.id] = bac
    const shares = (phaseId && SHARES_BY_PHASE[phaseId]) || DEFAULT_SHARES
    const t = (wiggleOf(event.id) - 0.85) / 0.3 // [0, 1]
    const laborShare = Math.min(
      0.6,
      Math.max(0.45, shares.labor + (t - 0.5) * 0.1),
    )
    const labor = Math.round(bac * laborShare)
    const material = Math.round(bac * shares.material)
    breakdownByEvent[event.id] = {
      labor,
      material,
      equipment: bac - labor - material,
    }
  }
  return buildBudgetEntity({
    id: DEMO_BUDGET_ID,
    planEntityId,
    planAnchor: plan.anchor,
    budget: {
      schemaVersion: 1,
      currency: "MXN",
      timePhasing: "uniform",
      bacByEvent,
      breakdownByEvent,
    },
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
