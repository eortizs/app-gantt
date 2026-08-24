import { useEffect, useMemo, useState } from "react"
import { GanttPlanViewer } from "@/components/gantt-plan/GanttPlanViewer"
import { EvmPanel } from "@/components/gantt-plan/EvmPanel"
import { buildDemoEntity, DEMO_PLAN_ID } from "@/data/demo-entity"
import { buildDemoActuals, buildDemoBudget } from "@/data/demo-contables"
import { APP_STRINGS_ES } from "@/lib/i18n-es"
import type { UmeJsonEntity } from "@/lib/umejson/schema"
import type { UmeBudgetEntity } from "@/lib/umejson/budget"
import { decodeBudget } from "@/lib/umejson/budget"
import type { UmeActualsEntity } from "@/lib/umejson/actuals"
import { decodeActuals } from "@/lib/umejson/actuals"
import { applyOps, type ChangeOp } from "@/lib/umejson/codec"

interface PlanBundle {
  entity: UmeJsonEntity
  budget: UmeBudgetEntity
  actuals: UmeActualsEntity
  /** True when the plan fetch failed and the in-memory demo took over. */
  offline: boolean
}

const fetchJson = (url: string): Promise<unknown> =>
  fetch(url).then((res) =>
    res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
  )

function demoBundle(entity: UmeJsonEntity): PlanBundle {
  const plan = entity.dynamicProperties.plan
  const budget = buildDemoBudget(plan)
  return {
    entity,
    budget,
    actuals: buildDemoActuals(plan, budget),
    offline: true,
  }
}

function usePlanBundle(): PlanBundle | null {
  const [bundle, setBundle] = useState<PlanBundle | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchJson(`/api/plans/${DEMO_PLAN_ID}`)
      .then(async (docRaw: unknown) => {
        const entity = docRaw as UmeJsonEntity
        const plan = entity.dynamicProperties.plan
        // Hermanas: fetch en paralelo; cada una que falle (o no pase el
        // decoder contra el plan recibido) cae a su builder demo sobre el
        // MISMO plan para que los ids de eventos sigan alineados.
        const [budgetRaw, actualsRaw] = await Promise.allSettled([
          fetchJson(`/api/plans/${DEMO_PLAN_ID}/budget`),
          fetchJson(`/api/plans/${DEMO_PLAN_ID}/actuals`),
        ])
        if (cancelled) return
        const demoBudget = buildDemoBudget(plan)
        const budget: UmeBudgetEntity =
          budgetRaw.status === "fulfilled" &&
          decodeBudget(budgetRaw.value, plan, DEMO_PLAN_ID).ok
            ? (budgetRaw.value as UmeBudgetEntity)
            : demoBudget
        const actuals: UmeActualsEntity =
          actualsRaw.status === "fulfilled" &&
          decodeActuals(actualsRaw.value, plan, DEMO_PLAN_ID).ok
            ? (actualsRaw.value as UmeActualsEntity)
            : buildDemoActuals(plan, budget)
        setBundle({ entity, budget, actuals, offline: false })
      })
      .catch(() => {
        // Resiliencia offline/demo: sin backend la app sigue siendo el
        // demo completo, solo que sin persistencia.
        if (!cancelled) setBundle(demoBundle(buildDemoEntity()))
      })
    return () => {
      cancelled = true
    }
  }, [])
  return bundle
}

function App() {
  const bundle = usePlanBundle()
  const [ops, setOps] = useState<ChangeOp[]>([])
  const basePlan = bundle?.entity.dynamicProperties.plan
  const livePlan = useMemo(
    () =>
      basePlan ? (ops.length ? applyOps(basePlan, ops) : basePlan) : null,
    [basePlan, ops],
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
      <GanttPlanViewer document={bundle.entity} onOpsChange={setOps} />
      <EvmPanel plan={livePlan} budget={bundle.budget} actuals={bundle.actuals} />
    </div>
  )
}

export default App
