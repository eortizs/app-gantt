// Filter switchboard for the plan tree (Ola 1C): presentational popover.
// The MATCHING logic lives in GanttPlanViewer (it owns the live events,
// CPM set and drift policy); this component only edits the filter state.
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { FunnelIcon, RotateCcwIcon } from "lucide-react"
import { APP_STRINGS_ES } from "@/lib/i18n-es"

/** Tree filters; every field defaults to its neutral (no-filter) value. */
export interface PlanFilters {
  /** Substring match on the row title (case-insensitive). */
  text: string
  /** Exact responsable match; "" = any. */
  responsable: string
  /** Exact phase id (resolved through the ancestor chain); "" = any. */
  fase: string
  /** Only rows whose event sits on the critical path (float 0). */
  critical: boolean
  /** Only rows whose live dates drifted from their reference baseline. */
  drifted: boolean
  /** Only milestone rows. */
  milestones: boolean
}

export const EMPTY_PLAN_FILTERS: PlanFilters = {
  text: "",
  responsable: "",
  fase: "",
  critical: false,
  drifted: false,
  milestones: false,
}

/** True when at least one filter narrows the tree. */
export function isPlanFilterActive(f: PlanFilters): boolean {
  return (
    f.text.trim() !== "" ||
    f.responsable !== "" ||
    f.fase !== "" ||
    f.critical ||
    f.drifted ||
    f.milestones
  )
}

export interface PlanFiltersMenuProps {
  filters: PlanFilters
  onChange: (next: PlanFilters) => void
  /** Distinct responsables available in the live plan (sorted). */
  responsables: string[]
  /** Phases of the live plan (id + title). */
  phases: Array<{ id: string; title: string }>
  /** Hidden-row count while filters bite; rendered as a bubble on the trigger. */
  hiddenCount?: number
}

/**
 * Popover editor for the tree filters, pinned inside the tree header's free
 * band next to the WBS level control. Ops keep applying to filtered-out
 * rows (drift/cascade move them regardless) - the hint at the bottom says
 * so explicitly, and the viewer surfaces the hidden-row count as a badge.
 */
export function PlanFiltersMenu({
  filters,
  onChange,
  responsables,
  phases,
  hiddenCount = 0,
}: PlanFiltersMenuProps) {
  const active = isPlanFilterActive(filters)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              hiddenCount > 0
                ? APP_STRINGS_ES.filterHiddenBadge(hiddenCount)
                : APP_STRINGS_ES.filterTitle
            }
            title={APP_STRINGS_ES.filterTitle}
            data-slot="gantt-filters-trigger"
            className="text-muted-foreground hover:text-foreground relative"
          />
        }
      >
        <FunnelIcon className="size-3.5" aria-hidden />
        {hiddenCount > 0 && (
          <span
            data-slot="gantt-filter-hidden"
            className="bg-primary text-primary-foreground absolute -end-1.5 -top-1.5 min-w-2 rounded-full px-0.5 text-center text-[8px] leading-[8px] font-medium tabular-nums"
          >
            {hiddenCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-medium">{APP_STRINGS_ES.filterTitle}</span>
          <input
            type="text"
            data-slot="gantt-filter-text"
            value={filters.text}
            onChange={(e) => onChange({ ...filters, text: e.target.value })}
            placeholder={APP_STRINGS_ES.filterTextPlaceholder}
            aria-label={APP_STRINGS_ES.filterTextLabel}
            className="ring-ring/30 bg-background focus-visible:ring-ring/50 w-full rounded-md px-2 py-1 text-xs ring-1 outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2"
          />
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {APP_STRINGS_ES.filterResponsable}
            </span>
            <select
              data-slot="gantt-filter-responsable"
              value={filters.responsable}
              onChange={(e) =>
                onChange({ ...filters, responsable: e.target.value })
              }
              aria-label={APP_STRINGS_ES.filterResponsable}
              className="bg-background ring-ring/30 w-32 rounded-md px-1 py-0.5 ring-1 outline-none"
            >
              <option value="">{APP_STRINGS_ES.filterAny}</option>
              {responsables.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {APP_STRINGS_ES.filterFase}
            </span>
            <select
              data-slot="gantt-filter-fase"
              value={filters.fase}
              onChange={(e) => onChange({ ...filters, fase: e.target.value })}
              aria-label={APP_STRINGS_ES.filterFase}
              className="bg-background ring-ring/30 w-32 rounded-md px-1 py-0.5 ring-1 outline-none"
            >
              <option value="">{APP_STRINGS_ES.filterAny}</option>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1.5 border-t pt-2">
            {(
              [
                ["critical", APP_STRINGS_ES.filterCritical],
                ["drifted", APP_STRINGS_ES.filterDrifted],
                ["milestones", APP_STRINGS_ES.filterMilestones],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded-sm px-0.5 py-0.5 text-xs"
              >
                <Checkbox
                  checked={filters[key]}
                  onCheckedChange={(checked: boolean) =>
                    onChange({ ...filters, [key]: checked })
                  }
                  aria-label={label}
                  className="size-3.5"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t pt-2">
            <p className="text-muted-foreground max-w-[9rem] text-[10px] leading-tight">
              {APP_STRINGS_ES.filterHiddenHint}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!active}
              onClick={() => onChange(EMPTY_PLAN_FILTERS)}
              data-slot="gantt-filters-clear"
            >
              <RotateCcwIcon aria-hidden />
              {APP_STRINGS_ES.filterClear}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
