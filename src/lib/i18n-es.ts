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
  /** Sum of every entry's Δ vs the current plan, so nobody adds by hand. */
  baselineTotalDelta: (d: number) =>
    d === 0 ? "Σ Δ 0 d" : `Σ Δ ${d > 0 ? "+" : ""}${d} d`,
  /** Baseline span across calendar days. */
  baselineDurationDays: (d: number) => (d === 1 ? "1 día" : `${d} días`),
  /** Baseline span within a single calendar day. */
  baselineDurationHours: (h: number) => (h === 1 ? "1 hora" : `${h} horas`),
  versionShort: (v: number) => `LB${v}`,
  toggleHistoricalBaselines: "Líneas base",
  closePanel: "Cerrar",
  /** Reason persisted on the LB1 materialized at first capture (see captureBaseline). */
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

  // ----- CPM -----
  /** Legend for the critical-path paint: phase-color stroke = float 0. */
  criticalPathLegend: (n: number) =>
    `Ruta crítica: ${n} ${n === 1 ? "evento" : "eventos"} con holgura 0 (borde de color de fase)`,

  // ----- EVM -----
  evmTitle: "Valor ganado (EVM)",
  evmDataDate: (d: string) => `Corte: ${d}`,
  evmBac: "BAC",
  evmPv: "PV",
  evmEv: "EV",
  evmAc: "AC",
  evmSpi: "SPI",
  evmCpi: "CPI",
  evmEac: "EAC",
  evmSv: "SV",
  evmCv: "CV",
  evmEtc: "ETC",
  evmTcpi: "TCPI",
  evmVac: "VAC",

  // ----- carga del plan (backend) -----
  loadingPlan: "Cargando plan…",
  /** Shown when GET /api/plans/:id failed and the demo entity took over. */
  offlineFallbackNote:
    "Sin conexión al backend: usando el plan demo en memoria (sin persistencia).",

  // ----- solicitudes de cambio -----
  /** Proposes the recorded ops as a CR (server builds + freezes impact). */
  proposeChangeRequest: "Proponer solicitud de cambio",
  proposeReasonPlaceholder: "Motivo (opcional)",
  /** Shown after the server accepted the proposal. */
  crProposedNote:
    "Solicitud propuesta: el impacto quedó congelado para el aprobador.",
  /** Error text when the propose POST failed. */
  crProposeError: (detail: string) => `No se pudo proponer la solicitud (${detail}).`,
  /** Queue panel title. */
  crTitle: "Solicitudes de cambio",
  /** Empty queue placeholder. */
  crEmpty: "Todavía no hay solicitudes de cambio.",
  /** Status badge labels. */
  crStatusLabels: {
    proposed: "Propuesta",
    approved: "Aprobada",
    rejected: "Rechazada",
    applied: "Aplicada",
  } as const,
  /** Affectation count of a frozen impact snapshot. */
  crImpactEvents: (n: number) =>
    `${n} ${n === 1 ? "evento afectado" : "eventos afectados"}`,
  /** Signed Σ drift of a frozen impact snapshot. */
  crImpactDrift: (d: number) =>
    d === 0 ? "Σ desliz 0 d" : `Σ desliz ${d > 0 ? "+" : ""}${d} d`,
  /** Days added to the labor calendar (positive drifts only). */
  crExtendedDays: (d: number) =>
    d === 1 ? "1 día de extensión" : `${d} días de extensión`,
  /** Frozen cost projection label. */
  crProjectedCost: "Costo proyectado",
  /** Suffix clarifying the labor-burn model. */
  crProjectedCostHint: "solo mano de obra",
  /** Decision buttons. */
  crApprove: "Aprobar",
  crReject: "Rechazar",
  crApply: "Aplicar",
  /** Row-level error when a decision POST failed. */
  crDecisionError: (detail: string) => `No se pudo decidir (${detail}).`,
  /** Stale CR: bound to a plan revision that already moved — must be re-proposed. */
  crRevisionConflict: (bound: number, current: number) =>
    `Anclada a la rev ${bound} y el plan va por la rev ${current}: otras solicitudes se aplicaron después de proponerla. Re-propón los cambios para evaluarlos sobre el plan vigente.`,
  /** Decision reason for the apply statusLog entry. */
  crApplyReason: "Aplicada desde la cola de solicitudes",

  // ----- RRHH (workforce) -----
  /** Tree-panel column naming the crew assigned to each row. */
  crewColumn: "Cuadrilla",
} as const
