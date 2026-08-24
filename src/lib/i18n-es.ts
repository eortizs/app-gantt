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
    connectHandleTitle: "Arrastra hasta otra tarea para crear una dependencia",
    announceConnected: (from, to) =>
      `Dependencia creada: ${from} → ${to}`,
    announceConnectBlocked: (from) =>
      `No se puede ligar desde ${from}: cerraría un ciclo, ya existe o apunta a la misma tarea`,
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
  /** Baseline span across calendar days. */
  baselineDurationDays: (d: number) => (d === 1 ? "1 día" : `${d} días`),
  /** Baseline span within a single calendar day. */
  baselineDurationHours: (h: number) => (h === 1 ? "1 hora" : `${h} horas`),
  versionShort: (v: number) => `LB${v}`,
  toggleHistoricalBaselines: "Líneas base",
  closePanel: "Cerrar",
  /** Reason persisted on the load-time LB1 snapshot (see plan-mapper). */
  baselineOriginalReason: "Carga inicial del plan",
  /** Reason for the manually-captured entry (seed of a Fijar línea base). */
  baselineManualReason: "Captura manual",
  /** Reason for entries auto-captured on transitive dependents of a seed. */
  baselineCascadeReason: (title: string) =>
    `Refijada en cascada desde «${title}»`,

  // ----- dependencias -----
  /** Context-menu submenu over a bar: link this event to a successor. */
  addDependency: "Agregar dependencia",
  /** Context-menu submenu: unlink an edge touching this event. */
  removeDependency: "Quitar dependencia",
  dependencyTypes: {
    FS: "Fin → Inicio",
    SS: "Inicio → Inicio",
    FF: "Fin → Fin",
    SF: "Inicio → Fin",
  } as const,
  /** Menu entry naming the target event of a prospective edge. */
  dependencyTargetLabel: (title: string) => `Hacia «${title}»`,
  /** Menu entry naming one existing edge (direction relative to this event). */
  dependencyEdgeLabel: (title: string, type: string, outgoing: boolean) =>
    `${outgoing ? "→" : "←"} ${title} (${type})`,
  dependencyPanelTitle: "Dependencia",
  dependencyRemoveAction: "Quitar",
  dependencyClose: "Cerrar panel de dependencia",
  /** Connector tooltip/aria text: type + lag between two named events. */
  dependencyAriaLabel: (fromTitle: string, toTitle: string, type: string) =>
    `${fromTitle} → ${toTitle} (${type})`,
  /** Cause badge on auto-adjusted ops in the changeset JSON. */
  cascadeCauseLegend:
    "Los ops con «cause» son ajustes automáticos en cascada por dependencias; el resto son ediciones manuales.",
  dependencyCycleBlocked: "(cerraría un ciclo)",
  /** Badge on a connector whose constraint the current dates violate. */
  dependencyViolated: "Fuera de secuencia",
} as const
