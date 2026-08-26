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
    resizeColumn: (title) => `Redimensionar columna «${title}»`,
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
    editTitle: (current) => `Editar título: ${current}`,
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
  /** Footer buttons: whole-snapshot undo/redo of the changeset. */
  undoLabel: "Deshacer",
  redoLabel: "Rehacer",
  setBaseline: "Fijar línea base",
  /** Context-menu toggle: convert the task into a finish milestone. */
  convertToMilestone: "Convertir en hito",
  /** Context-menu toggle: restore the milestone back to a task. */
  convertToTask: "Convertir en tarea",
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
  /** Span label for a milestone's baseline (an instant, not a duration). */
  milestoneDurationLabel: "Hito",
  versionShort: (v: number) => `LB${v}`,
  closePanel: "Cerrar",
  /** Reason persisted on the LB1 materialized at first capture (see captureBaseline). */
  baselineOriginalReason: "Carga inicial del plan",
  /** Reason for the manually-captured entry (seed of a Fijar línea base). */
  baselineManualReason: "Captura manual",
  /** Reason for entries auto-captured on transitive dependents of a seed. */
  baselineCascadeReason: (title: string) =>
    `Refijada en cascada desde «${title}»`,

  // ----- avance real -----
  /** Context-menu entry: capture field progress (% and optional AC). */
  registerProgress: "Registrar avance",
  progressDialogTitle: "Registrar avance",
  /** Percent input label (0–100). */
  progressPercentLabel: "Avance físico (%)",
  /** Optional accumulated-cost input. */
  progressAcLabel: "AC acumulado (opcional)",
  /** Shown under the dialog: the actuals cutoff in force. */
  progressDataDateLabel: "Corte vigente",
  progressCommit: "Registrar",
  progressCancel: "Cancelar",
  /** Hint when offline: % still flows to the changeset, AC stays local. */
  progressOfflineHint:
    "Sin backend: el avance viaja al changeset y el AC queda en memoria.",
  /** Invalid numeric input feedback. */
  progressInvalidPercent: "El avance debe ser un número entre 0 y 100.",
  progressInvalidAc: "El AC debe ser un número mayor o igual a 0.",

  // ----- duración por teclado -----
  /** Context-menu entry: retype a task's duration in working days. */
  durationMenuItem: "Duración…",
  durationDialogTitle: "Cambiar duración",
  durationDaysLabel: "Duración (días laborables)",
  durationInvalid: "La duración debe ser un entero mayor o igual a 1.",
  /** Hint under the input: the end seats on the task's own calendar. */
  durationHint:
    "El fin se reasienta en días laborables del calendario de la tarea; los dependientes siguen la cascada.",
  durationCommit: "Guardar",

  // ----- filtros del árbol -----
  /** Filters popover title + trigger aria-label. */
  filterTitle: "Filtros del árbol",
  filterTextPlaceholder: "Buscar por título o responsable…",
  filterTextLabel: "Texto a buscar",
  filterResponsable: "Responsable",
  filterFase: "Fase",
  filterAny: "Cualquiera",
  filterCritical: "Solo ruta crítica",
  filterDrifted: "Solo con desvío",
  filterMilestones: "Solo hitos",
  filterClear: "Limpiar",
  /** Trigger bubble/aria when rows are hidden by the active filters. */
  filterHiddenBadge: (n: number) =>
    `${n} ${n === 1 ? "fila oculta" : "filas ocultas"} por filtro`,
  /** Hint inside the popover: edits still reach filtered-out rows. */
  filterHiddenHint:
    "Los cambios siguen aplicando a las filas ocultas (drift y cascada las mueven igual).",

  // ----- nivelación de recursos -----
  /** Tree-panel column naming each row's crew-overload days. */
  overloadColumn: "Sobrecarga",
  overloadDaysLabel: (n: number) => `${n} d`,
  overloadDaysTitle: (n: number) =>
    `${n} ${n === 1 ? "día" : "días"} con la cuadrilla por encima de su capacidad`,
  /** Toolbar button + preview dialog. */
  levelingButton: "Nivelar recursos",
  levelingTitle: "Nivelación de recursos",
  levelingMoved: (n: number) =>
    `${n} ${n === 1 ? "evento movido" : "eventos movidos"}`,
  levelingRuns: (resolved: number, unresolved: number) =>
    `${resolved} sobrecarga(s) resuelta(s) · ${unresolved} sin resolver`,
  levelingEndDelta: (d: number) =>
    d === 0 ? "Δ fin 0 d" : `Δ fin ${d > 0 ? "+" : ""}${d} d`,
  levelingNoop:
    "Sin sobrecargas: la demanda de cuadrillas ya cabe en su capacidad.",
  levelingApply: "Aplicar nivelación",

  // ----- statusDate + convención de scheduling -----
  /** Label of the seeded status-date cutoff (marker + footer readout). */
  statusDateLabel: "Fecha de corte",
  /** Out-of-sequence convention selector. */
  schedulingLabel: "Fuera de secuencia",
  schedulingRetained: "Lógica retenida",
  schedulingOverride: "Avance como límite",
  /** Hint: switching affects future cascades and the CPM lens at once. */
  schedulingHint:
    "La convención rige las próximas cascadas y la lente CPM; el corte marca el avance de obra.",

  // ----- identidad y sesiones -----
  authTitle: "Ingresar al módulo",
  authPickActor: "Actor",
  authPasscode: "Passcode",
  authSubmit: "Ingresar",
  authLoginButton: "Ingresar",
  authLogout: "Salir",
  /** Wrong passcode / unknown actor / network failure on login. */
  authInvalid: "Passcode inválido o actor inexistente.",
  authLoadError: "No se pudo cargar el directorio de actores.",
  roleLabels: {
    visor: "Visor",
    editor: "Editor",
    aprobador: "Aprobador",
  } as const,

  // ----- parte de horas (timesheets) -----
  timesheetsTitle: "Parte de horas",
  timesheetsPrevWeek: "Semana anterior",
  timesheetsNextWeek: "Semana siguiente",
  timesheetsMine: "Mi semana",
  timesheetsLoginHint: "Ingresa para registrar tus horas de obra.",
  timesheetsEventLabel: "Evento",
  timesheetsDateLabel: "Fecha",
  timesheetsHoursLabel: "Horas",
  timesheetsRemoveRow: "Quitar fila",
  timesheetsAddRow: "Agregar fila",
  timesheetsSaveDraft: "Guardar borrador",
  /** Submit the whole week draft → submitted (REPLACE semantics). */
  timesheetsSubmit: "Enviar a aprobación",
  timesheetsQueueTitle: "Cola de aprobación",
  timesheetsQueueEmpty: "Sin partes pendientes de decisión.",
  /** Merge note under the queue: approval feeds AC via crew day rates. */
  timesheetsHint:
    "Al aprobar, las horas se convierten en costo real (AC) con la tarifa/día de la cuadrilla y mueven el corte del EVM.",

  // ----- dependencias -----
  // (Crear dependencias es drag-and-drop desde los connect handles de la
  // barra; el menú contextual solo quita.)
  /** Context-menu submenu: unlink an edge touching this event. */
  removeDependency: "Quitar dependencia",
  dependencyTypes: {
    FS: "Fin → Inicio",
    SS: "Inicio → Inicio",
    FF: "Fin → Fin",
    SF: "Inicio → Fin",
  } as const,
  /** Menu entry naming one existing edge (direction relative to this event). */
  dependencyEdgeLabel: (title: string, type: string, outgoing: boolean) =>
    `${outgoing ? "→" : "←"} ${title} (${type})`,
  dependencyPanelTitle: "Dependencia",
  dependencyRemoveAction: "Quitar",
  dependencyClose: "Cerrar panel de dependencia",
  /** Connector tooltip/aria text: type + lag between two named events. */
  dependencyAriaLabel: (
    fromTitle: string,
    toTitle: string,
    type: string,
    lagDays?: number,
  ) =>
    `${fromTitle} → ${toTitle} (${type}${
      lagDays ? `, ${lagDays > 0 ? "+" : ""}${lagDays} d` : ""
    })`,
  /** Segmented control heading: the constraint type of the edge. */
  dependencyTypeLabel: "Tipo",
  /** Lag stepper heading (calendar days, signed). */
  dependencyLagLabel: "Lag (días)",
  /** Hint under the lag stepper: negative lag = overlap (lead). */
  dependencyLagHint: "Negativo = solapamiento (adelanto)",
  /** Stepper button: subtract one day of lag. */
  dependencyLagDecrease: "Restar un día de lag",
  /** Stepper button: add one day of lag. */
  dependencyLagIncrease: "Sumar un día de lag",
  /** Cause badge on auto-adjusted ops in the changeset JSON. */
  cascadeCauseLegend:
    "Los ops con «cause» son ajustes automáticos en cascada por dependencias; el resto son ediciones manuales.",
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

  // ----- Presupuesto (budget) -----
  /** Tree-panel column naming each row's money reference (BAC). */
  budgetColumn: "Presupuesto",

  // ----- columnas del panel de árbol -----
  /** Tree-panel column naming each row's responsible person. */
  responsibleColumn: "Responsable",
  /** Columns dropdown trigger (show/hide tree-panel columns). */
  columnsMenuTrigger: "Mostrar u ocultar columnas",
  /** Columns dropdown heading. */
  columnsMenuTitle: "Columnas",
  /** Menu item restoring the default column widths. */
  columnsMenuResetWidths: "Restaurar anchos de columna",
} as const
