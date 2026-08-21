import { GanttPlanViewer } from "@/components/gantt-plan/GanttPlanViewer"

function App() {
  return (
    <div className="mx-auto w-full max-w-[1400px] p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Módulo Gantt — Construcción de departamento
        </h1>
        <p className="text-sm text-muted-foreground">
          Plan sintético editable. Arrastra o redimensiona barras para registrar
          cambios; el panel inferior muestra el contrato JSON de la futura API.
        </p>
      </header>
      <GanttPlanViewer />
    </div>
  )
}

export default App
