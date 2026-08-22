import { es } from "date-fns/locale"
import type { GanttI18nOverrides } from "@/components/reui/gantt/gantt-i18n"

export const I18N_ES: GanttI18nOverrides = {
  labels: {
    today: "Hoy",
    previous: "Anterior",
    next: "Siguiente",
    addEvent: "Agregar evento",
    addTask: "Agregar tarea",
    allDay: "Todo el día",
    loading: "Cargando eventos",
    event: "evento",
    events: (n) => (n === 1 ? "1 evento" : `${n} eventos`),
    week: (n) => `S${n}`,
    resources: "Recursos",
    goToDate: "Ir a fecha",
    scheduleHint: "Clic para programar",
    scheduleHintDrag: "Clic o arrastra para programar",
    reorder: "Reordenar",
    selectView: "Seleccionar vista",
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    resizePanel: "Redimensionar panel",
    jumpToBar: (title) => `Ir a "${title}"`,
    progress: (p) => `${p}% completado`,
    durationDays: (d) => (d === 1 ? "1 día" : `${d} días`),
    startDate: "Fecha de inicio",
    endDate: "Fecha de fin",
    continues: "continúa",
    scales: {
      day: "Día",
      week: "Semana",
      month: "Mes",
      quarter: "Trimestre",
      year: "Año",
    },
  },
  formats: {
    monthTitle: "MMMM yyyy",
    dayTitle: "EEEE, d 'de' MMMM 'de' yyyy",
    timeGutter: "h a",
    eventTime: "h:mm a",
  },
}

export const LOCALE_ES = es

export const APP_STRINGS_ES = {
  deleteEvent: "Borrar",
  setBaseline: "Fijar línea base",
  viewBaselines: "Historial de líneas base",
  baselinesLink: (n: number) => `Líneas base (${n})`,
  baselinesTitle: "Historial de líneas base",
  currentPlan: "Plan actual",
  baselineCaptured: "Capturado",
  /** Drift of a baseline's end vs the current plan end, in whole days. */
  baselineDelta: (d: number) =>
    d === 0 ? "Δ 0 d" : `Δ ${d > 0 ? "+" : ""}${d} d`,
  versionShort: (v: number) => `LB${v}`,
  toggleHistoricalBaselines: "Líneas base",
  closePanel: "Cerrar",
  /** Reason persisted on the load-time LB1 snapshot (see plan-mapper). */
  baselineOriginalReason: "Carga inicial del plan",
} as const
