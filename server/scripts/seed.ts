// Seed: idempotent upsert of the demo plan plus its sibling entities.
// Policy (decided, see AGENTS.md): the PLAN is never overwritten
// (ON CONFLICT DO NOTHING — edits survive reseeds); the DEMO SIBLINGS
// (budget/actuals/workforce) are regenerable, so every reseed OVERWRITES
// them (clobbering any PUT edit is accepted — they are demo data).
// Imports the SAME builders the App uses as offline fallback, so what the
// API serves and what demo mode renders are byte-identical envelopes.
// Each document is decoded before persisting: the seed refuses to store
// anything the contract would reject.
import { buildDemoEntity, DEMO_PLAN_ID } from "../../src/data/demo-entity.ts"
import {
  buildDemoActuals,
  buildDemoBudget,
} from "../../src/data/demo-contables.ts"
import { buildDemoWorkforce } from "../../src/data/demo-workforce.ts"
import { decodeUmePlan } from "../../src/lib/umejson/schema.ts"
import {
  ENTITY_NAME_BUDGET,
  decodeBudget,
} from "../../src/lib/umejson/budget.ts"
import {
  ENTITY_NAME_ACTUALS,
  decodeActuals,
} from "../../src/lib/umejson/actuals.ts"
import {
  ENTITY_NAME_WORKFORCE,
  decodeWorkforce,
} from "../../src/lib/umejson/workforce.ts"
import { createPool } from "../src/db/pool.ts"
import { runMigrations } from "../src/db/migrate.ts"
import { currentRevision, putEntity } from "../src/entities.ts"

const pool = createPool()
try {
  const ran = await runMigrations(pool)
  if (ran.length) console.log(`migrations applied: ${ran.join(", ")}`)

  const entity = buildDemoEntity()
  const plan = entity.dynamicProperties.plan
  const decodedPlan = decodeUmePlan(entity)
  if (!decodedPlan.ok) {
    throw new Error(`seed plan failed decodeUmePlan: ${JSON.stringify(decodedPlan.errors)}`)
  }
  const planOutcome = await putEntity(pool, {
    entityName: "GanttPlan",
    entity: decodedPlan.entity,
    document: entity,
    planEntityId: null,
    expectedRevision: 0,
    ifNotExists: true,
  })
  console.log(planOutcome === "ok" ? `seeded plan ${DEMO_PLAN_ID}` : "plan already present, left untouched")

  // Hermanas demo: builder → decoder (contract check) → seedOverwrite.
  const siblings = [
    {
      label: "budget",
      entityName: ENTITY_NAME_BUDGET,
      document: buildDemoBudget(plan),
      decode: (doc: unknown) => decodeBudget(doc, plan, DEMO_PLAN_ID),
    },
    {
      label: "actuals",
      entityName: ENTITY_NAME_ACTUALS,
      document: buildDemoActuals(plan),
      decode: (doc: unknown) => decodeActuals(doc, plan, DEMO_PLAN_ID),
    },
    {
      label: "workforce",
      entityName: ENTITY_NAME_WORKFORCE,
      document: buildDemoWorkforce(plan),
      decode: (doc: unknown) => decodeWorkforce(doc, plan, DEMO_PLAN_ID),
    },
  ] as const
  for (const sibling of siblings) {
    const decoded = sibling.decode(sibling.document)
    if (!decoded.ok) {
      throw new Error(`seed ${sibling.label} failed decode: ${JSON.stringify(decoded.errors)}`)
    }
    const before = await currentRevision(pool, decoded.entity.id)
    const outcome = await putEntity(pool, {
      entityName: sibling.entityName,
      entity: decoded.entity,
      document: sibling.document,
      planEntityId: DEMO_PLAN_ID,
      expectedRevision: 0,
      seedOverwrite: true,
    })
    if (outcome !== "ok") {
      console.log(`${sibling.label}: conflict, left untouched`)
    } else if (before === null) {
      console.log(`seeded ${sibling.label}`)
    } else {
      console.log(`refreshed ${sibling.label} (regenerable demo data, revision reset to 1)`)
    }
  }
} finally {
  await pool.end()
}
