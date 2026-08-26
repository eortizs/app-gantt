// Earned Value Management, runtime-pura: PV/EV/AC and the derived
// indices per event and for the whole project. Nothing is persisted —
// EVM is a LENSE over (plan, budget, actuals), recomputed on demand so
// it can never drift from the documents it reads.
//
// Measurement policy (documented):
// - PV: the event's BAC spread UNIFORMLY across its drift reference
//   window (vigente baseline dates — the version the capture anchored
//   when present — else the event's own current dates), earned linearly
//   up to the data date and clamped to [0, BAC].
// - EV: BAC × progress/100 (independent of dates).
// - AC: the actuals cutoff sum for the event (0 when absent).
// - Indices are null when their denominator makes them meaningless
//   (PV = 0, AC = 0, CPI = 0 → EAC undefined). "Events without BAC"
//   participate with zero-valued metrics, never crashes.
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` and the backend
// imports it verbatim, same as every other contract module.
import type { PlanJSON } from "../plan-types.ts"
import { vigenteBaseline } from "./baselines.ts"
import { workingDaysBetween, type WorkingCalendar } from "./working-time.ts"
import type { BudgetPayload } from "./budget.ts"
import type { ActualsPayload } from "./actuals.ts"

export interface EvmEventMetrics {
  /** Budget at completion for the event. */
  bac: number
  /** Planned value (BCWS) earned by the data date. */
  pv: number
  /** Earned value (BCWP). */
  ev: number
  /** Actual cost accumulated at the cutoff. */
  ac: number
  sv: number
  cv: number
  /** EV/PV; null when PV = 0 (nothing planned yet — ratio undefined). */
  spi: number | null
  /** EV/AC; 0 is a REAL answer (spent, earned nothing). */
  cpi: number | null
  /** BAC/CPI; null when CPI = 0 or undefined. */
  eac: number | null
  /** EAC − AC; null when EAC is. */
  etc: number | null
  /** (BAC − EV)/(BAC − AC); null when the remaining budget is exhausted. */
  tcpi: number | null
  /** BAC − EAC; null when EAC is. */
  vac: number | null
}

export interface EvmResult {
  dataDate: string
  currency: string
  byEvent: Map<string, EvmEventMetrics>
  project: EvmEventMetrics
}

/**
 * Uniform PV fraction of one window earned by the data date, clamped.
 * With `cal` the window phases over its WORKING days (earned = working
 * days elapsed inside the window ÷ total working days of the window);
 * null = linear over the corrido span, byte-equal to the old formula.
 */
export function pvFraction(
  dataDateMs: number,
  startMs: number,
  endMs: number,
  cal?: WorkingCalendar | null,
): number {
  const span = endMs - startMs
  if (span <= 0) return dataDateMs >= endMs ? 1 : 0
  if (!cal) {
    const fraction = (dataDateMs - startMs) / span
    return Math.min(1, Math.max(0, fraction))
  }
  const total = workingDaysBetween(cal, startMs, endMs)
  if (total <= 0) return dataDateMs >= endMs ? 1 : 0
  const earnedThrough = Math.min(Math.max(dataDateMs, startMs), endMs)
  const earned = workingDaysBetween(cal, startMs, earnedThrough)
  return Math.min(1, Math.max(0, earned / total))
}

const metricsOf = (
  bac: number,
  pv: number,
  ev: number,
  ac: number,
): EvmEventMetrics => {
  const cpi = ac > 0 ? ev / ac : null
  const eac = cpi !== null && cpi > 0 ? bac / cpi : null
  const remaining = bac - ac
  return {
    bac,
    pv,
    ev,
    ac,
    sv: ev - pv,
    cv: ev - ac,
    spi: pv > 0 ? ev / pv : null,
    cpi,
    eac,
    etc: eac !== null ? eac - ac : null,
    tcpi: remaining > 0 ? (bac - ev) / remaining : null,
    vac: eac !== null ? bac - eac : null,
  }
}

export function computeEvm(
  plan: PlanJSON,
  budget: BudgetPayload,
  actuals: ActualsPayload,
  resolve?: (eventId: string) => WorkingCalendar | null,
): EvmResult {
  // Cutoff resolution order (documented): the actuals' own dataDate wins;
  // without a usable one the plan's statusDate stands in; last resort is
  // "now" (an empty/invalid actuals cutoff must never NaN every metric).
  const dataDateMs = (() => {
    const fromActuals = Date.parse(actuals.dataDate)
    if (Number.isFinite(fromActuals)) return fromActuals
    const fromPlan = plan.statusDate ? Date.parse(plan.statusDate) : NaN
    if (Number.isFinite(fromPlan)) return fromPlan
    return Date.now()
  })()
  const byEvent = new Map<string, EvmEventMetrics>()
  let bac = 0
  let pv = 0
  let ev = 0
  let ac = 0
  for (const event of plan.events) {
    const eventBac = budget.bacByEvent[event.id] ?? 0
    // Drift-reference window: the vigente baseline (the version the
    // capture anchored, when recorded) — else the event's current dates.
    const anchorVersion = actuals.baselineVersionByEvent?.[event.id]
    const history = event.baselines ?? []
    const vigente = vigenteBaseline(history)
    const anchored =
      anchorVersion !== undefined
        ? history.find((b) => b.version === anchorVersion) ?? vigente
        : vigente
    const startMs = Date.parse(anchored?.start ?? event.start)
    const endMs = Date.parse(anchored?.end ?? event.end)
    // PV phases over the event's OWN working days when a calendar backs
    // the plan; corrido-linear otherwise.
    const eventPv = eventBac * pvFraction(dataDateMs, startMs, endMs, resolve?.(event.id) ?? null)
    const eventEv = eventBac * (event.progress / 100)
    const eventAc = actuals.acByEvent[event.id] ?? 0
    byEvent.set(event.id, metricsOf(eventBac, eventPv, eventEv, eventAc))
    bac += eventBac
    pv += eventPv
    ev += eventEv
    ac += eventAc
  }
  return {
    dataDate: new Date(dataDateMs).toISOString(),
    currency: budget.currency,
    byEvent,
    project: metricsOf(bac, pv, ev, ac),
  }
}
