// GanttWorkforce: the plan's RRHH data as a sibling umeJSON entity —
// crews (specialty, headcount, day rate) plus which crew an event draws
// on. The plan schema stays frozen at v2, so obra data lives in its OWN
// document bound to the plan via relations[] (one workforce per plan),
// same pattern as GanttBudget/GanttActuals.
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

export const ENTITY_NAME_WORKFORCE = "GanttWorkforce"
export const WORKFORCE_SCHEMA_VERSION = 1

export interface WorkforceCrew {
  id: string
  title: string
  specialty: string
  /** People in the crew (integer >= 1). */
  headcount: number
  /** MXN per person per day (finite, >= 0). */
  dayRate: number
}

export interface CrewAssignment {
  crewId: string
  /** People of that crew the event draws on (integer >= 1). */
  headcount: number
}

export interface WorkforcePayload {
  schemaVersion: 1
  crews: WorkforceCrew[]
  /** Event id → crew allocation. Events absent carry no assignment. */
  assignmentByEvent: Record<string, CrewAssignment>
}

export interface UmeWorkforceEntity {
  id: string
  entityName: typeof ENTITY_NAME_WORKFORCE
  dynamicProperties: { workforce: WorkforcePayload; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  markdownDocumentation: string
  relations?: UmeJsonEntity["relations"]
}

export type DecodeWorkforceResult =
  | { ok: true; entity: UmeWorkforceEntity; workforce: WorkforcePayload }
  | { ok: false; errors: ValidationError[] }

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1

const validateHeadcount = (
  v: unknown,
  path: string,
  errors: ValidationError[],
): void => {
  if (!isPositiveInt(v)) {
    errors.push(err(path, "range", "headcount must be an integer >= 1"))
  }
}

/**
 * Hand-rolled validator in the decodeBudget style: envelope via the
 * shared helper, payload (crews with unique ids, assignments referencing
 * existing crews), and — when the plan is supplied — that every assigned
 * event exists and the relation points at that plan.
 */
export function decodeWorkforce(
  input: unknown,
  plan?: PlanJSON,
  planEntityId?: string,
): DecodeWorkforceResult {
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }
  const errors = validateUmeEnvelope(input, ENTITY_NAME_WORKFORCE)

  const workforce = isObject(input.dynamicProperties)
    ? input.dynamicProperties.workforce
    : undefined
  const P = "dynamicProperties.workforce"
  if (!isObject(workforce)) {
    errors.push(err(P, "type", "workforce must be an object"))
  } else {
    if (workforce.schemaVersion !== WORKFORCE_SCHEMA_VERSION) {
      errors.push(err(`${P}.schemaVersion`, "enum", `schemaVersion must be ${WORKFORCE_SCHEMA_VERSION}`))
    }
    if (!Array.isArray(workforce.crews)) {
      errors.push(err(`${P}.crews`, "type", "crews must be an array"))
    } else {
      const crewIds = new Set<string>()
      workforce.crews.forEach((crew: unknown, i: number) => {
        const cp = `${P}.crews[${i}]`
        if (!isObject(crew)) {
          errors.push(err(cp, "type", "crew must be an object"))
          return
        }
        if (typeof crew.id !== "string" || crew.id === "") {
          errors.push(err(`${cp}.id`, "type", "crew.id must be a non-empty string"))
        } else if (crewIds.has(crew.id)) {
          errors.push(err(`${cp}.id`, "unique", `duplicate crew id "${crew.id}"`))
        } else {
          crewIds.add(crew.id)
        }
        if (typeof crew.title !== "string" || crew.title === "") {
          errors.push(err(`${cp}.title`, "type", "crew.title must be a non-empty string"))
        }
        if (typeof crew.specialty !== "string" || crew.specialty === "") {
          errors.push(err(`${cp}.specialty`, "type", "crew.specialty must be a non-empty string"))
        }
        validateHeadcount(crew.headcount, `${cp}.headcount`, errors)
        if (!isFiniteNumber(crew.dayRate) || crew.dayRate < 0) {
          errors.push(err(`${cp}.dayRate`, "range", "crew.dayRate must be a finite number >= 0"))
        }
      })
    }
    if (!isObject(workforce.assignmentByEvent)) {
      errors.push(err(`${P}.assignmentByEvent`, "type", "assignmentByEvent must be an object"))
    } else if (Array.isArray(workforce.crews)) {
      const crewIds = new Set(
        workforce.crews
          .filter(isObject)
          .filter((c) => typeof c.id === "string")
          .map((c) => c.id as string),
      )
      for (const [eventId, assignment] of Object.entries(workforce.assignmentByEvent)) {
        const ap = `${P}.assignmentByEvent["${eventId}"]`
        if (!isObject(assignment)) {
          errors.push(err(ap, "type", "assignment must be an object"))
          continue
        }
        if (typeof assignment.crewId !== "string" || !crewIds.has(assignment.crewId)) {
          errors.push(err(`${ap}.crewId`, "ref", `assignment references unknown crew "${String(assignment.crewId)}"`))
        }
        validateHeadcount(assignment.headcount, `${ap}.headcount`, errors)
      }
    }
  }

  // Binding: relations[0] must point at a GanttPlan; when the plan is
  // supplied, at THAT plan.
  if (input.relations !== undefined) {
    if (!Array.isArray(input.relations) || input.relations.length !== 1) {
      errors.push(err("relations", "type", "a workforce carries exactly one relation (to its plan)"))
    } else {
      const rel = input.relations[0]
      if (!isObject(rel) || rel.targetEntity !== ENTITY_NAME) {
        errors.push(err("relations[0].targetEntity", "enum", `relation targetEntity must be "${ENTITY_NAME}"`))
      }
      if (!isObject(rel) || typeof rel.targetId !== "string" || rel.targetId === "") {
        errors.push(err("relations[0].targetId", "type", "relation targetId must be a non-empty string"))
      } else if (planEntityId !== undefined && rel.targetId !== planEntityId) {
        errors.push(err("relations[0].targetId", "ref", `workforce relates to plan "${rel.targetId}" but the supplied plan entity is "${planEntityId}"`))
      }
    }
  }

  if (plan && isObject(workforce) && isObject(workforce.assignmentByEvent)) {
    const known = new Set(plan.events.map((e) => e.id))
    for (const eventId of Object.keys(workforce.assignmentByEvent)) {
      if (!known.has(eventId)) {
        errors.push(err(`${P}.assignmentByEvent["${eventId}"]`, "ref", `assigned event "${eventId}" is not an event of the supplied plan`))
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeWorkforceEntity,
    workforce: workforce as unknown as WorkforcePayload,
  }
}

/** Envelope builder for programmatic construction (demo/seed). */
export function buildWorkforceEntity(input: {
  id: string
  planEntityId: string
  planAnchor: string
  workforce: WorkforcePayload
  markdownDocumentation?: string
}): UmeWorkforceEntity {
  const now = new Date().toISOString()
  return {
    id: input.id,
    entityName: ENTITY_NAME_WORKFORCE,
    dynamicProperties: { workforce: input.workforce },
    lifecycle: { createdAt: now, updatedAt: now, deletedAt: null, version: 1 },
    state: {
      current: "active",
      statusLog: [{ status: "active", timestamp: now, reason: "workforce created" }],
    },
    markdownDocumentation:
      input.markdownDocumentation ??
      `# Cuadrillas\n\nRRHH del plan ${input.planEntityId} (ancla ${input.planAnchor}): ${input.workforce.crews.length} cuadrillas y ${Object.keys(input.workforce.assignmentByEvent).length} asignaciones por evento.`,
    relations: [{
      targetEntity: ENTITY_NAME,
      targetId: input.planEntityId,
      type: "one-to-one",
      context: "workforce-for",
    }],
  }
}
