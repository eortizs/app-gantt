import { useCallback, useEffect, useMemo, useState } from "react"
import { GanttPlanViewer } from "@/components/gantt-plan/GanttPlanViewer"
import { EvmPanel } from "@/components/gantt-plan/EvmPanel"
import {
  ChangeRequestsPanel,
  RevisionConflictError,
  type ChangeRequestItem,
} from "@/components/gantt-plan/ChangeRequestsPanel"
import { buildDemoEntity, DEMO_PLAN_ID } from "@/data/demo-entity"
import {
  buildDemoActuals,
  buildDemoBudget,
  DEMO_ACTUALS_ID,
} from "@/data/demo-contables"
import { buildDemoWorkforce } from "@/data/demo-workforce"
import { buildDemoCalendar } from "@/data/demo-calendar"
import { buildStressEntity, STRESS_PLAN_ID } from "@/data/stress-plan"
import { AuthPanel, type ActorOption } from "@/components/gantt-plan/AuthPanel"
import { TimesheetsPanel } from "@/components/gantt-plan/TimesheetsPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { APP_STRINGS_ES } from "@/lib/i18n-es"
import type { UmeJsonEntity } from "@/lib/umejson/schema"
import type { UmeBudgetEntity } from "@/lib/umejson/budget"
import { decodeBudget } from "@/lib/umejson/budget"
import type { UmeActualsEntity } from "@/lib/umejson/actuals"
import { buildActualsEntity, decodeActuals } from "@/lib/umejson/actuals"
import type { ActualsPayload } from "@/lib/umejson/actuals"
import type { UmeWorkforceEntity } from "@/lib/umejson/workforce"
import { decodeWorkforce } from "@/lib/umejson/workforce"
import type { UmeCalendarEntity } from "@/lib/umejson/calendar"
import { decodeCalendar } from "@/lib/umejson/calendar"
import { buildResolver, type CalendarResolver } from "@/lib/umejson/working-time"
import {
  decodeChangeRequest,
  type ChangeRequestStatus,
} from "@/lib/umejson/change-request"
import { applyOps, type ChangeOp } from "@/lib/umejson/codec"

interface PlanBundle {
  entity: UmeJsonEntity
  budget: UmeBudgetEntity
  actuals: UmeActualsEntity
  workforce: UmeWorkforceEntity
  calendar: UmeCalendarEntity
  /** True when the plan fetch failed and the in-memory demo took over. */
  offline: boolean
}

/** Sesión (Ola 3A): identidad del visitante, null = anónimo (visor). */
type ActorRole = "visor" | "editor" | "aprobador"
interface SessionActor extends ActorOption {}
const ROLE_RANK: Record<ActorRole, number> = { visor: 1, editor: 2, aprobador: 3 }

const fetchJson = (url: string): Promise<unknown> =>
  fetch(url).then((res) =>
    res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
  )

/** El plan documento, tal como vive dentro del envelope umeJSON. */
type PlanDoc = UmeJsonEntity["dynamicProperties"]["plan"]

/**
 * Hermana: fetch + decode contra el plan recién recibido; si algo falla
 * (red o decoder) cae a su builder demo SOBRE EL MISMO plan para que los
 * ids de eventos sigan alineados. Resuelve siempre — una hermana caída
 * nunca tumba el bundle.
 */
function fetchSibling<T>(
  url: string,
  plan: PlanDoc,
  decode: (raw: unknown, plan: PlanDoc, planEntityId: string) => { ok: boolean },
  buildDemo: (plan: PlanDoc) => T,
): Promise<T> {
  return fetchJson(url)
    .then((raw) =>
      decode(raw, plan, DEMO_PLAN_ID).ok ? (raw as T) : buildDemo(plan),
    )
    .catch(() => buildDemo(plan))
}

function demoBundle(entity: UmeJsonEntity): PlanBundle {
  const plan = entity.dynamicProperties.plan
  const budget = buildDemoBudget(plan)
  return {
    entity,
    budget,
    actuals: buildDemoActuals(plan, budget),
    workforce: buildDemoWorkforce(plan),
    calendar: buildDemoCalendar(plan, DEMO_PLAN_ID),
    offline: true,
  }
}

/** `?stress=N` (solo dev): reemplaza el bundle por el plan generado. */
const stressCount = (() => {
  const raw = new URLSearchParams(window.location.search).get("stress")
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : null
})()

function stressBundle(count: number): PlanBundle {
  const entity = buildStressEntity(count)
  const plan = entity.dynamicProperties.plan
  const budget = buildDemoBudget(plan)
  return {
    entity,
    budget,
    actuals: buildDemoActuals(plan, budget),
    workforce: buildDemoWorkforce(plan),
    calendar: buildDemoCalendar(plan, STRESS_PLAN_ID),
    offline: true,
  }
}

function usePlanBundle(reloadKey: number): {
  bundle: PlanBundle | null
  setBundle: (updater: (prev: PlanBundle | null) => PlanBundle | null) => void
} {
  const [bundle, setBundle] = useState<PlanBundle | null>(() =>
    // Stress mode never fetches: the generated plan lives only in memory.
    stressCount !== null ? stressBundle(stressCount) : null,
  )
  useEffect(() => {
    if (stressCount !== null) return
    let cancelled = false
    fetchJson(`/api/plans/${DEMO_PLAN_ID}`)
      .then(async (docRaw: unknown) => {
        const entity = docRaw as UmeJsonEntity
        const plan = entity.dynamicProperties.plan
        // Hermanas: budget primero (el fallback de actuals se construye
        // contra el budget YA resuelto, online o demo); actuals y workforce
        // en paralelo. Cada una que falle (o no pase el decoder contra el
        // plan recibido) cae a su builder demo — ver fetchSibling.
        const budget = await fetchSibling(
          `/api/plans/${DEMO_PLAN_ID}/budget`,
          plan,
          decodeBudget,
          buildDemoBudget,
        )
        const [actuals, workforce, calendar] = await Promise.all([
          fetchSibling(
            `/api/plans/${DEMO_PLAN_ID}/actuals`,
            plan,
            decodeActuals,
            (p) => buildDemoActuals(p, budget),
          ),
          fetchSibling(
            `/api/plans/${DEMO_PLAN_ID}/workforce`,
            plan,
            decodeWorkforce,
            buildDemoWorkforce,
          ),
          fetchSibling(
            `/api/plans/${DEMO_PLAN_ID}/calendar`,
            plan,
            decodeCalendar,
            (p) => buildDemoCalendar(p, DEMO_PLAN_ID),
          ),
        ])
        if (cancelled) return
        setBundle({ entity, budget, actuals, workforce, calendar, offline: false })
      })
      .catch(() => {
        // Resiliencia offline/demo: sin backend la app sigue siendo el
        // demo completo, solo que sin persistencia.
        if (!cancelled) setBundle(demoBundle(buildDemoEntity()))
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])
  return { bundle, setBundle }
}

/**
 * Instrumentación del modo estrés (dev-only, documentada en
 * scripts/gen-stress-plan.mts): marca el primer pintado tras el mount y
 * muestrea el presupuesto de frame SOLO en frames con scroll durante una
 * ventana de 4 s. Sin dependencias nuevas.
 */
function useStressBenchmarks(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || import.meta.env.PROD) return
    const start = performance.now()
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        console.info(
          `[stress] first paint after mount: ${(performance.now() - start).toFixed(1)} ms`,
        )
      }),
    )
    let rafId = 0
    let last = 0
    let startedAt = 0
    let scrolledSinceLastFrame = false
    const deltas: number[] = []
    const onScroll = (): void => {
      scrolledSinceLastFrame = true
      if (startedAt === 0) {
        startedAt = performance.now()
        const loop = (t: number): void => {
          if (scrolledSinceLastFrame && last) deltas.push(t - last)
          if (scrolledSinceLastFrame) last = t
          scrolledSinceLastFrame = false
          if (performance.now() - startedAt < 4000) {
            rafId = requestAnimationFrame(loop)
            return
          }
          rafId = 0
          startedAt = -1
          const sorted = [...deltas].sort((a, b) => a - b)
          const n = sorted.length
          const avg = n ? sorted.reduce((s, d) => s + d, 0) / n : 0
          const p95 = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))]: 0
          const max = n ? sorted[n - 1] : 0
          console.info(
            `[stress] scroll frames: n=${n} avg=${avg.toFixed(1)}ms p95=${Number(p95).toFixed(1)}ms max=${Number(max).toFixed(1)}ms`,
          )
        }
        rafId = requestAnimationFrame(loop)
      }
    }
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true })
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [enabled])
}

function App() {
  // Bumped after an apply (or a 409): refetches the whole bundle. The
  // viewer's key derives from the plan revision, so the fresh document
  // REMOUNTS it — its internal events state doesn't re-init from props.
  const [reloadKey, setReloadKey] = useState(0)
  const { bundle, setBundle } = usePlanBundle(reloadKey)
  useStressBenchmarks(stressCount !== null)
  const [ops, setOps] = useState<ChangeOp[]>([])
  const [changeRequests, setChangeRequests] = useState<ChangeRequestItem[] | null>(null)
  const online = bundle !== null && !bundle.offline
  const basePlan = bundle?.entity.dynamicProperties.plan
  const livePlan = useMemo(
    () =>
      basePlan ? (ops.length ? applyOps(basePlan, ops) : basePlan) : null,
    [basePlan, ops],
  )

  // ----- sesión e identidad -----
  const [me, setMe] = useState<SessionActor | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  useEffect(() => {
    if (!online) {
      setMe(null)
      return
    }
    let cancelled = false
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { actor: SessionActor | null }) => {
        if (!cancelled) setMe(body.actor)
      })
      .catch(() => {
        if (!cancelled) setMe(null)
      })
    return () => {
      cancelled = true
    }
  }, [online, reloadKey])
  const canWrite = me !== null && ROLE_RANK[me.role] >= ROLE_RANK.editor
  const canDecide = me !== null && ROLE_RANK[me.role] >= ROLE_RANK.aprobador
  /** Un 401 en una escritura abre el login la primera vez. */
  const onWriteRejected = useCallback((status: number): void => {
    if (status === 401) setAuthOpen(true)
  }, [])
  // Working-time del plan: la hermana calendario resuelta a un
  // `(eventId) => calendario | null` que gobierna la matemática laborable
  // del viewer y de los kernels (null = corrido).
  const calendarResolver: CalendarResolver | undefined = useMemo(() => {
    if (!bundle) return undefined
    return buildResolver(bundle.calendar.dynamicProperties.calendar)
  }, [bundle])

  const refetchChangeRequests = useCallback(async () => {
    try {
      const raw = (await fetchJson(
        `/api/plans/${DEMO_PLAN_ID}/change-requests`,
      )) as unknown[]
      const items = (Array.isArray(raw) ? raw : []).flatMap((doc) => {
        const decoded = decodeChangeRequest(doc)
        return decoded.ok ? [{ entity: decoded.entity, cr: decoded.cr }] : []
      })
      setChangeRequests(items)
    } catch {
      setChangeRequests([])
    }
  }, [])

  useEffect(() => {
    if (online) void refetchChangeRequests()
  }, [online, refetchChangeRequests, reloadKey])

  const proposeChangeRequest = useCallback(
    async (ops: ChangeOp[], reason?: string) => {
      const res = await fetch(`/api/plans/${DEMO_PLAN_ID}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops, ...(reason ? { reason } : {}) }),
      })
      if (!res.ok) {
        onWriteRejected(res.status)
        throw new Error(`HTTP ${res.status}`)
      }
      await refetchChangeRequests()
    },
    [refetchChangeRequests, onWriteRejected],
  )

  const decideChangeRequest = useCallback(
    async (id: string, to: ChangeRequestStatus) => {
      const res = await fetch(`/api/change-requests/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          ...(to === "applied" ? { reason: APP_STRINGS_ES.crApplyReason } : {}),
        }),
      })
      if (!res.ok) {
        // 409 = our plan view is stale (revision moved): refresh the
        // whole bundle so the next attempt decides on live data. When
        // the body carries the revision pair it's the plan-revision
        // binding (apply): surface WHY it refused, not just the code.
        if (res.status === 409) {
          setReloadKey((k) => k + 1)
          const body = (await res.json().catch(() => null)) as {
            currentRevision?: unknown
            crPlanRevision?: unknown
          } | null
          if (
            body !== null &&
            typeof body.currentRevision === "number" &&
            typeof body.crPlanRevision === "number"
          ) {
            throw new RevisionConflictError(
              body.currentRevision,
              body.crPlanRevision,
            )
          }
        }
        throw new Error(`HTTP ${res.status}`)
      }
      await refetchChangeRequests()
      if (to === "applied") setReloadKey((k) => k + 1)
    },
    [refetchChangeRequests, onWriteRejected],
  )

  /**
   * Avance real: merge del AC sobre los actuals vigentes (semántica
   * REPLACE por evento — AC es costo ACUMULADO) + bump de dataDate.
   * Online: PUT de la hermana con expectedRevision (leída del header del
   * GET) y refetch del bundle. Offline: queda en memoria para el EVM.
   */
  const captureActuals = useCallback(
    async (
      entries: { eventId: string; ac: number }[],
      dataDate: string,
    ): Promise<void> => {
      if (!bundle) return
      const planDoc = bundle.entity.dynamicProperties.plan
      let base: ActualsPayload | null = null
      let expectedRevision = 0
      if (!bundle.offline) {
        // Fresh GET (no cache): its x-ume-revision header feeds the PUT lock.
        const res = await fetch(`/api/plans/${DEMO_PLAN_ID}/actuals`)
        if (res.ok) {
          expectedRevision =
            Number(res.headers.get("x-ume-revision") ?? "") || 0
          const raw = await res.json()
          const decoded = decodeActuals(raw, planDoc, DEMO_PLAN_ID)
          if (decoded.ok) base = decoded.actuals
        }
      }
      if (!base) base = bundle.actuals.dynamicProperties.actuals
      const acByEvent: Record<string, number> = { ...base.acByEvent }
      for (const { eventId, ac } of entries) acByEvent[eventId] = ac
      const entity = buildActualsEntity({
        id: DEMO_ACTUALS_ID,
        planEntityId: DEMO_PLAN_ID,
        actuals: {
          schemaVersion: 1,
          dataDate,
          planAnchor: base.planAnchor,
          acByEvent,
          ...(base.baselineVersionByEvent
            ? { baselineVersionByEvent: base.baselineVersionByEvent }
            : {}),
        },
      })
      if (bundle.offline) {
        // Sin backend: los actuals actualizados viven SOLO en memoria.
        setBundle((prev) => (prev ? { ...prev, actuals: entity } : prev))
        return
      }
      const put = await fetch(`/api/plans/${DEMO_PLAN_ID}/actuals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, expectedRevision }),
      })
      if (!put.ok) {
        onWriteRejected(put.status)
        throw new Error(`HTTP ${put.status}`)
      }
      setReloadKey((k) => k + 1)
    },
    [bundle, onWriteRejected],
  )

  if (!bundle || !livePlan) {
    return (
      <div className="mx-auto w-full max-w-[1400px] p-6">
        <p className="text-sm text-muted-foreground">
          {APP_STRINGS_ES.loadingPlan}
        </p>
      </div>
    )
  }
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-6">
      <header>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Módulo Gantt — Construcción de departamento
          </h1>
          {online && (
            <div className="flex shrink-0 items-center gap-2" data-slot="gantt-auth">
              {me ? (
                <>
                  <Badge variant="outline" data-slot="gantt-auth-name">
                    {me.name}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {APP_STRINGS_ES.roleLabels[me.role]}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void fetch("/api/auth/logout", { method: "POST" }).then(
                        () => setMe(null),
                      )
                    }}
                  >
                    {APP_STRINGS_ES.authLogout}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setAuthOpen(true)}>
                  {APP_STRINGS_ES.authLoginButton}
                </Button>
              )}
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Caja negra umeJSON: la app recibe una entidad finalizada, valida su
          estructura, la hace editable, y emite el changeset <code>Op[]</code>{" "}
          junto con la entidad actualizada.
        </p>
        {bundle.offline && (
          <p className="mt-1 text-xs text-muted-foreground" data-slot="gantt-offline-note">
            {APP_STRINGS_ES.offlineFallbackNote}
          </p>
        )}
        {stressCount !== null && (
          <p className="mt-1 text-xs text-muted-foreground" data-slot="gantt-stress-note">
            Benchmark de virtualización: {stressCount} eventos generados en memoria
            (?stress={stressCount}). Mide mount y scroll frame budget en la consola.
          </p>
        )}
      </header>
      <GanttPlanViewer
        key={`${DEMO_PLAN_ID}:${bundle.entity.lifecycle.version}`}
        document={bundle.entity}
        onOpsChange={setOps}
        workforce={bundle.workforce.dynamicProperties.workforce}
        budget={bundle.budget.dynamicProperties.budget}
        resolve={calendarResolver}
        actuals={bundle.actuals.dynamicProperties.actuals}
        onCaptureActuals={captureActuals}
        onProposeChangeRequest={online && canWrite ? proposeChangeRequest : undefined}
      />
      <EvmPanel plan={livePlan} budget={bundle.budget} actuals={bundle.actuals} />
      {online && changeRequests !== null && (
        <ChangeRequestsPanel
          requests={changeRequests}
          planRevision={bundle.entity.lifecycle.version}
          onDecision={decideChangeRequest}
          canDecide={canDecide}
        />
      )}
      {!stressCount && (
        <TimesheetsPanel
          events={livePlan.events.map((e) => ({
            id: e.id,
            title: e.resourceId
              ? bundle.entity.dynamicProperties.plan.resources.find(
                  (r) => r.id === e.resourceId,
                )?.title ?? e.resourceId
              : e.resourceId,
          }))}
          offline={!online}
          me={me}
          canWrite={canWrite}
          canDecide={canDecide}
          onWriteRejected={onWriteRejected}
          onApproved={() => setReloadKey((k) => k + 1)}
        />
      )}
      <AuthPanel
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onLoggedIn={(actor) => {
          setMe(actor)
          setAuthOpen(false)
        }}
      />
    </div>
  )
}

export default App
