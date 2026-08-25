import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Columns3Icon, RotateCcwIcon } from "lucide-react"
import { APP_STRINGS_ES } from "@/lib/i18n-es"

export interface TreeColumnsMenuProps {
  /** Every available column (visible or hidden), in display order. */
  columns: Array<{ id: string; title: string }>
  hiddenIds: string[]
  /** Whether any user-resized width is in effect (gates the reset item). */
  hasCustomWidths: boolean
  onToggle: (id: string, visible: boolean) => void
  onResetWidths: () => void
}

/**
 * Show/hide switchboard for the tree-panel columns, pinned by the engine at
 * the end of the tree header (`columnsMenu`). Toggles keep the menu open so
 * several columns can be flipped in one visit.
 */
export function TreeColumnsMenu({
  columns,
  hiddenIds,
  hasCustomWidths,
  onToggle,
  onResetWidths,
}: TreeColumnsMenuProps) {
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={APP_STRINGS_ES.columnsMenuTrigger}
            title={APP_STRINGS_ES.columnsMenuTrigger}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Columns3Icon className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {APP_STRINGS_ES.columnsMenuTitle}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={!hiddenSet.has(column.id)}
            onCheckedChange={(checked: boolean) =>
              onToggle(column.id, checked)
            }
            closeOnClick={false}
          >
            {column.title}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hasCustomWidths} onClick={onResetWidths}>
          <RotateCcwIcon aria-hidden />
          {APP_STRINGS_ES.columnsMenuResetWidths}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
