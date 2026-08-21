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
