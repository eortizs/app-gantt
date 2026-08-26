#!/usr/bin/env node
// scripts/gen-stress-plan.mts
//
// Deterministic stress-plan generator CLI (virtualization benchmarks).
// Runs under node --experimental-strip-types; the builder itself lives in
// src/data/stress-plan.ts so Vite can load the SAME code for `?stress=N`.
//
// Usage:
//   node --experimental-strip-types scripts/gen-stress-plan.mts [count]
//   count ∈ {1000, 5000, 20000} recommended; default 5000.
//
// Browser measurement (no new deps, no test framework):
//   1. pnpm dev, then open http://localhost:5173/?stress=5000
//   2. MOUNT: the app logs `[stress] first paint after mount: <ms>` to the
//      console automatically in dev builds (rAF×2 after the viewer mounts).
//   3. SCROLL FRAME BUDGET: keep the pointer over the timeline and scroll
//      continuously; the app samples requestAnimationFrame deltas for 4s
//      starting at the first scroll event and logs
//      `[stress] scroll frames: n=… avg=…ms p95=…ms max=…ms`.
//      Budget rule of thumb: avg well under 16.7ms = fluid 60fps; p95 under
//      ~32ms reads smooth with occasional hiccups.
//   4. Repeat with ?stress=20000 and compare against the demo (?stress
//      omitted, 31 rows) for the regression baseline.

import { buildStressPlan } from "../src/data/stress-plan.ts"
import { decodeUmePlan } from "../src/lib/umejson/schema.ts"

const arg = process.argv[2]
const count = arg === undefined ? 5000 : Number(arg)
if (!Number.isInteger(count) || count <= 0 || count > 200_000) {
  console.error(`usage: gen-stress-plan.mts [count]  (got "${arg ?? ""}")`)
  process.exit(1)
}

const t0 = performance.now()
const plan = buildStressPlan(count)
const genMs = performance.now() - t0

// The generated plan must pass the real decoder: same contract as anything
// the viewer would ever receive.
const decoded = decodeUmePlan({
  id: "00000000-0000-4000-8000-0000000000ff",
  entityName: "GanttPlan",
  dynamicProperties: { plan },
  lifecycle: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    version: 1,
  },
  state: {
    current: "active",
    statusLog: [{ status: "active", timestamp: new Date().toISOString() }],
  },
  markdownDocumentation: "# stress",
})

console.log(
  [
    `events=${plan.events.length}`,
    `milestones=${plan.events.filter((e) => e.kind === "milestone").length}`,
    `dependencies=${plan.dependencies?.length ?? 0}`,
    `resources=${plan.resources.length}`,
    `phases=${plan.phases.length}`,
    `generated in ${genMs.toFixed(1)}ms`,
    `decode=${decoded.ok ? "ok" : `FAILED (${decoded.errors.length} errors)`}`,
  ].join("  "),
)
if (!decoded.ok) {
  console.error(decoded.errors.slice(0, 10))
  process.exit(1)
}
