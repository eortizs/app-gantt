import { useEffect, useMemo, useRef, useState } from "react"
import {
  Gantt,
  type GanttApi,
  type GanttColumn,
} from "@/components/reui/gantt/gantt"
import {
  GanttNav,
  GanttNavNext,
  GanttNavPrev,
  GanttNavToday,
  GanttScaleSwitcher,
  GanttTitle,
} from "@/components/reui/gantt/gantt-nav"
import { GanttView } from "@/components/reui/gantt/gantt-view"
import type {
  GanttEvent,
  GanttResource,
} from "@/components/reui/gantt/gantt-types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PLAN, RESPONSABLES, type EventData } from "@/data/plan-departamento"
import { toGanttEvents, toGanttResources } from "@/lib/plan-mapper"
import { createChangesetRecorder, type ChangesetRecorder } from "@/lib/changeset"
import { I18N_ES, LOCALE_ES } from "@/lib/i18n-es"
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
        treePanel={{ width: 240 }}
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
            <GanttScaleSwitcher />
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
