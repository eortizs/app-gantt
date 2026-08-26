#!/usr/bin/env node
// scripts/verify-roundtrip.mts
//
// Round-trip + invariant checks for the umeJSON codec. Runs under
//   node --experimental-strip-types scripts/verify-roundtrip.mts
//
// Imports use relative paths because `@/` aliases don't resolve under node.

import { applyOps, encodeUpdatedPlan, type ChangeOp } from "../src/lib/umejson/codec.ts"
import {
  decodeUmePlan,
  SENTINEL,
  type UmeJsonEntity,
} from "../src/lib/umejson/schema.ts"
import {
  cascadeSchedule,
  dependentClosure,
  impliedLagDays,
  snapToDependency,
  wouldCreateCycle,
} from "../src/lib/umejson/schedule.ts"
import { cpmSchedule } from "../src/lib/umejson/cpm.ts"
import {
  buildBudgetEntity,
  decodeBudget,
  type BudgetPayload,
  type UmeBudgetEntity,
} from "../src/lib/umejson/budget.ts"
import {
  buildActualsEntity,
  decodeActuals,
  type ActualsPayload,
  type UmeActualsEntity,
} from "../src/lib/umejson/actuals.ts"
import { computeEvm, pvFraction } from "../src/lib/umejson/evm.ts"
import {
  vigenteBaseline,
  driftReference,
  isDrifted,
  restoreBaselineOp,
  driftDays,
} from "../src/lib/umejson/baselines.ts"
import {
  buildWorkforceEntity,
  decodeWorkforce,
  type WorkforcePayload,
  type UmeWorkforceEntity,
} from "../src/lib/umejson/workforce.ts"
import {
  buildCalendarEntity,
  decodeCalendar,
  type UmeCalendarEntity,
} from "../src/lib/umejson/calendar.ts"
import {
  addWorkingDays,
  buildResolver,
  isWorkingDay,
  workingDaysBetween,
} from "../src/lib/umejson/working-time.ts"
import { buildDemoCalendar } from "../src/data/demo-calendar.ts"
import {
  buildChangeRequestEntity,
  buildImpactSnapshot,
  createChangeRequest,
  canTransition,
  transitionChangeRequest,
  encodeChangeRequest,
  decodeChangeRequest,
  ENTITY_NAME_CHANGE_REQUEST,
  type UmeChangeRequestEntity,
} from "../src/lib/umejson/change-request.ts"
import { PLAN } from "../src/data/plan-departamento.ts"
import { DEMO_PLAN_ID, buildDemoEntity } from "../src/data/demo-entity.ts"
import { buildDemoBudget } from "../src/data/demo-contables.ts"
import { buildDemoWorkforce } from "../src/data/demo-workforce.ts"
import {
  eventOverloadDays,
  levelPlan,
  overallocations,
} from "../src/lib/umejson/leveling.ts"
import {
  buildTimesheetEntity,
  decodeTimesheet,
  transitionEntry,
} from "../src/lib/umejson/timesheet.ts"
import type { PlanJSON } from "../src/lib/plan-types.ts"

const fails: string[] = []
const ok = (label: string) => console.log(`  ok  ${label}`)
const fail = (label: string, why: string) => {
  fails.push(`${label}: ${why}`)
  console.log(`  FAIL  ${label}: ${why}`)
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const arrA = a as unknown[]
    const arrB = b as unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i++) if (!deepEqual(arrA[i], arrB[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false
  return true
}

const ISO = "2026-01-12T12:00:00.000Z"

const fixturePlan: PlanJSON = {
  schemaVersion: 2,
  anchor: ISO,
  phases: [{ id: "p1", title: "Fase 1", color: "var(--color-amber-500)" }],
  resources: [
    { id: "root", title: "Root" },
    { id: "child", title: "Child", parentId: "root" },
  ],
  events: [
    {
      id: "e1",
      resourceId: "child",
      start: ISO,
      end: ISO,
      progress: 50,
      baselines: [
        { version: 1, start: ISO, end: ISO, capturedAt: ISO },
        { version: 2, start: ISO, end: ISO, capturedAt: ISO, reason: "Re-plan" },
      ],
    },
  ],
}

const fixtureEntity: UmeJsonEntity = {
  id: "00000000-0000-4000-8000-000000000001",
  entityName: "GanttPlan",
  dynamicProperties: { plan: fixturePlan },
  lifecycle: { createdAt: ISO, updatedAt: ISO, deletedAt: null, version: 1 },
  state: { current: "active", statusLog: [] },
  markdownDocumentation: "# demo",
}

// ---- 1. Round-trip PLAN -> encode -> decode -> PLAN ------------------------
// Encode sets `updatedAt` to the RESERVED_FOR_SYSTEM sentinel (the backend
// fills it on persist), so the encoded envelope is NOT meant to be re-decoded
// by the same client. We round-trip the `plan` payload only.
{
  const encoded = encodeUpdatedPlan(fixtureEntity, fixturePlan, 0)
  if (!deepEqual(encoded.dynamicProperties.plan, fixturePlan)) {
    fail("round-trip: plan preserved", "encoded.plan differs from input")
  } else {
    ok("round-trip: plan preserved")
  }
}

// ---- 2. applyOps (update + create + delete) -------------------------------
{
  const ops: ChangeOp[] = [
    { op: "update", id: "e1", patch: { start: ISO, end: ISO } },
    {
      op: "create",
      event: {
        id: "e2",
        resourceId: "child",
        start: ISO,
        end: ISO,
        progress: 0,
        title: "Nuevo",
        color: "var(--color-indigo-500)",
        data: { responsable: "—", fase: "p1", status: "Pendiente" },
      },
    },
    { op: "delete", id: "e1" },
  ]
  const next = applyOps(fixturePlan, ops)
  if (next.events.length !== fixturePlan.events.length) {
    fail("applyOps: event count", `expected ${fixturePlan.events.length}, got ${next.events.length}`)
  } else {
    const ids = next.events.map((e) => e.id).sort()
    const expected = ["e2"]
    if (!deepEqual(ids, expected)) fail("applyOps: surviving ids", JSON.stringify(ids))
    else ok("applyOps: surviving ids")
  }
}

// ---- 3. Decoder rejections ------------------------------------------------
const rejectionCases: Array<[string, unknown]> = [
  ["schemaVersion 3", { ...fixtureEntity, dynamicProperties: { plan: { ...fixturePlan, schemaVersion: 3 } } }],
  ["malformed anchor", { ...fixtureEntity, dynamicProperties: { plan: { ...fixturePlan, anchor: "not-a-date" } } }],
  [
    "orphan event resourceId",
    {
      ...fixtureEntity,
      dynamicProperties: {
        plan: { ...fixturePlan, events: [{ ...fixturePlan.events[0], resourceId: "ghost" }] },
      },
    },
  ],
  ["sentinel id", { ...fixtureEntity, id: SENTINEL }],
  ["wrong entityName", { ...fixtureEntity, entityName: "Other" }],
]
for (const [label, input] of rejectionCases) {
  const decoded = decodeUmePlan(input)
  if (decoded.ok) fail(`reject: ${label}`, "decoder accepted it")
  else ok(`reject: ${label}`)
}

// ---- 4. Inmutabilidad: applyOps no muta el input ---------------------------
{
  const snapshot = JSON.parse(JSON.stringify(fixturePlan))
  applyOps(fixturePlan, [
    { op: "update", id: "e1", patch: { start: ISO, end: ISO } },
  ])
  if (!deepEqual(fixturePlan, snapshot)) fail("inmutabilidad", "applyOps mutated input")
  else ok("inmutabilidad")
}

// ---- 5. encodeUpdatedPlan: deep-clone + sentinel + statusLog ---------------
{
  const out = encodeUpdatedPlan(fixtureEntity, fixturePlan, 3)
  if (out === fixtureEntity) fail("encode: clone", "returned same reference")
  else if (out.lifecycle.updatedAt !== SENTINEL) fail("encode: updatedAt sentinel", out.lifecycle.updatedAt)
  else if (out.lifecycle.version !== 1) fail("encode: version preserved", String(out.lifecycle.version))
  else if (out.state.statusLog.length !== 1) fail("encode: statusLog append", String(out.state.statusLog.length))
  else if (out.state.statusLog[0]?.reason !== "gantt: 3 ops") fail("encode: reason", String(out.state.statusLog[0]?.reason))
  else if (out.markdownDocumentation !== fixtureEntity.markdownDocumentation) fail("encode: markdown preserved", "differs")
  else if (fixtureEntity.lifecycle.updatedAt !== ISO) fail("encode: input untouched", "updatedAt changed on input")
  else ok("encode: clone + sentinel + version + statusLog + markdown preserved")
}

// ---- 6. Bitácora de baselines ------------------------------------------------
{
  // The baseline history must survive encode untouched (append-only log).
  const encoded = encodeUpdatedPlan(fixtureEntity, fixturePlan, 0)
  const out = encoded.dynamicProperties.plan.events[0]?.baselines
  if (!deepEqual(out, fixturePlan.events[0]?.baselines)) {
    fail("baselines: preserved through encode", "history differs after encode")
  } else {
    ok("baselines: preserved through encode")
  }

  // A date update rewrites start/end but must never touch the history.
  const next = applyOps(fixturePlan, [
    { op: "update", id: "e1", patch: { start: ISO, end: ISO } },
  ])
  const after = next.events[0]?.baselines
  if (!deepEqual(after, fixturePlan.events[0]?.baselines)) {
    fail("baselines: untouched by update op", "history changed on update")
  } else {
    ok("baselines: untouched by update op")
  }

  // Decoder rejections for malformed history entries.
  const baselineEvent = fixturePlan.events[0]
  const withBaselines = (baselines: unknown): unknown => ({
    ...fixtureEntity,
    dynamicProperties: {
      plan: { ...fixturePlan, events: [{ ...baselineEvent, baselines }] },
    },
  })
  const baselineRejections: Array<[string, unknown]> = [
    ["baselines: not an array", withBaselines("nope")],
    ["baselines: version 0", withBaselines([{ version: 0, start: ISO, end: ISO, capturedAt: ISO }])],
    ["baselines: duplicate version", withBaselines([
      { version: 1, start: ISO, end: ISO, capturedAt: ISO },
      { version: 1, start: ISO, end: ISO, capturedAt: ISO },
    ])],
    ["baselines: bad capturedAt", withBaselines([{ version: 1, start: ISO, end: ISO, capturedAt: "nope" }])],
    ["baselines: entry not an object", withBaselines(["v1"])],
  ]
  for (const [label, input] of baselineRejections) {
    const decoded = decodeUmePlan(input)
    if (decoded.ok) fail(`reject: ${label}`, "decoder accepted it")
    else ok(`reject: ${label}`)
  }

  // And the happy path: a valid history decodes fine.
  const decoded = decodeUmePlan(fixtureEntity)
  if (!decoded.ok) fail("baselines: valid history decodes", decoded.errors[0]?.message ?? "rejected")
  else ok("baselines: valid history decodes")
}

// ---- 7. Dependencias: ops + applyOps mantiene el grafo válido --------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const depPlan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(1), end: t(3), progress: 0 },
      { id: "c", resourceId: "r", start: t(2), end: t(4), progress: 0 },
    ],
    dependencies: [
      { id: "d1", fromEventId: "a", toEventId: "b", type: "FS" },
      { id: "d2", fromEventId: "b", toEventId: "c", type: "FS" },
    ],
  }

  // addDependency replaces by id, removeDependency filters, delete prunes
  // incident edges so the document never carries dangling refs.
  const added = applyOps(depPlan, [
    { op: "addDependency", dependency: { id: "d3", fromEventId: "c", toEventId: "b", type: "SS" } },
  ])
  if (!deepEqual(
    added.dependencies?.map((d) => d.id),
    ["d1", "d2", "d3"],
  )) fail("deps: addDependency appends", JSON.stringify(added.dependencies))
  else ok("deps: addDependency appends")

  const removed = applyOps(depPlan, [{ op: "removeDependency", id: "d1" }])
  if (!deepEqual(removed.dependencies?.map((d) => d.id), ["d2"])) {
    fail("deps: removeDependency filters", JSON.stringify(removed.dependencies))
  } else ok("deps: add/remove ops")

  // Contract: any edge incident to the deleted event is pruned. The
  // resulting graph is empty AND absent as a field (round-trip semantics:
  // "no constraints" is the same shape as a plan that never had any).
  const deleted = applyOps(depPlan, [{ op: "delete", id: "b" }])
  if (
    deleted.events.length !== 2 ||
    "dependencies" in deleted ||
    deleted.dependencies !== undefined
  ) {
    fail(
      "deps: delete prunes incident edges",
      JSON.stringify({
        deps: deleted.dependencies,
        depsKeyPresent: "dependencies" in deleted,
        events: deleted.events.length,
      }),
    )
  } else ok("deps: delete prunes incident edges")

  // A plan without the field stays without it (round-trip equality).
  const bare: PlanJSON = { ...depPlan, dependencies: undefined }
  const untouched = applyOps(bare, [{ op: "update", id: "a", patch: { start: t(0), end: t(2) } }])
  if ("dependencies" in untouched && untouched.dependencies !== undefined) {
    fail("deps: absent field not synthesized", String(untouched.dependencies))
  } else ok("deps: absent field not synthesized")

  // Same when a delete op runs on a bare plan: the dependency walk still
  // executes (it filters nothing) but the field stays truly absent, not just
  // undefined - the codec rebuilds the object so the original property does
  // not resurrect via spread.
  const bareDelete = applyOps(bare, [{ op: "delete", id: "a" }])
  if ("dependencies" in bareDelete || bareDelete.dependencies !== undefined) {
    fail(
      "deps: absent field not synthesized on delete",
      `key=${"dependencies" in bareDelete} value=${String(bareDelete.dependencies)}`,
    )
  } else ok("deps: absent field not synthesized on delete")

  // ---- 8. Cascada: push-forward documentado, nunca pull-back -------------
  const shifted: PlanJSON = {
    ...depPlan,
    events: depPlan.events.map((e) =>
      e.id === "a" ? { ...e, start: t(5), end: t(7) } : e,
    ),
  }
  const adjustments = cascadeSchedule(shifted, ["a"])
  if (adjustments.length !== 2) {
    fail("cascade: transitive chain", JSON.stringify(adjustments))
  } else {
    const bAdj = adjustments[0]!
    const cAdj = adjustments[1]!
    if (
      bAdj.eventId !== "b" ||
      bAdj.start !== t(7) ||
      bAdj.end !== t(9) ||
      bAdj.cause.sourceEventId !== "a" ||
      bAdj.cause.type !== "FS" ||
      bAdj.cause.shiftDays !== 6
    ) fail("cascade: direct successor", JSON.stringify(bAdj))
    else if (
      cAdj.eventId !== "c" ||
      cAdj.start !== t(9) ||
      cAdj.cause.sourceEventId !== "b"
    ) fail("cascade: transitive successor", JSON.stringify(cAdj))
    else ok("cascade: transitive chain with documented cause")
  }

  // Forward-only: moving a predecessor EARLIER relaxes; nobody is pulled.
  const earlier: PlanJSON = {
    ...depPlan,
    events: depPlan.events.map((e) =>
      e.id === "a" ? { ...e, start: t(-4), end: t(-2) } : e,
    ),
  }
  if (cascadeSchedule(earlier, ["a"]).length !== 0) {
    fail("cascade: forward-only", "pulled successors backward")
  } else ok("cascade: forward-only (no pull-back)")

  // FF bounds the END: B must finish when A finishes, duration preserved.
  const ffPlan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(5), progress: 0 },
      { id: "b", resourceId: "r", start: t(1), end: t(3), progress: 0 },
    ],
    dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FF" }],
  }
  const ffAdj = cascadeSchedule(ffPlan, ["a"])[0]
  if (!ffAdj || ffAdj.start !== t(3) || ffAdj.end !== t(5)) {
    fail("cascade: FF math", JSON.stringify(ffAdj))
  } else ok("cascade: FF bounds the end, duration preserved")

  // Lag: FS with lagDays=2 pushes past pred.end + 2 days.
  const lagPlan: PlanJSON = {
    ...ffPlan,
    dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FS", lagDays: 2 }],
  }
  const lagAdj = cascadeSchedule(lagPlan, ["a"])[0]
  if (!lagAdj || lagAdj.start !== t(7)) fail("cascade: FS lag", JSON.stringify(lagAdj))
  else ok("cascade: FS lagDays respected")

  // ---- 9. wouldCreateCycle ------------------------------------------------
  if (wouldCreateCycle(depPlan.dependencies ?? [], "a", "a")) ok("cycle veto: self-loop")
  else fail("cycle veto: self-loop", "not detected")
  if (wouldCreateCycle(depPlan.dependencies ?? [], "c", "a")) ok("cycle veto: back-edge into ancestry")
  else fail("cycle veto: back-edge", "not detected")
  if (wouldCreateCycle(depPlan.dependencies ?? [], "a", "c")) {
    fail("cycle veto: clean edge rejected", "false positive")
  } else ok("cycle veto: clean edge allowed")

  // ---- 9b. dependentClosure ----------------------------------------------
  const diamondDeps: PlanDependency[] = [
    { id: "d1", fromEventId: "a", toEventId: "b", type: "FS" },
    { id: "d2", fromEventId: "a", toEventId: "c", type: "FS" },
    { id: "d3", fromEventId: "b", toEventId: "d", type: "FS" },
    { id: "d4", fromEventId: "c", toEventId: "d", type: "FS" },
    { id: "d5", fromEventId: "a", toEventId: "e", type: "FS" },
  ]
  const closure = dependentClosure(diamondDeps, ["a"])
  const expected = ["b", "c", "e", "d"]
  if (
    closure.length === expected.length &&
    closure.every((id, i) => id === expected[i])
  ) {
    ok("closure: BFS order, diamond deduped")
  } else {
    fail("closure: BFS order, diamond deduped", `got ${JSON.stringify(closure)}`)
  }
  if (dependentClosure(diamondDeps, ["z"]).length === 0) {
    ok("closure: no edges from seed")
  } else {
    fail("closure: no edges from seed", "non-empty")
  }
  if (dependentClosure(diamondDeps, []).length === 0) {
    ok("closure: empty seed list")
  } else {
    fail("closure: empty seed list", "non-empty")
  }

  // ---- 10. Decoder: rechazos y happy path del grafo -----------------------
  const withDeps = (dependencies: unknown): unknown => ({
    ...fixtureEntity,
    dynamicProperties: { plan: { ...fixturePlanWithDeps(), dependencies } },
  })
  function fixturePlanWithDeps(): PlanJSON {
    return {
      ...fixturePlan,
      events: [
        ...fixturePlan.events,
        { id: "e2", resourceId: "child", start: ISO, end: ISO, progress: 0 },
      ],
    }
  }
  const depRejections: Array<[string, unknown]> = [
    ["deps: unknown endpoint", withDeps([{ id: "x", fromEventId: "e1", toEventId: "ghost", type: "FS" }])],
    ["deps: duplicate id", withDeps([
      { id: "same", fromEventId: "e1", toEventId: "e2", type: "FS" },
      { id: "same", fromEventId: "e2", toEventId: "e1", type: "FS" },
    ])],
    ["deps: self-loop", withDeps([{ id: "x", fromEventId: "e1", toEventId: "e1", type: "FS" }])],
    ["deps: bad type", withDeps([{ id: "x", fromEventId: "e1", toEventId: "e2", type: "XX" }])],
    ["deps: cycle", withDeps([
      { id: "x1", fromEventId: "e1", toEventId: "e2", type: "FS" },
      { id: "x2", fromEventId: "e2", toEventId: "e1", type: "FS" },
    ])],
    ["deps: non-integer lag", withDeps([{ id: "x", fromEventId: "e1", toEventId: "e2", type: "FS", lagDays: 1.5 }])],
  ]
  for (const [label, input] of depRejections) {
    const decoded = decodeUmePlan(input)
    if (decoded.ok) fail(`reject: ${label}`, "decoder accepted it")
    else ok(`reject: ${label}`)
  }
  const validDeps = decodeUmePlan(withDeps([
    { id: "ok1", fromEventId: "e1", toEventId: "e2", type: "FS", lagDays: -1 },
    { id: "ok2", fromEventId: "e2", toEventId: "e1", type: "SS" },
  ]))
  // SS e2->e1 plus FS e1->e2 is NOT a cycle for the validator? It IS:
  // two edges between the same pair in opposite directions close one.
  if (validDeps.ok) fail("reject: deps opposite pair closes cycle", "decoder accepted it")
  else ok("reject: opposite-direction pair closes a cycle")

  const happy = decodeUmePlan(
    withDeps([{ id: "ok", fromEventId: "e1", toEventId: "e2", type: "FS", lagDays: 2 }]),
  )
  if (!happy.ok) {
    fail("deps: valid graph decodes", JSON.stringify(happy.errors.slice(0, 3)))
  } else {
    ok("deps: valid graph decodes")
    // And the graph survives encode untouched.
    const encodedDeps = encodeUpdatedPlan(fixtureEntity, happy.plan, 0)
    if (!deepEqual(encodedDeps.dynamicProperties.plan.dependencies, happy.plan.dependencies)) {
      fail("deps: preserved through encode", "graph differs after encode")
    } else ok("deps: preserved through encode")
  }
}

// ---- 11. Política de drift promovida (umejson/baselines.ts) --------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()

  // Vigente = highest version, NOT the last array position.
  const shuffled = [
    { version: 2, start: t(0), end: t(0), capturedAt: ISO },
    { version: 3, start: t(0), end: t(0), capturedAt: ISO },
    { version: 1, start: t(0), end: t(0), capturedAt: ISO },
  ]
  if (vigenteBaseline(shuffled)?.version !== 3) fail("drift-lib: vigente is highest version", String(vigenteBaseline(shuffled)?.version))
  else ok("drift-lib: vigente is highest version")
  if (vigenteBaseline([]) !== null || vigenteBaseline(undefined) !== null) fail("drift-lib: empty history", "not null")
  else ok("drift-lib: empty history yields null")

  // Reference: vigente wins over the initial anchor; fallback to initial;
  // null when neither anchor exists.
  const withHistory = driftReference({
    start: t(1), end: t(2),
    baselines: [{ version: 1, start: t(0), end: t(0), capturedAt: ISO }],
    initialStart: t(9), initialEnd: t(9),
  })
  if (withHistory?.start !== t(0)) fail("drift-lib: vigente wins", JSON.stringify(withHistory))
  else ok("drift-lib: vigente wins over initial anchor")
  const withInitialOnly = driftReference({ start: t(1), end: t(2), initialStart: t(9), initialEnd: t(9) })
  if (withInitialOnly?.start !== t(9)) fail("drift-lib: falls back to initial", JSON.stringify(withInitialOnly))
  else ok("drift-lib: falls back to initial")
  if (driftReference({ start: t(1), end: t(2) }) !== null) fail("drift-lib: no anchor", "not null")
  else ok("drift-lib: no anchor yields null")

  // Instants, not strings: same moment in differently-normalized ISO is
  // NOT drift.
  const bare = "2026-01-12T12:00:00Z"
  const milli = "2026-01-12T12:00:00.000Z"
  if (isDrifted({ start: bare, end: bare, initialStart: milli, initialEnd: milli })) {
    fail("drift-lib: instant equality", "same instant flagged as drift")
  } else ok("drift-lib: compares instants, not strings")

  if (!isDrifted({ start: t(1), end: t(2), initialStart: t(0), initialEnd: t(1) })) fail("drift-lib: detects drift", "false negative")
  else ok("drift-lib: detects drift")
  if (isDrifted({ start: t(0), end: t(1), initialStart: t(0), initialEnd: t(1) })) fail("drift-lib: clean is clean", "false positive")
  else ok("drift-lib: clean is clean")
  if (isDrifted({ start: t(1), end: t(2) })) fail("drift-lib: no reference", "flagged without anchor")
  else ok("drift-lib: no reference is not drift")

  // Shared rounding: reports and the panel can never disagree.
  if (driftDays(t(3), t(0)) !== 3 || driftDays(t(-2), t(0)) !== -2) fail("drift-lib: driftDays rounding", String(driftDays(t(3), t(0))))
  else ok("drift-lib: driftDays rounding")
}

// ---- 12. restoreBaselineOp: reversión como datos --------------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const history = [
    { version: 1, start: t(0), end: t(2), capturedAt: ISO },
    { version: 2, start: t(4), end: t(6), capturedAt: ISO },
  ]
  const op = restoreBaselineOp("e1", history, 2)
  if (!op || op.op !== "update" || op.id !== "e1" || op.patch.start !== t(4) || op.patch.end !== t(6)) {
    fail("restore: op patches to LB dates", JSON.stringify(op))
  } else ok("restore: op patches to LB dates")
  if (restoreBaselineOp("e1", history, 9) !== null) fail("restore: unknown version", "returned an op")
  else ok("restore: unknown version yields null")
}

// ---- 13. buildImpactSnapshot: blast radius congelada ----------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(1), end: t(3), progress: 0 },
      { id: "c", resourceId: "r", start: t(2), end: t(4), progress: 0 },
    ],
    dependencies: [
      { id: "d1", fromEventId: "a", toEventId: "b", type: "FS" },
      { id: "d2", fromEventId: "b", toEventId: "c", type: "FS" },
    ],
  }

  // Seed-only ops: b and c land in the blast radius via closure even
  // though no op moves them - their proposed dates equal the base, so
  // their drift against the plan's own dates is 0 (honest fan-out).
  const snapSeed = buildImpactSnapshot(plan, [
    { op: "update", id: "a", patch: { start: t(5), end: t(7) } },
  ])
  const byIdSeed = new Map(snapSeed.entries.map((e) => [e.eventId, e]))
  const aS = byIdSeed.get("a")
  const bS = byIdSeed.get("b")
  if (
    snapSeed.entries.length !== 3 ||
    aS?.driftDays !== 5 ||
    bS?.driftDays !== 0 ||
    byIdSeed.get("c")?.driftDays !== 0
  ) {
    fail("impact: closure fan-out", JSON.stringify(snapSeed.entries))
  } else ok("impact: closure fan-out with frozen drift")

  // With the cascade ops the recorder would emit, dependents show their
  // own drift (b end t(9) vs base t(3) = +6; c end t(11) vs t(4) = +7).
  const snapCascade = buildImpactSnapshot(plan, [
    { op: "update", id: "a", patch: { start: t(5), end: t(7) } },
    { op: "update", id: "b", patch: { start: t(7), end: t(9) } },
    { op: "update", id: "c", patch: { start: t(9), end: t(11) } },
  ])
  const byIdCascade = new Map(snapCascade.entries.map((e) => [e.eventId, e]))
  if (byIdCascade.get("a")?.driftDays !== 5 || byIdCascade.get("b")?.driftDays !== 6 || byIdCascade.get("c")?.driftDays !== 7) {
    fail("impact: cascade drift", JSON.stringify(snapCascade.entries))
  } else ok("impact: cascade ops surface per-event drift")

  // A created event has no anchor: entry present, reference/drift absent.
  const snapCreate = buildImpactSnapshot(plan, [
    {
      op: "create",
      event: {
        id: "n", resourceId: "r", start: t(1), end: t(2), progress: 0,
        title: "N", data: { responsable: "—", fase: "", status: "Pendiente" },
      },
    },
  ])
  const nEntry = snapCreate.entries.find((e) => e.eventId === "n")
  if (!nEntry || "reference" in nEntry || "driftDays" in nEntry) {
    fail("impact: created event has no anchor", JSON.stringify(nEntry))
  } else ok("impact: created event has no anchor")

  // A deleted seed produces no entry (gone, not "impacted").
  const snapDelete = buildImpactSnapshot(plan, [{ op: "delete", id: "a" }])
  if (snapDelete.entries.length !== 0) fail("impact: deleted seed", JSON.stringify(snapDelete.entries))
  else ok("impact: deleted seed yields no entry")

  // Purity: the snapshot never mutates the base plan.
  const before = JSON.parse(JSON.stringify(plan))
  buildImpactSnapshot(plan, [
    { op: "update", id: "a", patch: { start: t(5), end: t(7) } },
    { op: "addDependency", dependency: { id: "d9", fromEventId: "c", toEventId: "a", type: "SS" } },
  ])
  if (!deepEqual(plan, before)) fail("impact: purity", "base plan mutated")
  else ok("impact: purity")

  // A baseline in force re-anchors the drift (policy: vigente ?? original).
  const anchored: PlanJSON = {
    ...plan,
    events: plan.events.map((e) =>
      e.id === "a"
        ? { ...e, baselines: [{ version: 1, start: t(4), end: t(6), capturedAt: ISO }] }
        : e,
    ),
  }
  const snapAnchored = buildImpactSnapshot(anchored, [
    { op: "update", id: "a", patch: { start: t(7), end: t(9) } },
  ])
  const aAnchored = snapAnchored.entries.find((e) => e.eventId === "a")
  if (aAnchored?.driftDays !== 3 || aAnchored.reference?.end !== t(6)) {
    fail("impact: vigente re-anchors drift", JSON.stringify(aAnchored))
  } else ok("impact: vigente re-anchors drift")
}

// ---- 14. Contrato de change request (umejson/change-request.ts) -----------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(1), end: t(3), progress: 0 },
    ],
    dependencies: [{ id: "d1", fromEventId: "a", toEventId: "b", type: "FS" }],
  }
  const ops: ChangeOp[] = [
    { op: "update", id: "a", patch: { start: t(5), end: t(7) } },
    {
      op: "update",
      id: "b",
      patch: { start: t(7), end: t(9) },
      cause: { kind: "dependency-cascade", sourceEventId: "a", type: "FS", shiftDays: 6 },
    },
  ]

  // Proposal born coherent: snapshot computed from the SAME plan it binds to.
  const cr = createChangeRequest({
    planEntityId: "plan-1",
    planAnchor: plan.anchor,
    planRevision: 3,
    basePlan: plan,
    ops,
  })
  if (
    cr.status !== "proposed" ||
    cr.statusLog.length !== 1 ||
    cr.statusLog[0]?.status !== "proposed" ||
    cr.requestedBy !== SENTINEL ||
    cr.planRevision !== 3 ||
    cr.impact.entries.length !== 2
  ) {
    fail("cr: proposal shape", JSON.stringify({ status: cr.status, log: cr.statusLog.length, impact: cr.impact.entries.length }))
  } else ok("cr: proposal born with coherent impact")

  // Legal/illegal transitions.
  const approved = transitionChangeRequest(cr, "approved", "Aprobado por PMO")
  if (!approved || approved.status !== "approved" || approved.statusLog.length !== 2 || approved.decidedBy !== SENTINEL) {
    fail("cr: proposed -> approved", JSON.stringify(approved?.statusLog))
  } else ok("cr: proposed -> approved (decidedBy stamped)")
  if (transitionChangeRequest(cr, "applied") !== null) fail("cr: proposed -> applied is illegal", "returned a payload")
  else ok("cr: proposed -> applied is illegal")
  const rejected = transitionChangeRequest(cr, "rejected")
  if (!rejected || transitionChangeRequest(rejected, "approved") !== null) fail("cr: rejected is terminal", "resurrected")
  else ok("cr: rejected is terminal")
  const applied = approved ? transitionChangeRequest(approved, "applied") : null
  if (!applied || applied.statusLog.length !== 3) fail("cr: approved -> applied", JSON.stringify(applied?.statusLog))
  else ok("cr: approved -> applied")
  if (canTransition("proposed", "approved") === false || canTransition("applied", "applied")) {
    fail("cr: canTransition table", "wrong answer")
  } else ok("cr: canTransition table")

  // Envelope discipline mirrors encodeUpdatedPlan: clone + sentinel
  // updatedAt + appended statusLog; input untouched.
  const crEntity: UmeChangeRequestEntity = {
    id: "00000000-0000-4000-8000-000000000002",
    entityName: ENTITY_NAME_CHANGE_REQUEST,
    dynamicProperties: { changeRequest: cr },
    lifecycle: { createdAt: ISO, updatedAt: ISO, deletedAt: null, version: 1 },
    state: { current: "active", statusLog: [] },
    markdownDocumentation: "# cr",
  }
  const appliedPayload = applied ?? cr
  const encoded = encodeChangeRequest(crEntity, appliedPayload)
  if (
    encoded === crEntity ||
    encoded.lifecycle.updatedAt !== SENTINEL ||
    encoded.state.statusLog[0]?.reason !== `change-request: ${appliedPayload.status}` ||
    crEntity.lifecycle.updatedAt !== ISO
  ) {
    fail("cr: encode discipline", JSON.stringify({ updatedAt: encoded.lifecycle.updatedAt, reason: encoded.state.statusLog[0]?.reason }))
  } else ok("cr: encode discipline (sentinel + statusLog + input untouched)")

  // Round-trip: decode the PRE-encode envelope; the payload survives
  // untouched (ops, causes, impact, audit log).
  const preEncode: UmeChangeRequestEntity = { ...crEntity, dynamicProperties: { changeRequest: appliedPayload } }
  const decoded = decodeChangeRequest(preEncode, plan, "plan-1")
  if (!decoded.ok) fail("cr: decode happy path with plan binding", decoded.errors[0]?.message ?? "rejected")
  else if (!deepEqual(decoded.cr, appliedPayload)) fail("cr: round-trip payload", "differs after decode")
  else ok("cr: round-trip preserves payload + plan binding")

  // The ENCODED envelope is for the backend: sentinel updatedAt must be
  // rejected by this same client (same asymmetry as the plan codec).
  if (decodeChangeRequest(encoded).ok) fail("cr: encoded envelope is not re-decodable", "accepted sentinel updatedAt")
  else ok("cr: encoded envelope is not re-decodable")

  const crPayload = (patch: Record<string, unknown>): unknown => ({
    ...crEntity,
    dynamicProperties: { changeRequest: { ...appliedPayload, ...patch } },
  })
  const crRejections: Array<[string, unknown]> = [
    ["wrong entityName", { ...crEntity, entityName: "Other", dynamicProperties: { changeRequest: appliedPayload } }],
    ["schemaVersion 2", crPayload({ schemaVersion: 2 })],
    ["unknown status", crPayload({ status: "paused" })],
    ["empty statusLog", crPayload({ statusLog: [] })],
    ["log head not proposed", crPayload({ status: "approved", statusLog: [{ status: "approved", timestamp: ISO }] })],
    ["illegal transition in log", crPayload({ status: "applied", statusLog: [
      { status: "proposed", timestamp: ISO },
      { status: "applied", timestamp: ISO },
    ] })],
    ["log tail mismatches status", crPayload({ status: "approved" })],
    ["malformed update op", crPayload({ ops: [{ op: "update", id: "a", patch: { start: "nope", end: t(1) } }] })],
    ["addDependency bad type", crPayload({ ops: [{ op: "addDependency", dependency: { id: "x", fromEventId: "a", toEventId: "b", type: "XX" } }] })],
    ["bad cause shape", crPayload({ ops: [{ op: "update", id: "a", patch: { start: t(0), end: t(1) }, cause: { kind: "manual" } }] })],
    ["planRevision missing", crPayload({ planRevision: undefined })],
    ["planRevision 0", crPayload({ planRevision: 0 })],
    ["planRevision non-integer", crPayload({ planRevision: 1.5 })],
    ["costImpact not an object", crPayload({ impact: { entries: [], costImpact: "gratis" } })],
    ["costImpact bad projection", crPayload({ impact: { entries: [], costImpact: { currency: "MXN", projectedExtraCost: "mucho", extendedDays: 0 } } })],
    ["costImpact negative extendedDays", crPayload({ impact: { entries: [], costImpact: { currency: "MXN", projectedExtraCost: 0, extendedDays: -1 } } })],
    ["relation to other plan", {
      ...crEntity,
      relations: [{ targetEntity: "GanttPlan", targetId: "other-plan", type: "one-to-one" }],
      dynamicProperties: { changeRequest: appliedPayload },
    }],
  ]
  for (const [label, input] of crRejections) {
    const d = decodeChangeRequest(input)
    if (d.ok) fail(`reject cr: ${label}`, "decoder accepted it")
    else ok(`reject cr: ${label}`)
  }

  // Revision binding, checked against a supplied plan.
  const driftedPlan: PlanJSON = { ...plan, anchor: t(99) }
  if (decodeChangeRequest(preEncode, driftedPlan).ok) fail("reject cr: anchor mismatch", "accepted a CR bound to another revision")
  else ok("reject cr: anchor mismatch")
  if (decodeChangeRequest(preEncode, plan, "other-plan").ok) fail("reject cr: plan entity mismatch", "accepted")
  else ok("reject cr: plan entity mismatch")
  const ghostOp = crPayload({ ops: [{ op: "update", id: "ghost", patch: { start: t(0), end: t(1) } }], status: "proposed", statusLog: [{ status: "proposed", timestamp: ISO }] })
  if (decodeChangeRequest(ghostOp, plan).ok) fail("reject cr: unknown op target", "accepted")
  else ok("reject cr: unknown op target")
}

// ---- 15. CPM: forward/backward pass, holguras y conjunto crítico -------
{
  const t = (days: number) => Date.parse(ISO) + days * 86_400_000
  const planWith = (
    events: Array<{ id: string; s: number; e: number }>,
    deps: Array<{ id: string; from: string; to: string; type: "FS" | "SS" | "FF" | "SF"; lag?: number }>,
  ): PlanJSON => ({
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: events.map((x) => ({
      id: x.id,
      resourceId: "r",
      start: new Date(x.s).toISOString(),
      end: new Date(x.e).toISOString(),
      progress: 0,
    })),
    dependencies: deps.map((d) => ({
      id: d.id,
      fromEventId: d.from,
      toEventId: d.to,
      type: d.type,
      ...(d.lag !== undefined ? { lagDays: d.lag } : {}),
    })),
  })
  const day = (v: number | undefined) => (v === undefined ? undefined : Math.round((v - Date.parse(ISO)) / 86_400_000))

  // Branch with an FS lag: A(0-2) -> B lag+1 (3-6), A -> C (2-7).
  // C ends last and binds A; B banks one day of float.
  {
    const r = cpmSchedule(planWith(
      [{ id: "a", s: t(0), e: t(2) }, { id: "b", s: t(3), e: t(6) }, { id: "c", s: t(2), e: t(7) }],
      [
        { id: "d1", from: "a", to: "b", type: "FS", lag: 1 },
        { id: "d2", from: "a", to: "c", type: "FS" },
      ],
    ))
    if (r.projectEnd !== t(7)) fail("cpm: branch project end", String(day(r.projectEnd)))
    else if (day(r.es.get("a")) !== 0 || day(r.ef.get("a")) !== 2) fail("cpm: branch a es/ef", JSON.stringify([...r.es]))
    else if (day(r.es.get("b")) !== 3 || day(r.es.get("c")) !== 2) fail("cpm: branch successor es (lag)", JSON.stringify([...r.es]))
    else if (r.floatDays.get("a") !== 0 || r.floatDays.get("b") !== 1 || r.floatDays.get("c") !== 0) {
      fail("cpm: branch floats", JSON.stringify([...r.floatDays]))
    } else if (
      r.critical.size !== 2 || !r.critical.has("a") || !r.critical.has("c") || r.critical.has("b")
    ) {
      fail("cpm: branch critical set", JSON.stringify([...r.critical]))
    } else ok("cpm: FS branch with lag (floats + critical set)")
  }

  // SS + FF semantics: X(0-4), Y SS X (0-3), Z FF X (2-4).
  {
    const r = cpmSchedule(planWith(
      [{ id: "x", s: t(0), e: t(4) }, { id: "y", s: t(0), e: t(3) }, { id: "z", s: t(2), e: t(4) }],
      [
        { id: "d1", from: "x", to: "y", type: "SS" },
        { id: "d2", from: "x", to: "z", type: "FF" },
      ],
    ))
    if (r.projectEnd !== t(4)) fail("cpm: ss/ff project end", String(day(r.projectEnd)))
    else if (day(r.es.get("y")) !== 0 || day(r.es.get("z")) !== 2) fail("cpm: ss/ff forward", JSON.stringify([...r.es]))
    else if (day(r.ls.get("y")) !== 1) fail("cpm: ss backward (y ls)", JSON.stringify([...r.ls]))
    else if (r.floatDays.get("y") !== 1 || r.floatDays.get("x") !== 0 || r.floatDays.get("z") !== 0) {
      fail("cpm: ss/ff floats", JSON.stringify([...r.floatDays]))
    } else if (r.critical.size !== 2 || !r.critical.has("x") || !r.critical.has("z")) {
      fail("cpm: ss/ff critical set", JSON.stringify([...r.critical]))
    } else ok("cpm: SS/FF constraints drive both passes")
  }

  // Diamond: A(0-2) -> B(2-4) and C(2-5) -> D(5-7). C's chain binds.
  {
    const r = cpmSchedule(planWith(
      [{ id: "a", s: t(0), e: t(2) }, { id: "b", s: t(2), e: t(4) }, { id: "c", s: t(2), e: t(5) }, { id: "d", s: t(5), e: t(7) }],
      [
        { id: "d1", from: "a", to: "b", type: "FS" },
        { id: "d2", from: "a", to: "c", type: "FS" },
        { id: "d3", from: "b", to: "d", type: "FS" },
        { id: "d4", from: "c", to: "d", type: "FS" },
      ],
    ))
    if (r.floatDays.get("b") !== 1) fail("cpm: diamond b float", String(r.floatDays.get("b")))
    else if (r.critical.size !== 3 || !r.critical.has("a") || !r.critical.has("c") || !r.critical.has("d") || r.critical.has("b")) {
      fail("cpm: diamond critical set", JSON.stringify([...r.critical]))
    } else ok("cpm: diamond takes the binding branch")
  }

  // Negative lag (lead): A(0-2) -> B FS lag -1 (1-3). Both critical.
  {
    const r = cpmSchedule(planWith(
      [{ id: "a", s: t(0), e: t(2) }, { id: "b", s: t(1), e: t(3) }],
      [{ id: "d", from: "a", to: "b", type: "FS", lag: -1 }],
    ))
    if (day(r.es.get("b")) !== 1) fail("cpm: lead forward", JSON.stringify([...r.es]))
    else if (r.floatDays.get("a") !== 0 || r.floatDays.get("b") !== 0) fail("cpm: lead floats", JSON.stringify([...r.floatDays]))
    else ok("cpm: negative lag (lead) respected")
  }

  // Isolated task: its own critical path.
  {
    const r = cpmSchedule(planWith([{ id: "solo", s: t(10), e: t(13) }], []))
    if (r.projectEnd !== t(13)) fail("cpm: isolated project end", String(day(r.projectEnd)))
    else if (r.floatDays.get("solo") !== 0 || r.critical.size !== 1 || !r.critical.has("solo")) {
      fail("cpm: isolated critical", JSON.stringify([...r.critical]))
    } else ok("cpm: isolated task is its own critical path")
  }

  // Empty plan: structured nothing, not a crash.
  {
    const r = cpmSchedule(planWith([], []))
    if (r.projectEnd !== null || r.critical.size !== 0 || r.es.size !== 0) {
      fail("cpm: empty plan", JSON.stringify({ projectEnd: r.projectEnd, critical: r.critical.size }))
    } else ok("cpm: empty plan yields empty result")
  }

  // As-planned floor: a successor scheduled LATER than its constraint
  // demands cannot bank that gap as float — it still binds the project.
  {
    const r = cpmSchedule(planWith(
      [{ id: "a", s: t(0), e: t(2) }, { id: "b", s: t(4), e: t(6) }],
      [{ id: "d", from: "a", to: "b", type: "FS" }],
    ))
    if (day(r.es.get("b")) !== 4) fail("cpm: as-planned floor es", String(day(r.es.get("b"))))
    else if (r.floatDays.get("b") !== 0 || !r.critical.has("b")) fail("cpm: as-planned floor float", JSON.stringify([...r.floatDays]))
    else ok("cpm: as-planned floor (banked start is not float)")
  }
}

// ---- 16. Entidades contables: GanttBudget / GanttActuals -----------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(4), progress: 50 },
      {
        id: "b",
        resourceId: "r",
        start: t(4),
        end: t(8),
        progress: 0,
        baselines: [{ version: 1, start: t(4), end: t(6), capturedAt: ISO }],
      },
    ],
  }
  const budgetPayload: BudgetPayload = {
    schemaVersion: 1,
    currency: "MXN",
    timePhasing: "uniform",
    bacByEvent: { a: 100_000, b: 40_000 },
  }
  const budgetEntity: UmeBudgetEntity = buildBudgetEntity({
    id: "00000000-0000-4000-8000-000000000002",
    planEntityId: "plan-1",
    planAnchor: ISO,
    budget: budgetPayload,
  })
  const actualsPayload: ActualsPayload = {
    schemaVersion: 1,
    dataDate: t(4),
    planAnchor: ISO,
    acByEvent: { a: 60_000 },
    baselineVersionByEvent: { b: 1 },
  }
  const actualsEntity: UmeActualsEntity = buildActualsEntity({
    id: "00000000-0000-4000-8000-000000000003",
    planEntityId: "plan-1",
    actuals: actualsPayload,
  })

  // Happy paths + round-trip + plan binding.
  const dBudget = decodeBudget(budgetEntity, plan, "plan-1")
  if (!dBudget.ok) fail("budget: happy path", dBudget.errors[0]?.message ?? "rejected")
  else if (!deepEqual(dBudget.budget, budgetPayload)) fail("budget: round-trip", "payload differs")
  else ok("budget: decodes with plan binding (round-trip)")
  const dActuals = decodeActuals(actualsEntity, plan, "plan-1")
  if (!dActuals.ok) fail("actuals: happy path", dActuals.errors[0]?.message ?? "rejected")
  else if (!deepEqual(dActuals.actuals, actualsPayload)) fail("actuals: round-trip", "payload differs")
  else ok("actuals: decodes with plan binding (round-trip)")

  const budgetWith = (patch: Record<string, unknown>): unknown => ({
    ...budgetEntity,
    dynamicProperties: { budget: { ...budgetPayload, ...patch } },
  })
  const actualsWith = (patch: Record<string, unknown>): unknown => ({
    ...actualsEntity,
    dynamicProperties: { actuals: { ...actualsPayload, ...patch } },
  })
  const budgetRejects: Array<[string, unknown]> = [
    ["budget: wrong entityName", { ...budgetEntity, entityName: "Other" }],
    ["budget: negative BAC", budgetWith({ bacByEvent: { a: -1 } })],
    ["budget: non-numeric BAC", budgetWith({ bacByEvent: { a: "mucho" } })],
    ["budget: front-loaded phasing", budgetWith({ timePhasing: "front-loaded" })],
    ["budget: empty currency", budgetWith({ currency: "" })],
    ["budget: schemaVersion 2", budgetWith({ schemaVersion: 2 })],
    ["budget: sentinel updatedAt", { ...budgetEntity, lifecycle: { ...budgetEntity.lifecycle, updatedAt: SENTINEL } }],
  ]
  const actualsRejects: Array<[string, unknown]> = [
    ["actuals: wrong entityName", { ...actualsEntity, entityName: "Other" }],
    ["actuals: non-ISO dataDate", actualsWith({ dataDate: "nope" })],
    ["actuals: sentinel dataDate", actualsWith({ dataDate: SENTINEL })],
    ["actuals: negative AC", actualsWith({ acByEvent: { a: -5 } })],
    ["actuals: baseline version 0", actualsWith({ baselineVersionByEvent: { b: 0 } })],
  ]
  for (const [label, input] of budgetRejects) {
    if (decodeBudget(input).ok) fail(`reject contable: ${label}`, "decoder accepted it")
    else ok(`reject contable: ${label}`)
  }
  for (const [label, input] of actualsRejects) {
    if (decodeActuals(input).ok) fail(`reject contable: ${label}`, "decoder accepted it")
    else ok(`reject contable: ${label}`)
  }

  // Ref checks against the supplied plan.
  if (decodeBudget(budgetWith({ bacByEvent: { ghost: 1 } }), plan).ok) {
    fail("reject contable: budgeted unknown event", "accepted")
  } else ok("reject contable: budgeted unknown event")
  if (decodeActuals(actualsWith({ acByEvent: { ghost: 1 } }), plan).ok) {
    fail("reject contable: AC unknown event", "accepted")
  } else ok("reject contable: AC unknown event")
  if (decodeActuals(actualsWith({ baselineVersionByEvent: { b: 7 } }), plan).ok) {
    fail("reject contable: anchored version not in bitácora", "accepted")
  } else ok("reject contable: anchored version not in bitácora")
  const wrongRelBudget: unknown = {
    ...budgetEntity,
    relations: [{ targetEntity: "GanttPlan", targetId: "other-plan", type: "one-to-one" }],
  }
  if (decodeBudget(wrongRelBudget, plan, "plan-1").ok) {
    fail("reject contable: budget bound to other plan", "accepted")
  } else ok("reject contable: budget bound to other plan")
  const wrongRelActuals: unknown = {
    ...actualsEntity,
    relations: [{ targetEntity: "GanttBudget", targetId: "plan-1", type: "one-to-one" }],
  }
  if (decodeActuals(wrongRelActuals, plan, "plan-1").ok) {
    fail("reject contable: relation to non-plan entity", "accepted")
  } else ok("reject contable: relation to non-plan entity")
}

// ---- 17. EVM: PV/EV/AC y derivadas contra caso calculado a mano ----------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const approx = (got: number, want: number, eps = 1e-9) => Math.abs(got - want) < eps
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(4), progress: 50 },
      {
        id: "b",
        resourceId: "r",
        start: t(4),
        end: t(8),
        progress: 0,
        baselines: [{ version: 1, start: t(4), end: t(6), capturedAt: ISO }],
      },
      { id: "c", resourceId: "r", start: t(1), end: t(2), progress: 30 }, // sin BAC
    ],
  }
  const budget: BudgetPayload = {
    schemaVersion: 1,
    currency: "MXN",
    timePhasing: "uniform",
    bacByEvent: { a: 100_000, b: 40_000 },
  }
  const actuals: ActualsPayload = {
    schemaVersion: 1,
    dataDate: t(4),
    planAnchor: ISO,
    acByEvent: { a: 60_000 },
  }

  // Hand case: PMB 100k, 50% progress, dataDate at plan end, AC 60k
  // → CPI 5/6 ≈ 0.83, EAC 120k, SV −50k, CV −10k, TCPI 1.25, VAC −20k.
  {
    const r = computeEvm(plan, budget, actuals)
    const a = r.byEvent.get("a")!
    if (
      !approx(a.pv, 100_000) || !approx(a.ev, 50_000) || !approx(a.ac, 60_000) ||
      !approx(a.sv, -50_000) || !approx(a.cv, -10_000) ||
      !approx(a.spi ?? 0, 0.5) || !approx(a.cpi ?? 0, 5 / 6, 1e-12) ||
      !approx(a.eac ?? 0, 120_000) || !approx(a.etc ?? 0, 60_000) ||
      !approx(a.tcpi ?? 0, 1.25) || !approx(a.vac ?? 0, -20_000)
    ) {
      fail("evm: hand case", JSON.stringify(a))
    } else ok("evm: hand case (PMB 100k, 50%, AC 60k → CPI 0.83, EAC 120k)")

    // PV over the VIGENTE BASELINE window, not the live dates: b's PMB
    // spans LB1 t(4)..t(6); at dataDate t(4) the fraction is 0.
    const b = r.byEvent.get("b")!
    if (!approx(b.pv, 0)) fail("evm: baseline window PV", String(b.pv))
    else ok("evm: PV phases over the vigente baseline window")

    // Project roll-up: same formulas over the sums (EAC = BAC/CPI).
    const p = r.project
    if (
      !approx(p.bac, 140_000) || !approx(p.pv, 100_000) || !approx(p.ev, 50_000) ||
      !approx(p.ac, 60_000) || !approx(p.eac ?? 0, 168_000)
    ) {
      fail("evm: project roll-up", JSON.stringify(p))
    } else ok("evm: project roll-up (EAC 168k over summed BAC)")

    // Events without BAC participate with zeroed metrics, no crash.
    const c = r.byEvent.get("c")!
    if (c.bac !== 0 || c.ev !== 0 || c.spi !== null || c.eac !== null) {
      fail("evm: event without BAC", JSON.stringify(c))
    } else ok("evm: event without BAC is zeroed, not fatal")
  }

  // CPI 0 (spent, earned nothing): EAC/ETC/VAC null; TCPI still meaningful.
  {
    const zeroPlan: PlanJSON = { ...plan, events: [plan.events[1]!] } // b: progress 0
    const zr = computeEvm(zeroPlan, budget, {
      ...actuals,
      dataDate: t(4),
      acByEvent: { b: 24_000 },
    })
    const z = zr.byEvent.get("b")!
    if (z.cpi !== 0 || z.eac !== null || z.etc !== null || z.vac !== null) {
      fail("evm: CPI 0 edge", JSON.stringify(z))
    } else if (!approx(z.tcpi ?? 0, 2.5)) {
      fail("evm: CPI 0 tcpi", String(z.tcpi))
    } else ok("evm: CPI 0 → EAC/ETC/VAC null, TCPI finite")
  }

  // Data date outside the windows clamps instead of extrapolating.
  {
    const late = computeEvm(plan, budget, { ...actuals, dataDate: t(99) })
    if (!approx(late.byEvent.get("a")!.pv, 100_000)) fail("evm: late PV clamp", String(late.byEvent.get("a")!.pv))
    else ok("evm: dataDate after the window clamps PV to BAC")
    const early = computeEvm(plan, budget, { ...actuals, dataDate: t(-9) })
    const e = early.byEvent.get("a")!
    if (e.pv !== 0 || e.spi !== null) fail("evm: early PV clamp", JSON.stringify(e))
    else ok("evm: dataDate before the window → PV 0, SPI null")
  }

  // Degenerate window (milestone): all-or-nothing.
  if (pvFraction(10, 10, 10) !== 1 || pvFraction(9, 10, 10) !== 0) {
    fail("evm: degenerate window", "milestone fraction wrong")
  } else ok("evm: degenerate (zero-span) window is all-or-nothing")
}

// ---- 18. CR: binding de revisión + costo labor-burn ------------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const approx = (got: number, want: number, eps = 1e-9) => Math.abs(got - want) < eps
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(10), progress: 0 },
      { id: "b", resourceId: "r", start: t(0), end: t(10), progress: 0 },
    ],
  }
  const ops: ChangeOp[] = [
    { op: "update", id: "a", patch: { start: t(0), end: t(13) } }, // +3 d
    { op: "update", id: "b", patch: { start: t(0), end: t(8) } }, // −2 d
  ]
  const budget: BudgetPayload = {
    schemaVersion: 1,
    currency: "MXN",
    timePhasing: "uniform",
    bacByEvent: { a: 100_000, b: 100_000 },
    breakdownByEvent: {
      a: { labor: 60_000, material: 30_000, equipment: 10_000 },
      b: { labor: 50_000, material: 30_000, equipment: 20_000 },
    },
  }

  // Hand case: burns are labor/duration — 60k/10d × 3 = +18k on a,
  // 50k/10d × (−2) = −10k on b → +8k total; extendedDays counts ONLY the
  // positive drift (3).
  {
    const snap = buildImpactSnapshot(plan, ops, budget)
    const ci = snap.costImpact
    if (!ci) fail("cr-cost: attached", "no costImpact with budget+breakdown")
    else if (ci.currency !== "MXN" || !approx(ci.projectedExtraCost, 8_000) || ci.extendedDays !== 3) {
      fail("cr-cost: hand case", JSON.stringify(ci))
    } else ok("cr-cost: labor-burn hand case (+18k −10k → 8k, extended 3d)")

    // Sin budget → sin costImpact: nothing to project against.
    const noBudget = buildImpactSnapshot(plan, ops)
    if ("costImpact" in noBudget) fail("cr-cost: sin budget", "costImpact attached without a budget")
    else ok("cr-cost: sin budget → sin costImpact")

    // Sin desglose → burn 0: the projection exists but nothing extends.
    const bare: BudgetPayload = { ...budget, breakdownByEvent: undefined }
    const bareSnap = buildImpactSnapshot(plan, ops, bare)
    const bareCi = bareSnap.costImpact
    if (!bareCi || !approx(bareCi.projectedExtraCost, 0) || bareCi.extendedDays !== 3) {
      fail("cr-cost: sin desglose", JSON.stringify(bareCi))
    } else ok("cr-cost: sin desglose → burn 0 (extendedDays still counted)")

    // The proposal carries the frozen projection end to end.
    const cr = createChangeRequest({
      planEntityId: "plan-1",
      planAnchor: plan.anchor,
      planRevision: 2,
      basePlan: plan,
      ops,
      budget,
    })
    if (cr.planRevision !== 2 || !approx(cr.impact.costImpact?.projectedExtraCost ?? NaN, 8_000)) {
      fail("cr-cost: createChangeRequest carries it", JSON.stringify(cr.impact.costImpact))
    } else ok("cr-cost: proposal born with the frozen projection")

    // buildChangeRequestEntity: fresh envelope, bound to the plan, and
    // decodable (payload sentinels are legal pre-persist).
    const entity = buildChangeRequestEntity({ payload: cr })
    if (
      entity.id === "" ||
      entity.entityName !== ENTITY_NAME_CHANGE_REQUEST ||
      entity.relations?.[0]?.targetId !== "plan-1" ||
      entity.lifecycle.version !== 1
    ) {
      fail("cr-entity: envelope shape", JSON.stringify({ id: entity.id, rel: entity.relations?.[0] }))
    } else ok("cr-entity: fresh envelope bound to the plan")
    const decodedEntity = decodeChangeRequest(entity, plan, "plan-1")
    if (!decodedEntity.ok) fail("cr-entity: decodes at the border", decodedEntity.errors[0]?.message ?? "rejected")
    else ok("cr-entity: decodes at the border (uuid + relation)")

    // Purity: neither the builder nor the snapshot mutated the inputs.
    const planBefore = JSON.parse(JSON.stringify(plan))
    const crBefore = JSON.parse(JSON.stringify(cr))
    buildChangeRequestEntity({ payload: cr })
    buildImpactSnapshot(plan, ops, budget)
    if (!deepEqual(plan, planBefore)) fail("cr-entity: purity", "plan mutated")
    else if (!deepEqual(cr, crBefore)) fail("cr-entity: purity", "payload mutated")
    else ok("cr-entity: purity (inputs untouched)")
  }
}

// ---- 19. Budget: desglose por evento (partición exacta del BAC) -----------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(4), progress: 0 },
      { id: "b", resourceId: "r", start: t(4), end: t(8), progress: 0 },
    ],
  }
  const base = buildBudgetEntity({
    id: "00000000-0000-4000-8000-000000000002",
    planEntityId: "plan-1",
    planAnchor: ISO,
    budget: {
      schemaVersion: 1,
      currency: "MXN",
      timePhasing: "uniform",
      bacByEvent: { a: 100_000, b: 40_000 },
    },
  })
  const breakdownWith = (breakdownByEvent: unknown): unknown => ({
    ...base,
    dynamicProperties: {
      budget: { ...base.dynamicProperties.budget, breakdownByEvent },
    },
  })

  // Exact partition decodes (and round-trips).
  const happy = breakdownWith({
    a: { labor: 60_000, material: 30_000, equipment: 10_000 },
    b: { labor: 20_000, material: 15_000, equipment: 5_000 },
  })
  const dHappy = decodeBudget(happy, plan, "plan-1")
  if (!dHappy.ok) fail("budget-breakdown: happy path", dHappy.errors[0]?.message ?? "rejected")
  else ok("budget-breakdown: exact partition decodes")

  const breakdownRejections: Array<[string, unknown]> = [
    ["sum mismatch", breakdownWith({ a: { labor: 500, material: 300, equipment: 100 } })],
    ["negative part", breakdownWith({ a: { labor: -1, material: 30_000, equipment: 70_001 } })],
    ["entry not an object", breakdownWith({ a: "reparto" })],
    ["missing part", breakdownWith({ a: { labor: 100_000, material: 0 } })],
    ["no BAC to partition", breakdownWith({ c: { labor: 0, material: 0, equipment: 0 } })],
    ["breakdown not an object", breakdownWith("nope")],
  ]
  for (const [label, input] of breakdownRejections) {
    if (decodeBudget(input).ok) fail(`reject budget-breakdown: ${label}`, "decoder accepted it")
    else ok(`reject budget-breakdown: ${label}`)
  }
  // Ref check against the supplied plan.
  if (decodeBudget(breakdownWith({ ghost: { labor: 0, material: 0, equipment: 0 } }), plan).ok) {
    fail("reject budget-breakdown: unknown event", "accepted")
  } else ok("reject budget-breakdown: unknown event")
}

// ---- 20. GanttWorkforce: entidad hermana de RRHH ---------------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(4), progress: 0 },
      { id: "b", resourceId: "r", start: t(4), end: t(8), progress: 0 },
    ],
  }
  const workforce: WorkforcePayload = {
    schemaVersion: 1,
    crews: [
      { id: "c1", title: "Cuadrilla A", specialty: "Albañilería", headcount: 6, dayRate: 950 },
      { id: "c2", title: "Electricista", specialty: "Eléctrica", headcount: 2, dayRate: 1_100 },
    ],
    assignmentByEvent: {
      a: { crewId: "c1", headcount: 4 },
      b: { crewId: "c2", headcount: 2 },
    },
  }
  const entity: UmeWorkforceEntity = buildWorkforceEntity({
    id: "00000000-0000-4000-8000-000000000004",
    planEntityId: "plan-1",
    planAnchor: ISO,
    workforce,
  })

  const d = decodeWorkforce(entity, plan, "plan-1")
  if (!d.ok) fail("workforce: happy path", d.errors[0]?.message ?? "rejected")
  else if (!deepEqual(d.workforce, workforce)) fail("workforce: round-trip", "payload differs")
  else ok("workforce: decodes with plan binding (round-trip)")

  const workforceWith = (patch: Record<string, unknown>): unknown => ({
    ...entity,
    dynamicProperties: { workforce: { ...workforce, ...patch } },
  })
  const workforceRejects: Array<[string, unknown]> = [
    ["wrong entityName", { ...entity, entityName: "Other" }],
    ["schemaVersion 2", workforceWith({ schemaVersion: 2 })],
    ["duplicate crew id", workforceWith({ crews: [
      { id: "c1", title: "A", specialty: "s", headcount: 3, dayRate: 850 },
      { id: "c1", title: "B", specialty: "s", headcount: 3, dayRate: 850 },
    ] })],
    ["crew headcount 0", workforceWith({ crews: [
      { id: "c1", title: "A", specialty: "s", headcount: 0, dayRate: 850 },
    ] })],
    ["negative dayRate", workforceWith({ crews: [
      { id: "c1", title: "A", specialty: "s", headcount: 3, dayRate: -1 },
    ] })],
    ["assignment to unknown crew", workforceWith({ assignmentByEvent: {
      a: { crewId: "ghost", headcount: 2 },
    } })],
    ["assignment headcount 0", workforceWith({ assignmentByEvent: {
      a: { crewId: "c1", headcount: 0 },
    } })],
    ["assignment not an object", workforceWith({ assignmentByEvent: { a: "todos" } })],
    ["assignmentByEvent not an object", workforceWith({ assignmentByEvent: "nope" })],
    ["crew missing specialty", workforceWith({ crews: [
      { id: "c1", title: "A", headcount: 3, dayRate: 850 },
    ] })],
  ]
  for (const [label, input] of workforceRejects) {
    if (decodeWorkforce(input).ok) fail(`reject workforce: ${label}`, "decoder accepted it")
    else ok(`reject workforce: ${label}`)
  }
  // Ref checks against the supplied plan + relation binding.
  if (decodeWorkforce(workforceWith({ assignmentByEvent: {
    ghost: { crewId: "c1", headcount: 2 },
  } }), plan).ok) {
    fail("reject workforce: unknown event", "accepted")
  } else ok("reject workforce: unknown event")
  const wrongPlanRel: unknown = {
    ...entity,
    relations: [{ targetEntity: "GanttPlan", targetId: "other-plan", type: "one-to-one" }],
  }
  if (decodeWorkforce(wrongPlanRel, plan, "plan-1").ok) fail("reject workforce: bound to other plan", "accepted")
  else ok("reject workforce: bound to other plan")
  const nonPlanRel: unknown = {
    ...entity,
    relations: [{ targetEntity: "GanttBudget", targetId: "plan-1", type: "one-to-one" }],
  }
  if (decodeWorkforce(nonPlanRel).ok) fail("reject workforce: relation to non-plan entity", "accepted")
  else ok("reject workforce: relation to non-plan entity")

  // Purity: the builder leaves the payload alone.
  const before = JSON.parse(JSON.stringify(workforce))
  buildWorkforceEntity({ id: "00000000-0000-4000-8000-000000000004", planEntityId: "plan-1", planAnchor: ISO, workforce })
  if (!deepEqual(workforce, before)) fail("workforce: builder purity", "payload mutated")
  else ok("workforce: builder purity")
}

// ---- 21. Demo builders: hermanas sintéticas pasan su propio contrato ------
{
  // Budget: every breakdown partitions its BAC EXACTLY (integers, no
  // negative equipment remainder) and the document decodes against PLAN.
  const budget = buildDemoBudget(PLAN)
  const dBudget = decodeBudget(budget, PLAN, DEMO_PLAN_ID)
  if (!dBudget.ok) {
    fail("demo: budget decodes against PLAN", dBudget.errors[0]?.message ?? "rejected")
  } else {
    let sumsOk = true
    let breakdownCount = 0
    for (const [eventId, bac] of Object.entries(dBudget.budget.bacByEvent)) {
      const b = dBudget.budget.breakdownByEvent?.[eventId]
      if (!b) continue
      breakdownCount++
      if (
        !Number.isInteger(b.labor) || !Number.isInteger(b.material) || !Number.isInteger(b.equipment) ||
        b.labor < 0 || b.material < 0 || b.equipment < 0 ||
        b.labor + b.material + b.equipment !== bac
      ) {
        sumsOk = false
        fail("demo: breakdown partitions BAC", JSON.stringify({ eventId, bac, b }))
        break
      }
    }
    if (sumsOk && breakdownCount === Object.keys(dBudget.budget.bacByEvent).length) {
      ok(`demo: breakdown partitions every BAC exactly (${breakdownCount} events)`)
    }
  }

  // Workforce: crews derived from the plan's own responsables, every
  // event assigned, decodes against PLAN, and PLAN itself untouched.
  const planBefore = JSON.parse(JSON.stringify(PLAN))
  const workforceEntity = buildDemoWorkforce(PLAN)
  const dWorkforce = decodeWorkforce(workforceEntity, PLAN, DEMO_PLAN_ID)
  if (!dWorkforce.ok) {
    fail("demo: workforce decodes against PLAN", dWorkforce.errors[0]?.message ?? "rejected")
  } else if (Object.keys(dWorkforce.workforce.assignmentByEvent).length !== PLAN.events.length) {
    fail("demo: workforce assigns every event", `${Object.keys(dWorkforce.workforce.assignmentByEvent).length}/${PLAN.events.length}`)
  } else if (new Set(dWorkforce.workforce.crews.map((c) => c.id)).size !== dWorkforce.workforce.crews.length) {
    fail("demo: crew ids unique", "duplicates found")
  } else if (!deepEqual(PLAN, planBefore)) {
    fail("demo: workforce builder purity", "PLAN mutated")
  } else {
    ok(`demo: workforce (${dWorkforce.workforce.crews.length} crews, all events assigned, PLAN untouched)`)
  }
}

// ---- 22. Hitos: kind milestone + toggle canónico + cascada + CPM + demo --
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()

  // (a) Decoder: `kind: "milestone"` pasa, `kind: "x"` se rechaza.
  const msPlan: PlanJSON = {
    ...fixturePlan,
    events: [
      ...fixturePlan.events,
      { id: "m1", resourceId: "child", start: ISO, end: ISO, progress: 0, kind: "milestone" },
    ],
  }
  const withMs: unknown = { ...fixtureEntity, dynamicProperties: { plan: msPlan } }
  if (!decodeUmePlan(withMs).ok) fail("milestone: decode accepts kind", "rejected")
  else ok("milestone: decode accepts kind")
  const badKind: unknown = {
    ...fixtureEntity,
    dynamicProperties: {
      plan: {
        ...msPlan,
        events: [
          ...msPlan.events.slice(0, -1),
          { id: "m1", resourceId: "child", start: ISO, end: ISO, progress: 0, kind: "hito" },
        ],
      },
    },
  }
  if (decodeUmePlan(badKind).ok) fail("milestone: decode rejects bad kind", "accepted")
  else ok("milestone: decode rejects bad kind")

  // (b) Toggle ida y vuelta: el campo `kind` DESAPARECE al volver a tarea
  // (forma canónica) y un evento que nunca fue hito round-tripea igual.
  const taskEvent: PlanJSON["events"][number] = {
    id: "tk", resourceId: "child", start: t(0), end: t(5), progress: 0,
  }
  const taskPlan: PlanJSON = { ...fixturePlan, events: [taskEvent] }
  const asMs = applyOps(taskPlan, [
    { op: "update", id: "tk", patch: { start: t(5), end: t(5), kind: "milestone" } },
  ])
  const msEv = asMs.events[0]
  if (msEv?.kind !== "milestone" || msEv.start !== t(5) || msEv.end !== t(5)) {
    fail("milestone: conversion collapses onto the end", JSON.stringify(msEv))
  } else ok("milestone: conversion collapses onto the end")
  const back = applyOps(asMs, [
    { op: "update", id: "tk", patch: { start: t(0), end: t(5), kind: "task" } },
  ])
  const backEv = back.events[0]
  if (!backEv || "kind" in backEv || !deepEqual(backEv, taskEvent)) {
    fail("milestone: toggle back is byte-identical", JSON.stringify(backEv))
  } else ok("milestone: toggle back drops the kind field (byte-identical)")
  const datesOnly = applyOps(taskPlan, [
    { op: "update", id: "tk", patch: { start: t(1), end: t(6) } },
  ])
  if ("kind" in (datesOnly.events[0] ?? {})) {
    fail("milestone: dates-only op synthesizes kind", "kind appeared")
  } else ok("milestone: dates-only op never synthesizes kind")

  // (c) Cascada FS desde un hito: el sucesor arranca en el instante.
  const cascadePlan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "m", resourceId: "r", start: t(5), end: t(5), progress: 0, kind: "milestone" },
      { id: "b", resourceId: "r", start: t(3), end: t(6), progress: 0 },
    ],
    dependencies: [{ id: "d", fromEventId: "m", toEventId: "b", type: "FS" }],
  }
  const msAdj = cascadeSchedule(cascadePlan, ["m"])[0]
  if (!msAdj || msAdj.eventId !== "b" || msAdj.start !== t(5) || msAdj.end !== t(8)) {
    fail("milestone: FS cascade pushes to the instant", JSON.stringify(msAdj))
  } else ok("milestone: FS cascade pushes to the instant")

  // (d) CPM con hito de duración 0: no truena y el hito une la ruta.
  {
    const r = cpmSchedule(cascadePlan)
    const day = (v: number | undefined) =>
      v === undefined ? undefined : Math.round((v - Date.parse(ISO)) / 86_400_000)
    if (
      r.projectEnd === null ||
      day(r.es.get("b")) !== 5 ||
      !r.critical.has("m") ||
      !r.critical.has("b")
    ) {
      fail("milestone: cpm survives duration 0", JSON.stringify({ projectEnd: r.projectEnd, critical: [...r.critical] }))
    } else ok("milestone: cpm treats the instant as float-0 chain link")
  }

  // (e) Plan demo con el hito sembrado: decode del envelope + budget con
  // BAC 0 y partición 0/0/0 exacta sobre el evento hito.
  {
    const entity = buildDemoEntity()
    const dPlan = decodeUmePlan(entity)
    if (!dPlan.ok) {
      fail("milestone: demo plan decodes", dPlan.errors[0]?.message ?? "rejected")
    } else {
      const acta = dPlan.plan.events.find((e) => e.id === "acta-entrega")
      if (acta?.kind !== "milestone" || acta.start !== acta.end) {
        fail("milestone: demo seeds acta-entrega", JSON.stringify({ kind: acta?.kind, start: acta?.start, end: acta?.end }))
      } else ok("milestone: demo seeds acta-entrega as duration-0 milestone")
      const budget = buildDemoBudget(dPlan.plan)
      const dBudget = decodeBudget(budget, dPlan.plan, DEMO_PLAN_ID)
      const b = dBudget.ok ? dBudget.budget : null
      if (!b) {
        fail("milestone: demo budget decodes", dBudget.ok ? "" : "rejected")
      } else if ((b.bacByEvent["acta-entrega"] ?? -1) !== 0) {
        fail("milestone: demo budget BAC 0", String(b.bacByEvent["acta-entrega"]))
      } else {
        const part = b.breakdownByEvent["acta-entrega"]
        if (part && (part.labor !== 0 || part.material !== 0 || part.equipment !== 0)) {
          fail("milestone: demo breakdown 0/0/0", JSON.stringify(part))
        } else ok("milestone: demo budget BAC 0 with exact 0/0/0 partition")
      }
    }
  }
}

// ---- 23. updateDependency: op de forma + matemática del editor ------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(1), end: t(3), progress: 0 },
      { id: "c", resourceId: "r", start: t(2), end: t(4), progress: 0 },
    ],
    dependencies: [
      { id: "d1", fromEventId: "a", toEventId: "b", type: "FS" },
      { id: "d2", fromEventId: "b", toEventId: "c", type: "FS" },
    ],
  }

  // Replaces the shape (type + lag) by id; sibling edges untouched.
  const reshaped = applyOps(plan, [
    { op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "SS", lagDays: -3 } },
  ])
  const d1 = reshaped.dependencies?.find((d) => d.id === "d1")
  const d2 = reshaped.dependencies?.find((d) => d.id === "d2")
  if (
    !d1 || d1.type !== "SS" || d1.lagDays !== -3 ||
    !d2 || d2.type !== "FS" || d2.lagDays !== undefined
  ) {
    fail("upd-dep: replaces shape by id", JSON.stringify(reshaped.dependencies))
  } else ok("upd-dep: replaces shape by id")

  // Unknown id: silent no-op, graph intact (same criterion as update on
  // a ghost event).
  const ghost = applyOps(plan, [
    { op: "updateDependency", dependency: { id: "nope", fromEventId: "a", toEventId: "b", type: "SS" } },
  ])
  if (!deepEqual(ghost, plan)) fail("upd-dep: unknown id is a no-op", "graph changed")
  else ok("upd-dep: unknown id is a no-op")

  // add + update sequence: the update lands on the added edge.
  const seq = applyOps(plan, [
    { op: "addDependency", dependency: { id: "d3", fromEventId: "a", toEventId: "c", type: "FS" } },
    { op: "updateDependency", dependency: { id: "d3", fromEventId: "a", toEventId: "c", type: "FS", lagDays: 4 } },
  ])
  const d3 = seq.dependencies?.find((d) => d.id === "d3")
  if (!d3 || d3.lagDays !== 4 || seq.dependencies?.length !== 3) {
    fail("upd-dep: add then update", JSON.stringify(seq.dependencies))
  } else ok("upd-dep: add then update lands on the added edge")

  // Editor math: FS lag −3 with the successor exactly at the bound.
  // Tightening to lag 0 pushes +3 (documented cause); relaxing back to
  // −3 moves nothing (forward-only).
  const lagPlan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(-1), end: t(1), progress: 0 },
    ],
    dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FS", lagDays: -3 }],
  }
  const tightened = applyOps(lagPlan, [
    { op: "updateDependency", dependency: { id: "d", fromEventId: "a", toEventId: "b", type: "FS" } },
  ])
  const push = cascadeSchedule(tightened, ["b"])
  const pushAdj = push[0]
  if (
    push.length !== 1 ||
    pushAdj?.eventId !== "b" ||
    pushAdj.start !== t(2) ||
    pushAdj.end !== t(4) ||
    pushAdj.cause.sourceEventId !== "a" ||
    pushAdj.cause.shiftDays !== 3
  ) {
    fail("upd-dep: tightening pushes forward", JSON.stringify(push))
  } else ok("upd-dep: tightening to lag 0 pushes +3 with cause")
  const movedPlan: PlanJSON = {
    ...tightened,
    events: tightened.events.map((e) =>
      e.id === "b" ? { ...e, start: t(2), end: t(4) } : e,
    ),
  }
  const relaxed = applyOps(movedPlan, [
    { op: "updateDependency", dependency: { id: "d", fromEventId: "a", toEventId: "b", type: "FS", lagDays: -3 } },
  ])
  if (cascadeSchedule(relaxed, ["b"]).length !== 0) {
    fail("upd-dep: relaxing never pulls back", "cascade moved the successor")
  } else ok("upd-dep: relaxing never pulls back (forward-only)")

  // CR contract: a valid op decodes with plan binding.
  const cr = createChangeRequest({
    planEntityId: "plan-1",
    planAnchor: plan.anchor,
    planRevision: 1,
    basePlan: plan,
    ops: [{ op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "FS", lagDays: -2 } }],
  })
  const crEntity = buildChangeRequestEntity({ payload: cr })
  if (!decodeChangeRequest(crEntity, plan, "plan-1").ok) fail("upd-dep: cr decode happy path", "rejected")
  else ok("upd-dep: cr decodes the op with plan binding")

  const crPayload = (patch: Record<string, unknown>): unknown => ({
    ...crEntity,
    dynamicProperties: { changeRequest: { ...cr, ...patch } },
  })
  const crRejects: Array<[string, unknown]> = [
    ["bad type in op", crPayload({ ops: [{ op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "XX" } }] })],
    ["non-integer lag in op", crPayload({ ops: [{ op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "FS", lagDays: 1.5 } }] })],
    ["unknown dependency id", crPayload({ ops: [{ op: "updateDependency", dependency: { id: "ghost", fromEventId: "a", toEventId: "b", type: "FS" } }] })],
    ["ghost endpoint", crPayload({ ops: [{ op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "ghost", type: "FS" } }] })],
  ]
  for (const [label, input] of crRejects) {
    const d = decodeChangeRequest(input, plan)
    if (d.ok) fail(`reject upd-dep cr: ${label}`, "decoder accepted it")
    else ok(`reject upd-dep cr: ${label}`)
  }

  // Impact snapshot: the op seeds the successor (entry present).
  const snap = buildImpactSnapshot(plan, [
    { op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "FS", lagDays: 5 } },
  ])
  if (!snap.entries.some((e) => e.eventId === "b")) {
    fail("upd-dep: impact seeds toEventId", JSON.stringify(snap.entries))
  } else ok("upd-dep: impact snapshot seeds toEventId")
}

// ---- 24. snapToDependency: reasiento al borde de la restricción ------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const day = (iso: string) => Math.round((Date.parse(iso) - Date.parse(ISO)) / 86_400_000)
  const planWith = (
    events: Array<{ id: string; s: number; e: number; kind?: "milestone" }>,
    deps: Array<{ id: string; from: string; to: string; type: "FS" | "SS" | "FF" | "SF"; lag?: number }>,
  ): PlanJSON => ({
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: events.map((x) => ({
      id: x.id,
      resourceId: "r",
      start: t(x.s),
      end: t(x.e),
      progress: 0,
      ...(x.kind === "milestone" ? { kind: "milestone" } : {}),
    })),
    dependencies: deps.map((d) => ({
      id: d.id,
      fromEventId: d.from,
      toEventId: d.to,
      type: d.type,
      ...(d.lag !== undefined ? { lagDays: d.lag } : {}),
    })),
  })
  const snapOf = (
    plan: PlanJSON,
    depId: string,
  ) => {
    const dep = (plan.dependencies ?? []).find((d) => d.id === depId)!
    return snapToDependency(plan, dep)
  }

  // FS: the successor STARTS at pred.end (+lag), duration preserved.
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 4, e: 6 }],
      [{ id: "d", from: "a", to: "b", type: "FS" }],
    )
    const snap = snapOf(plan, "d")
    if (!snap || snap.eventId !== "b" || day(snap.start) !== 2 || day(snap.end) !== 4) {
      fail("snap: FS seats at pred end", JSON.stringify(snap))
    } else if (snap.cause.shiftDays !== -2) {
      fail("snap: FS signed shift", String(snap.cause.shiftDays))
    } else ok("snap: FS seats start at pred end (signed shift)")
  }

  // SS: starts aligned; FF: ends aligned; SF: end at pred start.
  {
    const ss = snapOf(planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 4, e: 6 }],
      [{ id: "d", from: "a", to: "b", type: "SS" }],
    ), "d")
    if (!ss || day(ss.start) !== 0 || day(ss.end) !== 2) fail("snap: SS aligns starts", JSON.stringify(ss))
    else ok("snap: SS aligns starts")
    const ff = snapOf(planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 4, e: 6 }],
      [{ id: "d", from: "a", to: "b", type: "FF" }],
    ), "d")
    if (!ff || day(ff.start) !== 0 || day(ff.end) !== 2) fail("snap: FF aligns ends", JSON.stringify(ff))
    else ok("snap: FF aligns ends (duration preserved)")
    const sf = snapOf(planWith(
      [{ id: "a", s: 3, e: 5 }, { id: "b", s: 6, e: 8 }],
      [{ id: "d", from: "a", to: "b", type: "SF" }],
    ), "d")
    if (!sf || day(sf.start) !== 1 || day(sf.end) !== 3) fail("snap: SF end at pred start", JSON.stringify(sf))
    else ok("snap: SF seats end at pred start")
  }

  // Lag applies to the bound in every direction.
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 4, e: 6 }],
      [{ id: "d", from: "a", to: "b", type: "FS", lag: -5 }],
    )
    const snap = snapOf(plan, "d")
    if (!snap || day(snap.start) !== -3 || day(snap.end) !== -1) {
      fail("snap: negative lag", JSON.stringify(snap))
    } else ok("snap: negative lag seats back from the bound")
  }

  // Already at the bound → null (no noise op).
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 2, e: 4 }],
      [{ id: "d", from: "a", to: "b", type: "FS" }],
    )
    if (snapOf(plan, "d") !== null) fail("snap: at bound yields null", "returned an adjustment")
    else ok("snap: bar already at the bound yields null")
  }

  // Missing endpoint → null (defensive).
  {
    const plan = planWith([{ id: "a", s: 0, e: 2 }], [
      { id: "d", from: "a", to: "ghost", type: "FS" },
    ])
    if (snapOf(plan, "d") !== null) fail("snap: ghost endpoint yields null", "returned an adjustment")
    else ok("snap: missing endpoint yields null")
  }

  // Milestone successor: duration 0 seats the instant at the bound.
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "m", s: 5, e: 5, kind: "milestone" }],
      [{ id: "d", from: "a", to: "m", type: "FS" }],
    )
    const snap = snapOf(plan, "d")
    if (!snap || day(snap.start) !== 2 || day(snap.end) !== 2) {
      fail("snap: milestone seats the instant", JSON.stringify(snap))
    } else ok("snap: milestone seats the instant at the bound")
  }

  // Recorder flow, reproduced purely: seat FIRST (folded as an update op),
  // then the forward cascade over the seated plan pushes transitive
  // dependents. Tightening: SS → FS lag +1 moves b to (3-5), c to (5-7).
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 0, e: 2 }, { id: "c", s: 2, e: 4 }],
      [
        { id: "d1", from: "a", to: "b", type: "SS" },
        { id: "d2", from: "b", to: "c", type: "FS" },
      ],
    )
    const reshaped = applyOps(plan, [
      { op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "FS", lagDays: 1 } },
    ])
    const snap = snapToDependency(reshaped, reshaped.dependencies!.find((d) => d.id === "d1")!)
    if (!snap || day(snap.start) !== 3 || day(snap.end) !== 5) {
      fail("snap: recorder flow seats b", JSON.stringify(snap))
    } else {
      const seated = applyOps(reshaped, [
        { op: "update", id: "b", patch: { start: snap.start, end: snap.end } },
      ])
      const casc = cascadeSchedule(seated, ["b"])
      const cAdj = casc.find((a) => a.eventId === "c")
      if (!cAdj || day(cAdj.start) !== 5 || day(cAdj.end) !== 7) {
        fail("snap: recorder flow cascades c", JSON.stringify(casc))
      } else ok("snap: seat + forward cascade (tightening propagates)")
    }
  }

  // Relaxing seats the bar BACK and the cascade moves nothing downstream
  // (forward-only is the cascade's rule; the SNAP is the bidirectional one).
  {
    const plan = planWith(
      [{ id: "a", s: 0, e: 2 }, { id: "b", s: 2, e: 4 }, { id: "c", s: 4, e: 6 }],
      [
        { id: "d1", from: "a", to: "b", type: "FS" },
        { id: "d2", from: "b", to: "c", type: "FS" },
      ],
    )
    const reshaped = applyOps(plan, [
      { op: "updateDependency", dependency: { id: "d1", fromEventId: "a", toEventId: "b", type: "SS" } },
    ])
    const snap = snapToDependency(reshaped, reshaped.dependencies!.find((d) => d.id === "d1")!)
    if (!snap || day(snap.start) !== 0 || day(snap.end) !== 2) {
      fail("snap: relaxing seats back", JSON.stringify(snap))
    } else {
      const seated = applyOps(reshaped, [
        { op: "update", id: "b", patch: { start: snap.start, end: snap.end } },
      ])
      if (cascadeSchedule(seated, ["b"]).length !== 0) {
        fail("snap: relaxing cascades nothing", "dependents moved")
      } else ok("snap: relaxing seats back, cascade stays forward-only")
    }
  }
}

// ---- 25. impliedLagDays: lectura del lag desde fechas vivas ---------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const pred = { start: t(0), end: t(2) }

  // FS reads succ.start - pred.end; SS start-to-start.
  if (impliedLagDays({ type: "FS" }, pred, { start: t(-1), end: t(3) }) !== -3) {
    fail("implied-lag: FS", String(impliedLagDays({ type: "FS" }, pred, { start: t(-1), end: t(3) })))
  } else ok("implied-lag: FS reads succ.start − pred.end")
  if (impliedLagDays({ type: "SS" }, pred, { start: t(5), end: t(9) }) !== 5) {
    fail("implied-lag: SS", "wrong value")
  } else ok("implied-lag: SS reads succ.start − pred.start")

  // FF reads end-to-end; SF reads succ.end - pred.start.
  if (impliedLagDays({ type: "FF" }, pred, { start: t(4), end: t(6) }) !== 4) {
    fail("implied-lag: FF", "wrong value")
  } else ok("implied-lag: FF reads succ.end − pred.end")
  if (impliedLagDays({ type: "SF" }, pred, { start: t(7), end: t(1) }) !== 1) {
    fail("implied-lag: SF", "wrong value")
  } else ok("implied-lag: SF reads succ.end − pred.start")

  // Same rounding as the cascade/snap (half-days round away from zero).
  if (impliedLagDays({ type: "FS" }, pred, { start: t(4.5), end: t(6) }) !== 3) {
    fail("implied-lag: rounding", "half-day did not round")
  } else ok("implied-lag: half-day rounds like the cascade")

  // Date objects (the engine's live events) are accepted directly.
  if (impliedLagDays({ type: "FS" }, { start: new Date(Date.parse(ISO)), end: new Date(t(2)) }, { start: new Date(t(2)), end: new Date(t(5)) }) !== 0) {
    fail("implied-lag: Date objects", "wrong value")
  } else ok("implied-lag: accepts live Date objects (bar at bound → 0)")

  // Round-trip with the snap: implied(snap(x)) === x for every type.
  for (const type of ["FS", "SS", "FF", "SF"] as const) {
    const plan: PlanJSON = {
      schemaVersion: 2,
      anchor: ISO,
      phases: [],
      resources: [{ id: "r", title: "R" }],
      events: [
        { id: "a", resourceId: "r", start: t(0), end: t(3), progress: 0 },
        { id: "b", resourceId: "r", start: t(10), end: t(14), progress: 0 },
      ],
      dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type, lagDays: -2 }],
    }
    const dep = plan.dependencies![0]!
    const snap = snapToDependency(plan, dep)
    if (!snap) {
      fail(`implied-lag: round-trip ${type}`, "snap produced nothing")
      continue
    }
    const seated: PlanJSON = {
      ...plan,
      events: plan.events.map((e) =>
        e.id === "b" ? { ...e, start: snap.start, end: snap.end } : e,
      ),
    }
    const implied = impliedLagDays(
      dep,
      { start: seated.events[0]!.start, end: seated.events[0]!.end },
      { start: seated.events[1]!.start, end: seated.events[1]!.end },
    )
    if (implied !== -2) fail(`implied-lag: round-trip ${type}`, String(implied))
    else ok(`implied-lag: implied(snap(lag)) === lag (${type})`)
  }
}

// ---- 26. Working-time: helpers de día laborable ----------------------------
{
  const t = (days: number) => Date.parse(ISO) + days * 86_400_000
  // ISO (2026-01-12) cae LUNES: t(0)=lun, t(4)=vie, t(5)=sáb, t(7)=lun.
  const monFri = { id: "c1", title: "Lun–Vie", workWeek: [false, true, true, true, true, true, false] as const, exceptions: {} }
  const cal = { ...monFri, workWeek: [...monFri.workWeek], exceptions: { ...monFri.exceptions } }

  // null = corrido EXACTO: byte-igual a la aritmética que reemplaza.
  if (addWorkingDays(null, t(0), 3) !== t(3)) fail("wt: addWorkingDays null corrido", "differs")
  else ok("wt: addWorkingDays(null) is exact corrido arithmetic")
  if (workingDaysBetween(null, t(0), t(2.4)) !== Math.round((t(2.4) - t(0)) / 86_400_000)) {
    fail("wt: between null rounding", String(workingDaysBetween(null, t(0), t(2.4))))
  } else ok("wt: workingDaysBetween(null) matches driftDays rounding")

  // Firmado sobre fines de semana: +1 desde viernes aterriza lunes.
  if (addWorkingDays(cal, t(4), 1) !== t(7)) fail("wt: fri+1 → lun", String(addWorkingDays(cal, t(4), 1)))
  else ok("wt: addWorkingDays skips the weekend (fri +1 → mon)")
  if (addWorkingDays(cal, t(0), -1) !== t(-3)) fail("wt: mon-1 → vie", String(addWorkingDays(cal, t(0), -1)))
  else ok("wt: addWorkingDays backward lands on the prior friday")
  // n=0 convención de asiento: sábado se sienta en lunes; lunes queda igual.
  if (addWorkingDays(cal, t(5), 0) !== t(7)) fail("wt: seat sat→mon", String(addWorkingDays(cal, t(5), 0)))
  else ok("wt: addWorkingDays n=0 seats an off day onto the next working day")
  if (addWorkingDays(cal, t(0), 0) !== t(0)) fail("wt: seat working day unchanged", "moved")
  else ok("wt: addWorkingDays n=0 keeps a working instant")
  // Excepciones: feriado miércoles empuja +1 al jueves; sábado trabajado cuenta.
  const hol = { ...cal, exceptions: { [new Date(t(1)).toISOString().slice(0, 10)]: false, [new Date(t(5)).toISOString().slice(0, 10)]: true } }
  if (addWorkingDays(hol, t(0), 1) !== t(2)) fail("wt: feriado skipped", String(addWorkingDays(hol, t(0), 1)))
  else ok("wt: exception feriado is skipped by the step")
  if (addWorkingDays(hol, t(4), 1) !== t(5)) fail("wt: worked saturday counts", String(addWorkingDays(hol, t(4), 1)))
  else ok("wt: worked-saturday exception counts as a working day")
  if (!isWorkingDay(cal, t(1)) || isWorkingDay(cal, t(5))) fail("wt: isWorkingDay weekly pattern", "wrong")
  else ok("wt: isWorkingDay follows the weekly pattern")

  // Conteo firmado: jue→vie+lun = 2 laborables (corrido serían 4).
  if (workingDaysBetween(cal, t(3), t(7)) !== 2 || workingDaysBetween(cal, t(7), t(3)) !== -2) {
    fail("wt: between signed weekend bridge", `${workingDaysBetween(cal, t(3), t(7))}/${workingDaysBetween(cal, t(7), t(3))}`)
  } else ok("wt: workingDaysBetween counts the thu→mon bridge as 2, signed")
}

// ---- 27. Kernels con calendario: cascada, snap/implied, CPM, drift ---------
{
  const t = (days: number) => Date.parse(ISO) + days * 86_400_000
  const dayIso = (days: number) => new Date(t(days)).toISOString()
  // Lun–Vie puro (el ancla cae lunes).
  const cal = {
    id: "c1",
    title: "Lun–Vie",
    workWeek: [false, true, true, true, true, true, false] as boolean[],
    exceptions: {} as Record<string, boolean>,
  }
  // El mismo con UN feriado: el miércoles de la semana del ancla (puente).
  const calBridge = {
    ...cal,
    exceptions: { [dayIso(2).slice(0, 10)]: false } as Record<string, boolean>,
  }
  const resolve = (_eventId: string) => cal
  const resolveBridge = (_eventId: string) => calBridge
  const planOf = (events: Array<{ id: string; s: number; e: number }>, lag?: number): PlanJSON => ({
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: events.map((x) => ({ id: x.id, resourceId: "r", start: dayIso(x.s), end: dayIso(x.e), progress: 0 })),
    dependencies: [
      { id: "d1", fromEventId: "a", toEventId: "b", type: "FS", ...(lag !== undefined ? { lagDays: lag } : {}) },
    ],
  })

  // Cascada sobre un puente festivo: A termina martes; B sentado temprano
  // es empujado AL JUEVES (el feriado no cuenta como asiento ni como día).
  {
    const adj = cascadeSchedule(planOf([{ id: "a", s: 0, e: 2 }, { id: "b", s: 0, e: 2 }]), ["a"], resolveBridge)[0]
    if (!adj || adj.eventId !== "b" || adj.start !== dayIso(3) || adj.end !== dayIso(5)) {
      fail("wt-cascade: seats past the holiday", JSON.stringify(adj))
    } else if (adj.cause.shiftDays !== 2) {
      fail("wt-cascade: shift in WORKING days", String(adj.cause.shiftDays))
    } else ok("wt-cascade: FS over a holiday seats on the next working day (+2 laborables)")
    // Mismo plan SIN resolver: corrido byte-idéntico (mar t2, fin t4, +2 d).
    const plain = cascadeSchedule(planOf([{ id: "a", s: 0, e: 2 }, { id: "b", s: 0, e: 2 }]), ["a"])[0]
    if (!plain || plain.start !== dayIso(2) || plain.end !== dayIso(4) || plain.cause.shiftDays !== 2) {
      fail("wt-cascade: null mode unchanged", JSON.stringify(plain))
    } else ok("wt-cascade: null resolver reproduces the corrido cascade exactly")
  }

  // snap/implied round-trip en laborables: FS lag +2 desde un fin de
  // semana cruza al lunes siguiente y la lectura devuelve 2.
  for (const type of ["FS", "SS", "FF", "SF"] as const) {
    const plan: PlanJSON = {
      schemaVersion: 2,
      anchor: ISO,
      phases: [],
      resources: [{ id: "r", title: "R" }],
      events: [
        { id: "a", resourceId: "r", start: dayIso(0), end: dayIso(2), progress: 0 },
        { id: "b", resourceId: "r", start: dayIso(10), end: dayIso(14), progress: 0 },
      ],
      dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type, lagDays: -2 }],
    }
    const dep = plan.dependencies![0]!
    const snap = snapToDependency(plan, dep, resolve)
    if (!snap) {
      fail(`wt-snap: round-trip ${type}`, "snap produced nothing")
      continue
    }
    const seated: PlanJSON = {
      ...plan,
      events: plan.events.map((e) =>
        e.id === "b" ? { ...e, start: snap.start, end: snap.end } : e,
      ),
    }
    const implied = impliedLagDays(
      dep,
      { start: seated.events[0]!.start, end: seated.events[0]!.end },
      { start: seated.events[1]!.start, end: seated.events[1]!.end },
      resolve(seated.events[1]!.id),
    )
    if (implied !== -2) fail(`wt-snap: implied(snap(lag)) === lag (${type})`, String(implied))
    else ok(`wt-snap: working-time round-trip (${type})`)
  }
  // Y sin calendario el snap es corrido histórico: FS lag −2 desde un fin
  // en martes aterriza domingo por la noche (t0), feriados invisibles.
  {
    const plan: PlanJSON = {
      schemaVersion: 2,
      anchor: ISO,
      phases: [],
      resources: [{ id: "r", title: "R" }],
      events: [
        { id: "a", resourceId: "r", start: dayIso(0), end: dayIso(2), progress: 0 },
        { id: "b", resourceId: "r", start: dayIso(10), end: dayIso(14), progress: 0 },
      ],
      dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FS", lagDays: -2 }],
    }
    const plain = snapToDependency(plan, plan.dependencies![0]!)
    if (!plain || plain.start !== dayIso(0)) fail("wt-snap: null mode corrido", JSON.stringify(plain))
    else ok("wt-snap: null resolver keeps the corrido seat exactly")
  }

  // CPM con calendario: el lag del vínculo corre en laborables del
  // sucesor, así A solo banca UN laborable (martes) antes de correr a B;
  // corrido la misma cadena lee 3.
  {
    const r = cpmSchedule(planOf([{ id: "a", s: 0, e: 2 }, { id: "b", s: 7, e: 10 }], 2), resolve)
    if (r.floatDays.get("a") !== 1 || r.floatDays.get("b") !== 0 || !r.critical.has("b")) {
      fail("wt-cpm: float in working days", JSON.stringify([...r.floatDays]))
    } else ok("wt-cpm: float reads in WORKING days of the event's own calendar")
    const plainR = cpmSchedule(planOf([{ id: "a", s: 0, e: 2 }, { id: "b", s: 7, e: 10 }], 2))
    if (plainR.floatDays.get("a") !== 3) {
      fail("wt-cpm: null mode corrido float", JSON.stringify([...plainR.floatDays]))
    } else ok("wt-cpm: without calendar the same chain reads corrido (3)")
  }

  // driftDays laborable: jue→lun son 2 laborables (4 corridos).
  if (driftDays(dayIso(7), dayIso(3), cal) !== 2 || driftDays(dayIso(7), dayIso(3)) !== 4) {
    fail("wt-drift: working driftDays", `${driftDays(dayIso(7), dayIso(3), cal)}/${driftDays(dayIso(7), dayIso(3))}`)
  } else ok("wt-drift: driftDays counts 2 laborables over a weekend, 4 corridos without calendar")

  // Impact snapshot congelado en laborables: b referencia viernes-instante
  // (t4) y propone lunes (t7): el fin de semana no cuenta → 1 laborable;
  // corrido serían 3.
  {
    const plan = planOf([{ id: "a", s: 0, e: 3 }, { id: "b", s: 3, e: 4 }])
    const ops: ChangeOp[] = [{ op: "update", id: "b", patch: { start: dayIso(6), end: dayIso(7) } }]
    const snapWt = buildImpactSnapshot(plan, ops, undefined, resolve)
    const bWt = snapWt.entries.find((e) => e.eventId === "b")
    if (bWt?.driftDays !== 1) fail("wt-impact: frozen drift in working days", JSON.stringify(bWt))
    else ok("wt-impact: impact snapshot freezes drift in WORKING days")
    const snapPlain = buildImpactSnapshot(plan, ops)
    if (snapPlain.entries.find((e) => e.eventId === "b")?.driftDays !== 3) {
      fail("wt-impact: null mode corrido drift", JSON.stringify(snapPlain.entries))
    } else ok("wt-impact: without resolver the snapshot stays corrido")
  }
}

// ---- 28. GanttCalendar: hermana decodifica + demo carga limpia -------------
{
  const entity: UmeCalendarEntity = buildCalendarEntity({
    id: "00000000-0000-4000-8000-000000000005",
    planEntityId: "plan-1",
    planAnchor: ISO,
    calendar: {
      schemaVersion: 1,
      calendars: [
        {
          id: "c1",
          title: "Obra",
          workWeek: [false, true, true, true, true, true, false],
          exceptions: { "2026-01-16": false },
        },
      ],
      defaultCalendarId: "c1",
      assignmentByEvent: { e1: { calendarId: "c1" } },
    },
  })
  const d = decodeCalendar(entity, fixturePlan, "plan-1")
  if (!d.ok) fail("calendar: happy path", d.errors[0]?.message ?? "rejected")
  else if (d.calendar.defaultCalendarId !== "c1") fail("calendar: round-trip", "payload differs")
  else ok("calendar: decodes with plan binding (round-trip)")

  const patched = (patch: Record<string, unknown>): unknown => ({
    ...entity,
    dynamicProperties: { calendar: { ...entity.dynamicProperties.calendar, ...patch } },
  })
  const rejects: Array<[string, unknown]> = [
    ["workWeek of 6", patched({ calendars: [{ id: "c1", title: "X", workWeek: [true, true, true, true, true, true], exceptions: {} }] })],
    ["all-false workWeek", patched({ calendars: [{ id: "c1", title: "X", workWeek: [false, false, false, false, false, false, false], exceptions: {} }] })],
    ["unknown default", patched({ defaultCalendarId: "ghost" })],
    ["ghost assignment", patched({ assignmentByEvent: { e1: { calendarId: "ghost" } } })],
    ["non-ISO exception key", patched({ calendars: [{ id: "c1", title: "X", workWeek: [false, true, true, true, true, true, false], exceptions: { "2026-13-45": false } }] })],
    ["duplicate calendar id", patched({ calendars: [
      { id: "c1", title: "A", workWeek: [false, true, true, true, true, true, false], exceptions: {} },
      { id: "c1", title: "B", workWeek: [false, true, true, true, true, true, false], exceptions: {} },
    ] })],
    ["assignment to unknown event", patched({ assignmentByEvent: { ghost: { calendarId: "c1" } } })],
  ]
  for (const [label, input] of rejects) {
    const dd = decodeCalendar(input, label.includes("unknown event") ? fixturePlan : undefined)
    if (dd.ok) fail(`reject calendar: ${label}`, "decoder accepted it")
    else ok(`reject calendar: ${label}`)
  }
  const wrongRel: unknown = {
    ...entity,
    relations: [{ targetEntity: "GanttPlan", targetId: "other-plan", type: "one-to-one" }],
  }
  if (decodeCalendar(wrongRel, fixturePlan, "plan-1").ok) fail("reject calendar: bound to other plan", "accepted")
  else ok("reject calendar: bound to other plan")

  // Demo: la hermana decodifica contra PLAN y el grafo sembrado carga
  // LIMPIO bajo su propio calendario — cada dependencia ya descansa en su
  // borde (snap null ⇔ sin violación), ninguna barra arranca en día
  // inhábil y al menos una cruza un fin de semana (el salto visible).
  const demoEntity = buildDemoCalendar(PLAN, DEMO_PLAN_ID)
  const dDemo = decodeCalendar(demoEntity, PLAN, DEMO_PLAN_ID)
  if (!dDemo.ok) {
    fail("demo: calendar decodes against PLAN", dDemo.errors[0]?.message ?? "rejected")
  } else {
    const resolver = buildResolver(dDemo.calendar)
    const atBound = PLAN.dependencies!.every(
      (dep) => snapToDependency(PLAN, dep, resolver) === null,
    )
    if (!atBound) fail("demo: deps load clean under the demo calendar", "some edge sits off its bound")
    else ok(`demo: all ${PLAN.dependencies!.length} seeded deps sit exactly at their bounds (working time)`)
    const badStart = PLAN.events.filter((e) => !isWorkingDay(resolver(e.id), Date.parse(e.start)))
    if (badStart.length) fail("demo: every event starts on a working day", badStart.map((e) => e.id).join(","))
    else ok("demo: every seeded event starts on a working day")
    const spansWeekend = PLAN.events.some((e) =>
      workingDaysBetween(resolver(e.id), Date.parse(e.start), Date.parse(e.end)) <
      Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86_400_000)
    )
    if (!spansWeekend) fail("demo: some event visibly spans a weekend", "none found")
    else ok("demo: the plan shows the weekend jump live (span > working days)")
    const before = JSON.parse(JSON.stringify(PLAN))
    buildDemoCalendar(PLAN, DEMO_PLAN_ID)
    if (!deepEqual(PLAN, before)) fail("demo: calendar builder purity", "PLAN mutated")
    else ok("demo: calendar builder leaves PLAN untouched")
  }
}

// ---- 29. Avance real: patch.progress auditable ------------------------------
{
  const t = (days: number) => Date.parse(ISO) + days * 86_400_000
  const dayIso = (days: number) => new Date(t(days)).toISOString()
  const plan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: dayIso(0), end: dayIso(4), progress: 20 },
      { id: "b", resourceId: "r", start: dayIso(0), end: dayIso(4), progress: 0 },
    ],
  }

  // applyOps aplica el % y deja el resto intacto.
  {
    const next = applyOps(plan, [
      { op: "update", id: "a", patch: { start: dayIso(0), end: dayIso(4), progress: 55 } },
    ])
    if (next.events[0]?.progress !== 55 || next.events[0].start !== dayIso(0)) {
      fail("progress: applyOps applies percent", JSON.stringify(next.events[0]))
    } else ok("progress: applyOps applies the captured percent")
  }
  // Op de fechas solamente NUNCA sintetiza progress (aditivo como kind).
  {
    const next = applyOps(plan, [
      { op: "update", id: "a", patch: { start: dayIso(1), end: dayIso(5) } },
    ])
    if (next.events[0]?.progress !== 20) fail("progress: dates-only keeps prior", JSON.stringify(next.events[0]))
    else ok("progress: dates-only op leaves the stored percent untouched")
  }
  // Merge con drag/kind a nivel codec: drag (kind milestone) + avance
  // posterior en la MISMA secuencia conservan ambos campos.
  {
    const dragged = applyOps(plan, [
      { op: "update", id: "b", patch: { start: dayIso(3), end: dayIso(3), kind: "milestone" } },
    ])
    const merged = applyOps(dragged, [
      { op: "update", id: "b", patch: { start: dayIso(3), end: dayIso(3), kind: "milestone", progress: 70 } },
    ])
    const b = merged.events.find((e) => e.id === "b")
    if (
      b?.kind !== "milestone" || b.progress !== 70 ||
      b.start !== dayIso(3) || b.end !== dayIso(3)
    ) {
      fail("progress: merge with kind conversion", JSON.stringify(b))
    } else ok("progress: drag+conversion+percent all ride one document state")
    // Toggle back to task drops kind but KEEPS the recorded percent.
    const back = applyOps(merged, [
      { op: "update", id: "b", patch: { start: dayIso(3), end: dayIso(7), kind: "task", progress: 70 } },
    ])
    const b2 = back.events.find((e) => e.id === "b")
    if (!b2 || "kind" in b2 || b2.progress !== 70) {
      fail("progress: toggle back keeps percent, drops kind", JSON.stringify(b2))
    } else ok("progress: conversion back drops kind, keeps the percent")
  }

  // CR decoder rejections: 101, −1 y "mucho".
  {
    const base = buildChangeRequestEntity({
      payload: createChangeRequest({
        planEntityId: "plan-1",
        planAnchor: plan.anchor,
        planRevision: 1,
        basePlan: plan,
        ops: [{ op: "update", id: "a", patch: { start: dayIso(0), end: dayIso(4), progress: 50 } }],
      }),
    })
    const happy = decodeChangeRequest(base, plan, "plan-1")
    if (!happy.ok) fail("progress: cr decodes valid percent", happy.errors[0]?.message ?? "rejected")
    else ok("progress: CR carries a valid percent through the border")
    const withProgress = (v: unknown): unknown => ({
      ...base,
      dynamicProperties: {
        changeRequest: {
          ...base.dynamicProperties.changeRequest,
          ops: [{ op: "update", id: "a", patch: { start: dayIso(0), end: dayIso(4), progress: v } }],
        },
      },
    })
    for (const [label, v] of [["101", 101], ["−1", -1], ["mucho", "mucho"], ["NaN-ish", Number.POSITIVE_INFINITY]] as const) {
      if (decodeChangeRequest(withProgress(v)).ok) fail(`reject progress: ${label}`, "accepted")
      else ok(`reject progress: ${label}`)
    }
  }

  // El snapshot NO cambia de drift por un avance: mismas entradas/fechas
  // que sin el patch de progress (el % no mueve nada).
  {
    const opsDates: ChangeOp[] = [{ op: "update", id: "a", patch: { start: dayIso(5), end: dayIso(9) } }]
    const withPct: ChangeOp[] = [
      ...opsDates,
      { op: "update", id: "b", patch: { start: dayIso(0), end: dayIso(4), progress: 99 } },
    ]
    const snapA = buildImpactSnapshot(plan, opsDates)
    const snapB = buildImpactSnapshot(plan, withPct)
    const aEntry = snapB.entries.find((e) => e.eventId === "a")
    const bEntry = snapB.entries.find((e) => e.eventId === "b")
    if (!deepEqual(snapA.entries, snapB.entries.filter((e) => e.eventId !== "b"))) {
      fail("progress-impact: dates drift unchanged", JSON.stringify(snapB.entries))
    } else if (snapB.entries.length !== 2 || bEntry?.driftDays !== 0) {
      fail("progress-impact: progress seed drifts nothing", JSON.stringify(bEntry))
    } else ok("progress-impact: percent never perturbs the frozen drift")
  }
}

// ---- 25. updateResource + priority aditivo (Ola 1B/2A) -------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()

  // (a) applyOps: título y responsable se aplican por id; un patch parcial
  // NUNCA sintetiza el campo ausente; id desconocido = no-op puro.
  const resPlan: PlanJSON = {
    ...fixturePlan,
    resources: [
      { id: "root", title: "Root" },
      { id: "child", title: "Child", parentId: "root", responsable: "Alguien" },
    ],
    events: [{ id: "e1", resourceId: "child", start: t(0), end: t(3), progress: 0 }],
  }
  const renamed = applyOps(resPlan, [
    { op: "updateResource", id: "child", patch: { title: "Hijo" } },
  ])
  const child = renamed.resources.find((r) => r.id === "child")
  if (!child || child.title !== "Hijo" || child.responsable !== "Alguien") {
    fail("updateResource: partial patch keeps untouched keys", JSON.stringify(child))
  } else ok("updateResource: partial patch keeps untouched keys")
  if (!deepEqual(renamed.events, resPlan.events)) {
    fail("updateResource: events untouched", JSON.stringify(renamed.events))
  } else ok("updateResource: events untouched")
  const ghost = applyOps(resPlan, [
    { op: "updateResource", id: "nope", patch: { title: "X" } },
  ])
  if (!deepEqual(ghost, resPlan)) {
    fail("updateResource: unknown id is a pure no-op", JSON.stringify(ghost.resources))
  } else ok("updateResource: unknown id is a pure no-op")
  const both = applyOps(resPlan, [
    { op: "updateResource", id: "child", patch: { title: "Hijo", responsable: "Nadie" } },
  ])
  const child2 = both.resources.find((r) => r.id === "child")
  if (!child2 || child2.title !== "Hijo" || child2.responsable !== "Nadie") {
    fail("updateResource: full patch applies every key", JSON.stringify(child2))
  } else ok("updateResource: full patch applies every key")

  // (b) Round-trip BYTE-IDÉNTICO: sin ops de recurso, `resources` nunca se
  // reconstruye; con uno, aplicar → encodear → re-aplicar → re-encodear es
  // estable (el punto fijo del codec).
  const noResOps = applyOps(resPlan, [
    { op: "update", id: "e1", patch: { start: t(1), end: t(4), progress: 50 } },
  ])
  if (JSON.stringify(noResOps.resources) !== JSON.stringify(resPlan.resources)) {
    fail("updateResource: resource-free ops keep resources byte-identical", "resources rebuilt")
  } else ok("updateResource: resource-free ops keep resources byte-identical")
  const entityOut1 = { ...fixtureEntity, dynamicProperties: { plan: renamed } }
  const dec1 = decodeUmePlan(entityOut1)
  if (!dec1.ok) fail("updateResource: renamed document decodes", dec1.errors[0]?.message ?? "rejected")
  else {
    const again = applyOps(dec1.plan, [
      { op: "updateResource", id: "child", patch: { title: "Hijo" } },
    ])
    if (JSON.stringify(again) !== JSON.stringify(dec1.plan)) {
      fail("updateResource: re-apply is a fixed point", "documents differ")
    } else ok("updateResource: apply→decode→re-apply is byte-identical")
  }

  // (c) Fold-by-key del recorder: dos renombres seguidos son UN op con el
  // último título (la semántica que ChangesetRecorder garantiza).
  const folded = applyOps(resPlan, [
    { op: "updateResource", id: "child", patch: { title: "Uno" } },
    { op: "updateResource", id: "child", patch: { title: "Dos" } },
  ])
  const child3 = folded.resources.find((r) => r.id === "child")
  if (!child3 || child3.title !== "Dos") {
    fail("updateResource: later op wins the fold", JSON.stringify(child3))
  } else ok("updateResource: later op wins the fold")

  // (d) priority aditivo: válido cuando es entero 1..1000; rechazado fuera
  // de rango o no entero; ausente sigue siendo la forma canónica.
  const prio = (v: unknown): unknown => ({
    ...fixtureEntity,
    dynamicProperties: {
      plan: {
        ...fixturePlan,
        events: [{ id: "e1", resourceId: "child", start: t(0), end: t(3), progress: 0, ...(v === undefined ? {} : { priority: v }) }],
      },
    },
  })
  if (!decodeUmePlan(prio(500)).ok) fail("priority: decode accepts integer", "rejected")
  else ok("priority: decode accepts integer in range")
  for (const [label, v] of [["0", 0], ["1001", 1001], ["medio", 2.5], ["texto", "alta"]] as const) {
    if (decodeUmePlan(prio(v)).ok) fail(`reject priority: ${label}`, "accepted")
    else ok(`reject priority: ${label}`)
  }
  if (!decodeUmePlan(prio(undefined)).ok) fail("priority: absent stays valid", "rejected")
  else ok("priority: absent stays valid")
}

// ---- 26. Nivelación: demanda, sobrecarga y levelPlan (Ola 2A) ------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()

  // (a) Detección: dos eventos paralelos de la misma cuadrilla de 1 → una
  // corrida de sobrecarga [d0..d2], pico 2, exceso 3 persona-días.
  const wf = (headcount: number): WorkforcePayload => ({
    schemaVersion: 1,
    crews: [{ id: "C", title: "Cuadrilla C", specialty: "obra", headcount, dayRate: 900 }],
    assignmentByEvent: {
      a: { crewId: "C", headcount: 1 },
      b: { crewId: "C", headcount: 1 },
    },
  })
  const parallel: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(3), progress: 0, priority: 1000 },
      { id: "b", resourceId: "r", start: t(0), end: t(3), progress: 0, priority: 1 },
    ],
  }
  const runs0 = overallocations(parallel, wf(1))
  if (
    runs0.length !== 1 ||
    runs0[0].from !== t(0).slice(0, 10) + "T00:00:00.000Z" ||
    runs0[0].peak !== 2 ||
    runs0[0].excessPersonDays !== 3
  ) {
    fail("leveling: detects the known run", JSON.stringify(runs0))
  } else ok("leveling: detects the known overallocation run")
  const overloadMap = eventOverloadDays(parallel, wf(1))
  if (overloadMap.get("a") !== 3 || overloadMap.get("b") !== 3) {
    fail("leveling: per-event overload days", JSON.stringify([...overloadMap]))
  } else ok("leveling: per-event heatmap days count every overloaded day")

  // (b) levelPlan: prioridad ALTA se empuja primero (orden del plan);
  // duración preservada; el resultado limpia TODAS las sobrecargas.
  const lv = levelPlan(parallel, wf(1))
  if (lv.ops.length !== 1 || lv.ops[0].id !== "a") {
    fail("leveling: highest priority is the victim", JSON.stringify(lv.ops))
  } else if (lv.ops[0].op !== "update" || lv.ops[0].patch.start !== t(3) || lv.ops[0].patch.end !== t(6)) {
    fail("leveling: seat past the run keeps duration", JSON.stringify(lv.ops[0]))
  } else ok("leveling: victim seats past the run with duration preserved")
  if (overallocations(lv.ops.length ? applyOps(parallel, lv.ops) : parallel, wf(1)).length !== 0) {
    fail("leveling: applying ops clears overallocations", "still overloaded")
  } else ok("leveling: applying the ops clears every overallocation")
  if (lv.report.movedEvents !== 1 || lv.report.resolvedRuns !== 1 || lv.report.unresolvedRuns !== 0) {
    fail("leveling: report counts", JSON.stringify(lv.report))
  } else ok("leveling: report counts one move and one resolved run")

  // (c) Cascada documentada: el dependiente FS del empujado viaja con cause.
  const chained: PlanJSON = {
    ...parallel,
    events: [
      ...parallel.events,
      { id: "c", resourceId: "r", start: t(4), end: t(7), progress: 0 },
    ],
    dependencies: [{ id: "d1", fromEventId: "a", toEventId: "c", type: "FS" }],
  }
  const lvChain = levelPlan(chained, wf(1))
  const cOp = lvChain.ops.find((o) => o.id === "c")
  if (
    !cOp || cOp.op !== "update" ||
    cOp.cause?.kind !== "dependency-cascade" ||
    cOp.cause.sourceEventId !== "a"
  ) {
    fail("leveling: cascade op carries documented cause", JSON.stringify(cOp))
  } else ok("leveling: dependent cascade rides its documented cause")

  // (d) Hitos nunca son víctimas aunque tengan cuadrilla asignada.
  const withMs: PlanJSON = {
    ...parallel,
    events: [
      { id: "m", resourceId: "r", start: t(3), end: t(3), progress: 0, kind: "milestone" as const },
      ...parallel.events,
    ],
    dependencies: [],
  }
  const wfM: WorkforcePayload = {
    ...wf(1),
    assignmentByEvent: {
      ...wf(1).assignmentByEvent,
      m: { crewId: "C", headcount: 2 },
    },
  }
  const lvMs = levelPlan(withMs, wfM)
  if (lvMs.ops.some((o) => o.id === "m")) {
    fail("leveling: milestones are never victims", JSON.stringify(lvMs.ops))
  } else ok("leveling: a milestone never becomes the victim")

  // (e) Capacidad suficiente = cero ops, reporte limpio.
  const lvNone = levelPlan(parallel, wf(4))
  if (lvNone.ops.length !== 0 || lvNone.report.iterations !== 0) {
    fail("leveling: roomy capacity levels nothing", JSON.stringify(lvNone))
  } else ok("leveling: roomy capacity produces no ops")
}

// ---- 27. StatusDate + convenciones + free float (Ola 2B) -----------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()

  // Plan con avance FUERA de secuencia: A empezó antes del corte y va al
  // 50%; su sucesor B arrancó antes del fin de A (violación viva).
  const base: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    statusDate: t(10),
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(5), progress: 50 },
      { id: "b", resourceId: "r", start: t(3), end: t(8), progress: 0 },
    ],
    dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FS" }],
    schedulingOptions: { outOfSequence: "retainedLogic" },
  }

  // (a) Retained logic: B se sienta desde el fin VIVO de A conservando SU
  // duración (5 d) → t(5)..t(10).
  const retained = cascadeSchedule(base, ["a"])
  if (
    retained.length !== 1 ||
    retained[0].eventId !== "b" ||
    retained[0].start !== t(5) ||
    retained[0].end !== t(10)
  ) {
    fail("statusDate: retained logic seats from the live finish", JSON.stringify(retained))
  } else ok("statusDate: retained logic keeps B's duration from the live finish")

  // (b) Progress override: el asiento PISA el corte y B conserva solo la
  // fracción restante (0% aquí → duración completa desplazada a t(10)).
  const overridePlan: PlanJSON = {
    ...base,
    schedulingOptions: { outOfSequence: "progressOverride" },
  }
  const override = cascadeSchedule(overridePlan, ["a"])
  if (
    override.length !== 1 ||
    override[0].eventId !== "b" ||
    override[0].start !== t(10) ||
    override[0].end !== t(15)
  ) {
    fail("statusDate: override floors at the cutoff", JSON.stringify(override))
  } else ok("statusDate: override seats at the cutoff with remaining duration")
  // Distintas convenciones → fechas distintas sobre el MISMO plan.
  if (retained[0]?.start === override[0]?.start) {
    fail("statusDate: conventions diverge", "identical results")
  } else ok("statusDate: retained vs override produce different dates")

  // (c) Frozen actuals: A (progress>0, empezó antes del corte) NUNCA se
  // mueve aunque sea la semilla; sus sucesores sí se re-evalúan.
  if (cascadeSchedule(base, ["a"]).some((adj) => adj.eventId === "a")) {
    fail("statusDate: frozen actuals never move", "A moved")
  } else ok("statusDate: frozen actual stays put")

  // (d) Free float: cadena holgada A→B (B planeado tarde): A puede
  // deslizarse 3 días sin empujar a B; B cierra contra el fin del proyecto.
  const slackChain: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [
      { id: "a", resourceId: "r", start: t(0), end: t(2), progress: 0 },
      { id: "b", resourceId: "r", start: t(5), end: t(7), progress: 0 },
    ],
    dependencies: [{ id: "d", fromEventId: "a", toEventId: "b", type: "FS" }],
  }
  const cpmSlack = cpmSchedule(slackChain)
  if (cpmSlack.freeFloatDays.get("a") !== 3 || cpmSlack.freeFloatDays.get("b") !== 0) {
    fail(
      "statusDate: free float counts unpushed slip",
      JSON.stringify([...cpmSlack.freeFloatDays]),
    )
  } else ok("statusDate: free float = slip that pushes nobody (a=3, b=0)")

  // (e) updatePlanSettings: fold, drop canónico y round-trip byte-idéntico.
  const withStatus: PlanJSON = { ...fixturePlan, statusDate: t(10) }
  const cleared = applyOps(withStatus, [
    { op: "updatePlanSettings", patch: { statusDate: null } },
  ])
  if ("statusDate" in cleared) {
    fail("settings: null patch drops the field", JSON.stringify(cleared.statusDate))
  } else ok("settings: null patch drops statusDate (canonical absence)")
  const setBoth = applyOps(fixturePlan, [
    { op: "updatePlanSettings", patch: { statusDate: t(10), schedulingOptions: { outOfSequence: "progressOverride" } } },
    { op: "updatePlanSettings", patch: { schedulingOptions: { outOfSequence: "retainedLogic" } } },
  ])
  if (
    setBoth.statusDate !== t(10) ||
    setBoth.schedulingOptions?.outOfSequence !== "retainedLogic"
  ) {
    fail("settings: last write wins per field", JSON.stringify({ s: setBoth.statusDate, o: setBoth.schedulingOptions }))
  } else ok("settings: per-field fold, last write wins")
  const entitySettings: unknown = { ...fixtureEntity, dynamicProperties: { plan: setBoth } }
  const decSet = decodeUmePlan(entitySettings)
  if (!decSet.ok) fail("settings: document decodes", decSet.errors[0]?.message ?? "rejected")
  else {
    const again = applyOps(decSet.plan, [
      { op: "updatePlanSettings", patch: { schedulingOptions: { outOfSequence: "retainedLogic" } } },
    ])
    if (JSON.stringify(again) !== JSON.stringify(decSet.plan)) {
      fail("settings: re-apply is a fixed point", "documents differ")
    } else ok("settings: apply→decode→re-apply is byte-identical")
  }

  // (f) EVM: el corte resuelve actuals.dataDate ?? plan.statusDate ?? now.
  const evmBudget = { schemaVersion: 1 as const, currency: "MXN", bacByEvent: { a: 100 } }
  const evmActualsNoDate = {
    schemaVersion: 1 as const,
    dataDate: "",
    planAnchor: ISO,
    acByEvent: {},
  }
  const evmWithStatus = computeEvm(
    { ...slackChain, statusDate: t(9) },
    evmBudget,
    evmActualsNoDate,
  )
  if (evmWithStatus.dataDate !== t(9)) {
    fail("statusDate: EVM falls back to plan.statusDate", evmWithStatus.dataDate)
  } else ok("statusDate: EVM dataDate resolves from the plan when actuals lack one")
}

// ---- 28. Timesheets: decode + transiciones (Ola 3B) ----------------------
{
  const t = (days: number) => new Date(Date.parse(ISO) + days * 86_400_000).toISOString()
  const tsPlan: PlanJSON = {
    schemaVersion: 2,
    anchor: ISO,
    phases: [],
    resources: [{ id: "r", title: "R" }],
    events: [{ id: "e1", resourceId: "r", start: t(0), end: t(3), progress: 0 }],
  }
  const payload = (over: Record<string, unknown>): unknown => ({
    id: "00000000-0000-4000-8000-0000000000e1",
    entityName: "GanttTimesheet",
    dynamicProperties: {
      timesheet: {
        schemaVersion: 1,
        weekOf: ISO,
        entries: [
          {
            id: "x1",
            actor: "Ing. Ríos",
            date: t(0),
            eventId: "e1",
            hours: 8,
            status: "draft",
            ...over,
          },
        ],
      },
    },
    lifecycle: {
      createdAt: ISO,
      updatedAt: ISO,
      deletedAt: null,
      version: 1,
    },
    relations: [
      { targetEntity: "GanttPlan", targetId: "plan-1", type: "many-to-one" },
    ],
    state: { current: "draft", statusLog: [{ status: "draft", timestamp: ISO }] },
    markdownDocumentation: "# parte",
  })

  const happy = decodeTimesheet(payload({}), tsPlan, "plan-1")
  if (!happy.ok) fail("timesheet: valid entry decodes", happy.errors[0]?.message ?? "rejected")
  else ok("timesheet: valid entry decodes")

  // Refs y rangos.
  for (const [label, over] of [
    ["unknown event", { eventId: "ghost" }],
    ["zero hours", { hours: 0 }],
    ["25h day", { hours: 25 }],
    ["date outside window", { date: t(200) }],
    ["duplicate handled by second row", null],
    ["bad status", { status: "approved?" }],
  ] as const) {
    if (label === "duplicate handled by second row") continue
    const doc = payload(over as Record<string, unknown>)
    if (decodeTimesheet(doc, tsPlan, "plan-1").ok) fail(`reject timesheet: ${label}`, "accepted")
    else ok(`reject timesheet: ${label}`)
  }
  const dupDoc = payload({}) as { dynamicProperties: { timesheet: { entries: unknown[] } } }
  dupDoc.dynamicProperties.timesheet.entries.push({
    ...dupDoc.dynamicProperties.timesheet.entries[0],
  })
  if (decodeTimesheet(dupDoc, tsPlan, "plan-1").ok) fail("reject timesheet: duplicate entry id", "accepted")
  else ok("reject timesheet: duplicate entry id")

  // Transiciones: draft → submitted → approved | rejected; approved terminal;
  // saltos ilegales → null (misma disciplina que transitionChangeRequest).
  const e: import("../src/lib/umejson/timesheet.ts").TimesheetEntry = {
    id: "x", actor: "a", date: t(0), eventId: "e1", hours: 8, status: "draft",
  }
  if (transitionEntry(e, "approved") !== null) fail("timesheet: draft→approved illegal", "allowed")
  else ok("timesheet: draft→approved is illegal")
  const submitted = transitionEntry(e, "submitted")
  if (!submitted || submitted.status !== "submitted") fail("timesheet: draft→submitted", JSON.stringify(submitted))
  else ok("timesheet: draft→submitted is legal")
  const approved = submitted ? transitionEntry(submitted, "approved") : null
  if (!approved || approved.status !== "approved") fail("timesheet: submitted→approved", JSON.stringify(approved))
  else ok("timesheet: submitted→approved is legal")
  if (transitionEntry(approved!, "rejected") !== null || transitionEntry(approved!, "submitted") !== null) {
    fail("timesheet: approved is terminal", "moved")
  } else ok("timesheet: approved is terminal")

  // Round-trip del builder: encodear → decodificar es estable.
  const entity = buildTimesheetEntity({
    id: "00000000-0000-4000-8000-0000000000e2",
    planEntityId: "plan-1",
    planAnchor: ISO,
    timesheet: {
      schemaVersion: 1,
      weekOf: ISO,
      entries: [{ id: "y1", actor: "b", date: t(1), eventId: "e1", hours: 4.5, status: "submitted" }],
    },
  })
  const rt = decodeTimesheet(entity, tsPlan, "plan-1")
  if (!rt.ok) fail("timesheet: builder output decodes", rt.errors[0]?.message ?? "rejected")
  else if (JSON.stringify(rt.timesheet) !== JSON.stringify(entity.dynamicProperties.timesheet)) {
    fail("timesheet: builder round-trips byte-identical", "payload differs")
  } else ok("timesheet: builder round-trip is stable")
}

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\nAll checks passed.")
