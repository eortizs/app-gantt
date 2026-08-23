import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { differenceInCalendarDays, format } from "date-fns"
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
import { barTones, baselineTones, DIRTY_LIGHT } from "@/components/reui/gantt/gantt-color"
import type {
  GanttEvent,
  GanttOccurrence,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import { Slider } from "@/components/ui/slider"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  GhostIcon,
  HistoryIcon,
  PinIcon,
  SplineIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react"
import { createChangesetRecorder, type ChangesetRecorder } from "@/lib/changeset"
import { APP_STRINGS_ES, I18N_ES, LOCALE_ES } from "@/lib/i18n-es"
import type {
  EventData,
  PlanBaseline,
  PlanDependency,
  PlanJSON,
} from "@/lib/plan-types"
import {
  resolveDependencyMarks,
  toGanttEvents,
  toGanttResources,
} from "@/lib/plan-mapper"
import { wouldCreateCycle, type ScheduleAdjustment } from "@/lib/umejson/schedule"
import { applyOps, encodeUpdatedPlan, type ChangeOp } from "@/lib/umejson/codec"
import { decodeUmePlan, type UmeJsonEntity, type ValidationError } from "@/lib/umejson/schema"
import { wbsLevelStyle } from "@/lib/wbs-levels"
import { ChangesetPanel } from "@/components/gantt-plan/ChangesetPanel"
import type { GanttDependencyMark } from "@/components/reui/gantt/gantt-types"
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
    recorderRef.current = createChangesetRecorder(apiRef, {
      getBasePlan: () => originalPlan,
    })
  }
  const recorder = recorderRef.current!

  const [events, setEvents] = useState<GanttEvent<EventData>[]>(() =>
    toGanttEvents(originalPlan),
  )
  const resources: GanttResource[] = useMemo(
    () => toGanttResources(originalPlan),
    [originalPlan],
  )

  // ----- dependencias: cascada documentada -----
  // The engine emits the WHOLE events array after a committed drag, carrying
  // only the dragged bar's new dates. The recorder queues the cascade it
  // computed for that same gesture; merging HERE (after the engine's
  // emission) is what keeps the adjusted successors visible without a second
  // commit pass. Order is deterministic: onEventUpdate -> onEventsChange.
  const handleEventsChange = useCallback(
    (next: GanttEvent<EventData>[]) => {
      const pending = recorder.consumePendingCascade()
      if (!pending.length) {
        setEvents(next)
        return
      }
      setEvents(applyAdjustmentsTo(next, pending))
    },
    [recorder],
  )

  // Mirror adjustments produced outside an engine emission (adding an edge
  // can bind its successor immediately).
  const applyAdjustments = useCallback((adjustments: readonly ScheduleAdjustment[]) => {
    setEvents((prev) => applyAdjustmentsTo(prev, adjustments))
  }, [])

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

  // Connector click: parked with the pointer position; the panel reads the
  // edge out of the LIVE plan, so removing/reverting it closes this too.
  const [dependencyTarget, setDependencyTarget] = useState<{
    mark: GanttDependencyMark
    x: number
    y: number
  } | null>(null)

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
        color: event.color,
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

  // ----- bitono: resting pastel / progress overlay per event -----
  // Dirty = the LIVE event's dates differ from the vigente baseline (the
  // highest-version entry of data.baselines). When they line up, the
  // resting fill is the phase's 80% pastel; when they don't, it's gray-200
  // to signal "unsynced". The progress overlay keeps the phase's full
  // color either way - only the resting surface shifts to communicate
  // drift. Drag->release and Fijar línea base both flow through `events`,
  // so this map stays in sync without an effect.
  const barToneByEventId = useMemo(() => {
    const map = new Map<
      string,
      { resting: string; progress: string } | undefined
    >()
    for (const ev of events) {
      const history = ev.data?.baselines ?? []
      const vigente = history.length
        ? history.reduce((max, b) => (b.version > max.version ? b : max))
        : null
      const dirty =
        !!vigente &&
        (ev.start.getTime() !== new Date(vigente.start).getTime() ||
          ev.end.getTime() !== new Date(vigente.end).getTime())
      const tones = barTones(ev.color)
      map.set(ev.id, {
        resting: dirty ? DIRTY_LIGHT : tones.light,
        progress: tones.dark,
      })
    }
    return map
  }, [events])

  // STABLE identity: the engine's per-row layout memo calls this for every
  // segment, and a fresh closure per render would rebuild every row. The
  // map is the source of truth; the callback only looks up.
  const getEventBarTone = useCallback(
    ({ event }: { event: GanttEvent<EventData> }) =>
      barToneByEventId.get(event.id),
    [barToneByEventId],
  )

  // STABLE identity, same contract. The phase color for a group comes from
  // any descendant event (the plan maps phases per-resource and groups
  // inherit downward; the first leaf is the cheapest faithful signal).
  // Mapping off the live event list so a drag-update keeps the rollup
  // reading the colors the tree actually shows today.
  const summaryToneByResourceId = useMemo(() => {
    const map = new Map<
      string,
      { resting: string; progress: string } | undefined
    >()
    const byResource = new Map<string, string>()
    for (const ev of events) {
      const rid = ev.resourceId
      if (ev.color && rid && !byResource.has(rid)) {
        byResource.set(rid, ev.color)
      }
    }
    const stack = [...resources]
    const grouped = new Set<string>()
    while (stack.length) {
      const node = stack.pop()!
      if (grouped.has(node.id)) continue
      grouped.add(node.id)
      if (node.children?.length) stack.push(...node.children)
      const color = byResource.get(node.id)
      if (color) {
        const t = barTones(color)
        map.set(node.id, { resting: t.light, progress: t.dark })
      }
    }
    return map
  }, [resources, events])

  const getSummaryBarTone = useCallback(
    ({ resource }: { resource: GanttResource; events: GanttEvent<EventData>[] }) =>
      summaryToneByResourceId.get(resource.id),
    [summaryToneByResourceId],
  )

  // Hovering a history entry reprojects that event's LIVE bar at the hovered
  // version's own dates AND tone (pink/amber/emerald... matching the panel
  // swatch and the timeline fan). Resolved HERE rather than from rendered
  // marks: the default view only paints the newest baseline, so an older
  // version's mark may not exist on the timeline at all - but its tone AND
  // its dates are derivable from the event's own history. Key format is
  // ours: `${eventId}::baseline-v${version}`. The resting surface takes the
  // version's fill (a pastel), and the progress overlay takes the strong
  // partner - so the bar previews the version's bitono instead of one
  // monochrome block.
  const eventBarOverlays = useMemo(() => {
    if (!highlightedBaseline) return undefined
    const marker = "::baseline-v"
    const sep = highlightedBaseline.lastIndexOf(marker)
    if (sep < 0) return undefined
    const eventId = highlightedBaseline.slice(0, sep)
    const version = Number(highlightedBaseline.slice(sep + marker.length))
    const ev = events.find((e) => e.id === eventId)
    if (!ev) return undefined
    const ordered = [...(ev.data?.baselines ?? [])].sort(
      (a, b) => b.version - a.version,
    )
    const idx = ordered.findIndex((b) => b.version === version)
    if (idx < 0) return undefined
    const baseline = ordered[idx]
    const tone = baselineTones(ev.color, idx)
    return {
      [eventId]: {
        color: tone.fill,
        progressColor: tone.full,
        start: new Date(baseline.start),
        end: new Date(baseline.end),
      },
    }
  }, [highlightedBaseline, events])

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
  const livePlan = useMemo(
    () => (ops.length ? applyOps(originalPlan, ops) : originalPlan),
    [ops, originalPlan],
  )
  const documentOut = useMemo(
    () => (ops.length ? encodeUpdatedPlan(entity, livePlan, ops.length) : null),
    [ops, entity, livePlan],
  )

  // Connectors read the LIVE engine events: a violation lights up during the
  // drag that causes it, before any op is committed to the document.
  const dependencyMarks = useMemo(
    () => resolveDependencyMarks(livePlan.dependencies ?? [], events),
    [livePlan, events],
  )

  // Derived, not effect-synced: an edge that disappears (removed, reset)
  // closes the panel during render with no extra pass.
  const activeDependency =
    dependencyTarget &&
    livePlan.dependencies?.some((d) => d.id === dependencyTarget.mark.key)
      ? dependencyTarget
      : null

  const handleAddDependency = useCallback(
    (fromEventId: string, toEventId: string) => {
      const dep: PlanDependency = {
        id: crypto.randomUUID(),
        fromEventId,
        toEventId,
        type: "FS",
      }
      const adjustments = recorder.addDependency(dep)
      if (adjustments !== false) applyAdjustments(adjustments)
    },
    [recorder, applyAdjustments],
  )

  useEffect(() => {
    onOpsChange?.(ops)
  }, [ops, onOpsChange])

  useEffect(() => {
    if (documentOut) onDocumentChange?.(documentOut)
  }, [documentOut, onDocumentChange])

  const handleReset = () => {
    setEvents(toGanttEvents(originalPlan))
    setDependencyTarget(null)
    recorder.reset()
  }

  return (
    <div ref={rootRef} className="relative flex flex-col gap-4">
      <Gantt<EventData>
        apiRef={apiRef}
        events={events}
        onEventsChange={handleEventsChange}
        resources={resources}
        dependencies={dependencyMarks}
        onDependencyClick={(mark, e) =>
          setDependencyTarget({ mark, x: e.clientX, y: e.clientY })
        }
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
        eventBarOverlays={eventBarOverlays}
        getEventBarTone={getEventBarTone}
        getSummaryBarTone={getSummaryBarTone}
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
              className="mt-0.5 cursor-pointer font-medium underline underline-offset-2"
            >
              {APP_STRINGS_ES.baselinesLink(count)}
            </button>
          )
        }}
        renderEventMenu={({ occurrence }) => {
          const selfId = occurrence.event.id
          const deps = livePlan.dependencies ?? []
          // Outgoing = this event is the predecessor; incoming = successor.
          const outgoing = deps.filter((d) => d.fromEventId === selfId)
          const incoming = deps.filter((d) => d.toEventId === selfId)
          const titleOf = (id: string) =>
            events.find((ev) => ev.id === id)?.title ?? id
          return (
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
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <SplineIcon aria-hidden /> {APP_STRINGS_ES.addDependency}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="max-h-64 overflow-auto">
                  {events
                    .filter((ev) => ev.id !== selfId)
                    .map((ev) => {
                      const blocked = wouldCreateCycle(deps, selfId, ev.id)
                      return (
                        <ContextMenuItem
                          key={ev.id}
                          disabled={blocked}
                          onClick={() =>
                            handleAddDependency(selfId, ev.id)
                          }
                        >
                          {APP_STRINGS_ES.dependencyTargetLabel(ev.title)}
                          {blocked && (
                            <span className="text-muted-foreground ms-2 text-xs">
                              {APP_STRINGS_ES.dependencyCycleBlocked}
                            </span>
                          )}
                        </ContextMenuItem>
                      )
                    })}
                </ContextMenuSubContent>
              </ContextMenuSub>
              {(outgoing.length > 0 || incoming.length > 0) && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <UnlinkIcon aria-hidden /> {APP_STRINGS_ES.removeDependency}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-64 overflow-auto">
                    {[...outgoing, ...incoming].map((dep) => (
                      <ContextMenuItem
                        key={dep.id}
                        onClick={() => recorder.removeDependency(dep.id)}
                      >
                        {APP_STRINGS_ES.dependencyEdgeLabel(
                          titleOf(
                            dep.fromEventId === selfId
                              ? dep.toEventId
                              : dep.fromEventId,
                          ),
                          APP_STRINGS_ES.dependencyTypes[dep.type],
                          dep.fromEventId === selfId,
                        )}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
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
          )
        }}
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
      {activeDependency && (
        <DependencyPanel
          mark={activeDependency.mark}
          deps={livePlan.dependencies ?? []}
          events={events}
          point={{ x: activeDependency.x, y: activeDependency.y }}
          onRemove={() => {
            recorder.removeDependency(activeDependency.mark.key)
            setDependencyTarget(null)
          }}
          onClose={() => setDependencyTarget(null)}
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

/** Pure merge of cascade adjustments into an events array (by event id). */
function applyAdjustmentsTo(
  events: GanttEvent<EventData>[],
  adjustments: readonly ScheduleAdjustment[],
): GanttEvent<EventData>[] {
  if (!adjustments.length) return events
  const byId = new Map(adjustments.map((a) => [a.eventId, a]))
  return events.map((ev) => {
    const adj = byId.get(ev.id)
    return adj
      ? { ...ev, start: new Date(adj.start), end: new Date(adj.end) }
      : ev
  })
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
 * A baseline's own span: calendar days when it crosses days (matching how
 * all-day ranges read), hours when it starts and ends inside the same day.
 */
function baselineDurationLabel(b: PlanBaseline): string {
  const start = new Date(b.start)
  const end = new Date(b.end)
  const days = differenceInCalendarDays(end, start)
  if (days >= 1) return APP_STRINGS_ES.baselineDurationDays(days)
  const hours = Math.round((end.getTime() - start.getTime()) / 3_600_000)
  return APP_STRINGS_ES.baselineDurationHours(hours)
}

/**
 * Floating bitácora for one event: every captured baseline, newest first,
 * each entry showing its end-date drift (Δ) against the current plan.
 * Hovering/focusing an entry cross-highlights its mark on the timeline via
 * `highlightedBaselineKeys` AND reprojects the event's live bar at that
 * version's dates and tone via `eventBarOverlays` - the bar previews the
 * version (works even when the version's mark isn't rendered, which is the
 * default view). Each entry's swatch mirrors the timeline's pastel (bar
 * for the version in force, ramp colors for older ones) so versions map at
 * a glance. Anchored to the BAR's rect at open
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
        {history.map((b, i) => {
          const key = `${event.id}::baseline-v${b.version}`
          const deltaDays = Math.round(
            (currentEndMs - new Date(b.end).getTime()) / 86_400_000,
          )
          // Same tones as the timeline (gantt-color.ts): the newest entry is
          // the current baseline BAR in the phase pastel; older ones take the
          // fixed pastel ramp by depth - index maps 1:1 to the fan.
          const tone = baselineTones(event.color, i)
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
                <span className="flex items-center gap-1.5 font-medium tabular-nums">
                  <span
                    aria-hidden
                    className={
                      // mirrors the timeline mark's shape: bar vs line
                      i === 0
                        ? "h-2 w-3 shrink-0 rounded-[3px]"
                        : "size-2 shrink-0 rounded-full"
                    }
                    style={{ backgroundColor: tone.full }}
                  />
                  {APP_STRINGS_ES.versionShort(b.version)}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({baselineDurationLabel(b)})
                  </span>
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

/**
 * Floating card for a clicked connector: names both ends, the constraint
 * type (and lag), and offers the documented removal. Anchored to the CLICK
 * point; like the baseline panel it closes when anything reflows under it,
 * so it can never end up describing the wrong edge.
 */
function DependencyPanel({
  mark,
  deps,
  events,
  point,
  onRemove,
  onClose,
}: {
  mark: GanttDependencyMark
  deps: readonly PlanDependency[]
  events: GanttEvent<EventData>[]
  point: { x: number; y: number }
  onRemove: () => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const contains = (target: EventTarget | null) =>
      target instanceof Node && cardRef.current?.contains(target) === true
    const onPointerDown = (e: PointerEvent) => {
      if (!contains(e.target)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
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

  const dep = deps.find((d) => d.id === mark.key)
  if (!dep) return null
  const titleOf = (id: string) =>
    events.find((ev) => ev.id === id)?.title ?? id
  const typeLabel = APP_STRINGS_ES.dependencyTypes[dep.type]
  const left = Math.min(
    Math.max(point.x, 120),
    window.innerWidth - 120,
  )

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={APP_STRINGS_ES.dependencyAriaLabel(
        titleOf(dep.fromEventId),
        titleOf(dep.toEventId),
        typeLabel,
      )}
      tabIndex={-1}
      data-slot="gantt-dependency-panel"
      className="bg-popover text-popover-foreground ring-ring/20 fixed z-50 w-max max-w-80 rounded-md py-2 text-xs shadow-md outline-none ring-1"
      style={{ left, top: point.y + 8, transform: "translateX(-50%)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4 px-3 pb-1">
        <span className="font-medium">{APP_STRINGS_ES.dependencyPanelTitle}</span>
        <button
          type="button"
          aria-label={APP_STRINGS_ES.dependencyClose}
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground -mr-1 rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-1.5 whitespace-nowrap px-3 pb-1">
        <span className="truncate font-medium">{titleOf(dep.fromEventId)}</span>
        <SplineIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
        <span className="truncate font-medium">{titleOf(dep.toEventId)}</span>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 whitespace-nowrap px-3">
        <span>{typeLabel}</span>
        {!!dep.lagDays && (
          <span className="tabular-nums">
            ({dep.lagDays > 0 ? "+" : ""}
            {dep.lagDays} d)
          </span>
        )}
        {mark.violated && (
          <span className="bg-destructive/10 text-destructive rounded-full px-1.5 py-px font-medium">
            {APP_STRINGS_ES.dependencyViolated}
          </span>
        )}
      </div>
      <div className="border-t px-1 pt-1 mt-1">
        <button
          type="button"
          data-slot="gantt-dependency-remove"
          onClick={onRemove}
          className="text-destructive focus-visible:bg-accent flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <UnlinkIcon className="size-3.5" aria-hidden />
          {APP_STRINGS_ES.dependencyRemoveAction}
        </button>
      </div>
    </div>
  )
}
