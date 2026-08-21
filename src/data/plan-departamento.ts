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
  phaseId?: string
}

export interface PlanPhase {
  id: string
  title: string
  color: string
}

export interface PlanJSON {
  schemaVersion: 2
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
  "departamento-merida": "Residencia",
  "preliminares": "Topografía",
  "trazo-nivelacion": "Topografía",
  "excavacion": "Cuadrilla A",
  "limpieza-trazos": "Cuadrilla A",
  "cimentacion": "Ing. Ríos",
  "zapatas": "Ing. Ríos",
  "zapatas-aisladas": "Ing. Ríos",
  "zapatas-corridas": "Ing. Ríos",
  "contratabes": "Ing. Ríos",
  "relleno": "Cuadrilla B",
  "impermeabilizacion-ciment": "Cuadrilla B",
  "estructura": "Ing. Ríos",
  "estructura-pb": "Ing. Ríos",
  "columnas-pb": "Ing. Ríos",
  "losa-pb": "Ing. Ríos",
  "estructura-pa": "Ing. Ríos",
  "columnas-pa": "Ing. Ríos",
  "losa-azotea": "Ing. Ríos",
  "losa-azotea-concreto": "Ing. Ríos",
  "losa-azotea-cimbra": "Ing. Ríos",
  "albanileria": "Mtro. Solís",
  "muros": "Mtro. Solís",
  "muros-bloque-pb": "Mtro. Solís",
  "muros-pa": "Mtro. Solís",
  "castillos-cadenas": "Mtro. Solís",
  "firmes": "Mtro. Solís",
  "instalaciones": "Residencia",
  "electrica-empotrada": "Electricista",
  "electrica-empotrada-pb": "Electricista",
  "electrica-empotrada-pa": "Electricista",
  "hidrosanitaria": "Plomería",
  "gas": "Gasista",
  "voz-datos": "Cableado",
  "acabados": "Acabados",
  "yeso-pintura": "Acabados",
  "pisos-ceramica": "Pisos",
  "carpinteria": "Carpintería",
  "herreria-aluminio": "Herrería",
  "entrega": "Residencia",
  "pruebas-puestas-marcha": "Residencia",
  "limpieza-fina": "Cuadrilla A",
  "obra-gris-correcciones": "Mtro. Solís",
  "kit-entrega": "Residencia",
  "acta-entrega": "Residencia",
}

const week = (n: number) => addDays(anchor, n * 7)
const days = (n: number) => addDays(anchor, n)

const anchor = startOfWeek(new Date(), { weekStartsOn: 1 })

const phases: PlanPhase[] = [
  {
    id: "preliminares",
    title: "Preliminares",
    color: "var(--color-stone-500)",
  },
  {
    id: "cimentacion",
    title: "Cimentación",
    color: "var(--color-sky-500)",
  },
  {
    id: "estructura",
    title: "Estructura",
    color: "var(--color-blue-500)",
  },
  {
    id: "albanileria",
    title: "Albañilería",
    color: "var(--color-amber-500)",
  },
  {
    id: "instalaciones",
    title: "Instalaciones",
    color: "var(--color-teal-500)",
  },
  {
    id: "acabados",
    title: "Acabados",
    color: "var(--color-violet-500)",
  },
  {
    id: "entrega",
    title: "Entrega",
    color: "var(--color-emerald-500)",
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

  event("zapatas-aisladas", "zapatas-aisladas", -8 * 7, 14, 100, "cimentacion"),
  event("zapatas-corridas", "zapatas-corridas", -7 * 7, 14, 100, "cimentacion"),
  event("contratabes", "contratabes", -7 * 7, 14, 100, "cimentacion"),
  event("relleno", "relleno", -5 * 7, 7, 100, "cimentacion"),
  event("impermeabilizacion-ciment", "impermeabilizacion-ciment", -5 * 7, 7, 100, "cimentacion"),

  event("columnas-pb", "columnas-pb", -5 * 7, 7, 100, "estructura"),
  event("losa-pb", "losa-pb", -4 * 7, 14, 85, "estructura"),
  event("columnas-pa", "columnas-pa", -2 * 7, 7, 70, "estructura"),
  event("losa-azotea-cimbra", "losa-azotea-cimbra", -1 * 7, 7, 60, "estructura"),
  event("losa-azotea-concreto", "losa-azotea-concreto", 0, 7, 50, "estructura"),

  event("muros-bloque-pb", "muros-bloque-pb", -1 * 7, 21, 40, "albanileria"),
  event("muros-pa", "muros-pa", 1 * 7, 21, 25, "albanileria"),
  event("castillos-cadenas", "castillos-cadenas", 3 * 7, 14, 10, "albanileria"),
  event("firmes", "firmes", 4 * 7, 14, 0, "albanileria"),

  event("electrica-empotrada-pb", "electrica-empotrada-pb", 2 * 7, 21, 15, "instalaciones"),
  event("electrica-empotrada-pa", "electrica-empotrada-pa", 5 * 7, 14, 5, "instalaciones"),
  event("hidrosanitaria", "hidrosanitaria", 3 * 7, 28, 10, "instalaciones"),
  event("gas", "gas", 6 * 7, 14, 0, "instalaciones"),
  event("voz-datos", "voz-datos", 6 * 7, 14, 0, "instalaciones"),

  event("yeso-pintura", "yeso-pintura", 7 * 7, 21, 0, "acabados"),
  event("pisos-ceramica", "pisos-ceramica", 9 * 7, 21, 0, "acabados"),
  event("carpinteria", "carpinteria", 11 * 7, 14, 0, "acabados"),
  event("herreria-aluminio", "herreria-aluminio", 11 * 7, 14, 0, "acabados"),

  event("pruebas-puestas-marcha", "pruebas-puestas-marcha", 14 * 7, 14, 0, "entrega"),
  event("limpieza-fina", "limpieza-fina", 15 * 7, 7, 0, "entrega"),
  event("obra-gris-correcciones", "obra-gris-correcciones", 13 * 7, 14, 0, "entrega"),
  event("kit-entrega", "kit-entrega", 16 * 7, 7, 0, "entrega"),
  event("acta-entrega", "acta-entrega", 17 * 7, 7, 0, "entrega"),
]

const resources: PlanResource[] = [
  { id: "departamento-merida", title: "Departamento Mérida" },

  { id: "preliminares", title: "Preliminares", parentId: "departamento-merida", phaseId: "preliminares" },
  { id: "trazo-nivelacion", title: "Trazo y nivelación", parentId: "preliminares" },
  { id: "excavacion", title: "Excavación", parentId: "preliminares" },
  { id: "limpieza-trazos", title: "Limpieza de trazos", parentId: "preliminares" },

  { id: "cimentacion", title: "Cimentación", parentId: "departamento-merida", phaseId: "cimentacion" },
  { id: "zapatas", title: "Zapatas", parentId: "cimentacion" },
  { id: "zapatas-aisladas", title: "Zapatas aisladas", parentId: "zapatas" },
  { id: "zapatas-corridas", title: "Zapatas corridas", parentId: "zapatas" },
  { id: "contratabes", title: "Contratabes", parentId: "cimentacion" },
  { id: "relleno", title: "Relleno compactado", parentId: "cimentacion" },
  { id: "impermeabilizacion-ciment", title: "Impermeabilización", parentId: "cimentacion" },

  { id: "estructura", title: "Estructura", parentId: "departamento-merida", phaseId: "estructura" },
  { id: "estructura-pb", title: "Estructura PB", parentId: "estructura" },
  { id: "columnas-pb", title: "Columnas PB", parentId: "estructura-pb" },
  { id: "losa-pb", title: "Losa PB", parentId: "estructura-pb" },
  { id: "estructura-pa", title: "Estructura PA", parentId: "estructura" },
  { id: "columnas-pa", title: "Columnas PA", parentId: "estructura-pa" },
  { id: "losa-azotea", title: "Losa azotea", parentId: "estructura-pa" },
  { id: "losa-azotea-cimbra", title: "Cimbra y armado", parentId: "losa-azotea" },
  { id: "losa-azotea-concreto", title: "Colado y curado", parentId: "losa-azotea" },

  { id: "albanileria", title: "Albañilería", parentId: "departamento-merida", phaseId: "albanileria" },
  { id: "muros", title: "Muros", parentId: "albanileria" },
  { id: "muros-bloque-pb", title: "Muros bloque PB", parentId: "muros" },
  { id: "muros-pa", title: "Muros PA", parentId: "muros" },
  { id: "castillos-cadenas", title: "Castillos y cadenas", parentId: "albanileria" },
  { id: "firmes", title: "Firmes", parentId: "albanileria" },

  { id: "instalaciones", title: "Instalaciones", parentId: "departamento-merida", phaseId: "instalaciones" },
  { id: "electrica-empotrada", title: "Eléctrica empotrada", parentId: "instalaciones" },
  { id: "electrica-empotrada-pb", title: "Eléctrica PB", parentId: "electrica-empotrada" },
  { id: "electrica-empotrada-pa", title: "Eléctrica PA", parentId: "electrica-empotrada" },
  { id: "hidrosanitaria", title: "Hidrosanitaria", parentId: "instalaciones" },
  { id: "gas", title: "Gas", parentId: "instalaciones" },
  { id: "voz-datos", title: "Voz y datos", parentId: "instalaciones" },

  { id: "acabados", title: "Acabados", parentId: "departamento-merida", phaseId: "acabados" },
  { id: "yeso-pintura", title: "Yeso y pintura", parentId: "acabados" },
  { id: "pisos-ceramica", title: "Pisos cerámica", parentId: "acabados" },
  { id: "carpinteria", title: "Carpintería", parentId: "acabados" },
  { id: "herreria-aluminio", title: "Herrería y aluminio", parentId: "acabados" },

  { id: "entrega", title: "Entrega", parentId: "departamento-merida", phaseId: "entrega" },
  { id: "pruebas-puestas-marcha", title: "Pruebas y puestas en marcha", parentId: "entrega" },
  { id: "limpieza-fina", title: "Limpieza fina", parentId: "entrega" },
  { id: "obra-gris-correcciones", title: "Correcciones obra gris", parentId: "entrega" },
  { id: "kit-entrega", title: "Kit de entrega", parentId: "entrega" },
  { id: "acta-entrega", title: "Acta de entrega", parentId: "entrega" },
]

export const PLAN: PlanJSON = {
  schemaVersion: 2,
  anchor: anchor.toISOString(),
  resources,
  phases,
  events,
}

export { week as weekOffset, days as daysOffset }
