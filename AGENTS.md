# AGENTS.md — module_gantt

Editable Gantt viewer (React 19 + Vite 8 + TS 6). Synthetic construction plan demo; the gantt engine is vendored in `src/components/reui/gantt/`.

## Commands

- **Install**: `pnpm install` — `pnpm-lock.yaml` is the lockfile. Don't use `npm install` (will rewrite lockfile and may break).
- **Dev**: `pnpm dev` → `http://localhost:5173`.
- **Build**: `pnpm build` = `tsc -b && vite build`. Build fails if `tsc` fails; fix type errors before expecting a bundle.
- **Lint**: `pnpm lint` (oxlint only — see `.oxlintrc.json`). No ESLint, no Prettier.
- **Preview**: `pnpm preview` serves `dist/`.
- **No test command** exists; there is no test framework configured. **Round-trip checks** live in `scripts/verify-roundtrip.mts` and run via `pnpm verify` (uses `node --experimental-strip-types`).

## Path alias

`@/*` → `./src/*` (both `vite.config.ts` and `tsconfig.app.json`). Imports use `@/lib/...`, `@/components/...`.

## Source layout (what lives where)

- `src/main.tsx` + `src/App.tsx` — entrypoint and shell. `App.tsx` builds the demo `UmeJsonEntity` (placeholder for the future GET endpoint).
- `src/components/gantt-plan/` — app-level viewer (`GanttPlanViewer.tsx` is the **umeJSON black box**) and the changes JSON panel (`ChangesetPanel.tsx`). This is where to add app features.
- `src/components/reui/gantt/` — **vendored gantt engine** (NOT an npm dep). Edit `gantt.tsx` (main) and siblings here when extending the engine. New generic props for the tree panel live around `gantt.tsx:1215`.
- `src/components/ui/` — shadcn-style primitives. `slider.tsx` is **custom** (no native `<input type="range">`); it has its own pointer/keyboard handlers.
- `src/data/plan-departamento.ts` — synthetic plan regenerated on every mount, anchored to the current week (see `:57`). WBS schema v2. Re-exports types from `@/lib/plan-types` for compat.
- `src/lib/plan-types.ts` — shared types: `PlanJSON`, `PlanEvent`, `PlanResource` (+`responsable?`), `PlanPhase`, `EventData`. `data/` imports types from here, never the other way.
- `src/lib/plan-mapper.ts` — `PlanJSON` → `GanttEvent[] + GanttResource[]`. Pure on the plan received: phase colors come from `plan.phases`, status is derived from the event's own `progress`, `responsable` comes from `resource.responsable`. Recursive tree builder, preserves sibling order, treats orphans/cycles as roots.
- `src/lib/umejson/schema.ts` — `UmeJsonEntity` type + `decodeUmePlan()` hand-rolled validator (envelope + payload). Exports `SENTINEL = "RESERVED_FOR_SYSTEM"` and `ENTITY_NAME = "GanttPlan"`.
- `src/lib/umejson/codec.ts` — anti-corruption layer: `ChangeOp` union (UpdateOp/CreateOp/DeleteOp), pure `applyOps(plan, ops)`, `encodeUpdatedPlan(base, plan, opCount)`. The recorder re-exports `ChangeOp` from here.
- `src/lib/changeset.ts` — `ChangesetRecorder` accepts a `createDraft(slot)` opt; the draft is the host module's responsibility (the recorder doesn't know the domain).
- `src/lib/wbs-levels.ts` — `WBS_LEVELS` palette + `wbsLevelStyle(depth)` helper.
- `src/lib/i18n-es.ts` — Spanish (es-AR) translations + locale config. **Every user-facing string goes here**; never hardcode JSX strings.

## Conventions (differ from defaults)

- **Styling**: Tailwind v4 with `@theme inline` and `data-[slot=…]` / `data-[state=…]` variants. No CSS modules.
- **Types**: `any` is forbidden unless marked with an explicit eslint-disable and a comment explaining the adapter.
- **Comments**: only where intent isn't obvious.
- **WBS depth is color, not indent.** Titles are left-aligned at the gutter; depth shows as row background via `wbsLevelStyle(depth)`. The depth slider (`WbsLevelSlider` in `gantt-plan/`) controls `collapsedGroups`: groups with `depth >= level` collapse. Default level = `maxDepth` (all expanded).
- **PlanJSON v2 quirks** (`plan-departamento.ts`):
  - `parentId` is free — can point to any resource, not just a phase.
  - `phaseId` is **inheritable**: missing `phaseId` falls back to the nearest ancestor's (bar color comes from the resolved chain).
  - `PlanPhase` is only color metadata (`id`, `title`, `color`) — no `resourceIds`.

## Verification order

Run after changes:

```
pnpm lint && pnpm build && pnpm verify
```

(`tsc -b` runs inside `build`, so type errors surface there. Lint is fast; run first. `pnpm verify` round-trips the umeJSON codec via `node --experimental-strip-types`.)

## Deploy

```
pnpm build && rsync -a --delete dist/ /var/www/apps/gantt/
```

Served by nginx as `https://gantt.aeon-ia.com/`. Don't skip `--delete` (stale assets linger otherwise).

## Gotchas

- The gantt engine is **vendored**, not installed from npm. There's no `@reui/gantt` in `package.json` — don't add it; extend `src/components/reui/gantt/` directly.
- `src/lib/umejson/` is **runtime-pure**: no value imports with the `@/` alias (the path alias is resolved by Vite/tsc, not by Node). Imports between modules in that tree use relative paths with explicit `.ts` extensions (`from "./schema.ts"`) so the same files can be loaded by `pnpm verify` under `node --experimental-strip-types` AND by `tsc -b`/`vite build`.
- `tsconfig.app.json` has `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `verbatimModuleSyntax: true`. Watch for unused imports and enum-style code.
- README's "Scripts" section says `npm install` — **the lockfile says pnpm**. Use pnpm.