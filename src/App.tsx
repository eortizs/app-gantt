import { useMemo } from "react"
import { GanttPlanViewer } from "@/components/gantt-plan/GanttPlanViewer"
import { PLAN } from "@/data/plan-departamento"
import type { UmeJsonEntity } from "@/lib/umejson/schema"

// Punto de reemplazo: cuando exista el GET real del backend, este useMemo
// desaparece y la entidad llega por props desde un loader superior.
function useDemoEntity(): UmeJsonEntity {
  return useMemo(() => buildDemoEntity(), [])
}

function buildDemoEntity(): UmeJsonEntity {
  const now = new Date("2026-01-12T12:00:00.000Z").toISOString()
  return {
    id: "00000000-0000-4000-8000-000000000001",
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

function App() {
  const entity = useDemoEntity()
  return (
    <div className="mx-auto w-full max-w-[1400px] p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Módulo Gantt — Construcción de departamento
        </h1>
        <p className="text-sm text-muted-foreground">
          Caja negra umeJSON: la app recibe una entidad finalizada, valida su
          estructura, la hace editable, y emite el changeset <code>Op[]</code>{" "}
          junto con la entidad actualizada.
        </p>
      </header>
      <GanttPlanViewer document={entity} />
    </div>
  )
}

export default App
