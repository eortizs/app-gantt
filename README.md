# app-gantt · Módulo Gantt — Construcción de departamento

Viewer Gantt editable construido con **React 19 + Vite 8 + TypeScript**, que consume el motor headless `@reui/gantt` (adaptado del árbol `src/components/reui/gantt/`), un set de datos sintéticos de una obra (departamento) y — desde la v2 del módulo — el **backend `gantt-api`** (Fastify + pg, workspace pnpm `server/`) que persiste el plan como documento umeJSON en PostgreSQL.

- **Stack frontend**: React 19.2, Vite 8.2, TypeScript 6.0, Tailwind v4, `date-fns` 4, `@base-ui/react` 1.7, `react-day-picker` 10, `lucide-react`.
- **Stack backend**: Fastify 5 + `pg`, Node ≥ 22.18 (TypeScript nativo por strip-types, sin transpilador), PostgreSQL 16.
- **Lint**: `oxlint` (config en `.oxlintrc.json`).
- **Build artefact**: `dist/` (servido por nginx en `/var/www/apps/gantt/` → `https://gantt.aeon-ia.com/`).

## Scripts

Raíz (workspace pnpm: app + `server/`; **no usar npm** — reescribe el lockfile):

```bash
pnpm install                     # instala ambos paquetes del workspace
pnpm dev                         # vite dev server (http://localhost:5173, proxy /api → 127.0.0.1:4600)
pnpm build                       # tsc -b && vite build → dist/
pnpm preview                     # sirve dist/ en local
pnpm lint                        # oxlint
pnpm verify                      # round-trip + invariantes del contrato umeJSON (Node strip-types)
```

Backend (`server/`):

```bash
pnpm --filter server dev         # node --watch src/index.ts (127.0.0.1:4600)
pnpm --filter server start       # node src/index.ts (producción, systemd)
pnpm --filter server typecheck   # tsc noEmit
pnpm --filter server migrate     # runner de migraciones idempotente (server/src/db/migrations/*.sql)
pnpm --filter server seed        # upsert idempotente del plan demo + budget + actuals (ON CONFLICT DO NOTHING)
```

Orden de verificación tras un cambio: `pnpm lint && pnpm build && pnpm verify` (frontend + contrato); cambios de backend agregan `pnpm --filter server typecheck && pnpm --filter server migrate` + smoke `curl -s localhost:4600/api/health`.

## Estructura

```
src/
├── components/
│   ├── gantt-plan/
│   │   ├── GanttPlanViewer.tsx   # vista principal (caja negra umeJSON): bitono (reposo claro + avance fuerte), trazo de ruta crítica, bitácora, dependencias, tarea ⇄ hito
│   │   ├── ChangesetPanel.tsx    # panel inferior: muestra el contrato JSON (cambios) + proponer CR
│   │   ├── ChangeRequestsPanel.tsx # cola de solicitudes de cambio (badges de estado, impacto congelado, Aprobar/Rechazar/Aplicar)
│   │   ├── TreeColumnsMenu.tsx   # dropdown mostrar/ocultar columnas del panel árbol (persiste en localStorage)
│   │   └── EvmPanel.tsx          # tarjetas BAC/PV/EV/AC/SPI/CPI/EAC sobre el plan vivo
│   ├── reui/gantt/               # motor gantt headless (gantt.tsx, gantt-view.tsx, ...)
│   └── ui/                       # primitivos shadcn-style (button, slider, scroll-area, tooltip, ...)
├── data/
│   ├── plan-departamento.ts      # plan sintético (schema v2): WBS de 4–5 niveles, 7 fases, ~31 eventos
│   ├── demo-entity.ts            # envelope umeJSON demo (única definición: fallback App + seed backend)
│   ├── demo-contables.ts         # builders demo de GanttBudget / GanttActuals (tarifa×días con desglose exacto, wiggle determinista)
│   └── demo-workforce.ts         # builder demo de GanttWorkforce (cuadrillas derivadas de los RESPONSABLES)
├── lib/
│   ├── plan-types.ts             # tipos PlanJSON v2 + EventData (compartidos data ↔ lib ↔ umejson)
│   ├── plan-mapper.ts            # PlanJSON → GanttEvent[] + GanttResource[] (puro sobre el plan recibido)
│   ├── wbs-levels.ts             # paleta L0–L4 + helper wbsLevelStyle(depth)
│   ├── changeset.ts              # recorder de operaciones (drag/resize/create/dependencias); re-exporta ChangeOp
│   ├── umejson/                  # CONTRATO (runtime-puro, imports relativos .ts — lo importa el backend verbatim)
│   │   ├── schema.ts             # UmeJsonEntity + decodeUmePlan() + validateUmeEnvelope() (DSL compartido)
│   │   ├── codec.ts              # ChangeOp + applyOps() + encodeUpdatedPlan() (capa anti-corrupción)
│   │   ├── schedule.ts           # grafo: cascadeSchedule (push-forward), dependentClosure, wouldCreateCycle
│   │   ├── baselines.ts          # política de drift: vigenteBaseline, driftReference/isDrifted, driftDays
│   │   ├── change-request.ts     # contrato del módulo de control de cambios (entidad propia, transiciones legales)
│   │   ├── cpm.ts                # CPM runtime-puro: ES/EF/LS/LF, holgura total, conjunto crítico
│   │   ├── budget.ts             # entidad hermana GanttBudget (BAC por evento, uniform) + decodeBudget
│   │   ├── actuals.ts            # entidad hermana GanttActuals (AC + dataDate + ancla baseline) + decodeActuals
│   │   └── evm.ts                # EVM runtime-pura: PV/EV/AC + SV/CV/SPI/CPI/EAC/ETC/TCPI/VAC
│   ├── i18n-es.ts                # traducciones + locale es-AR
│   └── utils.ts                  # cn() y helpers
├── App.tsx                       # shell: fetch del bundle (plan+budget+actuals) con fallback demo + EVM
├── main.tsx                      # entrypoint React 19 createRoot
└── index.css                     # tailwind v4 + tokens del tema
server/                           # gantt-api (paquete del workspace)
├── src/
│   ├── index.ts                  # Fastify 127.0.0.1:4600: health + GET/PUT plans + budget|actuals
│   ├── config.ts                 # carga server/.env manual (fail-fast al boot)
│   ├── entities.ts               # store híbrido JSONB + columnas promovidas + stampSentinels + lock optimista
│   └── db/
│       ├── pool.ts               # pool pg (max 10)
│       ├── migrate.ts            # runner de migraciones (schema_migrations, transacción por archivo)
│       └── migrations/           # 001_ume_entities.sql, 002_sibling_lookup_index.sql
└── scripts/seed.ts               # seed idempotente (plan + budget + actuals, decodificado antes de persistir)
public/                           # assets estáticos (favicon, íconos)
```

## Ejemplo: plan sintético de departamento

El módulo carga, en cada mount, un plan de obra generado a partir del inicio de la semana actual (`src/data/plan-departamento.ts:57`). Consta de:

- **7 fases** (groups L1): Preliminares · Cimentación · Estructura · Albañilería · Instalaciones · Acabados · Entrega.
- **~45 recursos** estructurados como WBS plano de 4–5 niveles (L0 proyecto → L1 fases → L2 paquetes → L3/L4 tareas). Cada `PlanResource` apunta a su padre con `parentId` y hereda el color de fase vía `phaseId` (resuelto en `plan-mapper.ts`).
- **~31 eventos** (schedules) con duraciones, offsets relativos al ancla, avance (`progress`) y responsable (`Cuadrilla A/B`, `Ing. Ríos`, `Mtro. Solís`, `Electricista`, etc.). El cierre `acta-entrega` es un **hito** (`kind: "milestone"`, duración 0 → diamante) con BAC 0 en el presupuesto demo.

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

`ChangesetRecorder` (`src/lib/changeset.ts`) escucha drag/resize/create vía callbacks del Gantt (`onEventUpdate`, `onSelectSlot`, `canSelectSlot`) y emite operaciones serializables. El draft (título/color/responsable de una nueva tarea) lo construye el módulo vía `createDraft(slot)` — el recorder no conoce el dominio.

```ts
// src/lib/umejson/codec.ts
export type UpdateOp = {
  op: "update"; id: string
  patch: {
    start: string; end: string
    kind?: "task" | "milestone" // toggle tarea ⇄ hito; ausente = no toca el kind
  }
  cause?: DependencyCause // ajuste en cascada documentado
}
export type CreateOp = {
  op: "create"
  event: {
    id: string
    resourceId: string
    start: string
    end: string
    progress: number
    title: string
    color?: string
    kind?: "task" | "milestone"
    data: { responsable: string; fase: string; status: string }
  }
}
export type DeleteOp = { op: "delete"; id: string }
export type ChangeOp = UpdateOp | CreateOp | DeleteOp | AddDependencyOp | RemoveDependencyOp
```

### Tarea ⇄ hito (`kind: "milestone"`)

El menú contextual de cada barra ofrece **«Convertir en hito» / «Convertir en tarea»**. Un hito es de **finalización** con duración 0: al convertir, `start = end = fin actual` (los dependientes FS quedan intactos; el inicio salta al fin y la cascada repara posibles SS). Al volver a tarea, el instante queda como inicio y la duración se restaura del **plan base** si allí era tarea (si nació hito → 1 día). El campo `kind` es opcional y aditivo (`schemaVersion` sigue en 2): aplicar `kind: "task"` en `applyOps` **elimina** el campo (forma canónica), así un toggle ida y vuelta round-tripea byte-idéntico. En pantalla el hito es un **diamante** cuadrado centrado en el instante (bitono: pastel de fase → tinte fuerte al 100%), sin resize y con la etiqueta siempre fuera; el plan demo siembra `acta-entrega` como hito.

El panel `ChangesetPanel` inferior muestra dos secciones: el **`Op[]`** acumulado y, cuando hay cambios, el **documento umeJSON actualizado** (entidad lista para POST). Ambos con **Copiar JSON**.

> **Nota sobre dependencias**: crear dependencias es **drag-and-drop** — se arranca desde los puntos de conexión en los bordes de la barra (con veto de ciclo en vivo `canConnectEvents`) y suelta sobre la tarea sucesora; no hay opción de alta en el menú contextual. El menú (y el clic sobre el conector, que abre `DependencyPanel`) queda para **quitar**.
> **Nota sobre borrado**: el menú contextual de cada barra expone borrado (`DeleteOp` vía `recorder.onEventDelete` + `GanttApi.removeEvent`); `applyOps` poda las dependencias incidentes para que el documento nunca quede con refs colgantes.

## Pipeline umeJSON (caja negra)

El módulo Gantt consume y produce **una sola entidad umeJSON** (`entityName: "GanttPlan"`, `dynamicProperties.plan` = `PlanJSON` v2 completo), ahora servida por `GET /api/plans/:id`. La frontera entre el documento externo y el dominio interno cruza por un codec puro en `src/lib/umejson/`.

```
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │
in ──▶ │  decodeUmePlan(entity)  ──▶  originalPlan (PlanJSON)        │
       │        │                                                    │
       │        └─ err ──▶ panel de error (nada del engine)          │
       │                                                             │
       │  ┌──────────────────────────────────────────┐               │
       │  │  Gantt engine (drag / resize / create)   │               │
       │  └──────────────────────────────────────────┘               │
       │        │                                                    │
       │        ▼                                                    │
       │  recorder  ──▶  ChangeOp[]   ──▶  applyOps(originalPlan)    │
       │                                     │                      │
       │                                     ▼                      │
       │  encodeUpdatedPlan(entity, …)  ──▶  entityOut               │
       │                                                             │
out ──▶│  ChangeOp[]  +  entityOut  ──▶  ChangesetPanel              │
       │                                                             │
       └─────────────────────────────────────────────────────────────┘
```

### Decisiones del contrato

- **D2 — Validación runtime**: hand-rolled, sin Zod. Errores estructurados `{ path, code, message }` para que el panel pueda renderizarlos y el backend mapearlos. El modelo es la `Ajv` schema del finalize-api (`ume-json-v1/finalize-api/server.mjs:43-99`).
- **D4 — Salida**: dual. `Op[]` para el transporte y la entidad completa actualizada para persistir. La entidad out:
  - preserva `id` y `lifecycle.version` (el server es dueño del bump);
  - marca `lifecycle.updatedAt` y `timestamp` del append a `statusLog` con el sentinel `RESERVED_FOR_SYSTEM` — el backend los completa al persistir;
  - append a `state.statusLog` con `{ status: <state.current actual>, timestamp: RESERVED_FOR_SYSTEM, reason: "gantt: N ops" }`;
  - preserva `markdownDocumentation` tal cual (puede quedar stale — ver nota abajo).
- **D5 — Forma del Op**: se adoptó la forma real del código (`{ op, … }`) y se agregó `delete` al union.
- **D6 — Input finalizado**: la entidad debe llegar **finalizada** (UUID real, timestamps reales). El decoder rechaza sentinels `RESERVED_FOR_SYSTEM` en `id`, `lifecycle.createdAt` y `lifecycle.updatedAt` — eso señaliza un documento sin finalizar.
- **D7 — Borrado en UI**: out of scope (ver nota arriba).

> **`markdownDocumentation` puede quedar stale**: el codec lo preserva intacto aunque el plan haya cambiado. Es responsabilidad del backend regenerarlo si el endpoint lo requiere.

### Validación local del codec

```bash
pnpm verify   # node --experimental-strip-types scripts/verify-roundtrip.mts
```

Cubre: round-trip del payload, `applyOps(update+create+delete+dependencias)`, cascada documentada, política de drift, contrato de change requests, CPM (lag, SS/FF, diamante, lead, tarea aislada, vacío), entidades contables (decode happy/rejections/refs) y EVM (caso calculado a mano, CPI 0, cortes fuera de rango).

## Backend `gantt-api` (`server/`)

Servicio Fastify + pg que escucha **solo en 127.0.0.1:4600** (nginx proxyea `/api/` desde el vhost TLS — mismo origen, sin CORS, `limit_req` 10r/s burst 20). Importa los módulos de `src/lib/umejson/` **verbatim**: la misma validación que corre el frontend corre en el borde del backend — única fuente de verdad del contrato. Node ≥ 22.18 ejecuta el TS nativo (strip-types), sin transpilador.

### Endpoints

| Ruta | Descripción |
|---|---|
| `GET /api/health` | `{ ok, db, revision }` (smoke; `db: false` → 503) |
| `GET /api/plans/:id` | Documento umeJSON del plan (404 si no existe); los bytes persistidos se devuelven tal cual |
| `PUT /api/plans/:id` | Body `{ entity, expectedRevision }`; ver abajo |
| `GET/PUT /api/plans/:planId/budget` | Entidad hermana `GanttBudget` del plan (la más reciente) |
| `GET/PUT /api/plans/:planId/actuals` | Entidad hermana `GanttActuals` del plan |
| `GET/PUT /api/plans/:planId/workforce` | Entidad hermana `GanttWorkforce` del plan (cuadrillas + asignaciones) |
| `GET /api/plans/:planId/change-requests?status=` | Cola de CRs del plan (`created_at DESC`, filtro opcional por estado promovido) |
| `POST /api/plans/:planId/change-requests` | Body `{ ops, reason? }` → propone una CR contra la revisión vigente; responde `{ id, revision, impact }` (201). Ops con targets inexistentes (vista vencida) → **422** |
| `POST /api/change-requests/:id/decision` | Body `{ to: "approved"\|"rejected"\|"applied", reason? }`. Transición ilegal → **422**; apply con revisión del plan movida → **409** `{ currentRevision, crPlanRevision }` (la CR queda approved y hay que re-proponer) |

### Pipeline del PUT

1. **Estampado de sentinels** (idempotente): `lifecycle.updatedAt` y cada `statusLog[].timestamp == RESERVED_FOR_SYSTEM` → `now`. Persistencia limpia: la DB jamás contiene sentinels.
2. **Versión**: `lifecycle.version = expectedRevision + 1` — el server es el único escritor del contador.
3. **Decode en el borde**: `decodeUmePlan` / `decodeBudget` / `decodeActuals` rechazan con **422** cualquier violación del contrato (incluidos sentinels remanentes).
4. **Identidad**: `entity.id` debe matchear la ruta; las hermanas deben relacionarse (`relations[0].targetId`) con el plan de la ruta.
5. **Upsert con lock optimista**: `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE ume_entities.revision = $expected` — 0 filas → **409** con la revisión actual.

### Persistencia híbrida

`ume_entities`: documento íntegro en JSONB (fuente de verdad) + columnas promovidas (`status`, `revision`, `plan_entity_id`) mantenidas por el servidor en cada write (escritor único = sin drift), con índices GIN sobre el documento y btree para lookups de hermanos y health. Migraciones: archivos `.sql` en `server/src/db/migrations/`, aplicadas en orden por el runner (`pnpm --filter server migrate`); el servicio también las corre al boot (transacción por archivo, tabla `schema_migrations`).

### Configuración

`server/.env` (gitignored, mode 640 root:gantt; template en `server/.env.example`): `DATABASE_URL` (rol `system`, owner de `db_umejson`), `PORT=4600` y `DEFAULT_ACTOR` (identidad que estampa `requestedBy`/`decidedBy` de las CRs — sin auth por ahora, el demo es público y rate-limited). Carga manual sin dotenv, fail-fast al boot. Credenciales jamás en archivos trackeados.

### Seed y política de hermanas

`pnpm --filter server seed` siembra el plan demo y sus hermanas (budget/actuals/workforce) con los mismos builders que el fallback offline de `App.tsx`. Política decidida: el **plan** nunca se sobreescribe (`ON CONFLICT DO NOTHING` — las ediciones sobreviven); las **hermanas demo son regenerables** y cada re-seed las refresca incondicionalmente (pisar una edición por PUT es aceptado y documentado). Cada documento se decodifica antes de persistir: el seed se niega a guardar algo que el contrato rechazaría.

## Entidades contables y EVM

El schema del plan queda **congelado en v2**; los datos contables viven en entidades umeJSON hermanas vinculadas por `relations[]`:

- **`GanttBudget`** (`budget.ts`): BAC por evento + moneda + time-phasing `uniform` (única política de la v1) + **`breakdownByEvent` opcional** (partición `labor/material/equipment` que debe sumar EXACTO al BAC del evento). `decodeBudget(input, plan?, planEntityId?)` valida montos ≥ 0 finitos, la suma exacta del desglose y refs contra el plan suministrado.
- **`GanttActuals`** (`actuals.ts`): AC acumulado por evento + `dataDate` de corte + `baselineVersionByEvent` (qué versión vigente de la bitácora era la referencia al cortar — cross-checkeada contra la bitácora real).
- **`GanttWorkforce`** (`workforce.ts`): RRHH de obra — `crews` (especialidad, headcount, tarifa/día/persona) + `assignmentByEvent` (evento → cuadrilla + headcount), con refs cruzadas (cuadrilla inexistente, evento desconocido vs plan) y relación exactamente 1 → `GanttPlan`. El viewer pinta la columna «Cuadrilla» (`{crew.title} · {headcount}`) cuando `App` le pasa la hermana.
- **EVM** (`evm.ts`, runtime-pura — nada se persiste, es una lente): `computeEvm(plan, budget, actuals)` produce PV (BAC distribuido uniformemente sobre la ventana de referencia de drift = baseline anclada/vigente, clamped [0, BAC]), EV (BAC × progress), AC (corte) y SV/CV/SPI/CPI/EAC/ETC/TCPI/VAC por evento y proyecto. Los índices son `null` cuando el denominador no tiene sentido (PV 0, AC 0); CPI 0 con AC > 0 es una respuesta real. El `EvmPanel` pinta tarjetas con semáforo (rojo < 0.9, ámbar < 1, verde ≥ 1) sobre el **plan vivo** (`applyOps(basePlan, ops)`).

Demo: `demo-contables.ts` genera montos sintéticos realistas (tarifa por fase × días para BAC con desglose que suma exacto; BAC × avance × wiggle determinista [0.85–1.15] para AC) y `demo-workforce.ts` deriva las cuadrillas de los `RESPONSABLES` del propio plan (única fuente) — el fallback offline de `App.tsx` y el seed del backend usan los mismos builders.

## Solicitudes de cambio (CRs end-to-end)

El contrato vive en `change-request.ts`; el backend lo opera; el frontend propone y decide.

- **Propuesta**: `POST /api/plans/:id/change-requests` con `{ ops, reason? }`. El servidor carga el plan almacenado, construye la CR con `createChangeRequest` (el snapshot de impacto nace del MISMO plan al que la CR se ancla — imposible adjuntar uno desincronizado), la envuelve con `buildChangeRequestEntity` (uuid nuevo) y la decodifica en el borde como check defensivo.
- **Binding de revisión**: el payload lleva `planRevision` (int ≥ 1). `planAnchor` NO protege contra ediciones intermedias (`applyOps` lo preserva intacto) — la revisión sí: apply contra otra revisión → **409**, la CR queda `approved` y hay que re-proponer.
- **Costo de un desliz (modelo labor-burn)**: `buildImpactSnapshot(basePlan, ops, budget?)` adjunta `costImpact` cuando hay budget: `dailyLaborBurn = breakdown.labor / duraciónDíasReferencia`; `projectedExtraCost = Σ driftDays × burn` (con signo — negativo = ahorro proyectado); `extendedDays = Σ driftDays > 0`. Sin budget no hay `costImpact`; sin desglose el burn es 0. Procurement/maquinaria-extendida/indirectos: out of scope (follow-up).
- **Decisiones**: `proposed → approved | rejected`, `approved → applied` (terminal). El apply verifica la revisión y escribe **plan + CR en una transacción** (`applyOps` → documento del plan con `statusLog` append `«CR aplicada: <id>»`, revisión +1 → fila CR `applied`).
- **Actores**: sin auth todavía — `DEFAULT_ACTOR` (`server/.env`) estampa `requestedBy`/`decidedBy` vía `stampChangeRequestSentinels`.
- **UI**: `ChangesetPanel` propone los ops grabados (sin resetear el recorder — el reset llega con el remount post-apply); `ChangeRequestsPanel` (patrón `EvmPanel`) lista la cola con badge de estado, razón, impacto congelado (N eventos, Σ desliz, costo proyectado con moneda y signo) y botones Aprobar/Rechazar/Aplicar. En modo offline ambas cosas se esconden. Tras un apply, `App` refetchea el bundle y remonta el viewer por `key={planId:revision}` (su estado interno de eventos no se re-inicializa con solo cambiar props — limitación existente, documentada).

## CPM (ruta crítica)

`cpmSchedule(plan)` (`cpm.ts`, runtime-pura) computa el forward pass (ES/EF, reusando `earliestStart` del cascade — misma semántica de restricciones), backward pass (LS/LF desde el fin del proyecto = max EF), **holgura total** (LS−ES, días corridos) y el conjunto crítico (float 0). Convención **as-planned**: ES = max(inicio planificado, restricciones) — la holgura que el planificador "guardó" arrancando tarde no es float.

### Invariante de pintado (bitono homologado)

El reposo de una barra viva es **siempre un tono claro** (pastel de fase, o `DIRTY_TINT` red-200 si hay drift vs la referencia de la bitácora); el **full-strength queda reservado en exclusiva al overlay de avance**. Una barra crítica al 0% nunca puede pintarse fuerte — se leería como avance inexistente. La ruta crítica se señaliza con un **trazo `inset-ring` en el color de fase** vía `getEventBarClassName` (hook genérico del motor, canal de clases separado de los rellenos); el tint dirty tiene prioridad visual sobre el pastel, no sobre el overlay de avance. Las líneas base pintan en pastel por definición (`baselineTones`: stack 0 = pastel 25% de fase, históricas = rampa pastel fija); el preview por hover de una versión usa el pastel de la versión como reposo y su partner fuerte solo como avance.

## Despliegue

Frontend — `dist/` se sincroniza al directorio servido por nginx:

```bash
pnpm build && rsync -a --delete dist/ /var/www/apps/gantt/
```

Backend — corre como unidad systemd:

- `gantt-api.service`: `User=gantt`, `EnvironmentFile=server/.env`, `ExecStart=node server/src/index.ts`, `Restart=always`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`).
- Cambios de código necesitan `systemctl restart gantt-api.service`.
- nginx (`/etc/nginx/sites-enabled/gantt.aeon-ia.com`): `location /api/` → `proxy_pass http://127.0.0.1:4600` con `limit_req` (zona `gantt_api` en `/etc/nginx/conf.d/gantt-api-limit.conf`, 10r/s burst 20, 429).

El host virtual sirve el estático de `/var/www/apps/gantt` como `https://gantt.aeon-ia.com/`.

## Convenciones

- **i18n**: todo lo user-facing pasa por `src/lib/i18n-es.ts`. Cualquier texto nuevo debe sumarse ahí; nunca hardcodear strings en JSX.
- **Estilos**: Tailwind v4 con `@theme inline` y variantes `data-[slot=...]` / `data-[state=...]`. Sin CSS modules.
- **Tipos**: nada de `any` salvo adapters internos (marcados con eslint-disable explícito y comentario).
- **Comentarios**: solo donde la intención no es evidente — el código se lee solo.
