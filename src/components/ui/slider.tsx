import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

/**
 * Custom slider (blue thumb) that exposes the current value through a small
 * floating label while the user is dragging. Pointer/keyboard events are
 * owned locally so the gesture does not fight the native range track.
 */
function Slider({
  className,
  min,
  max,
  step = 1,
  value,
  onChange,
  "aria-label": ariaLabel,
  variant = "blue",
  tooltipText,
}: {
  className?: string
  min: number
  max: number
  step?: number
  value: number
  onChange: (value: number) => void
  "aria-label"?: string
  /** Color theme. Blue (default) for primary actions, black for secondary. */
  variant?: "blue" | "black"
  /** Override the tooltip body (default: numeric `value`). Useful when the
   *  slider stands in for a categorical picker. */
  tooltipText?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  // Viewport anchor captured ONCE per drag: hosts with sticky/overflow
  // ancestors (the gantt tree header) clip or bury an absolutely-positioned
  // tooltip, so the label portals to <body> as position:fixed. The track
  // cannot move mid-gesture (touch-none, pointer captured) - the thumb's x
  // derives from this anchor + pct, keeping the render ref-free.
  const [dragAnchor, setDragAnchor] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
  const dragging = dragAnchor !== null
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0

  const snap = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return value
      const fraction = Math.min(
        Math.max((clientX - rect.left) / rect.width, 0),
        1,
      )
      const raw = min + fraction * (max - min)
      const stepped = Math.round(raw / step) * step
      return Math.min(Math.max(stepped, min), max)
    },
    [min, max, step, value],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: globalThis.PointerEvent) => onChange(snap(e.clientX))
    const onUp = () => setDragAnchor(null)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [dragging, snap, onChange])

  const start = (e: PointerEvent<HTMLDivElement>) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const rect = trackRef.current?.getBoundingClientRect()
    if (rect) setDragAnchor({ left: rect.left, top: rect.top, width: rect.width })
    onChange(snap(e.clientX))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault()
      onChange(Math.max(value - step, min))
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault()
      onChange(Math.min(value + step, max))
    } else if (e.key === "Home") {
      e.preventDefault()
      onChange(min)
    } else if (e.key === "End") {
      e.preventDefault()
      onChange(max)
    }
  }

  return (
    <div
      ref={trackRef}
      data-slot="slider"
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex h-4 w-full cursor-pointer touch-none select-none items-center",
        className,
      )}
    >
      <div className="absolute inset-x-0 h-[4.5px] rounded-full bg-muted" />
      <div
        className={cn(
          "absolute h-[4.5px] rounded-full",
          variant === "black" ? "bg-foreground" : "bg-blue-500",
        )}
        style={{ width: `${pct}%` }}
      />
      <div
        data-slot="slider-thumb"
        className={cn(
          "absolute size-[11.52px] -translate-x-1/2 rounded-full border bg-white shadow-sm",
          variant === "black" ? "border-foreground" : "border-blue-500",
        )}
        style={{ left: `${pct}%` }}
      />
      {dragAnchor &&
        createPortal(
          <div
            data-slot="slider-tooltip"
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md"
            style={{
              left: dragAnchor.left + (pct / 100) * dragAnchor.width,
              top: dragAnchor.top - 8,
            }}
          >
            {tooltipText ?? value}
          </div>,
          document.body,
        )}
    </div>
  )
}

export { Slider }
