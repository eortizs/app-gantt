import type { CSSProperties } from "react"

export interface WbsLevelStyle {
  bg: string
  fg: string
}

export const WBS_LEVELS: WbsLevelStyle[] = [
  { bg: "#162A4D", fg: "#FFFFFF" },
  { bg: "#4472C3", fg: "#FFFFFF" },
  { bg: "#BDD6EE", fg: "#1F2937" },
  { bg: "#D8D8D8", fg: "#1F2937" },
  { bg: "#F2F2F2", fg: "#1F2937" },
]

const LAST_INDEX = WBS_LEVELS.length - 1

export function wbsLevelStyle(depth: number): CSSProperties {
  const idx = Math.min(Math.max(depth, 0), LAST_INDEX)
  const level = WBS_LEVELS[idx]
  return { backgroundColor: level.bg, color: level.fg }
}
