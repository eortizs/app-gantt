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
│   │   ├── GanttPlanViewer.tsx   # vista principal: monta <Gantt> con plan sintético + slider de profundidad
│   │   └── ChangesetPanel.tsx    # panel inferior: muestra el contrato JSON (cambios)
│   ├── reui/gantt/               # motor gantt headless (gantt.tsx, gantt-view.tsx, ...)
│   └── ui/                       # primitivos shadcn-style (button, slider, scroll-area, tooltip, ...)
├── data/
│   └── plan-departamento.ts      # plan sintético (schema v2): WBS de 4–5 niveles, 7 fases, ~28 eventos
├── lib/
│   ├── plan-mapper.ts            # adapta PlanJSON → GanttEvent[] + GanttResource[] (árbol recursivo)
│   ├── wbs-levels.ts             # paleta L0–L4 + helper wbsLevelStyle(depth)
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

- **7 fases** (groups L1): Preliminares · Cimentación · Estructura · Albañilería · Instalaciones · Acabados · Entrega.
- **~45 recursos** estructurados como WBS plano de 4–5 niveles (L0 proyecto → L1 fases → L2 paquetes → L3/L4 tareas). Cada `PlanResource` apunta a su padre con `parentId` y hereda el color de fase vía `phaseId` (resuelto en `plan-mapper.ts`).
- **~28 eventos** (schedules) con duraciones, offsets relativos al ancla, avance (`progress`) y responsable (`Cuadrilla A/B`, `Ing. Ríos`, `Mtro. Solís`, `Electricista`, etc.).

El timeline arranca en escala `month` (por defecto), centrado en `now`, con `infiniteScroll`, `nowIndicator`, `dragCreate`, `displayScheduleHint` y `summaryBars` activados — la UI replica un Gantt de obra real: navegación por mes con flechas, cambio de escala (Día / Semana / Mes / Trimestre / Año), botón **Hoy**, fechas en español y tooltips localizados.

## WBS plano con control de profundidad

La jerarquía visual del panel de árbol ya no se comunica por indentación: todos los títulos quedan alineados al margen izquierdo y la profundidad del nodo se indica por el color de fondo de la fila. El **slider "Profundidad"** (en la banda libre del header del panel árbol, justo bajo los títulos de columna) controla qué niveles están expandidos: `0` muestra solo la raíz L0, `1` hasta fases, ..., `máx` = todo expandido. El `máx` se calcula del árbol mapeado (4 en el demo actual).

### Paleta

| Nivel | Fondo | Texto |
|-------|-------|-------|
| L0    | `#162A4D` | `#FFFFFF` |
| L1    | `#4472C3` | `#FFFFFF` |
| L2    | `#BDD6EE` | `#1F2937` |
| L3    | `#D8D8D8` | `#1F2937` |
| L4+   | `#F2F2F2` | `#1F2937` (clamp) |

Definida en `src/lib/wbs-levels.ts` (`WBS_LEVELS` + `wbsLevelStyle(depth)`).

### Schema `PlanJSON` v2

- `schemaVersion: 2`.
- `PlanResource.parentId?: string` — libre, apunta a cualquier recurso (no solo a una fase). El mapper (`toGanttResources`) construye el árbol recursivamente preservando el orden de declaración entre hermanos. Guardas: huérfanos (`parentId` inexistente) y miembros de ciclos se tratan como raíces, así todo recurso queda alcanzable exactamente una vez.
- `PlanResource.phaseId?: string` — opcional, **heredable**: si un nodo no tiene `phaseId`, el evento hereda el del ancestro más cercano. El color de la barra en el timeline sale de esta cadena (`EventData.fase` mantiene el id resuelto).
- `PlanPhase` ya no contiene `resourceIds`: pasa a ser solo metadato de color (`id`, `title`, `color`).

### Extensiones genéricas del motor (`@reui/gantt`)

Para soportar el WBS plano sin acoplarse al dominio, `GanttTreePanelConfig` (`src/components/reui/gantt/gantt.tsx:1215`) recibió cuatro props nuevas, todas opcionales y agnósticas de WBS:

- `indentPerLevelRem?: number` — default `0.875`. `0` aplana los títulos al gutter.
- `rowStyle?: (ctx) => CSSProperties` — estilo inline a nivel de fila del panel árbol (se aplica como fondo + color). Hover/selected se montan como overlay hijo (`group-data-hover/gantt-row:` / `group-data-selected/gantt-row:`) sobre el inline, para no tapar el fondo del nivel.
- `rowToggles?: boolean` — default `true`. Cuando es `false` no se renderizan los chevrons de expandir/colapsar por fila (el control de visibilidad pasa al slider).
- `headerContent?: ReactNode` — slot libre en la banda inferior del header del panel árbol (alineada con la segunda fila del header del timeline). Aquí vive el slider.

### Slider de profundidad (`src/components/ui/slider.tsx`)

Slider custom (no usa `<input type="range">` nativo) con pointer/keyboard events propios, track `bg-muted` con relleno `bg-blue-500`, thumb blanco con borde azul y tooltip flotante que muestra el valor durante el drag. Accesible por teclado: `←/→` paso, `Home/End` extremos.

### Cableado de la app

`GanttPlanViewer` calcula `maxDepth` del árbol mapeado, mantiene el estado `level` (default `maxDepth`) y deriva `collapsedGroups` controlado: todo grupo con `depth >= level` se colapsa. Pasa:

```tsx
<Gantt
  treePanel={{
    width: 240,
    indentPerLevelRem: 0,
    rowStyle: (ctx) => wbsLevelStyle(ctx.depth),
    rowToggles: false,
    headerContent: <WbsLevelSlider level={level} max={maxDepth} onChange={setLevel} />,
  }}
  collapsedGroups={collapsedGroups}
  ...
/>
```

El timeline (barras, filas del timeline, summary bars) conserva el color de fase — el color de nivel es exclusivo del panel izquierdo.

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
