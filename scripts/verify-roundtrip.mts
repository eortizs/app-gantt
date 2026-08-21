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
    { id: "e1", resourceId: "child", start: ISO, end: ISO, progress: 50 },
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

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\nAll checks passed.")
