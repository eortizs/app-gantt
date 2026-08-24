// Demo umeJSON envelope shared by the App fallback (offline resilience)
// and the backend seed script — one builder so both sides agree on the
// id/envelope and can never drift apart. Imports keep the runtime-pure
// discipline (relative `.ts`) so `node --experimental-strip-types` can
// load this file from server/scripts/seed.ts.
import { PLAN } from "./plan-departamento.ts"
import type { UmeJsonEntity } from "../lib/umejson/schema.ts"

export const DEMO_PLAN_ID = "00000000-0000-4000-8000-000000000001"

export function buildDemoEntity(): UmeJsonEntity {
  const now = new Date().toISOString()
  return {
    id: DEMO_PLAN_ID,
    entityName: "GanttPlan",
    dynamicProperties: { plan: PLAN },
    lifecycle: {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    },
    state: {
      current: "active",
      statusLog: [
        { status: "draft", timestamp: now, reason: "demo seed" },
        { status: "active", timestamp: now, reason: "demo seed finalized" },
      ],
    },
    markdownDocumentation:
      "# Plan de construcción — Departamento Mérida\n\n" +
      "Plan sintético generado por el demo del módulo Gantt. " +
      "Toda la metadata editable vive en `dynamicProperties.plan` (schemaVersion 2).",
  }
}
