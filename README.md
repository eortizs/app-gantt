# app-gantt · Módulo Gantt — Construcción de departamento

Viewer Gantt editable construido con **React 19 + Vite 8 + TypeScript**, que consume el motor headless `@reui/gantt` (adaptado del árbol `src/components/reui/gantt/`) y un set de datos sintéticos de una obra (departamento) generado al cargar el módulo.

- **Stack**: React 19.2, Vite 8.2, TypeScript 6.0, Tailwind v4, `date-fns` 4, `@base-ui/react` 1.7, `react-day-picker` 10, `lucide-react`.
- **Lint**: `oxlint` (config en `.oxlintrc.json`).
- **Build artefact**: `dist/` (servido por nginx en `/var/www/apps/gantt/` → `https://gantt.aeon-ia.com/`).

## Scripts

```bash
npm install        # instala dependencias
npm run dev        # vite dev server (http://localhost:5173)
npm run build      # tsc -b && vite build → dist/
npm run preview    # sirve dist/ en local
npm run lint       # oxlint
```

## Estructura

```
src/
├── components/
│   ├── gantt-plan/
│   │   ├── GanttPlanViewer.tsx   # vista principal: monta <Gantt> con plan sintético
│   │   └── ChangesetPanel.tsx    # panel inferior: muestra el contrato JSON (cambios)
│   ├── reui/gantt/               # motor gantt headless (gantt.tsx, gantt-view.tsx, ...)
│   └── ui/                       # primitivos shadcn-style (button, scroll-area, tooltip, ...)
├── data/
│   └── plan-departamento.ts      # plan sintético: 7 fases, ~28 eventos, responsables
├── lib/
│   ├── plan-mapper.ts            # adapta PlanJSON → GanttEvent[] + GanttResource[]
│   ├── changeset.ts              # recorder de operaciones (drag/resize/create)
│   ├── i18n-es.ts                # traducciones + locale es-AR
│   └── utils.ts                  # cn() y helpers
├── App.tsx                       # shell (header + GanttPlanViewer)
├── main.tsx                      # entrypoint React 19 createRoot
└── index.css                     # tailwind v4 + tokens del tema
public/                           # assets estáticos (favicon, íconos)
```

## Ejemplo: plan sintético de departamento

El módulo carga, en cada mount, un plan de obra generado a partir del inicio de la semana actual (`src/data/plan-departamento.ts:72`). Consta de:

- **7 fases** (groups): Preliminares · Cimentación · Estructura · Albañilería · Instalaciones · Acabados · Entrega.
- **~28 eventos** (schedules) con duraciones, offsets relativos al ancla, avance (`progress`) y responsable (`Cuadrilla A/B`, `Ing. Ríos`, `Mtro. Solís`, `Electricista`, etc.).
- **Recursos** derivados de las fases (cada recurso hoja se asocia a su fase padre).

El timeline arranca en escala `month` (por defecto), centrado en `now`, con `infiniteScroll`, `nowIndicator`, `dragCreate`, `displayScheduleHint` y `summaryBars` activados — la UI replica un Gantt de obra real: navegación por mes con flechas, cambio de escala (Día / Semana / Mes / Trimestre / Año), botón **Hoy**, fechas en español y tooltips localizados.

## Edición y contrato de cambios

`ChangesetRecorder` (`src/lib/changeset.ts`) escucha drag/resize/create vía callbacks del Gantt (`onEventUpdate`, `onSelectSlot`, `canSelectSlot`) y emite operaciones serializables:

```ts
type Op =
  | { kind: 'update'; id: string; before: { start: string; end: string; resourceId: string }; after: { ... } }
  | { kind: 'create'; slot: { resourceId: string; start: string; end: string }; task: string }
  | { kind: 'delete'; id: string }
```

El panel `ChangesetPanel` inferior muestra la lista acumulada y permite **Copiar JSON** — es el contrato que la futura API REST debe aceptar (POST batch de `Op[]`).

## Despliegue

`dist/` se sincroniza al directorio servido por nginx:

```bash
npm run build && rsync -a --delete dist/ /var/www/apps/gantt/
```

El host virtual (`/etc/nginx/sites-enabled/gantt.aeon-ia.com`) sirve ese directorio como `https://gantt.aeon-ia.com/`.

## Convenciones

- **i18n**: todo lo user-facing pasa por `src/lib/i18n-es.ts`. Cualquier texto nuevo debe sumarse ahí; nunca hardcodear strings en JSX.
- **Estilos**: Tailwind v4 con `@theme inline` y variantes `data-[slot=...]` / `data-[state=...]`. Sin CSS modules.
- **Tipos**: nada de `any` salvo adapters internos (marcados con eslint-disable explícito y comentario).
- **Comentarios**: solo donde la intención no es evidente — el código se lee solo.
