type GanttBarId = string

type GanttScale = "day" | "week" | "month" | "quarter" | "year"

/** Row drag-reorder proposal: `parentId` null is root, `resources` is the tree with the move applied. */
interface GanttResourceReorder {
  resourceId: string
  parentId: string | null
  /** Position among the new parent's children, the moved row excluded. */
  index: number
  resources: GanttResource[]
}

/**
 * "single" keeps the node on one track and refuses any gesture that would
 * create a concurrent schedule; "multiple" stacks them into stable lanes.
 */
type GanttScheduleMode = "single" | "multiple"

/**
 * Drop policy for a gesture overlapping another schedule in the SAME node.
 * Policy only - overlapping data always renders. "allow" (default) commits as
 * proposed, "clamp" stops at the neighbour's edge, "reject" never commits.
 */
type GanttOverlapPolicy = "allow" | "reject" | "clamp"

/** Vertical placement of row content when the node holds several lanes; "start" pins it to the first lane. */
type GanttRowAlign = "start" | "center"

/** One tree node, not domain-bound: a task (one schedule) or a resource lane (many). Children nest as collapsible groups. */
interface GanttResource {
  id: string
  title: string
  color?: string
  /** Per-node cardinality; falls back to the view-level default. */
  scheduleMode?: GanttScheduleMode
  children?: GanttResource[]
}

/** Preferred name for a tree node; `GanttResource` is the legacy alias. */
type GanttNode = GanttResource

/** Half-open: `start` inclusive, `end` exclusive. */
interface GanttDateRange {
  start: Date
  end: Date
}

/**
 * One historical baseline range of an event. The NEWEST mark of an event is
 * the baseline in force: painted as a full-size pastel bar sitting a lip
 * below its live bar; older marks shrink to thin solid pastel lines fanning
 * below. Domain-free on purpose: the engine never knows WHERE history is
 * stored, only how to paint what the consumer hands over.
 */
interface GanttBaselineMark {
  /** Stable identity (e.g. `${eventId}::v${version}`); powers cross-highlighting. */
  key: string
  /** Optional display label; opaque to the engine. */
  label?: string
  /**
   * Opaque CSS color for the mark (a phase color; `var()` references are
   * tolerated but concrete hexes are preferred - they paint without any
   * runtime resolution). Seeds the current-baseline bar's pastel; older
   * marks always take the fixed pastel ramp by depth. Without a color the
   * bar falls back to a muted neutral.
   */
  color?: string
  start: Date
  end: Date
}

/** The four standard scheduling constraints between two bars. */
type GanttDependencyType = "FS" | "SS" | "FF" | "SF"

/**
 * One connector between two events, painted as an elbow arrow on an overlay
 * above the rows. Domain-free like GanttBaselineMark: the consumer resolves
 * violation semantics; the engine only anchors endpoints by event id and
 * paints. `key` should be the dependency's own stable id so consumers can
 * offer edit/delete affordances off a click.
 */
interface GanttDependencyMark {
  key: string
  fromEventId: GanttBarId
  toEventId: GanttBarId
  type?: GanttDependencyType
  /** Painted destructive when true; semantics are the consumer's call. */
  violated?: boolean
}

type GanttWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

interface GanttRecurrenceRule {
  freq: "daily" | "weekly" | "monthly" | "yearly"
  interval?: number
  count?: number
  /** Inclusive, unlike the exclusive `end` of a range. */
  until?: Date
  byWeekday?: Array<GanttWeekday | { day: GanttWeekday; ordinal: number }>
  byMonthDay?: number[]
  byMonth?: number[]
  weekStart?: GanttWeekday
  exDates?: Date[]
  rDates?: Date[]
}

interface GanttEvent<TData = unknown> {
  id: GanttBarId
  title: string
  /** Plain instants, not ISO strings. `end` is exclusive and must be >= start. */
  start: Date
  end: Date
  allDay?: boolean
  /** Structured rule or a raw "RRULE:..." line. */
  recurrence?: GanttRecurrenceRule | string
  /** An edited single occurrence of that series; `originalStart` is the RECURRENCE-ID it replaces. */
  recurringEventId?: GanttBarId
  originalStart?: Date
  /** Token or css color; flows to the --gantt-event-color css var. */
  color?: string
  /** Vetoes only, ANDed with interactions.drag / .resize: readOnly blocks both, draggable/resizable one each. */
  readOnly?: boolean
  draggable?: boolean
  resizable?: boolean
  /**
   * Finish milestone: renders as a diamond centered on the event's END
   * instant (start === end, duration 0). Never resizable; draggable as a
   * whole. Absent = regular timed bar.
   */
  milestone?: boolean
  /** Feeds the default getEventPriority; higher orders and packs first. */
  priority?: number
  /** Completion 0-100, not 0-1. */
  progress?: number
  /** Explicit stacking override; wins over the computed z. */
  zIndex?: number
  resourceId?: string
  data?: TData
}

interface GanttOccurrence<TData = unknown> {
  /** Stable per instance: `${event.id}::${startISO}`. */
  key: string
  eventId: GanttBarId
  event: GanttEvent<TData>
  start: Date
  end: Date
  allDay: boolean
  isRecurring: boolean
  recurrenceIndex?: number
}

interface GanttSegment<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  /** Range-start reference instant of the segment's timeline slice. */
  day: Date
  isStart: boolean
  isEnd: boolean
  continuesBefore: boolean
  continuesAfter: boolean
  /** Minutes from the visible range start, clamped to the range. */
  startMin?: number
  endMin?: number
  /** Lane packing: 0-based lane index, then the lanes the node's row resolved to. */
  column?: number
  columnCount?: number
  columnSpan?: number
}

interface GanttSelection {
  eventKeys: string[]
  slot: { start: Date; end: Date; allDay: boolean } | null
}

interface GanttInteractions {
  /** Horizontal move within the bar's own row; never across rows. */
  drag: boolean
  resize: boolean
  selectSlot: boolean
}

interface GanttDragState<TData = unknown> {
  kind: "move" | "resize-start" | "resize-end"
  occurrence: GanttOccurrence<TData>
  proposedStart: Date
  proposedEnd: Date
  proposedAllDay: boolean
  proposedResourceId?: string
  /** Last canDropEvent verdict; drives data-drop-invalid styling. */
  valid: boolean
}

/** The in-gesture drag-create rectangle only; the committed slot is GanttSelection.slot. */
interface GanttSlotDraft {
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
}

interface GanttState<TData = unknown> {
  scale: GanttScale
  date: Date
  /** Full rendered axis range - fetch remote data for THIS, not for activeRange (the logical month/week). */
  visibleRange: GanttDateRange
  activeRange: GanttDateRange
  events: GanttEvent<TData>[]
  selection: GanttSelection
  interactions: GanttInteractions
  loading: boolean
  drag: GanttDragState<TData> | null
  slotDraft: GanttSlotDraft | null
  /** Center of the scrolled viewport; the nav title follows it. null falls back to the anchor date. */
  viewportCenter: Date | null
}

interface GanttRangeInfo {
  range: GanttDateRange
  activeRange: GanttDateRange
  scale: GanttScale
  date: Date
  timeZone: string
}

interface GanttProposedUpdate<TData = unknown> {
  event: GanttEvent<TData>
  /** null when source === "api". */
  occurrence: GanttOccurrence<TData> | null
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
  source: "drag" | "resize-start" | "resize-end" | "keyboard" | "api"
}

/** false = reject/revert; void or true = accept; object = accept with adjustment. */
type GanttUpdateResult =
  | boolean
  | void
  | { start?: Date; end?: Date; allDay?: boolean }

/** A click is a point, not a range; `end` is reserved for future gestures. */
interface GanttSlotInfo {
  date: Date
  end?: Date
  allDay: boolean
  resourceId?: string
}

/** Off-day marking; `true` takes the defaults. Marked cells carry `data-off` for CSS customization. */
interface GanttOffDaysConfig {
  /** Weekday numbers treated as off (0 = Sunday). Default [0, 6]. */
  weekendDays?: number[]
  /** Extra off dates compared by day in the display zone. */
  dates?: Date[]
  /** Runs in addition to weekendDays and dates, not instead; any match marks the day off. */
  isOffDay?: (day: Date) => boolean
  /** Marker classes; default "bg-muted/40". */
  className?: string
}

/** External-data contract; OAuth, tokens, and sync loops are application backend territory. */
interface GanttDataAdapter<TData = unknown> {
  getEvents(
    range: GanttDateRange,
    signal?: AbortSignal
  ): Promise<GanttEvent<TData>[]>
}

export type {
  GanttEvent,
  GanttBaselineMark,
  GanttDataAdapter,
  GanttDateRange,
  GanttDependencyMark,
  GanttDependencyType,
  GanttDragState,
  GanttBarId,
  GanttInteractions,
  GanttNode,
  GanttOccurrence,
  GanttOffDaysConfig,
  GanttOverlapPolicy,
  GanttProposedUpdate,
  GanttRangeInfo,
  GanttRecurrenceRule,
  GanttResource,
  GanttRowAlign,
  GanttScheduleMode,
  GanttSegment,
  GanttSelection,
  GanttSlotDraft,
  GanttSlotInfo,
  GanttState,
  GanttResourceReorder,
  GanttScale,
  GanttUpdateResult,
  GanttWeekday,
}