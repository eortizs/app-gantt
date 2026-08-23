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
import { cascadeSchedule, dependentClosure, wouldCreateCycle } from "../src/lib/umejson/schedule.ts"
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

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\nAll checks passed.")
