// GanttActuals: accumulated actual cost per event at a DATA DATE cutoff,
// as a sibling umeJSON entity of the plan. The capture records WHICH
// baseline was in force per event (its version), so PV is reproducible
// against the reference the capture measured — the bitácora is
// append-only, but the vigente version can move on after the cutoff.
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` and the backend
// imports it verbatim, same as every other contract module.
import type { PlanJSON } from "../plan-types.ts"
import {
  ENTITY_NAME,
  SENTINEL,
  err,
  isIsoDate,
  isObject,
  validateUmeEnvelope,
  type UmeJsonEntity,
  type UmeJsonLifecycle,
  type UmeJsonState,
  type ValidationError,
} from "./schema.ts"

export const ENTITY_NAME_ACTUALS = "GanttActuals"
export const ACTUALS_SCHEMA_VERSION = 1

export interface ActualsPayload {
  schemaVersion: 1
  /** Corte: everything is measured up to this instant (ISO). */
  dataDate: string
  /** Anchor of the plan revision the capture ran against. */
  planAnchor: string
  /** Accumulated actual cost per event id. */
  acByEvent: Record<string, number>
  /**
   * Vigente baseline VERSION per event at capture time — the reference
   * the numbers were cut against. Events without history carry no entry.
   */
  baselineVersionByEvent?: Record<string, number>
}

export interface UmeActualsEntity {
  id: string
  entityName: typeof ENTITY_NAME_ACTUALS
  dynamicProperties: { actuals: ActualsPayload; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  state: UmeJsonState
  markdownDocumentation: string
  relations?: UmeJsonEntity["relations"]
}

export type DecodeActualsResult =
  | { ok: true; entity: UmeActualsEntity; actuals: ActualsPayload }
  | { ok: false; errors: ValidationError[] }

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

export function decodeActuals(
  input: unknown,
  plan?: PlanJSON,
  planEntityId?: string,
): DecodeActualsResult {
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }
  const errors = validateUmeEnvelope(input, ENTITY_NAME_ACTUALS)

  const actuals = isObject(input.dynamicProperties)
    ? input.dynamicProperties.actuals
    : undefined
  const P = "dynamicProperties.actuals"
  if (!isObject(actuals)) {
    errors.push(err(P, "type", "actuals must be an object"))
  } else {
    if (actuals.schemaVersion !== ACTUALS_SCHEMA_VERSION) {
      errors.push(err(`${P}.schemaVersion`, "enum", `schemaVersion must be ${ACTUALS_SCHEMA_VERSION}`))
    }
    if (!isIsoDate(actuals.dataDate) || actuals.dataDate === SENTINEL) {
      errors.push(err(`${P}.dataDate`, "iso", "dataDate must be an ISO date string"))
    }
    if (!isIsoDate(actuals.planAnchor) || actuals.planAnchor === SENTINEL) {
      errors.push(err(`${P}.planAnchor`, "iso", "planAnchor must be an ISO date string"))
    }
    if (!isObject(actuals.acByEvent)) {
      errors.push(err(`${P}.acByEvent`, "type", "acByEvent must be an object"))
    } else {
      for (const [eventId, ac] of Object.entries(actuals.acByEvent)) {
        if (!isFiniteNumber(ac)) {
          errors.push(err(`${P}.acByEvent["${eventId}"]`, "type", "AC must be a finite number"))
        } else if (ac < 0) {
          errors.push(err(`${P}.acByEvent["${eventId}"]`, "range", "AC must be >= 0"))
        }
      }
    }
    if (actuals.baselineVersionByEvent !== undefined) {
      if (!isObject(actuals.baselineVersionByEvent)) {
        errors.push(err(`${P}.baselineVersionByEvent`, "type", "baselineVersionByEvent must be an object"))
      } else {
        for (const [eventId, version] of Object.entries(actuals.baselineVersionByEvent)) {
          if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
            errors.push(err(`${P}.baselineVersionByEvent["${eventId}"]`, "type", "baseline version must be an integer >= 1"))
          }
        }
      }
    }
  }

  if (input.relations !== undefined) {
    if (!Array.isArray(input.relations) || input.relations.length !== 1) {
      errors.push(err("relations", "type", "an actuals document carries exactly one relation (to its plan)"))
    } else {
      const rel = input.relations[0]
      if (!isObject(rel) || rel.targetEntity !== ENTITY_NAME) {
        errors.push(err("relations[0].targetEntity", "enum", `relation targetEntity must be "${ENTITY_NAME}"`))
      }
      if (!isObject(rel) || typeof rel.targetId !== "string" || rel.targetId === "") {
        errors.push(err("relations[0].targetId", "type", "relation targetId must be a non-empty string"))
      } else if (planEntityId !== undefined && rel.targetId !== planEntityId) {
        errors.push(err("relations[0].targetId", "ref", `actuals relate to plan "${rel.targetId}" but the supplied plan entity is "${planEntityId}"`))
      }
    }
  }

  if (plan && isObject(actuals)) {
    const known = new Set(plan.events.map((e) => e.id))
    if (isObject(actuals.acByEvent)) {
      for (const eventId of Object.keys(actuals.acByEvent)) {
        if (!known.has(eventId)) {
          errors.push(err(`${P}.acByEvent["${eventId}"]`, "ref", `actual cost references unknown event "${eventId}"`))
        }
      }
    }
    if (isObject(actuals.baselineVersionByEvent)) {
      for (const eventId of Object.keys(actuals.baselineVersionByEvent)) {
        if (!known.has(eventId)) {
          errors.push(err(`${P}.baselineVersionByEvent["${eventId}"]`, "ref", `baseline anchor references unknown event "${eventId}"`))
        }
      }
    }
    // Cross-check against the bitácora: an anchored version must exist.
    if (isObject(actuals.baselineVersionByEvent)) {
      const historyOf = new Map(plan.events.map((e) => [e.id, e.baselines ?? []]))
      for (const [eventId, version] of Object.entries(actuals.baselineVersionByEvent)) {
        const history = historyOf.get(eventId)
        if (
          history && typeof version === "number" &&
          !history.some((b) => b.version === version)
        ) {
          errors.push(err(`${P}.baselineVersionByEvent["${eventId}"]`, "ref", `event "${eventId}" has no baseline version ${version}`))
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entity: input as unknown as UmeActualsEntity,
    actuals: actuals as unknown as ActualsPayload,
  }
}

/** Envelope builder for programmatic construction (demo/seed). */
export function buildActualsEntity(input: {
  id: string
  planEntityId: string
  actuals: ActualsPayload
  markdownDocumentation?: string
}): UmeActualsEntity {
  const now = new Date().toISOString()
  return {
    id: input.id,
    entityName: ENTITY_NAME_ACTUALS,
    dynamicProperties: { actuals: input.actuals },
    lifecycle: { createdAt: now, updatedAt: now, deletedAt: null, version: 1 },
    state: {
      current: "active",
      statusLog: [{ status: "active", timestamp: now, reason: "actuals captured" }],
    },
    markdownDocumentation:
      input.markdownDocumentation ??
      `# Avances reales\n\nCosto real acumulado por evento del plan ${input.planEntityId} al corte ${input.actuals.dataDate}.`,
    relations: [
      {
        targetEntity: ENTITY_NAME,
        targetId: input.planEntityId,
        type: "one-to-one",
        context: "actuals-for",
      },
    ],
  }
}
