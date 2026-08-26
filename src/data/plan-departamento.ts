import { addDays, startOfWeek } from "date-fns"
import type { PlanBaseline, PlanDependency, PlanEvent, PlanJSON, PlanPhase, PlanResource } from "@/lib/plan-types"
// Relative `.ts` VALUE import (not `@/`): this module is loaded by
// node --experimental-strip-types from the seed script and the verify
// suite, where the alias does not resolve. Type-only `@/` imports are
// fine — they never execute.
import { addWorkingDays } from "../lib/umejson/working-time.ts"
import { buildDemoCalendarPayload, DEMO_CALENDAR_KEY } from "./demo-calendar.ts"

export type { PlanBaseline, PlanEvent, PlanResource, PlanPhase, PlanJSON, EventData } from "@/lib/plan-types"

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

const anchor = startOfWeek(new Date(), { weekStartsOn: 1 })
const anchorMs = anchor.getTime()

// Calendario demo (Lun–Vie + feriados sintéticos relativos al ancla): la
// MISMA definición que siembra la hermana GanttCalendar genera las fechas
// del plan, así ninguna barra arranca en fin de semana ni en feriado y el
// grafo carga en sus bordes por construcción.
const DEMO_CAL_PAYLOAD = buildDemoCalendarPayload(anchorMs)
const demoCal =
  DEMO_CAL_PAYLOAD.calendars.find((c) => c.id === DEMO_CALENDAR_KEY) ?? null

/** Conversión corrido→laborable del demo (redondeo proporcional 5/7). */
const wdur = (corridoDays: number): number =>
  Math.round((corridoDays * 5) / 7)

const iso = (instantMs: number): string => new Date(instantMs).toISOString()

/** Fin de una tarea que arranca en `startMs` y dura `durationDays` corridos (convertidos a laborables). */
const endAfter = (startMs: number, durationDays: number): string =>
  iso(addWorkingDays(demoCal, startMs, wdur(durationDays)))

// Concrete hexes (Tailwind v4 500-level), NOT `var()` references: the whole
// paint chain (bars, baseline tones, swatches) then works without any
// runtime CSS-variable resolution, which is silently unreliable across
// browsers.
const phases: PlanPhase[] = [
  { id: "preliminares", title: "Preliminares", color: "#78716c" },
  { id: "cimentacion", title: "Cimentación", color: "#0ea5e9" },
  { id: "estructura", title: "Estructura", color: "#3b82f6" },
  { id: "albanileria", title: "Albañilería", color: "#f59e0b" },
  { id: "instalaciones", title: "Instalaciones", color: "#14b8a6" },
  { id: "acabados", title: "Acabados", color: "#8b5cf6" },
  { id: "entrega", title: "Entrega", color: "#10b981" },
]

/**
 * Evento libre: su inicio sale del offset corrido convertido a laborables
 * (ancla + addWorkingDays), su fin cuenta la duración en laborables.
 */
const event = (
  id: string,
  resourceId: string,
  startOffset: number,
  durationDays: number,
  progress: number,
): PlanEvent => ({
  id,
  resourceId,
  start: iso(addWorkingDays(demoCal, anchorMs, wdur(startOffset))),
  end: endAfter(addWorkingDays(demoCal, anchorMs, wdur(startOffset)), durationDays),
  progress,
})

/**
 * Sucesor de una dependencia sembrada: el inicio DERIVA del borde del
 * predecesor (fin + lag, ambos en laborables) en vez de un offset propio,
 * así la restricción carga exactamente sentada en su límite — cero
 * violaciones al abrir el demo (lo verifica la suite).
 */
const linkedEvent = (
  id: string,
  resourceId: string,
  pred: PlanEvent,
  durationDays: number,
  progress: number,
  lagDays = 0,
): PlanEvent => {
  const startMs = addWorkingDays(demoCal, Date.parse(pred.end), lagDays)
  return {
    id,
    resourceId,
    start: iso(startMs),
    end: endAfter(startMs, durationDays),
    progress,
  }
}

/**
 * Seeds a baseline history on an event: each entry is a `[startOffset,
 * durationDays]` corrido pair (converted to working dates like everything
 * else), captured ten days before its own window, so versions ascend in
 * time like a real re-baselining log.
 */
const withBaselines = (
  e: PlanEvent,
  ...windows: Array<[number, number]>
): PlanEvent => ({
  ...e,
  baselines: windows.map(
    ([startOffset, durationDays], i): PlanBaseline => {
      const startMs = addWorkingDays(demoCal, anchorMs, wdur(startOffset))
      return {
        version: i + 1,
        start: iso(startMs),
        end: endAfter(startMs, durationDays),
        capturedAt: addDays(anchor, startOffset - 10).toISOString(),
        reason: "Línea base aprobada",
      }
    },
  ),
})

const trazoNivelacion = event("trazo-nivelacion", "trazo-nivelacion", -10 * 7, 7, 100)
// dep-01 (SS lag 0): mismo offset que trazo → arranques idénticos.
const excavacion = event("excavacion", "excavacion", -10 * 7, 14, 100)
const limpiezaTrazos = linkedEvent("limpieza-trazos", "limpieza-trazos", excavacion, 7, 100)

const zapatasAisladas = event("zapatas-aisladas", "zapatas-aisladas", -8 * 7, 14, 100)
const zapatasCorridas = event("zapatas-corridas", "zapatas-corridas", -7 * 7, 14, 100)
const contratabes = event("contratabes", "contratabes", -7 * 7, 14, 100)
const relleno = event("relleno", "relleno", -5 * 7, 7, 100)
const impermeabilizacionCiment = event("impermeabilizacion-ciment", "impermeabilizacion-ciment", -5 * 7, 7, 100)

const columnasPb = linkedEvent("columnas-pb", "columnas-pb", contratabes, 7, 100)
const losaPb = withBaselines(linkedEvent("losa-pb", "losa-pb", columnasPb, 14, 85), [-4 * 7 - 3, 10])
const columnasPa = linkedEvent("columnas-pa", "columnas-pa", losaPb, 7, 70)
const cimbraAzotea = linkedEvent("losa-azotea-cimbra", "losa-azotea-cimbra", columnasPa, 7, 60)
const concretoAzotea = linkedEvent("losa-azotea-concreto", "losa-azotea-concreto", cimbraAzotea, 7, 50)

const murosBloquePb = event("muros-bloque-pb", "muros-bloque-pb", -1 * 7, 21, 40)
const murosPa = withBaselines(
  // dep-08: solapamiento documentado de −7 laborables desde el fin del pred.
  linkedEvent("muros-pa", "muros-pa", murosBloquePb, 21, 25, -7),
  [0, 14],
)
const castillosCadenas = event("castillos-cadenas", "castillos-cadenas", 3 * 7, 14, 10)
const firmes = event("firmes", "firmes", 4 * 7, 14, 0)

const electricaPb = event("electrica-empotrada-pb", "electrica-empotrada-pb", 2 * 7, 21, 15)
const electricaPa = event("electrica-empotrada-pa", "electrica-empotrada-pa", 5 * 7, 14, 5)
const hidrosanitaria = withBaselines(
  event("hidrosanitaria", "hidrosanitaria", 3 * 7, 28, 10),
  [3 * 7 - 7, 21],
  [3 * 7 - 3, 24],
)
const gas = event("gas", "gas", 6 * 7, 14, 0)
const vozDatos = event("voz-datos", "voz-datos", 6 * 7, 14, 0)

const yesoPintura = linkedEvent("yeso-pintura", "yeso-pintura", electricaPa, 21, 0)
const pisosCeramica = event("pisos-ceramica", "pisos-ceramica", 9 * 7, 21, 0)
const carpinteria = event("carpinteria", "carpinteria", 11 * 7, 14, 0)
const herreriaAluminio = event("herreria-aluminio", "herreria-aluminio", 11 * 7, 14, 0)

const pruebasPuestasMarcha = linkedEvent("pruebas-puestas-marcha", "pruebas-puestas-marcha", herreriaAluminio, 14, 0)
const limpiezaFina = event("limpieza-fina", "limpieza-fina", 15 * 7, 7, 0)
const obraGrisCorrecciones = event("obra-gris-correcciones", "obra-gris-correcciones", 13 * 7, 14, 0)
const kitEntrega = event("kit-entrega", "kit-entrega", 16 * 7, 7, 0)
// Hito de cierre: duración 0 derivada del fin de kit-entrega + kind
// milestone — el diamante del plan demo.
const actaEntrega: PlanEvent = {
  ...linkedEvent("acta-entrega", "acta-entrega", kitEntrega, 0, 0),
  kind: "milestone" as const,
}

const events: PlanEvent[] = [
  trazoNivelacion,
  excavacion,
  limpiezaTrazos,

  zapatasAisladas,
  zapatasCorridas,
  contratabes,
  relleno,
  impermeabilizacionCiment,

  columnasPb,
  losaPb,
  columnasPa,
  cimbraAzotea,
  concretoAzotea,

  murosBloquePb,
  murosPa,
  castillosCadenas,
  firmes,

  electricaPb,
  electricaPa,
  hidrosanitaria,
  gas,
  vozDatos,

  yesoPintura,
  pisosCeramica,
  carpinteria,
  herreriaAluminio,

  pruebasPuestasMarcha,
  limpiezaFina,
  obraGrisCorrecciones,
  kitEntrega,
  actaEntrega,
]

const r = (
  id: string,
  title: string,
  rest: { parentId?: string; phaseId?: string } = {},
): PlanResource => ({
  id,
  title,
  ...rest,
  responsable: RESPONSABLES[id],
})

const resources: PlanResource[] = [
  r("departamento-merida", "Departamento Mérida"),

  r("preliminares", "Preliminares", { parentId: "departamento-merida", phaseId: "preliminares" }),
  r("trazo-nivelacion", "Trazo y nivelación", { parentId: "preliminares" }),
  r("excavacion", "Excavación", { parentId: "preliminares" }),
  r("limpieza-trazos", "Limpieza de trazos", { parentId: "preliminares" }),

  r("cimentacion", "Cimentación", { parentId: "departamento-merida", phaseId: "cimentacion" }),
  r("zapatas", "Zapatas", { parentId: "cimentacion" }),
  r("zapatas-aisladas", "Zapatas aisladas", { parentId: "zapatas" }),
  r("zapatas-corridas", "Zapatas corridas", { parentId: "zapatas" }),
  r("contratabes", "Contratabes", { parentId: "cimentacion" }),
  r("relleno", "Relleno compactado", { parentId: "cimentacion" }),
  r("impermeabilizacion-ciment", "Impermeabilización", { parentId: "cimentacion" }),

  r("estructura", "Estructura", { parentId: "departamento-merida", phaseId: "estructura" }),
  r("estructura-pb", "Estructura PB", { parentId: "estructura" }),
  r("columnas-pb", "Columnas PB", { parentId: "estructura-pb" }),
  r("losa-pb", "Losa PB", { parentId: "estructura-pb" }),
  r("estructura-pa", "Estructura PA", { parentId: "estructura" }),
  r("columnas-pa", "Columnas PA", { parentId: "estructura-pa" }),
  r("losa-azotea", "Losa azotea", { parentId: "estructura-pa" }),
  r("losa-azotea-cimbra", "Cimbra y armado", { parentId: "losa-azotea" }),
  r("losa-azotea-concreto", "Colado y curado", { parentId: "losa-azotea" }),

  r("albanileria", "Albañilería", { parentId: "departamento-merida", phaseId: "albanileria" }),
  r("muros", "Muros", { parentId: "albanileria" }),
  r("muros-bloque-pb", "Muros bloque PB", { parentId: "muros" }),
  r("muros-pa", "Muros PA", { parentId: "muros" }),
  r("castillos-cadenas", "Castillos y cadenas", { parentId: "albanileria" }),
  r("firmes", "Firmes", { parentId: "albanileria" }),

  r("instalaciones", "Instalaciones", { parentId: "departamento-merida", phaseId: "instalaciones" }),
  r("electrica-empotrada", "Eléctrica empotrada", { parentId: "instalaciones" }),
  r("electrica-empotrada-pb", "Eléctrica PB", { parentId: "electrica-empotrada" }),
  r("electrica-empotrada-pa", "Eléctrica PA", { parentId: "electrica-empotrada" }),
  r("hidrosanitaria", "Hidrosanitaria", { parentId: "instalaciones" }),
  r("gas", "Gas", { parentId: "instalaciones" }),
  r("voz-datos", "Voz y datos", { parentId: "instalaciones" }),

  r("acabados", "Acabados", { parentId: "departamento-merida", phaseId: "acabados" }),
  r("yeso-pintura", "Yeso y pintura", { parentId: "acabados" }),
  r("pisos-ceramica", "Pisos cerámica", { parentId: "acabados" }),
  r("carpinteria", "Carpintería", { parentId: "acabados" }),
  r("herreria-aluminio", "Herrería y aluminio", { parentId: "acabados" }),

  r("entrega", "Entrega", { parentId: "departamento-merida", phaseId: "entrega" }),
  r("pruebas-puestas-marcha", "Pruebas y puestas en marcha", { parentId: "entrega" }),
  r("limpieza-fina", "Limpieza fina", { parentId: "entrega" }),
  r("obra-gris-correcciones", "Correcciones obra gris", { parentId: "entrega" }),
  r("kit-entrega", "Kit de entrega", { parentId: "entrega" }),
  r("acta-entrega", "Acta de entrega", { parentId: "entrega" }),
]

/**
 * Seeded scheduling constraints, chosen against the event offsets so the
 * demo loads with a readable graph: mostly clean FS chains, one SS (trazo
 * runs parallel to excavación) and one DOCUMENTED overlap — muros-pa
 * starts 7 days before muros-bloque-pb finishes (FS with lag −7, the
 * dates already overlap by exactly that much). The violation machinery
 * stays demonstrable interactively: drag the predecessor forward and the
 * successor reddens live until the cascade repairs it.
 */
const dep = (
  id: string,
  fromEventId: string,
  toEventId: string,
  type: PlanDependency["type"] = "FS",
  lagDays?: number,
): PlanDependency => ({ id, fromEventId, toEventId, type, ...(lagDays ? { lagDays } : {}) })

const dependencies: PlanDependency[] = [
  dep("dep-01", "trazo-nivelacion", "excavacion", "SS"),
  dep("dep-02", "excavacion", "limpieza-trazos"),
  dep("dep-03", "contratabes", "columnas-pb"),
  dep("dep-04", "columnas-pb", "losa-pb"),
  dep("dep-05", "losa-pb", "columnas-pa"),
  dep("dep-06", "columnas-pa", "losa-azotea-cimbra"),
  dep("dep-07", "losa-azotea-cimbra", "losa-azotea-concreto"),
  dep("dep-08", "muros-bloque-pb", "muros-pa", "FS", -7),
  dep("dep-09", "electrica-empotrada-pa", "yeso-pintura"),
  dep("dep-10", "herreria-aluminio", "pruebas-puestas-marcha"),
  dep("dep-11", "kit-entrega", "acta-entrega"),
]

// Corte de avance del demo (~40% de la ventana del plan) + convención de
// fuera de secuencia por defecto. Aditivo-opcional en schema v2; los
// kernels (cascada, CPM, EVM) lo leen directamente del plan.
const planStartMs = Math.min(...events.map((e) => Date.parse(e.start)))
const planEndMs = Math.max(...events.map((e) => Date.parse(e.end)))
const STATUS_DATE = new Date(
  planStartMs + 0.4 * (planEndMs - planStartMs),
).toISOString()

export const PLAN: PlanJSON = {
  schemaVersion: 2,
  anchor: anchor.toISOString(),
  resources,
  phases,
  events,
  dependencies,
  statusDate: STATUS_DATE,
  schedulingOptions: { outOfSequence: "retainedLogic" },
}
