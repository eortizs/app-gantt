"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  useGantt,
  useGanttSelector,
  useGanttViewConfig,
} from "@/components/reui/gantt/gantt"
import {
  useGanttGestures,
  wasRecentDrag,
} from "@/components/reui/gantt/gantt-dnd"
import {
  flattenResources,
  toZoned,
} from "@/components/reui/gantt/gantt-lib"
import type {
  GanttOccurrence,
  GanttSegment,
} from "@/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { differenceInCalendarDays, format } from "date-fns"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { RepeatIcon, CheckIcon } from "lucide-react"

/**
 * Effective Tailwind palette presets for bar colors; every entry works on
 * light and dark surfaces through the bar's alpha background + accent border.
 */
const GANTT_COLORS: Array<{ name: string; value: string }> = [
  { name: "Blue", value: "var(--color-blue-500)" },
  { name: "Emerald", value: "var(--color-emerald-500)" },
  { name: "Violet", value: "var(--color-violet-500)" },
  { name: "Rose", value: "var(--color-rose-500)" },
  { name: "Amber", value: "var(--color-amber-500)" },
  { name: "Cyan", value: "var(--color-cyan-500)" },
  { name: "Orange", value: "var(--color-orange-500)" },
  { name: "Pink", value: "var(--color-pink-500)" },
  { name: "Teal", value: "var(--color-teal-500)" },
  { name: "Indigo", value: "var(--color-indigo-500)" },
]

/**
 * Grace period before a hover-closed tooltip actually unmounts: it gives the
 * pointer time to cross the gap from the bar onto the popup, which is
 * interactive (its data can be read and selected).
 */
const TOOLTIP_CLOSE_GRACE_MS = 150

interface GanttBarContextValue<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  segment: GanttSegment<TData>
  isDragging: boolean
  isSelected: boolean
}

const GanttBarContext =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContext<GanttBarContextValue<any> | null>(null)

/** The bar's subject; usable inside renderEvent content and bar children. */
function useGanttBarContext<TData = unknown>(): GanttBarContextValue<TData> {
  const ctx = useContext(GanttBarContext)
  if (!ctx) {
    throw new Error("useGanttBarContext must be used within <GanttBar>")
  }
  return ctx as GanttBarContextValue<TData>
}

interface GanttBarProps<TData = unknown> extends Omit<
  useRender.ComponentProps<"button">,
  "children"
> {
  segment: GanttSegment<TData>
  /** Replaces the default bar CONTENT; the wrapper stays gantt-owned. */
  children?: ReactNode
  /**
   * The title renders beside the bar (view-owned), so the default inner
   * content is suppressed. Explicit children and renderEvent still win.
   */
  labelOutside?: boolean
  /**
   * Owning row's title for the aria-label. Pass it when the row is in
   * scope (the internal view does); omitting falls back to a tree lookup.
   */
  rowTitle?: string
  /**
   * Temporary replacement for the bar's resting fill - e.g. a baseline
   * version's tone while a consumer cross-highlights that baseline. Painted
   * SOLID while active (no alpha) so plan-vs-version comparison reads at
   * full strength; the progress overlay keeps the EVENT'S OWN color so
   * completion stays readable underneath.
   */
  colorOverride?: string
  /**
   * Companion to `colorOverride` for the bitono model: tones the PROGRESS
   * overlay specifically. Defaults to the event color (anchored by
   * `--gantt-event-color`) so identity stays stable on every preview; a
   * consumer that drives the resting fill with one tone and the progress
   * overlay with another (the per-event bitono, or a history-version
   * preview) sets it independently.
   */
  progressTintOverride?: string
}

/**
 * The one interactive bar element. The wrapper owns positioning hooks, a11y,
 * selection, drag/resize listeners, and data attributes; content comes from
 * children, the root renderEvent override, or the built-in default.
 */
function GanttBar<TData = unknown>({
  segment,
  className,
  render,
  children,
  labelOutside,
  rowTitle: rowTitleProp,
  colorOverride,
  progressTintOverride,
  ...props
}: GanttBarProps<TData>) {
  const instance = useGantt<TData>()
  const viewConfig = useGanttViewConfig<TData>()
  const gestures = useGanttGestures<TData>()
  const { settings } = instance
  const occurrence = segment.occurrence
  const event = occurrence.event

  const isSelected = useGanttSelector<TData, boolean>(
    (state) => state.selection.eventKeys.includes(occurrence.key),
    { calendar: instance }
  )
  const isDragging = useGanttSelector<TData, boolean>(
    (state) => state.drag?.occurrence.key === occurrence.key,
    { calendar: instance }
  )
  // Which gesture owns this bar: a move hides the original (the smooth clone
  // stands in for it); a resize keeps it as a faint placeholder behind the
  // dashed preview so you can see the original extent.
  const dragKind = useGanttSelector<TData, string | null>(
    (state) =>
      state.drag?.occurrence.key === occurrence.key ? state.drag.kind : null,
    { calendar: instance }
  )
  // Hover-only range tooltip. Focus opens are ignored (the known button+
  // tooltip flash: clicking a bar opens a dialog, focus returns, and a
  // focus-triggered tooltip would pop). Hidden while dragging/resizing.
  const [tipOpen, setTipOpen] = useState(false)
  // Latest cursor position over the bar, kept in a ref so pointer movement
  // never re-renders the bar. The tooltip snapshots it once at open time and
  // stays pinned there for its whole lifetime (it does not follow the cursor);
  // only the X axis comes from here - Y anchors to the bar's TOP EDGE below,
  // so the popup always sits above the bar instead of covering it.
  const latestCursor = useRef<{ x: number; y: number } | null>(null)
  // Top edge of the hovered bar (viewport coords), captured on enter. The
  // rect can't go stale mid-hover: panning/zooming starts a gesture, which
  // suppresses the tooltip entirely.
  const latestBarTop = useRef<number | null>(null)
  const trackCursor = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    latestCursor.current = { x: e.clientX, y: e.clientY }
  }, [])
  const onPointerMove = trackCursor
  // Frozen anchor captured when the tooltip opens.
  const [tipAnchor, setTipAnchor] = useState<{ x: number; y: number } | null>(
    null
  )
  // Deferred close: the popup stays mounted for a grace period after the
  // pointer leaves the bar, so it can be reached and pinned. Whether a close
  // should even be pending is derived from two hover flags (trigger + popup)
  // instead of enter/leave ordering: any spurious close request while the
  // pointer rests on the popup finds overPopup=true and cancels, so the
  // tooltip can never close underneath a hovering cursor.
  const closeTimer = useRef<number | null>(null)
  const overTriggerRef = useRef(false)
  const overPopupRef = useRef(false)
  const cancelTipClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  // Immediate close for in-popup actions (e.g. a link handing off to the
  // consumer's own popup): no grace period - the user clicked away on
  // purpose, and the two popups must never stack.
  const dismissTip = useCallback(() => {
    cancelTipClose()
    setTipOpen(false)
    setTipAnchor(null)
  }, [cancelTipClose, setTipOpen, setTipAnchor])
  const requestTipClose = useCallback(() => {
    cancelTipClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setTipOpen(false)
      setTipAnchor(null)
    }, TOOLTIP_CLOSE_GRACE_MS)
  }, [cancelTipClose, setTipOpen, setTipAnchor])
  useEffect(() => cancelTipClose, [cancelTipClose])
  const syncTipHover = useCallback(() => {
    if (overTriggerRef.current || overPopupRef.current) {
      cancelTipClose()
    } else {
      requestTipClose()
    }
  }, [cancelTipClose, requestTipClose])
  // Measure the rendered popup so we can flip below the cursor when there's
  // not enough room above it. Re-measured on each open because the content
  // size depends on the event (title length, progress label).
  const popupRef = useRef<HTMLDivElement | null>(null)
  // Callback ref: an unmounting node fires no pointerleave, so clear the
  // hover flag here or a stale `true` would pin the next open's sync.
  const setPopupElement = useCallback((el: HTMLDivElement | null) => {
    popupRef.current = el
    if (!el) overPopupRef.current = false
  }, [])
  const [popupHeight, setPopupHeight] = useState(0)
  const [popupWidth, setPopupWidth] = useState(0)
  useLayoutEffect(() => {
    if (popupRef.current) {
      setPopupHeight(popupRef.current.offsetHeight)
      setPopupWidth(popupRef.current.offsetWidth)
    }
  }, [tipOpen])
  // ALWAYS above the bar: the anchor line is the bar's top edge, the popup
  // bottom rides a small gap over it, and both axes clamp to the viewport
  // once measured. The Y clamp only kicks in for bars on the first visible
  // row, where "fully above" is physically impossible - it shifts down just
  // enough to stay on-screen (grazing the row above, never the hovered bar).
  const TOOLTIP_GAP_PX = 6
  const tipX = tipAnchor
    ? Math.min(
        Math.max(tipAnchor.x, popupWidth / 2 + 8),
        window.innerWidth - popupWidth / 2 - 8,
      )
    : 0
  const tipY = tipAnchor
    ? Math.max(tipAnchor.y, popupHeight + TOOLTIP_GAP_PX + 8)
    : 0
  // Gated on tipOpen: with the tooltip closed the selector returns a stable
  // false, so gesture start/end doesn't re-render every mounted bar.
  const anyInteracting = useGanttSelector<TData, boolean>(
    (state) => tipOpen && (state.drag !== null || state.slotDraft !== null),
    { calendar: instance }
  )

  const progress =
    typeof event.progress === "number"
      ? Math.min(Math.max(Math.round(event.progress), 0), 100)
      : null
  // A milestone is an instant: the DIAMOND carries all the paint (resting
  // tint / achieved tint), so the square button itself stays transparent -
  // an opaque square behind a rotated square reads as a box, not a diamond.
  const isMilestone = event.milestone === true

  const defaultContent = (
    <>
      {occurrence.isRecurring && (
        <RepeatIcon className="size-2.5 shrink-0 opacity-70" aria-hidden="true" />
      )}
      <span className="truncate font-medium">{event.title}</span>
      {!occurrence.allDay && segment.isStart && (
        <span className="text-muted-foreground hidden truncate @[8rem]:inline">
          {settings.i18n.functions.formatEventTime(
            toZoned(occurrence.start, settings.timeZone),
            toZoned(occurrence.end, settings.timeZone),
            occurrence.allDay,
            settings.locale
          )}
        </span>
      )}
    </>
  )

  const renderProps = { occurrence, segment, isDragging, isSelected }
  const content =
    children ??
    viewConfig.renderEvent?.(renderProps) ??
    (labelOutside || isMilestone ? null : defaultContent)
  // Consumer-owned content owns the WHOLE inner visualization: the built-in
  // progress fill and done mark yield so custom bars start from a blank
  // canvas (progress stays readable via data-progress/data-completed).
  const consumerOwnsContent = children !== undefined || !!viewConfig.renderEvent

  const timeLabel = settings.i18n.functions.formatEventTime(
    toZoned(occurrence.start, settings.timeZone),
    toZoned(occurrence.end, settings.timeZone),
    occurrence.allDay,
    settings.locale
  )
  const startDate = format(
    toZoned(occurrence.start, settings.timeZone),
    "yyyy-MM-dd"
  )
  const endDate = format(
    toZoned(occurrence.end, settings.timeZone),
    "yyyy-MM-dd"
  )
  const durationDays = Math.max(
    1,
    differenceInCalendarDays(
      toZoned(occurrence.end, settings.timeZone),
      toZoned(occurrence.start, settings.timeZone)
    )
  )
  // name the row too: the split-pane layout carries no grid semantics.
  // The prop path is O(1); the lookup fallback is memoized so external
  // GanttBar usage never flattens the tree per render.
  const fallbackRowTitle = useMemo(
    () =>
      rowTitleProp === undefined && event.resourceId
        ? flattenResources(settings.resources).find(
            ({ resource }) => resource.id === event.resourceId
          )?.resource.title
        : undefined,
    [rowTitleProp, event.resourceId, settings.resources]
  )
  const rowTitle = rowTitleProp ?? fallbackRowTitle

  const showResize = gestures.canResize(segment)
  const resizeHandles = showResize && (
    <>
      {segment.isStart && (
        <span
          data-slot="gantt-resize-handle"
          data-edge="start"
          // grip hugs the start edge (justify-start + tight inset) so the
          // indicator reads as "resize this end", not a centered pill.
          // pointer-coarse keeps it visible on touch, where hover never fires
          className="absolute inset-y-0 start-0.5 flex w-2 cursor-ew-resize items-center justify-start opacity-0 group-hover/gantt-bar-group:opacity-100 pointer-coarse:opacity-100"
          onPointerDown={(e) => gestures.beginResize(e, segment, "start")}
        >
          <span
            aria-hidden
            className="bg-foreground/40 h-2.5 w-0.5 rounded-full"
          />
        </span>
      )}
      {segment.isEnd && (
        <span
          data-slot="gantt-resize-handle"
          data-edge="end"
          // grip hugs the end edge (justify-end + tight inset) so the
          // indicator reads as "resize this end", not a centered pill.
          // pointer-coarse keeps it visible on touch, where hover never fires
          className="absolute inset-y-0 end-0.5 flex w-2 cursor-ew-resize items-center justify-end opacity-0 group-hover/gantt-bar-group:opacity-100 pointer-coarse:opacity-100"
          onPointerDown={(e) => gestures.beginResize(e, segment, "end")}
        >
          <span
            aria-hidden
            className="bg-foreground/40 h-2.5 w-0.5 rounded-full"
          />
        </span>
      )}
    </>
  )

  const defaultProps = {
    type: "button" as const,
    "data-slot": "gantt-bar",
    // stable hook for consumers to find THIS bar's element (e.g. anchoring a
    // popup that outlives the cursor-anchored tooltip)
    "data-occurrence-key": occurrence.key,
    "data-all-day": occurrence.allDay || undefined,
    "data-recurring": occurrence.isRecurring || undefined,
    "data-selected": isSelected || undefined,
    "data-dragging": isDragging || undefined,
    "data-drag-kind": dragKind ?? undefined,
    "data-past": occurrence.end.getTime() < Date.now() || undefined,
    "data-label-outside": labelOutside || undefined,
    "data-progress": progress ?? undefined,
    "data-completed": progress === 100 || undefined,
    "data-bar-tinted": colorOverride || progressTintOverride || undefined,
    "aria-label": settings.i18n.functions.formatEventAriaLabel({
      title: event.title,
      timeLabel,
      rowTitle,
      progressLabel:
        progress !== null ? settings.i18n.labels.progress(progress) : undefined,
      continues: segment.continuesBefore || segment.continuesAfter,
    }),
    style: {
      // event color stays anchored to the phase: progress, focus chrome and
      // any consumer chrome that reads it must keep the event identity.
      "--gantt-event-color": event.color ?? "var(--color-primary)",
      // bar resting fill takes the override (baseline hover) and falls
      // back to the event color when none is set, so the resting layer
      // can shift independently of the progress layer.
      "--gantt-bar-tint": colorOverride ?? "var(--gantt-event-color)",
      // progress overlay tint moves independently: the consumer can paint a
      // bitono (separate resting + progress tones, e.g. for a history-
      // version preview) without rewriting --gantt-event-color.
      "--gantt-progress-tint":
        progressTintOverride ?? "var(--gantt-event-color)",
    } as CSSProperties,
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation()
      gestures.beginMove(e, segment)
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      if (wasRecentDrag()) return
      instance.api.selectEvent(occurrence.key)
      settings.onEventClick?.(occurrence, e)
    },
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
      overTriggerRef.current = true
      trackCursor(e)
      latestBarTop.current = e.currentTarget.getBoundingClientRect().top
      syncTipHover()
    },
    onPointerLeave: () => {
      overTriggerRef.current = false
      syncTipHover()
    },
    onPointerMove,
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      settings.onEventDoubleClick?.(occurrence, e)
    },
    className: cn(
      "group/gantt-bar-group text-foreground @container relative flex w-full min-w-0 cursor-pointer touch-none items-center gap-1.5 overflow-hidden rounded-sm text-start leading-normal select-none",
      "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
      // resting fill lives on the DIAMOND for milestones (see below); the
      // square hit-area stays transparent, darkening only on hover/selected
      // so the affordance reads without flattening the diamond into a box.
      !isMilestone && "px-1.5 py-0.5",
      !isMilestone &&
        // resting fill: translucent normally, OPAQUE while a baseline tint is
        // active so plan-vs-version comparison reads at full strength (the
        // progress overlay still uses the event color underneath)
        "bg-(--gantt-bar-tint)/20 data-bar-tinted:bg-(--gantt-bar-tint)",
      // move: hide the original (the smooth clone represents it)
      "data-[drag-kind=move]:opacity-0",
      // resize: keep the original event exactly, just fade it to a soft
      // placeholder behind the dashed preview - no dramatic restyle
      "data-[drag-kind=resize-start]:opacity-40 data-[drag-kind=resize-end]:opacity-40",
      // hover/selected: subtle alpha on the resting translucent look. The
      // opaque (tinted) layer must stay OPAQUE in every state: a translucent
      // background-color here would REPLACE the tint and make the bar go
      // see-through exactly when the pointer rests on it (e.g. right after
      // a drag), leaving the baseline lip underneath as the only visible
      // paint. So: re-assert the opaque tint under hover/selected, and lay
      // the darkening wash as a background-IMAGE, which stacks OVER the
      // background-color instead of replacing it.
      !isMilestone &&
        "hover:bg-(--gantt-bar-tint)/30 data-bar-tinted:hover:bg-(--gantt-bar-tint) data-bar-tinted:hover:bg-[linear-gradient(rgb(0_0_0/0.05),rgb(0_0_0/0.05))]",
      !isMilestone &&
        "data-selected:bg-(--gantt-bar-tint)/30 data-bar-tinted:data-selected:bg-(--gantt-bar-tint) data-bar-tinted:data-selected:bg-[linear-gradient(rgb(0_0_0/0.05),rgb(0_0_0/0.05))]",
      isMilestone &&
        "hover:bg-[linear-gradient(rgb(0_0_0/0.05),rgb(0_0_0/0.05))] data-selected:bg-[linear-gradient(rgb(0_0_0/0.05),rgb(0_0_0/0.05))]",
      segment.continuesBefore && "rounded-s-none",
      segment.continuesAfter && "rounded-e-none",
      viewConfig.classNames?.event,
      className
    ),
    children: (
      <>
        {isMilestone && (
          // The milestone shape itself: a diamond centered in the square
          // hit-area, painted with the SAME bitono channels as a bar - the
          // resting tint (consumer bitono / dirty tint via colorOverride)
          // while pending, the strong progress tint once achieved (100%).
          // State chrome that must not borrow the fills (critical-path
          // stroke via getEventBarClassName) rides the square wrapper.
          <span
            aria-hidden
            data-slot="gantt-milestone-diamond"
            data-completed={progress === 100 || undefined}
            className="border-(--gantt-progress-tint)/65 bg-(--gantt-bar-tint) pointer-events-none absolute top-1/2 left-1/2 block size-[68%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border data-completed:border-(--gantt-progress-tint) data-completed:bg-(--gantt-progress-tint)"
          />
        )}
        {progress !== null && !isMilestone && (
          // Chrome, not content: it is an absolutely-positioned layer BEHIND
          // whatever the bar renders, so a consumer bar (renderEvent) keeps
          // its completion fill instead of silently losing it. The inline
          // done-mark below stays gated, because that one really is content.
          // The tint comes from --gantt-progress-tint (defaults to the event
          // color) so the bitono can move progress independently of the
          // resting fill underneath. Milestones are all-or-nothing: the
          // diamond flips to the strong tint at 100%, no % strip.
          <span
            aria-hidden
            data-slot="gantt-bar-progress"
            className="pointer-events-none absolute inset-y-0 start-0 border-e border-(--gantt-progress-tint)/65 bg-(--gantt-progress-tint)/40 data-full:border-e-0"
            data-full={progress === 100 || undefined}
            style={{ width: `${progress}%` }}
          />
        )}
        {progress === 100 && !consumerOwnsContent && !isMilestone && (
          // done mark: completion chrome like the fill itself, so it shows
          // for outside-label bars too (where the inner content is empty)
          <CheckIcon className="relative size-2.5 shrink-0 opacity-80" aria-hidden="true" />
        )}
        {content}
        {resizeHandles}
      </>
    ),
  }

  const barButton = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  })

  // Consumer-owned right-click menu (headless): the primitive only wires the
  // ContextMenu; the items and their handlers come entirely from the block.
  const menu = viewConfig.renderEventMenu?.(renderProps)

  // The bar is simultaneously the tooltip trigger and (when a menu exists)
  // the context-menu trigger; Base UI composes both via render props.
  const trigger = menu ? (
    <ContextMenuTrigger render={<TooltipTrigger render={barButton} />} />
  ) : (
    <TooltipTrigger render={barButton} />
  )

  const barTree = (
    <TooltipProvider delay={500} closeDelay={0} timeout={300}>
      <Tooltip
        open={tipOpen && !anyInteracting}
        onOpenChange={(next: boolean, details: { reason?: string }) => {
          // opens only on hover; focus/press opens are dropped
          if (next && details?.reason !== "trigger-hover") return
          if (next) {
            overTriggerRef.current = true
            cancelTipClose()
            setTipOpen(true)
            // Freeze the anchor at open time; the popup stays there. X comes
            // from the cursor, Y from the bar's top edge: a cursor-anchored
            // tooltip flips ONTO the bar when the cursor hugs the viewport
            // top or the bar's lower half - exactly what must never happen.
            setTipAnchor({
              x: latestCursor.current?.x ?? 0,
              y: latestBarTop.current ?? latestCursor.current?.y ?? 0,
            })
          } else {
            // Base UI already saw the trigger hover end; the actual close is
            // decided by syncTipHover, so repeated close requests while the
            // pointer rests on the popup are inert.
            overTriggerRef.current = false
            syncTipHover()
          }
        }}
      >
        {trigger}
        {tipOpen && !anyInteracting && tipAnchor && (
          // Pinned at open time via CSS transforms, so we bypass Base UI's
          // Positioner: floating-ui's autoUpdate only tracks element rect
          // changes, not virtual-element rect changes. X anchors to the
          // cursor, Y to the bar's top edge (see setTipAnchor); the popup is
          // interactive on purpose: pointer-enter pins it open so its data
          // can be read and selected.
          <TooltipPortal>
            <div
              ref={setPopupElement}
              data-slot="tooltip-content"
              data-side="top"
              className="isolate z-50"
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                transform: `translate3d(${tipX}px, ${tipY}px, 0)`,
              }}
            >
              <div
                onPointerEnter={() => {
                  overPopupRef.current = true
                  syncTipHover()
                }}
                onPointerLeave={() => {
                  overPopupRef.current = false
                  syncTipHover()
                }}
                style={{
                  position: "absolute",
                  left: "50%",
                  transform: "translate(-50%, calc(-100% - 6px))",
                }}
                className="flex w-max max-w-xs flex-col items-start gap-0.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background"
              >
                <div className="font-medium">{event.title}</div>
                <div className="opacity-80">
                  {settings.i18n.labels.startDate} : {startDate}
                </div>
                {!isMilestone && (
                  <div className="opacity-80">
                    {settings.i18n.labels.endDate} : {endDate}
                  </div>
                )}
                {!isMilestone && (
                  <div className="opacity-80">
                    Duration : {settings.i18n.labels.durationDays(durationDays)}
                  </div>
                )}
                {progress !== null && (
                  <div className="opacity-80">Progress : {progress}</div>
                )}
                {viewConfig.renderTooltipExtras?.({
                  occurrence,
                  segment,
                  dismiss: dismissTip,
                })}
              </div>
            </div>
          </TooltipPortal>
        )}
      </Tooltip>
    </TooltipProvider>
  )

  return (
    <GanttBarContext.Provider
      value={{ occurrence, segment, isDragging, isSelected }}
    >
      {menu ? (
        <ContextMenu>
          {barTree}
          <ContextMenuContent data-slot="gantt-bar-menu" className="min-w-44">
            {menu}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        barTree
      )}
    </GanttBarContext.Provider>
  )
}

export { GANTT_COLORS, GanttBar, useGanttBarContext }
export type { GanttBarContextValue, GanttBarProps }