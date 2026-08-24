// Baseline drift policy, promoted out of the viewer so every consumer
// (the change-request contract, reports, a future approval UI) computes
// "modified vs original" with the SAME rule the dirty tint uses - no
// second copy of the policy to drift out of sync.
//
// Runtime-pure (relative `.ts` imports, no `@/` alias) so `pnpm verify`
// can load it under `node --experimental-strip-types` alongside the codec.
import type { PlanBaseline } from "../plan-types.ts"
import type { UpdateOp } from "./codec.ts"

const DAY_MS = 86_400_000

/** The baseline in force: the highest-version bitácora entry. */
export function vigenteBaseline(
  history: readonly PlanBaseline[] | undefined,
): PlanBaseline | null {
  if (!history || !history.length) return null
  return history.reduce((max, b) => (b.version > max.version ? b : max))
}

/**
 * What a bar's drift is measured against, expressed over PLAN types (ISO
 * strings, no gantt-engine types). Vigente baseline when the bitácora has
 * one, else the mapper-stamped original dates. Null only when neither
 * anchor exists (an event mapped before `initialStart/initialEnd` existed
 * AND without any capture).
 */
export interface DriftSubject {
  /** Live/current dates, ISO. */
  start: string
  end: string
  /** Append-only capture history, if any. */
  baselines?: readonly PlanBaseline[]
  /** The plan's original dates (the document itself, or the
   *  mapper-stamped `initialStart/initialEnd`). */
  initialStart?: string
  initialEnd?: string
}

export function driftReference(
  subject: DriftSubject,
): { start: string; end: string } | null {
  const vigente = vigenteBaseline(subject.baselines)
  if (vigente) return { start: vigente.start, end: vigente.end }
  const { initialStart: s, initialEnd: e } = subject
  return s && e ? { start: s, end: e } : null
}

/**
 * True when the live dates differ from the drift reference. Compared as
 * INSTANTS (Date.parse), never as strings: "…T00:00:00Z" and
 * "…T00:00:00.000Z" are the same moment in differently normalized ISO.
 */
export function isDrifted(subject: DriftSubject): boolean {
  const ref = driftReference(subject)
  if (!ref) return false
  return (
    Date.parse(subject.start) !== Date.parse(ref.start) ||
    Date.parse(subject.end) !== Date.parse(ref.end)
  )
}

/**
 * Whole-day Δ of one end date vs another (positive = later). The same
 * rounding the bitácora panel uses, shared so reports and the UI can
 * never disagree about what "+3 d" means.
 */
export function driftDays(end: string, referenceEnd: string): number {
  return Math.round((Date.parse(end) - Date.parse(referenceEnd)) / DAY_MS)
}

/**
 * Reversión como datos: the UpdateOp that puts one event back at a
 * captured version's dates. The bitácora is append-only and read-only, so
 * "restore to LB2" IS an edit to the live dates - expressed as an op the
 * change-request pipeline can propose, approve and apply like any other.
 * Null when that version doesn't exist in the history. Callers that want
 * a no-op guard check `isDrifted` first; this stays pure and unconditional.
 */
export function restoreBaselineOp(
  eventId: string,
  history: readonly PlanBaseline[],
  version: number,
): UpdateOp | null {
  const b = history.find((x) => x.version === version)
  if (!b) return null
  return { op: "update", id: eventId, patch: { start: b.start, end: b.end } }
}
