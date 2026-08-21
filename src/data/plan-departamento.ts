import { addDays, startOfWeek } from "date-fns"

export interface PlanEvent {
  id: string
  resourceId: string
  start: string
  end: string
  progress: number
}

export interface PlanResource {
  id: string
  title: string
  parentId?: string
}

export interface PlanPhase {
  id: string
  title: string
  color: string
  resourceIds: string[]
}

export interface PlanJSON {
  schemaVersion: 1
  anchor: string
  resources: PlanResource[]
  phases: PlanPhase[]
  events: PlanEvent[]
}

export type EventData = {
  responsable: string
  fase: string
  status: string
}

export const RESPONSABLES: Record<string, string> = {
  "trazo-nivelacion": "Topografía",
  "excavacion": "Cuadrilla A",
  "limpieza-trazos": "Cuadrilla A",
  "zapatas": "Ing. Ríos",
  "contratrabes": "Ing. Ríos",
  "relleno": "Cuadrilla B",
  "impermeabilizacion": "Cuadrilla B",
  "columnas-pb": "Ing. Ríos",
  "losa-pb": "Ing. Ríos",
  "columnas-pa": "Ing. Ríos",
  "losa-azotea": "Ing. Ríos",
  "muros-bloque-pb": "Mtro. Solís",
  "muros-pa": "Mtro. Solís",
  "castillos-cadenas": "Mtro. Solís",
  "firmes": "Mtro. Solís",
  "electrica-empotrada": "Electricista",
  "hidrosanitaria": "Plomería",
  "gas": "Gasista",
  "voz-datos": "Cableado",
  "yeso-pintura": "Acabados",
  "pisos-ceramica": "Pisos",
  "carpinteria": "Carpintería",
  "herreria-aluminio": "Herrería",
  "pruebas-puestas-marcha": "Residencia",
  "limpieza-fina": "Cuadrilla A",
  "entrega": "Residencia",
  "obra-gris-correcciones": "Mtro. Solís",
  "kit-entrega": "Residencia",
}

const week = (n: number) => addDays(anchor, n * 7)
const days = (n: number) => addDays(anchor, n)

const anchor = startOfWeek(new Date(), { weekStartsOn: 1 })

const phases: PlanPhase[] = [
  {
    id: "preliminares",
    title: "Preliminares",
    color: "var(--color-stone-500)",
    resourceIds: ["trazo-nivelacion", "excavacion", "limpieza-trazos"],
  },
  {
    id: "cimentacion",
    title: "Cimentación",
    color: "var(--color-sky-500)",
    resourceIds: ["zapatas", "contratrabes", "relleno", "impermeabilizacion"],
  },
  {
    id: "estructura",
    title: "Estructura",
    color: "var(--color-blue-500)",
    resourceIds: ["columnas-pb", "losa-pb", "columnas-pa", "losa-azotea"],
  },
  {
    id: "albanileria",
    title: "Albañilería",
    color: "var(--color-amber-500)",
    resourceIds: [
      "muros-bloque-pb",
      "muros-pa",
      "castillos-cadenas",
      "firmes",
    ],
  },
  {
    id: "instalaciones",
    title: "Instalaciones",
    color: "var(--color-teal-500)",
    resourceIds: ["electrica-empotrada", "hidrosanitaria", "gas", "voz-datos"],
  },
  {
    id: "acabados",
    title: "Acabados",
    color: "var(--color-violet-500)",
    resourceIds: ["yeso-pintura", "pisos-ceramica", "carpinteria", "herreria-aluminio"],
  },
  {
    id: "entrega",
    title: "Entrega",
    color: "var(--color-emerald-500)",
    resourceIds: [
      "pruebas-puestas-marcha",
      "limpieza-fina",
      "entrega",
      "obra-gris-correcciones",
      "kit-entrega",
    ],
  },
]

const event = (
  id: string,
  resourceId: string,
  startOffset: number,
  durationDays: number,
  progress: number,
  _fase: string,
): PlanEvent => ({
  id,
  resourceId,
  start: days(startOffset).toISOString(),
  end: days(startOffset + durationDays).toISOString(),
  progress,
})

const events: PlanEvent[] = [
  event("trazo-nivelacion", "trazo-nivelacion", -10 * 7, 7, 100, "preliminares"),
  event("excavacion", "excavacion", -10 * 7, 14, 100, "preliminares"),
  event("limpieza-trazos", "limpieza-trazos", -8 * 7, 7, 100, "preliminares"),

  event("zapatas", "zapatas", -8 * 7, 14, 100, "cimentacion"),
  event("contratrabes", "contratrabes", -7 * 7, 14, 100, "cimentacion"),
  event("relleno", "relleno", -5 * 7, 7, 100, "cimentacion"),
  event("impermeabilizacion", "impermeabilizacion", -5 * 7, 7, 100, "cimentacion"),

  event("columnas-pb", "columnas-pb", -5 * 7, 7, 100, "estructura"),
  event("losa-pb", "losa-pb", -4 * 7, 14, 85, "estructura"),
  event("columnas-pa", "columnas-pa", -2 * 7, 7, 70, "estructura"),
  event("losa-azotea", "losa-azotea", -1 * 7, 14, 60, "estructura"),

  event("muros-bloque-pb", "muros-bloque-pb", -1 * 7, 21, 40, "albanileria"),
  event("muros-pa", "muros-pa", 1 * 7, 21, 25, "albanileria"),
  event("castillos-cadenas", "castillos-cadenas", 3 * 7, 14, 10, "albanileria"),
  event("firmes", "firmes", 4 * 7, 14, 0, "albanileria"),

  event("electrica-empotrada", "electrica-empotrada", 2 * 7, 28, 15, "instalaciones"),
  event("hidrosanitaria", "hidrosanitaria", 3 * 7, 28, 10, "instalaciones"),
  event("gas", "gas", 6 * 7, 14, 0, "instalaciones"),
  event("voz-datos", "voz-datos", 6 * 7, 14, 0, "instalaciones"),

  event("yeso-pintura", "yeso-pintura", 7 * 7, 21, 0, "acabados"),
  event("pisos-ceramica", "pisos-ceramica", 9 * 7, 21, 0, "acabados"),
  event("carpinteria", "carpinteria", 11 * 7, 14, 0, "acabados"),
  event("herreria-aluminio", "herreria-aluminio", 11 * 7, 14, 0, "acabados"),

  event("pruebas-puestas-marcha", "pruebas-puestas-marcha", 14 * 7, 14, 0, "entrega"),
  event("limpieza-fina", "limpieza-fina", 15 * 7, 7, 0, "entrega"),
  event("entrega", "entrega", 16 * 7, 7, 0, "entrega"),
]

const resources: PlanResource[] = [
  ...phases.map((p) => ({ id: p.id, title: p.title })),
  ...phases.flatMap((p) =>
    p.resourceIds.map((rid) => {
      if (rid === p.id) return null
      return { id: rid, title: titleize(rid), parentId: p.id }
    }).filter(Boolean) as PlanResource[]
  ),
]

function titleize(id: string): string {
  return id
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

export const PLAN: PlanJSON = {
  schemaVersion: 1,
  anchor: anchor.toISOString(),
  resources,
  phases,
  events,
}

export { week as weekOffset, days as daysOffset }
