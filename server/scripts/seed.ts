// Seed: idempotent upsert of the demo plan plus its contable siblings
// (ON CONFLICT DO NOTHING — reseeding never overwrites edited
// documents). Imports the SAME builders the App uses as offline
// fallback, so what the API serves and what demo mode renders are
// byte-identical envelopes. Each document is decoded before persisting:
// the seed refuses to store anything the contract would reject.
import { buildDemoEntity, DEMO_PLAN_ID } from "../../src/data/demo-entity.ts"
import {
  buildDemoActuals,
  buildDemoBudget,
} from "../../src/data/demo-contables.ts"
import { decodeUmePlan } from "../../src/lib/umejson/schema.ts"
import {
  ENTITY_NAME_BUDGET,
  decodeBudget,
} from "../../src/lib/umejson/budget.ts"
import {
  ENTITY_NAME_ACTUALS,
  decodeActuals,
} from "../../src/lib/umejson/actuals.ts"
import { createPool } from "../src/db/pool.ts"
import { runMigrations } from "../src/db/migrate.ts"
import { putEntity } from "../src/entities.ts"

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

  const budget = buildDemoBudget(plan)
  const decodedBudget = decodeBudget(budget, plan, DEMO_PLAN_ID)
  if (!decodedBudget.ok) {
    throw new Error(`seed budget failed decodeBudget: ${JSON.stringify(decodedBudget.errors)}`)
  }
  const budgetOutcome = await putEntity(pool, {
    entityName: ENTITY_NAME_BUDGET,
    entity: decodedBudget.entity,
    document: budget,
    planEntityId: DEMO_PLAN_ID,
    expectedRevision: 0,
    ifNotExists: true,
  })
  console.log(budgetOutcome === "ok" ? "seeded budget" : "budget already present, left untouched")

  const actuals = buildDemoActuals(plan, budget)
  const decodedActuals = decodeActuals(actuals, plan, DEMO_PLAN_ID)
  if (!decodedActuals.ok) {
    throw new Error(`seed actuals failed decodeActuals: ${JSON.stringify(decodedActuals.errors)}`)
  }
  const actualsOutcome = await putEntity(pool, {
    entityName: ENTITY_NAME_ACTUALS,
    entity: decodedActuals.entity,
    document: actuals,
    planEntityId: DEMO_PLAN_ID,
    expectedRevision: 0,
    ifNotExists: true,
  })
  console.log(actualsOutcome === "ok" ? "seeded actuals" : "actuals already present, left untouched")
} finally {
  await pool.end()
}
