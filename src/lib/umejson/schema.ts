import type { PlanJSON } from "../plan-types.ts"

export const SENTINEL = "RESERVED_FOR_SYSTEM"
export const ENTITY_NAME = "GanttPlan"

export type UmeJsonStatus = "active" | "draft" | "validation_required"

export interface UmeJsonLifecycle {
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  version: number
}

export interface UmeJsonState {
  current: UmeJsonStatus
  statusLog: { status: string; timestamp: string; reason?: string }[]
}

export interface UmeJsonEntity {
  id: string
  entityName: string
  dynamicProperties: { plan: PlanJSON; [k: string]: unknown }
  lifecycle: UmeJsonLifecycle
  relations?: {
    targetEntity: string
    targetId: string
    type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
    context?: string
  }[]
  state: UmeJsonState
  markdownDocumentation: string
}

export interface ValidationError {
  path: string
  code: string
  message: string
}

export type DecodeResult =
  | { ok: true; entity: UmeJsonEntity; plan: PlanJSON }
  | { ok: false; errors: ValidationError[] }

// Shared validator DSL: exported so sibling decoders (change-request)
// validate with the exact same primitives instead of forking their own.
export const err = (path: string, code: string, message: string): ValidationError => ({
  path,
  code,
  message,
})

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string") return false
  const t = Date.parse(s)
  return Number.isFinite(t)
}

export const UME_STATUSES: readonly UmeJsonStatus[] = ["active", "draft", "validation_required"]

/**
 * Envelope validation shared by the sibling entity decoders (budget,
 * actuals, ...): the exact checks `decodeUmePlan` runs on id / entityName
 * / lifecycle / state / markdownDocumentation, parameterized by entity
 * name. Payload validation stays each decoder's own business.
 */
export function validateUmeEnvelope(
  input: Record<string, unknown>,
  expectedEntityName: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  for (const req of ["id", "entityName", "dynamicProperties", "lifecycle", "state", "markdownDocumentation"]) {
    if (!(req in input)) errors.push(err(req, "missing", `field "${req}" is required`))
  }
  if (typeof input.id !== "string" || input.id === "") {
    errors.push(err("id", "type", "id must be a non-empty string"))
  } else if (input.id === SENTINEL) {
    errors.push(err("id", "sentinel", "id must not be RESERVED_FOR_SYSTEM (document not finalized)"))
  }
  if (input.entityName !== expectedEntityName) {
    errors.push(err("entityName", "enum", `entityName must be "${expectedEntityName}"`))
  }
  if (typeof input.markdownDocumentation !== "string") {
    errors.push(err("markdownDocumentation", "type", "markdownDocumentation must be a string"))
  }
  if (!isObject(input.dynamicProperties)) {
    errors.push(err("dynamicProperties", "type", "dynamicProperties must be an object"))
  }
  if (!isObject(input.lifecycle)) {
    errors.push(err("lifecycle", "type", "lifecycle must be an object"))
  } else {
    const lc = input.lifecycle
    if (!isIsoDate(lc.createdAt)) errors.push(err("lifecycle.createdAt", "iso", "createdAt must be ISO date string"))
    else if (lc.createdAt === SENTINEL) errors.push(err("lifecycle.createdAt", "sentinel", "createdAt must not be RESERVED_FOR_SYSTEM"))
    if (!isIsoDate(lc.updatedAt)) errors.push(err("lifecycle.updatedAt", "iso", "updatedAt must be ISO date string"))
    else if (lc.updatedAt === SENTINEL) errors.push(err("lifecycle.updatedAt", "sentinel", "updatedAt must not be RESERVED_FOR_SYSTEM"))
    if (typeof lc.version !== "number" || !Number.isInteger(lc.version) || lc.version < 1) {
      errors.push(err("lifecycle.version", "type", "version must be integer >= 1"))
    }
  }
  if (!isObject(input.state)) {
    errors.push(err("state", "type", "state must be an object"))
  } else {
    if (!UME_STATUSES.includes(input.state.current as UmeJsonStatus)) {
      errors.push(err("state.current", "enum", `current must be one of ${UME_STATUSES.join(", ")}`))
    }
    if (!Array.isArray(input.state.statusLog)) {
      errors.push(err("state.statusLog", "type", "statusLog must be an array"))
    }
  }
  return errors
}

export function decodeUmePlan(input: unknown): DecodeResult {
  const errors: ValidationError[] = []
  if (!isObject(input)) {
    return { ok: false, errors: [err("", "type", "root must be an object")] }
  }

  // Capa 1: envelope
  for (const req of ["id", "entityName", "dynamicProperties", "lifecycle", "state", "markdownDocumentation"]) {
    if (!(req in input)) errors.push(err(req, "missing", `field "${req}" is required`))
  }
  if (typeof input.id !== "string" || input.id === "") {
    errors.push(err("id", "type", "id must be a non-empty string"))
  } else if (input.id === SENTINEL) {
    errors.push(err("id", "sentinel", "id must not be RESERVED_FOR_SYSTEM (document not finalized)"))
  }
  if (input.entityName !== ENTITY_NAME) {
    errors.push(err("entityName", "enum", `entityName must be "${ENTITY_NAME}"`))
  }
  if (typeof input.markdownDocumentation !== "string") {
    errors.push(err("markdownDocumentation", "type", "markdownDocumentation must be a string"))
  }

  if (!isObject(input.dynamicProperties)) {
    errors.push(err("dynamicProperties", "type", "dynamicProperties must be an object"))
  }
  if (!isObject(input.lifecycle)) {
    errors.push(err("lifecycle", "type", "lifecycle must be an object"))
  } else {
    const lc = input.lifecycle as Record<string, unknown>
    if (!isIsoDate(lc.createdAt)) errors.push(err("lifecycle.createdAt", "iso", "createdAt must be ISO date string"))
    else if (lc.createdAt === SENTINEL) errors.push(err("lifecycle.createdAt", "sentinel", "createdAt must not be RESERVED_FOR_SYSTEM"))
    if (!isIsoDate(lc.updatedAt)) errors.push(err("lifecycle.updatedAt", "iso", "updatedAt must be ISO date string"))
    else if (lc.updatedAt === SENTINEL) errors.push(err("lifecycle.updatedAt", "sentinel", "updatedAt must not be RESERVED_FOR_SYSTEM"))
    if (typeof lc.version !== "number" || !Number.isInteger(lc.version) || lc.version < 1) {
      errors.push(err("lifecycle.version", "type", "version must be integer >= 1"))
    }
  }

  if (!isObject(input.state)) {
    errors.push(err("state", "type", "state must be an object"))
  } else {
    const st = input.state as Record<string, unknown>
    if (!UME_STATUSES.includes(st.current as UmeJsonStatus)) {
      errors.push(err("state.current", "enum", `current must be one of ${UME_STATUSES.join(", ")}`))
    }
    if (!Array.isArray(st.statusLog)) {
      errors.push(err("state.statusLog", "type", "statusLog must be an array"))
    }
  }

  // Capa 2: payload
  const plan = isObject(input.dynamicProperties) ? (input.dynamicProperties as Record<string, unknown>).plan : undefined
  if (!isObject(plan)) {
    errors.push(err("dynamicProperties.plan", "type", "plan must be an object"))
  } else {
    if (plan.schemaVersion !== 2) {
      errors.push(err("dynamicProperties.plan.schemaVersion", "enum", "schemaVersion must be 2"))
    }
    if (!isIsoDate(plan.anchor)) {
      errors.push(err("dynamicProperties.plan.anchor", "iso", "anchor must be ISO date string"))
    }
    if (!Array.isArray(plan.resources)) {
      errors.push(err("dynamicProperties.plan.resources", "type", "resources must be an array"))
    }
    if (!Array.isArray(plan.phases)) {
      errors.push(err("dynamicProperties.plan.phases", "type", "phases must be an array"))
    }
    if (!Array.isArray(plan.events)) {
      errors.push(err("dynamicProperties.plan.events", "type", "events must be an array"))
    }

    const resourceIds = new Set<string>()
    if (Array.isArray(plan.resources)) {
      plan.resources.forEach((r, i) => {
        if (!isObject(r)) {
          errors.push(err(`dynamicProperties.plan.resources[${i}]`, "type", "resource must be an object"))
          return
        }
        if (typeof r.id !== "string" || r.id === "") {
          errors.push(err(`dynamicProperties.plan.resources[${i}].id`, "type", "resource.id must be a non-empty string"))
        } else {
          if (resourceIds.has(r.id)) errors.push(err(`dynamicProperties.plan.resources[${i}].id`, "unique", `duplicate resource id "${r.id}"`))
          resourceIds.add(r.id)
        }
        if (typeof r.title !== "string") errors.push(err(`dynamicProperties.plan.resources[${i}].title`, "type", "resource.title must be a string"))
      })
    }

    const phaseIds = new Set<string>()
    if (Array.isArray(plan.phases)) {
      plan.phases.forEach((p, i) => {
        if (!isObject(p)) {
          errors.push(err(`dynamicProperties.plan.phases[${i}]`, "type", "phase must be an object"))
          return
        }
        if (typeof p.id !== "string" || p.id === "") {
          errors.push(err(`dynamicProperties.plan.phases[${i}].id`, "type", "phase.id must be a non-empty string"))
        } else {
          if (phaseIds.has(p.id)) errors.push(err(`dynamicProperties.plan.phases[${i}].id`, "unique", `duplicate phase id "${p.id}"`))
          phaseIds.add(p.id)
        }
        if (typeof p.title !== "string") errors.push(err(`dynamicProperties.plan.phases[${i}].title`, "type", "phase.title must be a string"))
        if (typeof p.color !== "string") errors.push(err(`dynamicProperties.plan.phases[${i}].color`, "type", "phase.color must be a string"))
      })
    }

    if (Array.isArray(plan.events)) {
      plan.events.forEach((e, i) => {
        if (!isObject(e)) {
          errors.push(err(`dynamicProperties.plan.events[${i}]`, "type", "event must be an object"))
          return
        }
        if (typeof e.id !== "string" || e.id === "") {
          errors.push(err(`dynamicProperties.plan.events[${i}].id`, "type", "event.id must be a non-empty string"))
        }
        if (typeof e.resourceId !== "string") {
          errors.push(err(`dynamicProperties.plan.events[${i}].resourceId`, "type", "event.resourceId must be a string"))
        } else if (!resourceIds.has(e.resourceId)) {
          errors.push(err(`dynamicProperties.plan.events[${i}].resourceId`, "ref", `event references unknown resource "${e.resourceId}"`))
        }
        if (!isIsoDate(e.start)) errors.push(err(`dynamicProperties.plan.events[${i}].start`, "iso", "event.start must be ISO date string"))
        if (!isIsoDate(e.end)) errors.push(err(`dynamicProperties.plan.events[${i}].end`, "iso", "event.end must be ISO date string"))
        if (typeof e.progress !== "number" || e.progress < 0 || e.progress > 100) {
          errors.push(err(`dynamicProperties.plan.events[${i}].progress`, "range", "event.progress must be 0..100"))
        }
        if (typeof e.phaseId === "string" && !phaseIds.has(e.phaseId)) {
          errors.push(err(`dynamicProperties.plan.events[${i}].phaseId`, "ref", `event references unknown phase "${e.phaseId}"`))
        }
        // Bitácora de baselines: opcional; entries are immutable snapshots.
        if (e.baselines !== undefined) {
          if (!Array.isArray(e.baselines)) {
            errors.push(err(`dynamicProperties.plan.events[${i}].baselines`, "type", "event.baselines must be an array"))
          } else {
            const versions = new Set<number>()
            e.baselines.forEach((b, j) => {
              const bp = `dynamicProperties.plan.events[${i}].baselines[${j}]`
              if (!isObject(b)) {
                errors.push(err(bp, "type", "baseline must be an object"))
                return
              }
              if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) {
                errors.push(err(`${bp}.version`, "type", "baseline.version must be an integer >= 1"))
              } else if (versions.has(b.version)) {
                errors.push(err(`${bp}.version`, "unique", `duplicate baseline version "${b.version}"`))
              } else {
                versions.add(b.version)
              }
              if (!isIsoDate(b.start)) errors.push(err(`${bp}.start`, "iso", "baseline.start must be ISO date string"))
              if (!isIsoDate(b.end)) errors.push(err(`${bp}.end`, "iso", "baseline.end must be ISO date string"))
              if (!isIsoDate(b.capturedAt)) errors.push(err(`${bp}.capturedAt`, "iso", "baseline.capturedAt must be ISO date string"))
              if (b.reason !== undefined && typeof b.reason !== "string") {
                errors.push(err(`${bp}.reason`, "type", "baseline.reason must be a string"))
              }
            })
          }
        }
      })
    }

    // Grafo de dependencias: opcional; edges are validated as a WHOLE
    // (refs, duplicates, cycles) after the per-event pass, because an edge
    // is only meaningful when both endpoints exist.
    if (plan.dependencies !== undefined) {
      if (!Array.isArray(plan.dependencies)) {
        errors.push(err("dynamicProperties.plan.dependencies", "type", "plan.dependencies must be an array"))
      } else {
        const eventIds = new Set<string>()
        if (Array.isArray(plan.events)) {
          for (const e of plan.events) {
            if (isObject(e) && typeof e.id === "string") eventIds.add(e.id)
          }
        }
        const depIds = new Set<string>()
        const edges: Array<{ from: string; to: string; path: string }> = []
        plan.dependencies.forEach((d, i) => {
          const dp = `dynamicProperties.plan.dependencies[${i}]`
          if (!isObject(d)) {
            errors.push(err(dp, "type", "dependency must be an object"))
            return
          }
          if (typeof d.id !== "string" || d.id === "") {
            errors.push(err(`${dp}.id`, "type", "dependency.id must be a non-empty string"))
          } else if (depIds.has(d.id)) {
            errors.push(err(`${dp}.id`, "unique", `duplicate dependency id "${d.id}"`))
          } else {
            depIds.add(d.id)
          }
          for (const side of ["fromEventId", "toEventId"] as const) {
            if (typeof d[side] !== "string" || d[side] === "") {
              errors.push(err(`${dp}.${side}`, "type", `dependency.${side} must be a non-empty string`))
            } else if (!eventIds.has(d[side] as string)) {
              errors.push(err(`${dp}.${side}`, "ref", `dependency references unknown event "${d[side]}"`))
            }
          }
          if (d.fromEventId === d.toEventId && typeof d.fromEventId === "string") {
            errors.push(err(`${dp}`, "cycle", `dependency "${d.id}" links an event to itself`))
          }
          if (
            d.type !== "FS" && d.type !== "SS" && d.type !== "FF" && d.type !== "SF"
          ) {
            errors.push(err(`${dp}.type`, "enum", "dependency.type must be one of FS, SS, FF, SF"))
          }
          if (d.lagDays !== undefined && (typeof d.lagDays !== "number" || !Number.isInteger(d.lagDays))) {
            errors.push(err(`${dp}.lagDays`, "type", "dependency.lagDays must be an integer (negative for lead)"))
          }
          if (
            typeof d.fromEventId === "string" && typeof d.toEventId === "string" &&
            d.fromEventId !== d.toEventId &&
            eventIds.has(d.fromEventId) && eventIds.has(d.toEventId)
          ) {
            edges.push({ from: d.fromEventId, to: d.toEventId, path: dp })
          }
        })

        // Cycle detection: iterative DFS with colors over the VALID edges.
        // The error is reported at the edge that closes the cycle, so the
        // document author sees exactly which line to fix. Seed by NODE so
        // every connected component - including the trivial single-node case
        // - is visited even when edges are listed out of component order.
        const succs = new Map<string, Array<{ to: string; path: string }>>()
        const nodes = new Set<string>()
        for (const e of edges) {
          nodes.add(e.from)
          nodes.add(e.to)
          const list = succs.get(e.from)
          if (list) list.push({ to: e.to, path: e.path })
          else succs.set(e.from, [{ to: e.to, path: e.path }])
        }
        const color = new Map<string, 1 | 2>()
        const stack: string[] = []
        for (const seed of nodes) {
          if (color.get(seed)) continue
          stack.push(seed)
          while (stack.length) {
            const id = stack[stack.length - 1]!
            const state = color.get(id)
            if (state === 2) { stack.pop(); continue }
            if (state === 1) { color.set(id, 2); stack.pop(); continue }
            color.set(id, 1)
            for (const next of succs.get(id) ?? []) {
              if (color.get(next.to) === 1) {
                errors.push(err(next.path, "cycle", `dependency closes a cycle at "${next.to}"`))
                continue
              }
              if (!color.get(next.to)) stack.push(next.to)
            }
          }
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, entity: input as unknown as UmeJsonEntity, plan: (plan as unknown) as PlanJSON }
}
