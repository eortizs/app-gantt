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

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\nAll checks passed.")
