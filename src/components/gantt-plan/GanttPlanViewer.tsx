import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { format } from "date-fns"
import {
  Gantt,
  type GanttApi,
  type GanttBaselineMark,
  type GanttColumn,
  useGanttScale,
} from "@/components/reui/gantt/gantt"
import {
  GANTT_SCALES,
  GanttNav,
  GanttNavNext,
  GanttNavPrev,
  GanttNavToday,
  GanttTitle,
} from "@/components/reui/gantt/gantt-nav"
import { GanttView } from "@/components/reui/gantt/gantt-view"
import type {
  GanttEvent,
  GanttOccurrence,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { Slider } from "@/components/ui/slider"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  GhostIcon,
  HistoryIcon,
  PinIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { createChangesetRecorder, type ChangesetRecorder } from "@/lib/changeset"
import { APP_STRINGS_ES, I18N_ES, LOCALE_ES } from "@/lib/i18n-es"
import type { EventData, PlanJSON } from "@/lib/plan-types"
import { toGanttEvents, toGanttResources } from "@/lib/plan-mapper"
import { applyOps, encodeUpdatedPlan, type ChangeOp } from "@/lib/umejson/codec"
import { decodeUmePlan, type UmeJsonEntity, type ValidationError } from "@/lib/umejson/schema"
import { wbsLevelStyle } from "@/lib/wbs-levels"
import { ChangesetPanel } from "@/components/gantt-plan/ChangesetPanel"
import { cn } from "@/lib/utils"

export interface GanttPlanViewerProps {
  document: UmeJsonEntity
  onError?: (errors: ValidationError[]) => void
  onOpsChange?: (ops: ChangeOp[]) => void
  onDocumentChange?: (entity: UmeJsonEntity) => void
}

export function GanttPlanViewer({
  document,
  onError,
  onOpsChange,
  onDocumentChange,
}: GanttPlanViewerProps) {
  const decoded = useMemo(() => decodeUmePlan(document), [document])
  const validationError = !decoded.ok ? decoded.errors : null

  useEffect(() => {
    if (validationError && onError) onError(validationError)
  }, [validationError, onError])

  if (!decoded.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Documento umeJSON inválido</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            El documento recibido no cumple el contrato umeJSON. No se puede
            renderizar el Gantt hasta corregir los siguientes errores:
          </p>
          <pre className="text-xs overflow-auto max-h-72 rounded-md bg-muted p-3">
            {JSON.stringify(decoded.errors, null, 2)}
          </pre>
        </CardContent>
      </Card>
    )
  }

  return (
    <GanttPlanViewerInner
      entity={decoded.entity}
      originalPlan={decoded.plan}
      onOpsChange={onOpsChange}
      onDocumentChange={onDocumentChange}
    />
  )
}

function GanttPlanViewerInner({
  entity,
  originalPlan,
  onOpsChange,
  onDocumentChange,
}: {
  entity: UmeJsonEntity
  originalPlan: PlanJSON
  onOpsChange?: (ops: ChangeOp[]) => void
  onDocumentChange?: (entity: UmeJsonEntity) => void
}) {
  const apiRef = useRef<GanttApi<EventData> | null>(null)
  const recorderRef = useRef<ChangesetRecorder | null>(null)
  if (recorderRef.current === null) {
    recorderRef.current = createChangesetRecorder(apiRef)
  }
  const recorder = recorderRef.current!

  const [events, setEvents] = useState<GanttEvent<EventData>[]>(() =>
    toGanttEvents(originalPlan),
  )
  const resources: GanttResource[] = useMemo(
    () => toGanttResources(originalPlan),
    [originalPlan],
  )

  // ----- bitácora de baselines -----
  // Anchor lookups resolve against this subtree: the tooltip lives in a
  // portal, but bars stay right here.
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Default view shows only the immediately-previous baseline (the drift that
  // matters most); the toggle fans out the whole history on the timeline.
  const [showAllBaselines, setShowAllBaselines] = useState(false)
  const [historyTarget, setHistoryTarget] = useState<{
    eventId: string
    anchor: { x: number; y: number }
  } | null>(null)
  const [highlightedBaseline, setHighlightedBaseline] = useState<string | null>(
    null,
  )

  // STABLE identity is load-bearing: the engine's per-row layout memo depends
  // on this callback, and a fresh closure per render would rebuild every row.
  const getEventBaselines = useCallback(
    ({ event }: { event: GanttEvent<EventData> }): GanttBaselineMark[] => {
      const history = event.data?.baselines ?? []
      if (!history.length) return []
      const ordered = [...history].sort((a, b) => a.version - b.version)
      const visible = showAllBaselines ? ordered : ordered.slice(-1)
      return visible.map((b) => ({
        key: `${event.id}::baseline-v${b.version}`,
        label: APP_STRINGS_ES.versionShort(b.version),
        start: new Date(b.start),
        end: new Date(b.end),
      }))
    },
    [showAllBaselines],
  )

  // Same stability contract as above (array identity is compared upstream).
  const highlightedBaselineKeys = useMemo(
    () => (highlightedBaseline ? [highlightedBaseline] : undefined),
    [highlightedBaseline],
  )

  // Re-baselining is an explicit, auditable action: it snapshots the CURRENT
  // dates into the append-only history. Drags never touch it - they only
  // produce uncommitted ChangeOps until a save commits them.
  const captureBaseline = useCallback((eventId: string) => {
    setEvents((prev) =>
      prev.map((ev) => {
        if (ev.id !== eventId || !ev.data) return ev
        const nextVersion =
          ev.data.baselines?.reduce((max, b) => Math.max(max, b.version), 0) ??
          0
        return {
          ...ev,
          data: {
            ...ev.data,
            baselines: [
              ...(ev.data.baselines ?? []),
              {
                version: nextVersion + 1,
                start: ev.start.toISOString(),
                end: ev.end.toISOString(),
                capturedAt: new Date().toISOString(),
                reason: "Captura manual",
              },
            ],
          },
        }
      }),
    )
  }, [])

  // Opens the history panel anchored to the bar itself (not the cursor): the
  // tooltip freezes its anchor at open time, but a panel listing history
  // needs an anchor that stays put.
  const openHistory = useCallback(
    (occurrence: GanttOccurrence<EventData>) => {
      const bar = rootRef.current?.querySelector<HTMLElement>(
        `[data-occurrence-key="${CSS.escape(occurrence.key)}"]`,
      )
      const rect = bar?.getBoundingClientRect()
      setHistoryTarget({
        eventId: occurrence.event.id,
        anchor: {
          x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
          y: rect ? rect.bottom + 6 : window.innerHeight / 3,
        },
      })
      setHighlightedBaseline(null)
    },
    [],
  )

  // Derived, not effect-synced: if the event disappears (deleted, plan reset)
  // while the panel is open, dropping the target during render closes it with
  // no extra render pass. The stale state stays invisible and inert.
  const historyEvent = historyTarget
    ? events.find((ev) => ev.id === historyTarget.eventId) ?? null
    : null
  const activeHistory = historyTarget && historyEvent ? historyTarget : null

  const maxDepth = useMemo(() => depthOf(resources), [resources])
  const [level, setLevel] = useState(maxDepth)
  const collapsedGroups = useMemo(() => {
    const ids: string[] = []
    const walk = (nodes: GanttResource[], depth: number) => {
      for (const node of nodes) {
        if (!node.children?.length) continue
        if (depth >= level) ids.push(node.id)
        walk(node.children, depth + 1)
      }
    }
    walk(resources, 0)
    return ids
  }, [resources, level])

  const columns: GanttColumn[] = useMemo(
    () => [
      {
        id: "responsable",
        title: "Responsable",
        width: 130,
        render: (ctx: { resource: { id: string } }) => {
          const r = originalPlan.resources.find((rr) => rr.id === ctx.resource.id)
          return r?.responsable ?? "—"
        },
      },
    ],
    [originalPlan],
  )

  const ops = useRecorderOps(recorder)
  const documentOut = useMemo(
    () => (ops.length ? encodeUpdatedPlan(entity, applyOps(originalPlan, ops), ops.length) : null),
    [ops, entity, originalPlan],
  )

  useEffect(() => {
    onOpsChange?.(ops)
  }, [ops, onOpsChange])

  useEffect(() => {
    if (documentOut) onDocumentChange?.(documentOut)
  }, [documentOut, onDocumentChange])

  const handleReset = () => {
    setEvents(toGanttEvents(originalPlan))
    recorder.reset()
  }

  return (
    <div ref={rootRef} className="relative flex flex-col gap-4">
      <Gantt<EventData>
        apiRef={apiRef}
        events={events}
        onEventsChange={setEvents}
        resources={resources}
        defaultScale="month"
        locale={LOCALE_ES}
        i18n={I18N_ES}
        timeZone={undefined}
        treePanel={{
          width: 240,
          indentPerLevelRem: 0,
          rowStyle: (ctx) => wbsLevelStyle(ctx.depth),
          rowToggles: false,
          headerContent: (
            <WbsLevelSlider
              level={level}
              max={maxDepth}
              onChange={setLevel}
            />
          ),
        }}
        collapsedGroups={collapsedGroups}
        columns={columns}
        summaryBars
        offDays
        nowIndicator
        offscreenIndicators
        infiniteScroll
        onEventUpdate={recorder.onEventUpdate}
        getEventBaselines={getEventBaselines}
        highlightedBaselineKeys={highlightedBaselineKeys}
        renderTooltipExtras={({ occurrence, dismiss }) => {
          const count = occurrence.event.data?.baselines?.length ?? 0
          if (!count) return null
          return (
            <button
              type="button"
              data-slot="gantt-baselines-link"
              onClick={(e) => {
                e.stopPropagation()
                dismiss()
                openHistory(occurrence)
              }}
              className="mt-0.5 font-medium underline underline-offset-2"
            >
              {APP_STRINGS_ES.baselinesLink(count)}
            </button>
          )
        }}
        renderEventMenu={({ occurrence }) => (
          <>
            <ContextMenuItem onClick={() => captureBaseline(occurrence.event.id)}>
              <PinIcon aria-hidden /> {APP_STRINGS_ES.setBaseline}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!occurrence.event.data?.baselines?.length}
              onClick={() => openHistory(occurrence)}
            >
              <HistoryIcon aria-hidden /> {APP_STRINGS_ES.viewBaselines}
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => {
                apiRef.current?.removeEvent(occurrence.event.id)
                recorder.onEventDelete(occurrence.event.id)
              }}
            >
              <Trash2Icon aria-hidden /> {APP_STRINGS_ES.deleteEvent}
            </ContextMenuItem>
          </>
        )}
        className="h-[560px]"
      >
        <GanttNav>
          <TooltipProvider delay={600} closeDelay={0} timeout={300}>
            <div className="flex w-full flex-col gap-2">
              <div className="flex items-center gap-2">
                <GanttNavToday />
                <div className="flex items-center">
                  <GanttNavPrev />
                  <GanttNavNext />
                </div>
                <GanttTitle />
                <Button
                  size="sm"
                  variant={showAllBaselines ? "secondary" : "outline"}
                  aria-pressed={showAllBaselines}
                  title={APP_STRINGS_ES.viewBaselines}
                  onClick={() => setShowAllBaselines((v) => !v)}
                  data-slot="gantt-baselines-toggle"
                >
                  <GhostIcon aria-hidden />
                  {APP_STRINGS_ES.toggleHistoricalBaselines}
                </Button>
              </div>
              <GanttScaleSlider />
            </div>
          </TooltipProvider>
        </GanttNav>
        <GanttView />
      </Gantt>
      {activeHistory && historyEvent && (
        <BaselineHistoryPanel
          event={historyEvent}
          anchor={activeHistory.anchor}
          highlightedKey={highlightedBaseline}
          onHighlight={setHighlightedBaseline}
          onClose={() => setHistoryTarget(null)}
        />
      )}
      <div className="flex flex-col gap-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" data-slot="gantt-ops-count">
            {ops.length} cambios
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReset}
            data-slot="gantt-reset"
          >
            Reiniciar plan
          </Button>
        </div>
        <ChangesetPanel recorder={recorder} documentOut={documentOut} />
      </div>
    </div>
  )
}

function useRecorderOps(recorder: ChangesetRecorder): ChangeOp[] {
  const [ops, setOps] = useState<ChangeOp[]>(() => recorder.getOps())
  useEffect(() => {
    setOps(recorder.getOps())
    return recorder.subscribe(() => setOps(recorder.getOps()))
  }, [recorder])
  return ops
}

/** Deepest WBS level present in the mapped tree (root = 0). */
function depthOf(nodes: GanttResource[], depth = 0): number {
  return nodes.reduce(
    (max, node) =>
      node.children?.length
        ? Math.max(max, depthOf(node.children, depth + 1))
        : max,
    depth,
  )
}

function WbsLevelSlider({
  level,
  max,
  onChange,
}: {
  level: number
  max: number
  onChange: (level: number) => void
}) {
  return (
    <div className="flex w-full items-center gap-2" data-slot="gantt-wbs-level">
      <span className="text-muted-foreground shrink-0 text-xs font-medium">
        Profundidad
      </span>
      <Slider
        min={0}
        max={max}
        step={1}
        value={level}
        onChange={onChange}
        aria-label="Profundidad WBS visible"
        className="w-1/3 min-w-16"
      />
      <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
        {level >= max ? "máx" : `${level}/${max}`}
      </span>
    </div>
  )
}

function GanttScaleSlider() {
  const { scale, setScale } = useGanttScale()
  const labels = I18N_ES.labels?.scales
  const index = GANTT_SCALES.indexOf(scale)
  return (
    <div className="flex w-full items-center gap-2" data-slot="gantt-scale-slider">
      <span className="text-muted-foreground shrink-0 text-xs font-medium">
        Escala
      </span>
      <Slider
        variant="black"
        min={0}
        max={GANTT_SCALES.length - 1}
        step={1}
        value={index >= 0 ? index : 0}
        onChange={(i) => setScale(GANTT_SCALES[i])}
        tooltipText={labels?.[scale] ?? scale}
        aria-label="Escala del timeline"
        className="w-20"
      />
      <span
        data-slot="gantt-scale-value"
        className="text-muted-foreground ml-3 shrink-0 text-xs"
      >
        {labels?.[scale] ?? scale}
      </span>
    </div>
  )
}

/** Half the card's max width; keeps the clamped anchor fully on screen. */
const HISTORY_CARD_HALF_W = 160

/**
 * Floating bitácora for one event: every captured baseline, newest first,
 * each entry showing its end-date drift (Δ) against the current plan.
 * Hovering/focusing an entry cross-highlights its ghost strip on the
 * timeline via `highlightedBaselineKeys`. Anchored to the BAR's rect at open
 * time; without floating-ui the honest fallback is to close when anything
 * reflows under it (scroll/resize), so it can never point at the wrong bar.
 */
function BaselineHistoryPanel({
  event,
  anchor,
  highlightedKey,
  onHighlight,
  onClose,
}: {
  event: GanttEvent<EventData>
  anchor: { x: number; y: number }
  highlightedKey: string | null
  onHighlight: (key: string | null) => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    cardRef.current?.focus()
    const contains = (target: EventTarget | null) =>
      target instanceof Node && cardRef.current?.contains(target) === true
    const onPointerDown = (e: PointerEvent) => {
      if (!contains(e.target)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    // capture: the gantt body scrolls in a nested ScrollArea viewport
    const onScroll = (e: Event) => {
      if (!contains(e.target)) onClose()
    }
    const onResize = () => onClose()
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onResize)
    }
  }, [onClose])

  const history = [...(event.data?.baselines ?? [])].sort(
    (a, b) => b.version - a.version,
  )
  const currentEndMs = event.end.getTime()
  const left = Math.min(
    Math.max(anchor.x, HISTORY_CARD_HALF_W + 8),
    window.innerWidth - HISTORY_CARD_HALF_W - 8,
  )

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={APP_STRINGS_ES.baselinesTitle}
      tabIndex={-1}
      data-slot="gantt-baselines-panel"
      className="bg-popover text-popover-foreground ring-ring/20 fixed z-50 w-max max-w-80 rounded-md py-1.5 text-xs shadow-md outline-none ring-1"
      style={{
        left,
        top: anchor.y,
        transform: "translateX(-50%)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4 px-3 pb-1">
        <div className="flex flex-col">
          <span className="font-medium">{APP_STRINGS_ES.baselinesTitle}</span>
          <span className="text-muted-foreground whitespace-nowrap">
            {APP_STRINGS_ES.currentPlan}:{" "}
            {format(event.start, "d MMM yyyy", { locale: LOCALE_ES })} →{" "}
            {format(event.end, "d MMM yyyy", { locale: LOCALE_ES })}
          </span>
        </div>
        <button
          type="button"
          aria-label={APP_STRINGS_ES.closePanel}
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground -mr-1 rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="max-h-64 overflow-auto">
        {history.map((b) => {
          const key = `${event.id}::baseline-v${b.version}`
          const deltaDays = Math.round(
            (currentEndMs - new Date(b.end).getTime()) / 86_400_000,
          )
          return (
            <button
              key={key}
              type="button"
              data-highlighted={highlightedKey === key || undefined}
              onMouseEnter={() => onHighlight(key)}
              onMouseLeave={() => onHighlight(null)}
              onFocus={() => onHighlight(key)}
              onBlur={() => onHighlight(null)}
              className={cn(
                "hover:bg-accent block w-full px-3 py-1.5 text-start outline-none",
                "data-highlighted:bg-accent"
              )}
            >
              <span className="flex items-center justify-between gap-4">
                <span className="font-medium tabular-nums">
                  {APP_STRINGS_ES.versionShort(b.version)}
                </span>
                <span
                  className={cn(
                    "tabular-nums",
                    deltaDays > 0 && "text-destructive",
                    deltaDays < 0 && "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {APP_STRINGS_ES.baselineDelta(deltaDays)}
                </span>
              </span>
              <span className="text-muted-foreground block whitespace-nowrap">
                {format(b.start, "d MMM yyyy", { locale: LOCALE_ES })} →{" "}
                {format(b.end, "d MMM yyyy", { locale: LOCALE_ES })}
              </span>
              <span className="text-muted-foreground block whitespace-nowrap opacity-80">
                {APP_STRINGS_ES.baselineCaptured}:{" "}
                {format(b.capturedAt, "d MMM yyyy HH:mm", { locale: LOCALE_ES })}
              </span>
              {b.reason && (
                <span className="text-muted-foreground block truncate opacity-80">
                  {b.reason}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
