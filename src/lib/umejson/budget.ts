// GanttBudget: the plan's cost baseline as a sibling umeJSON entity. The
// plan schema stays frozen at v2, so contable data lives in its OWN
// document bound to the plan via relations[] — one budget per plan
// (one-to-one), BAC at event granularity, uniform time-phasing (the only
// policy schema v1 defines; others are a v2 decision).
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` and the backend
// imports it verbatim, same as every other contract module.
import type { PlanJSON } from "../plan-types.ts"
import {
  ENTITY_NAME,
  err,
  isObject,
  validateUmeEnvelope,
  type UmeJsonEntity,
  type UmeJsonLifecycle,
  type UmeJsonState,
  type ValidationError,
} from "./schema.ts"

export const ENTITY_NAME_BUDGET = "GanttBudget"
export const BUDGET_SCHEMA_VERSION = 1

/** The only time-phasing policy budget schema v1 defines. */
export type TimePhasingPolicy = "uniform"

/**
 * Per-event split of the BAC. When present, `labor + material +
 * equipment` must equal `bacByEvent[eventId]` EXACTLY — the breakdown is
 * a partition, not an extra budget. Feeds the CR cost model (labor-burn).
 */
export interface CostBreakdown {
  labor: number
  material: number
  equipment: number
}

export interface BudgetPayload {
  schemaVersion: 1
  /** ISO 4217 code the amounts are denominated in ("MXN"). */
  currency: string
  timePhasing: TimePhasingPolicy
  /** Budget at completion, per event id. Events absent carry no BAC. */
  bacByEvent: Record<string, number>
  /** Optional per-event breakdown of the BAC (additive; schema stays 1). */
  breakdownByEvent?: Record<string, CostBreakdown>
}

export interface UmeBudgetEntity {
  id: string
  entityName: typeof ENTITY_NAME_BUDGET
  dynamicProperties: { budget: BudgetPayload; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  markdownDocumentation: string
  relations?: UmeJsonEntity["relations"]
}

export type DecodeBudgetResult =
  | { ok: true; entity: UmeBudgetEntity; budget: BudgetPayload }
  | { ok: false; errors: ValidationError[] }

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

/**
 * Hand-rolled validator in the decodeUmePlan style: envelope via the
 * shared helper, payload (currency, uniform phasing, BAC map), and —
 * when the plan is supplied — that every budgeted event exists and the
 * relation points at that plan.
 */
export function decodeBudget(
  input: unknown,
  plan?: PlanJSON,
  planEntityId?: string,
): DecodeBudgetResult {
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }
  const errors = validateUmeEnvelope(input, ENTITY_NAME_BUDGET)

  const budget = isObject(input.dynamicProperties)
    ? input.dynamicProperties.budget
    : undefined
  const P = "dynamicProperties.budget"
  if (!isObject(budget)) {
    errors.push(err(P, "type", "budget must be an object"))
  } else {
    if (budget.schemaVersion !== BUDGET_SCHEMA_VERSION) {
      errors.push(err(`${P}.schemaVersion`, "enum", `schemaVersion must be ${BUDGET_SCHEMA_VERSION}`))
    }
    if (typeof budget.currency !== "string" || budget.currency === "") {
      errors.push(err(`${P}.currency`, "type", "currency must be a non-empty string"))
    }
    if (budget.timePhasing !== "uniform") {
      errors.push(err(`${P}.timePhasing`, "enum", 'timePhasing must be "uniform"'))
    }
    if (!isObject(budget.bacByEvent)) {
      errors.push(err(`${P}.bacByEvent`, "type", "bacByEvent must be an object"))
    } else {
      for (const [eventId, bac] of Object.entries(budget.bacByEvent)) {
        if (!isFiniteNumber(bac)) {
          errors.push(err(`${P}.bacByEvent["${eventId}"]`, "type", "BAC must be a finite number"))
        } else if (bac < 0) {
          errors.push(err(`${P}.bacByEvent["${eventId}"]`, "range", "BAC must be >= 0"))
        }
      }
    }
    // Desglose opcional: cada parte finita >= 0 y la suma EXACTA al BAC
    // del mismo evento (partición, no presupuesto extra).
    if (budget.breakdownByEvent !== undefined) {
      if (!isObject(budget.breakdownByEvent)) {
        errors.push(err(`${P}.breakdownByEvent`, "type", "breakdownByEvent must be an object"))
      } else {
        for (const [eventId, breakdown] of Object.entries(budget.breakdownByEvent)) {
          const bp = `${P}.breakdownByEvent["${eventId}"]`
          if (!isObject(breakdown)) {
            errors.push(err(bp, "type", "breakdown must be an object"))
            continue
          }
          let sum = 0
          for (const part of ["labor", "material", "equipment"] as const) {
            const v = breakdown[part]
            if (!isFiniteNumber(v) || v < 0) {
              errors.push(err(`${bp}.${part}`, "range", `${part} must be a finite number >= 0`))
            } else {
              sum += v
            }
          }
          const bac = isObject(budget.bacByEvent)
            ? (budget.bacByEvent as Record<string, unknown>)[eventId]
            : undefined
          if (!isFiniteNumber(bac)) {
            errors.push(err(bp, "ref", `breakdown for "${eventId}" has no BAC to partition`))
          } else if (sum !== bac) {
            errors.push(err(bp, "sum", `labor+material+equipment (${sum}) must equal the BAC (${bac}) exactly`))
          }
        }
      }
    }
  }

  // Binding: relations[0] must point at a GanttPlan; when the plan is
  // supplied, at THAT plan.
  if (input.relations !== undefined) {
    if (!Array.isArray(input.relations) || input.relations.length !== 1) {
      errors.push(err("relations", "type", "a budget carries exactly one relation (to its plan)"))
    } else {
      const rel = input.relations[0]
      if (!isObject(rel) || rel.targetEntity !== ENTITY_NAME) {
        errors.push(err("relations[0].targetEntity", "enum", `relation targetEntity must be "${ENTITY_NAME}"`))
      }
      if (!isObject(rel) || typeof rel.targetId !== "string" || rel.targetId === "") {
        errors.push(err("relations[0].targetId", "type", "relation targetId must be a non-empty string"))
      } else if (planEntityId !== undefined && rel.targetId !== planEntityId) {
        errors.push(err("relations[0].targetId", "ref", `budget relates to plan "${rel.targetId}" but the supplied plan entity is "${planEntityId}"`))
      }
    }
  }

  if (plan && isObject(budget) && isObject(budget.bacByEvent)) {
    const known = new Set(plan.events.map((e) => e.id))
    for (const eventId of Object.keys(budget.bacByEvent)) {
      if (!known.has(eventId)) {
        errors.push(err(`${P}.bacByEvent["${eventId}"]`, "ref", `budgeted event "${eventId}" is not an event of the supplied plan`))
      }
    }
    if (isObject(budget.breakdownByEvent)) {
      for (const eventId of Object.keys(budget.breakdownByEvent)) {
        if (!known.has(eventId)) {
          errors.push(err(`${P}.breakdownByEvent["${eventId}"]`, "ref", `broken-down event "${eventId}" is not an event of the supplied plan`))
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeBudgetEntity,
    budget: budget as unknown as BudgetPayload,
  }
}

/** Envelope builder for programmatic construction (demo/seed). */
export function buildBudgetEntity(input: {
  id: string
  planEntityId: string
  planAnchor: string
  budget: BudgetPayload
  markdownDocumentation?: string
}): UmeBudgetEntity {
  const now = new Date().toISOString()
  return {
    id: input.id,
    entityName: ENTITY_NAME_BUDGET,
    dynamicProperties: { budget: input.budget },
    lifecycle: { createdAt: now, updatedAt: now, deletedAt: null, version: 1 },
    state: {
      current: "active",
      statusLog: [{ status: "active", timestamp: now, reason: "budget created" }],
    },
    markdownDocumentation:
      input.markdownDocumentation ??
      `# Presupuesto\n\nBAC por evento del plan ${input.planEntityId} (ancla ${input.planAnchor}), moneda ${input.budget.currency}, time-phasing uniforme.`,
    relations: [{
      targetEntity: ENTITY_NAME,
      targetId: input.planEntityId,
      type: "one-to-one",
      context: "budget-for",
    }],
  }
}
