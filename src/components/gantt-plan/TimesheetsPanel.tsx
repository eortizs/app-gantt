// «Parte de horas» (Ola 3B): mobile-first week grid per actor/event with
// submit-for-approval, plus the aprobador queue (submitted entries across
// actors) — the visual pattern of ChangeRequestsPanel. Offline it renders
// the demo builder read-only; online every write goes to the API and a
// 401 opens the login dialog through `onWriteRejected`.
import { useCallback, useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { APP_STRINGS_ES, LOCALE_ES } from "@/lib/i18n-es"
import { cn } from "@/lib/utils"

type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected"

interface TimesheetEntry {
  id: string
  actor: string
  date: string
  eventId: string
  hours: number
  note?: string
  status: TimesheetStatus
}

interface TimesheetDoc {
  id: string
  dynamicProperties: { timesheet: { weekOf: string; entries: TimesheetEntry[] } }
}

const STATUS_VARIANT: Record<
  TimesheetStatus,
  "secondary" | "default" | "destructive" | "outline"
> = {
  draft: "outline",
  submitted: "secondary",
  approved: "default",
  rejected: "destructive",
}

export function TimesheetsPanel({
  events,
  offline,
  me,
  canWrite,
  canDecide,
  onWriteRejected,
  onApproved,
}: {
  /** Live plan events (id + title) for the row pickers. */
  events: Array<{ id: string; title: string }>
  offline: boolean
  me: { name: string } | null
  canWrite: boolean
  canDecide: boolean
  /** Called with the HTTP status of any failed write (401 opens login). */
  onWriteRejected: (status: number) => void
  /** Refresh hook after an approval (actuals/EVM moved). */
  onApproved: () => void
}) {
  // Semana en curso (lunes); ±semana con los botones.
  const [weekOffset, setWeekOffset] = useState(0)
  const weekOf = useMemo(() => {
    const now = new Date()
    const day = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
    monday.setUTCHours(12, 0, 0, 0)
    return new Date(monday.getTime() + weekOffset * 7 * 86_400_000).toISOString()
  }, [weekOffset])

  const [docs, setDocs] = useState<TimesheetDoc[] | null>(null)
  const reload = useCallback(() => {
    if (offline) return
    fetch(`/api/plans/${PLAN_ID_FOR_TS}/timesheets`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows: TimesheetDoc[]) => setDocs(Array.isArray(rows) ? rows : []))
      .catch(() => setDocs([]))
  }, [offline])
  useEffect(() => {
    reload()
  }, [reload])

  const allEntries: TimesheetEntry[] = useMemo(
    () =>
      (docs ?? []).flatMap((d) =>
        (d.dynamicProperties?.timesheet?.entries ?? []).map((e) => ({ ...e })),
      ),
    [docs],
  )
  const myEntries = useMemo(
    () =>
      me
        ? allEntries.filter((e) => e.actor === me.name && e.date.slice(0, 10) >= weekOf.slice(0, 10) && e.date.slice(0, 10) <= new Date(new Date(weekOf).getTime() + 6 * 86_400_000).toISOString().slice(0, 10))
        : [],
    [allEntries, me, weekOf],
  )

  // Borrador local de mi semana: el PUT reemplaza la semana completa.
  const [draft, setDraft] = useState<Array<{ eventId: string; date: string; hours: string; note?: string }>>([])
  useEffect(() => {
    setDraft(
      myEntries.map((e) => ({
        eventId: e.eventId,
        date: e.date.slice(0, 10),
        hours: String(e.hours),
        ...(e.note ? { note: e.note } : {}),
      })),
    )
    // Re-seed solo al cambiar de semana/usuario/documentos.
  }, [myEntries])

  const saveWeek = useCallback(
    async (submit: boolean) => {
      if (!me || !canWrite) return
      const res = await fetch(`/api/plans/${PLAN_ID_FOR_TS}/timesheets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          timesheet: {
            weekOf,
            entries: draft.map((d, i) => ({
              ...d,
              hours: Number(d.hours),
              status: submit ? "submitted" : "draft",
              id: `${weekOf.slice(0, 10)}-${i}`,
            })),
          },
        }),
      })
      if (!res.ok) onWriteRejected(res.status)
      reload()
    },
    [me, canWrite, draft, weekOf, onWriteRejected, reload],
  )

  const decide = useCallback(
    async (entryId: string, to: "approved" | "rejected") => {
      const res = await fetch(`/api/timesheets/${entryId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      })
      if (!res.ok) onWriteRejected(res.status)
      else if (to === "approved") onApproved()
      reload()
    },
    [onWriteRejected, onApproved, reload],
  )

  const queue = useMemo(
    () => allEntries.filter((e) => e.status === "submitted"),
    [allEntries],
  )
  const eventTitle = (id: string) =>
    events.find((ev) => ev.id === id)?.title ?? id

  return (
    <Card data-slot="gantt-timesheets-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{APP_STRINGS_ES.timesheetsTitle}</CardTitle>
        <div className="flex items-center gap-1" data-slot="gantt-ts-weeknav">
          <Button size="icon-xs" variant="ghost" aria-label={APP_STRINGS_ES.timesheetsPrevWeek} onClick={() => setWeekOffset((w) => w - 1)}>
            ‹
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {format(new Date(weekOf), "d MMM yyyy", { locale: LOCALE_ES })}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label={APP_STRINGS_ES.timesheetsNextWeek} onClick={() => setWeekOffset((w) => w + 1)}>
            ›
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Mi semana */}
        <div data-slot="gantt-ts-mine" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{APP_STRINGS_ES.timesheetsMine}</span>
            {offline && (
              <Badge variant="outline">{APP_STRINGS_ES.offlineFallbackNote.slice(0, 24)}…</Badge>
            )}
          </div>
          {!me && <p className="text-muted-foreground text-xs">{APP_STRINGS_ES.timesheetsLoginHint}</p>}
          {draft.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:flex sm:flex-wrap sm:items-center" data-slot="gantt-ts-row">
              <select
                aria-label={APP_STRINGS_ES.timesheetsEventLabel}
                value={row.eventId}
                disabled={!canWrite}
                onChange={(e) =>
                  setDraft((prev) => prev.map((r, j) => (j === i ? { ...r, eventId: e.target.value } : r)))
                }
                className="bg-background ring-ring/30 min-w-0 flex-1 rounded-md px-1 py-0.5 text-xs ring-1 outline-none"
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title}
                  </option>
                ))}
              </select>
              <input
                type="date"
                aria-label={APP_STRINGS_ES.timesheetsDateLabel}
                value={row.date}
                disabled={!canWrite}
                onChange={(e) =>
                  setDraft((prev) => prev.map((r, j) => (j === i ? { ...r, date: e.target.value } : r)))
                }
                className="bg-background ring-ring/30 rounded-md px-1 py-0.5 text-xs ring-1 outline-none"
              />
              <input
                type="number"
                inputMode="decimal"
                step="0.5"
                min="0"
                max="24"
                aria-label={APP_STRINGS_ES.timesheetsHoursLabel}
                value={row.hours}
                disabled={!canWrite}
                onChange={(e) =>
                  setDraft((prev) => prev.map((r, j) => (j === i ? { ...r, hours: e.target.value } : r)))
                }
                className="ring-ring/30 bg-background w-16 rounded-md px-1 py-0.5 text-center text-xs tabular-nums ring-1 outline-none"
              />
              {canWrite && (
                <button
                  type="button"
                  aria-label={APP_STRINGS_ES.timesheetsRemoveRow}
                  onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive px-1 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {canWrite && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft((prev) => [
                    ...prev,
                    { eventId: events[0]?.id ?? "", date: weekOf.slice(0, 10), hours: "8" },
                  ])
                }
                disabled={!canWrite}
              >
                {APP_STRINGS_ES.timesheetsAddRow}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveWeek(false)} disabled={!canWrite}>
                {APP_STRINGS_ES.timesheetsSaveDraft}
              </Button>
              <Button size="sm" onClick={() => void saveWeek(true)} disabled={!canWrite}>
                {APP_STRINGS_ES.timesheetsSubmit}
              </Button>
            </div>
          )}
        </div>

        {/* Cola de aprobación */}
        <div className="flex flex-col gap-1.5 border-t pt-2" data-slot="gantt-ts-queue">
          <span className="text-xs font-medium">{APP_STRINGS_ES.timesheetsQueueTitle}</span>
          {queue.length === 0 && (
            <p className="text-muted-foreground text-xs">{APP_STRINGS_ES.timesheetsQueueEmpty}</p>
          )}
          {queue.map((entry) => (
            <div key={entry.id} className="bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-xs">
              <Badge variant={STATUS_VARIANT[entry.status]}>{entry.actor}</Badge>
              <span className="min-w-0 truncate font-medium">{eventTitle(entry.eventId)}</span>
              <span className="text-muted-foreground tabular-nums">
                {format(new Date(entry.date), "d MMM", { locale: LOCALE_ES })} · {entry.hours} h
              </span>
              <span className="grow" />
              {canDecide && (
                <>
                  <Button
                    size="sm"
                    data-slot="gantt-ts-approve"
                    onClick={() => void decide(entry.id, "approved")}
                  >
                    {APP_STRINGS_ES.crApprove}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void decide(entry.id, "rejected")}>
                    {APP_STRINGS_ES.crReject}
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>

        <p className={cn("text-muted-foreground text-[10px]")}>{APP_STRINGS_ES.timesheetsHint}</p>
      </CardContent>
    </Card>
  )
}

/** El panel vive junto al plan demo de App. */
const PLAN_ID_FOR_TS = "00000000-0000-4000-8000-000000000001"
