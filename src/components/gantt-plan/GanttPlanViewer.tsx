import { useEffect, useMemo, useRef, useState } from "react"
import {
  Gantt,
  type GanttApi,
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
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PLAN, RESPONSABLES, type EventData } from "@/data/plan-departamento"
import { toGanttEvents, toGanttResources } from "@/lib/plan-mapper"
import { createChangesetRecorder, type ChangesetRecorder } from "@/lib/changeset"
import { I18N_ES, LOCALE_ES } from "@/lib/i18n-es"
import { wbsLevelStyle } from "@/lib/wbs-levels"
import { ChangesetPanel } from "@/components/gantt-plan/ChangesetPanel"

export function GanttPlanViewer() {
  const apiRef = useRef<GanttApi<EventData> | null>(null)
  const recorderRef = useRef<ChangesetRecorder | null>(null)
  if (recorderRef.current === null) {
    recorderRef.current = createChangesetRecorder(apiRef)
  }
  const recorder = recorderRef.current!

  const [events, setEvents] = useState<GanttEvent<EventData>[]>(() =>
    toGanttEvents(PLAN),
  )
  const resources: GanttResource[] = useMemo(() => toGanttResources(PLAN), [])

  // ----- WBS level control: one slider drives the visible depth -----
  const maxDepth = useMemo(() => depthOf(resources), [resources])
  const [level, setLevel] = useState(maxDepth)
  // every group at depth >= level folds; level = maxDepth leaves the tree open
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
        render: (ctx: { resource: { id: string } }) =>
          RESPONSABLES[ctx.resource.id] ?? "—",
      },
    ],
    [],
  )

  const [opsCount, setOpsCount] = useState(0)
  useEffect(() => {
    setOpsCount(recorder.getOps().length)
    return recorder.subscribe(() => setOpsCount(recorder.getOps().length))
  }, [recorder])

  const handleReset = () => {
    setEvents(toGanttEvents(PLAN))
    recorder.reset()
  }

  return (
    <div className="flex flex-col gap-4">
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
        displayScheduleHint
        dragCreate
        onEventUpdate={recorder.onEventUpdate}
        canSelectSlot={recorder.canSelectSlot}
        onSelectSlot={recorder.onSelectSlot}
        className="h-[560px]"
      >
        <GanttNav>
          <TooltipProvider delay={600} closeDelay={0} timeout={300}>
            <GanttNavToday />
            <GanttScaleSlider />
            <div className="flex items-center">
              <GanttNavPrev />
              <GanttNavNext />
            </div>
            <GanttTitle />
          </TooltipProvider>
        </GanttNav>
        <GanttView />
      </Gantt>
      <div className="flex flex-col gap-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" data-slot="gantt-ops-count">
            {opsCount} cambios
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
        <ChangesetPanel recorder={recorder} />
      </div>
    </div>
  )
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

/** Global depth control: 0 = root only, max = fully expanded. */
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

/** Timeline scale picker: Día / Semana / Mes / Trimestre / Año. Black variant
 *  to distinguish from the blue WBS depth control. */
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
