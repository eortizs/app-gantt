import { useCallback, useEffect, useMemo, useState } from "react"
import { GanttPlanViewer } from "@/components/gantt-plan/GanttPlanViewer"
import { EvmPanel } from "@/components/gantt-plan/EvmPanel"
import {
  ChangeRequestsPanel,
  RevisionConflictError,
  type ChangeRequestItem,
} from "@/components/gantt-plan/ChangeRequestsPanel"
import { buildDemoEntity, DEMO_PLAN_ID } from "@/data/demo-entity"
import { buildDemoActuals, buildDemoBudget } from "@/data/demo-contables"
import { buildDemoWorkforce } from "@/data/demo-workforce"
import { APP_STRINGS_ES } from "@/lib/i18n-es"
import type { UmeJsonEntity } from "@/lib/umejson/schema"
import type { UmeBudgetEntity } from "@/lib/umejson/budget"
import { decodeBudget } from "@/lib/umejson/budget"
import type { UmeActualsEntity } from "@/lib/umejson/actuals"
import { decodeActuals } from "@/lib/umejson/actuals"
import type { UmeWorkforceEntity } from "@/lib/umejson/workforce"
import { decodeWorkforce } from "@/lib/umejson/workforce"
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
  /** True when the plan fetch failed and the in-memory demo took over. */
  offline: boolean
}

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
    offline: true,
  }
}

function usePlanBundle(reloadKey: number): PlanBundle | null {
  const [bundle, setBundle] = useState<PlanBundle | null>(null)
  useEffect(() => {
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
        const [actuals, workforce] = await Promise.all([
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
        ])
        if (cancelled) return
        setBundle({ entity, budget, actuals, workforce, offline: false })
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
  return bundle
}

function App() {
  // Bumped after an apply (or a 409): refetches the whole bundle. The
  // viewer's key derives from the plan revision, so the fresh document
  // REMOUNTS it — its internal events state doesn't re-init from props.
  const [reloadKey, setReloadKey] = useState(0)
  const bundle = usePlanBundle(reloadKey)
  const [ops, setOps] = useState<ChangeOp[]>([])
  const [changeRequests, setChangeRequests] = useState<ChangeRequestItem[] | null>(null)
  const online = bundle !== null && !bundle.offline
  const basePlan = bundle?.entity.dynamicProperties.plan
  const livePlan = useMemo(
    () =>
      basePlan ? (ops.length ? applyOps(basePlan, ops) : basePlan) : null,
    [basePlan, ops],
  )

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refetchChangeRequests()
    },
    [refetchChangeRequests],
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
    [refetchChangeRequests],
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
        <h1 className="text-2xl font-semibold tracking-tight">
          Módulo Gantt — Construcción de departamento
        </h1>
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
      </header>
      <GanttPlanViewer
        key={`${DEMO_PLAN_ID}:${bundle.entity.lifecycle.version}`}
        document={bundle.entity}
        onOpsChange={setOps}
        workforce={bundle.workforce.dynamicProperties.workforce}
        budget={bundle.budget.dynamicProperties.budget}
        onProposeChangeRequest={online ? proposeChangeRequest : undefined}
      />
      <EvmPanel plan={livePlan} budget={bundle.budget} actuals={bundle.actuals} />
      {online && changeRequests !== null && (
        <ChangeRequestsPanel
          requests={changeRequests}
          planRevision={bundle.entity.lifecycle.version}
          onDecision={decideChangeRequest}
        />
      )}
    </div>
  )
}

export default App
