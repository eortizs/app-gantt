// Demo GanttWorkforce for the demo plan: crews derived from the plan's
// OWN responsables (single source: RESPONSABLES in plan-departamento), so
// the RRHH document can never disagree with the tree the viewer shows.
// Shared by the App fallback and the backend seed, same spirit as
// demo-contables. Runtime-pure imports (relative `.ts`) so
// server/scripts/seed.ts can load this under node.
import { PLAN, RESPONSABLES } from "./plan-departamento.ts"
import type { PlanJSON } from "../lib/plan-types.ts"
import {
  buildWorkforceEntity,
  type UmeWorkforceEntity,
  type WorkforceCrew,
} from "../lib/umejson/workforce.ts"
import { DEMO_PLAN_ID } from "./demo-entity.ts"

export const DEMO_WORKFORCE_ID = "00000000-0000-4000-8000-000000000004"

/** Per-responsable profile: specialty + MXN/day/person, realistic rates. */
const CREW_PROFILE: Record<string, { specialty: string; dayRate: number }> = {
  "Residencia": { specialty: "Residencia técnica", dayRate: 1500 },
  "Topografía": { specialty: "Topografía", dayRate: 1100 },
  "Cuadrilla A": { specialty: "Demolición y limpieza", dayRate: 850 },
  "Cuadrilla B": { specialty: "Relleno e impermeabilización", dayRate: 850 },
  "Ing. Ríos": { specialty: "Cimentación y estructura", dayRate: 1200 },
  "Mtro. Solís": { specialty: "Albañilería", dayRate: 950 },
  "Electricista": { specialty: "Instalación eléctrica", dayRate: 1100 },
  "Plomería": { specialty: "Hidrosanitaria", dayRate: 1000 },
  "Gasista": { specialty: "Instalación de gas", dayRate: 1150 },
  "Cableado": { specialty: "Voz y datos", dayRate: 1050 },
  "Acabados": { specialty: "Yeso y pintura", dayRate: 1000 },
  "Pisos": { specialty: "Pisos y cerámica", dayRate: 1000 },
  "Carpintería": { specialty: "Carpintería", dayRate: 1100 },
  "Herrería": { specialty: "Herrería y aluminio", dayRate: 1150 },
}

const slug = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** Deterministic hash → [0, max-1], same spirit as wiggleOf. */
const hashOf = (id: string): number => {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/**
 * Workforce document: one crew per distinct responsable (insertion order
 * of RESPONSABLES), each with specialty/tarifa/headcount; every event is
 * assigned to the crew of its resource's responsable (demo is 1:1
 * resource↔event). Deterministic: headcounts derive from id hashes.
 */
export function buildDemoWorkforce(
  plan: PlanJSON = PLAN,
  planEntityId: string = DEMO_PLAN_ID,
): UmeWorkforceEntity {
  const crews: WorkforceCrew[] = []
  const crewByResponsable = new Map<string, WorkforceCrew>()
  for (const responsable of new Set(Object.values(RESPONSABLES))) {
    const profile = CREW_PROFILE[responsable] ?? {
      specialty: responsable,
      dayRate: 1000,
    }
    const crew: WorkforceCrew = {
      id: `crew-${slug(responsable)}`,
      title: responsable,
      specialty: profile.specialty,
      headcount: 4 + (hashOf(responsable) % 5),
      dayRate: profile.dayRate,
    }
    crews.push(crew)
    crewByResponsable.set(responsable, crew)
  }

  const resourcesById = new Map(plan.resources.map((r) => [r.id, r]))
  const assignmentByEvent: Record<
    string,
    { crewId: string; headcount: number }
  > = {}
  for (const event of plan.events) {
    const resource = resourcesById.get(event.resourceId)
    const responsable = resource?.responsable ?? RESPONSABLES[event.resourceId]
    const crew = responsable ? crewByResponsable.get(responsable) : undefined
    if (!crew) continue
    // Deterministic draw between 2 and the crew's full headcount.
    const headcount = Math.max(
      2,
      crew.headcount - (hashOf(event.id) % 3),
    )
    assignmentByEvent[event.id] = { crewId: crew.id, headcount }
  }

  return buildWorkforceEntity({
    id: DEMO_WORKFORCE_ID,
    planEntityId,
    planAnchor: plan.anchor,
    workforce: {
      schemaVersion: 1,
      crews,
      assignmentByEvent,
    },
  })
}
