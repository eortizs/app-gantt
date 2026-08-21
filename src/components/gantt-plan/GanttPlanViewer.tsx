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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createChangesetRecorder, type ChangesetRecorder } from "@/lib/changeset"
import { I18N_ES, LOCALE_ES } from "@/lib/i18n-es"
import type { EventData, PlanJSON } from "@/lib/plan-types"
import { toGanttEvents, toGanttResources } from "@/lib/plan-mapper"
import { applyOps, encodeUpdatedPlan, type ChangeOp } from "@/lib/umejson/codec"
import { decodeUmePlan, type UmeJsonEntity, type ValidationError } from "@/lib/umejson/schema"
import { wbsLevelStyle } from "@/lib/wbs-levels"
import { ChangesetPanel } from "@/components/gantt-plan/ChangesetPanel"

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
        onEventUpdate={recorder.onEventUpdate}
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
              </div>
              <GanttScaleSlider />
            </div>
          </TooltipProvider>
        </GanttNav>
        <GanttView />
      </Gantt>
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
