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
- `src/components/reui/gantt/gantt-color.ts` — concrete-color helpers for the bar paint model. **All phase colors must be concrete hexes**; `var()` chains fail silently in some browsers (the whole chain goes invalid and paints transparent). Exports `baselineTones(color, stack)` for baseline marks (pastel ramp by depth) and `barTones(color)` for live bars (80% pastel + phase at α 0.85). Also `DIRTY_TINT = "#fecaca"` (red-200) for the modified/drifted state — gray-200 was retired: it sat at the same OKLCH lightness as every resting pastel (L≈93, chroma ≈0) and was invisible next to them.
- `src/components/ui/` — shadcn-style primitives. `slider.tsx` is **custom** (no native `<input type="range">`); it has its own pointer/keyboard handlers.
- `src/data/plan-departamento.ts` — synthetic plan regenerated on every mount, anchored to the current week (see `:57`). WBS schema v2. Phase `color` is a concrete hex (Tailwind 500-level) so every paint path (live bars, baseline tones, swatches) renders without runtime CSS-variable resolution. A few events ship with seeded `baselines` so the bitácora has content on load (panel + «Líneas base» toggle); they keep that history untouched. Re-exports types from `@/lib/plan-types` for compat.
- `src/lib/plan-types.ts` — shared types: `PlanJSON`, `PlanEvent` (+`baselines?`), `PlanBaseline`, `PlanResource` (+`responsable?`), `PlanPhase`, `EventData` (+`initialStart?`/`initialEnd?`, +`baselines?`). `data/` imports types from here, never the other way. The bitácora de líneas base lives in `EventData.baselines` (append-only snapshots; only real captures populate it — see `plan-mapper.ts`); `initialStart/End` are the hidden "modified vs original" anchor, never a bitácora entry.
- `src/lib/plan-mapper.ts` — `PlanJSON` → `GanttEvent[] + GanttResource[]`. Pure on the plan received: phase colors come from `plan.phases`, status is derived from the event's own `progress`, `responsable` comes from `resource.responsable`. Recursive tree builder, preserves sibling order, treats orphans/cycles as roots. **No synthetic LB1**: baselines exist only where a real capture happened (the seeded demo history, or an explicit *Fijar línea base*); events without history carry none. A load-time LB1 used to anchor every bar's original dates, so each drag left a full-size colored remnant pinned at the old spot — removed. Instead the mapper stamps `initialStart/initialEnd` into `EventData` so drift on a bare task measures against the plan's original dates without polluting the bitácora. First explicit capture on a *drifted* bare task yields a single-entry log; a clean bar captures nothing (see *Fijar línea base en cascada* below).
- `src/lib/umejson/schedule.ts` — pure dependency graph helpers. **`dependentClosure(deps, seedIds)`** returns the transitive successors reachable from `seedIds` along `fromEventId → toEventId` (BFS, visited set, seeds excluded). Used by *Fijar línea base* to fan out captures across dirty dependents. **`wouldCreateCycle`** is the edit-time veto on `from → to`. **`cascadeSchedule`** is the forward-only forward pass that emits per-edge documented adjustments (see `ChangesetPanel` for the codec surface).
- **Fijar línea base en cascada** (`GanttPlanViewer.captureBaseline`): only bars that are *drifted* (their live dates differ from their drift reference — vigente baseline, else the mapper-stamped original dates; see `driftReference` in the viewer) capture. The seed follows the same rule as its transitive dependents along the dependency graph: a clean bar gets no entry, because snapshotting an unmoved bar would append an entry identical to its reference — a duplicate whose only effect was a ghost twin painted under the live bar. Seed reason `baselineManualReason`; drifted dependents capture with reason `baselineCascadeReason(seedTitle)`. All entries share a single `capturedAt`. Persisted state only: «Reiniciar plan» wipes everything as before; ChangeOps are not touched.
- **Baseline ghosts are opt-in.** `getEventBaselines` (viewer) returns marks ONLY while the «Líneas base» toggle (`showAllBaselines`) is on; by default the timeline paints no baseline marks at all. The newest bitácora entry is the drift REFERENCE — its presence is signaled by the dirty tint, never by an ambient ghost: painting it by default stamped a twin under the live bar at capture time that only "revealed" itself after the bar moved. With the toggle on, the full bitácora fans out (newest = full-size stack 0, older = 3px lines). The bitácora panel and the hover-time reprojection (`eventBarOverlays`) read `data.baselines` directly and work regardless of the toggle.
- `src/lib/umejson/schema.ts` — `UmeJsonEntity` type + `decodeUmePlan()` hand-rolled validator (envelope + payload). Exports `SENTINEL = "RESERVED_FOR_SYSTEM"` and `ENTITY_NAME = "GanttPlan"`.
- `src/lib/umejson/codec.ts` — anti-corruption layer: `ChangeOp` union (UpdateOp/CreateOp/DeleteOp), pure `applyOps(plan, ops)`, `encodeUpdatedPlan(base, plan, opCount)`. The recorder re-exports `ChangeOp` from here.
- `src/lib/changeset.ts` — `ChangesetRecorder` accepts a `createDraft(slot)` opt; the draft is the host module's responsibility (the recorder doesn't know the domain).
- `src/lib/wbs-levels.ts` — `WBS_LEVELS` palette + `wbsLevelStyle(depth)` helper.
- `src/lib/i18n-es.ts` — Spanish (es-AR) translations + locale config. **Every user-facing string goes here**; never hardcode JSX strings.

## Bar paint model (bitono)

Live bars are painted in two layers; both tones come from the consumer through `GanttViewConfig`:

- **Resting surface** (`--gantt-bar-tint`): soft pastel, concrete hex. Defaults to `var(--gantt-event-color) / 20` (translucent) when no tone is supplied; switches to opaque (`data-bar-tinted` attribute, driven by `colorOverride` OR `progressTintOverride`) when any tone is provided. Hover/selected darken via `bg-black/5` on the opaque layer.
- **Progress overlay** (`--gantt-progress-tint`): full-strength phase color at α 0.85. Border at α 0.65. Defaults to `var(--gantt-event-color)`; switched by `progressTintOverride`. The two layers can move independently — a consumer paints a bitono.

Consumer entry points on `GanttViewConfig`:

- `getEventBarTone({ event }) => { resting?, progress? } | undefined` — per-event bitono. The `GanttPlanViewer` uses this to derive the resting fill from `barTones(ev.color)` and to mark the bar DIRTY (resting = `DIRTY_TINT`, red-200) when `ev.start/end` differ from its drift reference (vigente baseline = highest-version `data.baselines` entry, else the mapper-stamped `initialStart/initialEnd`). Drag-release and *Fijar línea base* both flow through `events`, so the dirty bit updates without an effect. Callback identity MUST be stable (wrap in `useCallback` over the derived `Map<eventId, tone>`).
- `getSummaryBarTone({ resource, events }) => { resting?, progress? } | undefined` — same contract for parent rollups. Used so the inline summary bar matches the live-bar bitono.
- `eventBarOverlays[eventId].progressColor?: string` — companion to `color` for history-version previews: `color = baselineTones(...).fill` (pastel), `progressColor = baselineTones(...).full` (strong), so hovering a bitácora entry shows the version's bitono on the bar itself.

Vendored engine additions: `GanttBar` exposes `progressTintOverride`; both overrides feed CSS vars and turn on `data-bar-tinted` so the resting fill switches to opaque.

## Conventions (differ from defaults)

- **Styling**: Tailwind v4 with `@theme inline` and `data-[slot=…]` / `data-[state=…]` variants. No CSS modules.
- **Types**: `any` is forbidden unless marked with an explicit eslint-disable and a comment explaining the adapter.
- **Comments**: only where intent isn't obvious.
- **WBS depth is color, not indent.** Titles are left-aligned at the gutter; depth shows as row background via `wbsLevelStyle(depth)`. The depth slider (`WbsLevelSlider` in `gantt-plan/`) controls `collapsedGroups`: groups with `depth >= level` collapse. Default level = `maxDepth` (all expanded).
- **Concrete-hex colors only.** Phase colors flow through `barTones()` and `baselineTones()` → CSS background, and the derivation chain uses `canvas.getContext("2d").fillStyle` for runtime resolution. CSS variables in `var()` chains are tolerated by the helpers but unreliable in the wild; pin hexes in `data/plan-departamento.ts` to keep paint predictable.
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

`https://gantt.aeon-ia.com/` is the live demo for this project. **Every change set ships to it** — verification passing is not enough, the user is on this subdomain. Treat the next command as a fourth step of the workflow above; do NOT finish a task without running it.

```
pnpm build && rsync -a --delete dist/ /var/www/apps/gantt/
```

- `pnpm build` regenerates `dist/` with a new content-hashed bundle name; the rsync below only overwrites what exists.
- `--delete` is mandatory — stale hashed assets linger otherwise and nginx happily serves them.
- After the rsync, confirm the deployment took: `curl -s https://gantt.aeon-ia.com/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'` should match the hash printed by `pnpm build`. If it doesn't, the rsync didn't land.
- If the user reports "no veo cambios", they are almost certainly hitting a cached `index.html` (assets are hash-busted and update on their own). Suggest a hard reload (Ctrl+Shift+R / Cmd+Shift+R) and re-check the served bundle hash against `ls dist/assets/`.

## Gotchas

- The gantt engine is **vendored**, not installed from npm. There's no `@reui/gantt` in `package.json` — don't add it; extend `src/components/reui/gantt/` directly.
- `src/lib/umejson/` is **runtime-pure**: no value imports with the `@/` alias (the path alias is resolved by Vite/tsc, not by Node). Imports between modules in that tree use relative paths with explicit `.ts` extensions (`from "./schema.ts"`) so the same files can be loaded by `pnpm verify` under `node --experimental-strip-types` AND by `tsc -b`/`vite build`.
- `tsconfig.app.json` has `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `verbatimModuleSyntax: true`. Watch for unused imports and enum-style code.
- README's "Scripts" section says `npm install` — **the lockfile says pnpm**. Use pnpm.