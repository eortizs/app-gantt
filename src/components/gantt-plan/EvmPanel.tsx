import { useMemo } from "react"
import { format } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { APP_STRINGS_ES, LOCALE_ES } from "@/lib/i18n-es"
import type { PlanJSON } from "@/lib/plan-types"
import type { UmeBudgetEntity } from "@/lib/umejson/budget"
import type { UmeActualsEntity } from "@/lib/umejson/actuals"
import { computeEvm } from "@/lib/umejson/evm"
import { cn } from "@/lib/utils"

export interface EvmPanelProps {
  plan: PlanJSON
  budget: UmeBudgetEntity
  actuals: UmeActualsEntity
}

/** rojo < 0.9, ámbar [0.9, 1.0), verde >= 1.0 — null se apaga. */
function indexClass(value: number | null): string {
  if (value === null) return "text-muted-foreground"
  if (value < 0.9) return "text-destructive"
  if (value < 1) return "text-amber-600 dark:text-amber-400"
  return "text-emerald-600 dark:text-emerald-400"
}

/**
 * Lens de valor ganado sobre el plan VIVO: PV sobre la referencia de
 * drift, EV del avance, AC del corte. Sin estado propio — todo deriva de
 * (plan, budget, actuals) vía `umejson/evm.ts`, así el panel nunca puede
 * discrepar con el contrato.
 */
export function EvmPanel({ plan, budget, actuals }: EvmPanelProps) {
  const evm = useMemo(
    () =>
      computeEvm(
        plan,
        budget.dynamicProperties.budget,
        actuals.dynamicProperties.actuals,
      ),
    [plan, budget, actuals],
  )
  const fmt = useMemo(
    () =>
      new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: evm.currency,
        maximumFractionDigits: 0,
      }),
    [evm.currency],
  )
  const index = (v: number | null) =>
    v === null ? "—" : v.toFixed(2)

  const cards = [
    { label: APP_STRINGS_ES.evmBac, value: fmt.format(evm.project.bac), tone: "" },
    { label: APP_STRINGS_ES.evmPv, value: fmt.format(evm.project.pv), tone: "" },
    { label: APP_STRINGS_ES.evmEv, value: fmt.format(evm.project.ev), tone: "" },
    { label: APP_STRINGS_ES.evmAc, value: fmt.format(evm.project.ac), tone: "" },
    { label: APP_STRINGS_ES.evmSpi, value: index(evm.project.spi), tone: indexClass(evm.project.spi) },
    { label: APP_STRINGS_ES.evmCpi, value: index(evm.project.cpi), tone: indexClass(evm.project.cpi) },
    { label: APP_STRINGS_ES.evmEac, value: evm.project.eac === null ? "—" : fmt.format(evm.project.eac), tone: "" },
  ]
  const rows = [
    { label: APP_STRINGS_ES.evmSv, value: fmt.format(evm.project.sv) },
    { label: APP_STRINGS_ES.evmCv, value: fmt.format(evm.project.cv) },
    {
      label: APP_STRINGS_ES.evmEtc,
      value: evm.project.etc === null ? "—" : fmt.format(evm.project.etc),
    },
    {
      label: APP_STRINGS_ES.evmTcpi,
      value: index(evm.project.tcpi),
    },
    {
      label: APP_STRINGS_ES.evmVac,
      value: evm.project.vac === null ? "—" : fmt.format(evm.project.vac),
    },
  ]

  return (
    <Card data-slot="gantt-evm-panel">
      <CardHeader>
        <CardTitle className="text-base">{APP_STRINGS_ES.evmTitle}</CardTitle>
        <p className="text-muted-foreground text-xs">
          {APP_STRINGS_ES.evmDataDate(
            format(new Date(evm.dataDate), "d MMM yyyy HH:mm", {
              locale: LOCALE_ES,
            }),
          )}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {cards.map((c) => (
            <div
              key={c.label}
              className="bg-muted/40 rounded-md px-3 py-2"
            >
              <div className="text-muted-foreground text-[11px] font-medium">
                {c.label}
              </div>
              <div
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  c.tone || "text-foreground",
                )}
              >
                {c.value}
              </div>
            </div>
          ))}
        </div>
        <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {rows.map((r) => (
            <span key={r.label} className="tabular-nums">
              {r.label}:{" "}
              <span className="text-foreground font-medium">{r.value}</span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
