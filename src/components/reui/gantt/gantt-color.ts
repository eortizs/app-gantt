/**
 * Concrete-color helpers for baseline marks.
 *
 * Past baselines use a FIXED pastel ramp of literal hexes - no CSS-variable
 * resolution, no color-mix, no relative color syntax. Those mechanisms fail
 * SILENTLY on some browsers (the whole declaration chain goes invalid and
 * paints transparent), which is exactly how past baselines lost their color
 * reference before. Only the current-baseline bar still derives its tone
 * from the event's own (now concrete-hex) phase color.
 */

/** Fallback tone when a mark's color cannot be resolved (or was omitted). */
const NEUTRAL_FALLBACK = "#6b7280"

interface Rgba {
  r: number // 0..255
  g: number
  b: number
  a: number // 0..1
}

interface Oklch {
  l: number // 0..1
  c: number // >= 0
  h: number // degrees, normalized 0..<360
  a: number
}

// ---------------------------------------------------------------------------
// Resolution: any CSS color (hex / rgb / oklch / var(...) chains) -> RGBA
// ---------------------------------------------------------------------------

let domProbe: HTMLElement | null = null
let canvasCtx: CanvasRenderingContext2D | null | undefined = undefined
const resolvedCache = new Map<string, Rgba | null>()

/** Resolves `var()` chains by letting the document cascade do it. */
function resolveViaDom(value: string): string {
  if (!domProbe) {
    domProbe = document.createElement("span")
    domProbe.setAttribute("aria-hidden", "true")
    const style = domProbe.style
    style.position = "fixed"
    style.visibility = "hidden"
    style.pointerEvents = "none"
    style.display = "none" // computed styles still resolve for display:none
    document.documentElement.appendChild(domProbe)
  }
  domProbe.style.color = ""
  domProbe.style.color = value
  return getComputedStyle(domProbe).color
}

/** Canvas normalizes ANY valid CSS color to sRGB hex/rgba; invalid -> null. */
function parseViaCanvas(css: string): Rgba | null {
  if (canvasCtx === undefined) {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    canvasCtx = canvas.getContext("2d")
  }
  const ctx = canvasCtx
  if (!ctx) return null
  const SENTINEL = "rgba(1, 2, 3, 0.123)"
  ctx.fillStyle = SENTINEL
  ctx.fillStyle = css
  const out = ctx.fillStyle
  if (out === SENTINEL && css.trim().toLowerCase() !== SENTINEL) return null
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(out)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return {
      r: n >> 16,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
      a: hex[2] ? parseInt(hex[2], 16) / 255 : 1,
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(out)
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
  }
  return null
}

function resolveToRgba(input: string | undefined): Rgba | null {
  if (!input) return null
  const key = input.trim()
  if (resolvedCache.has(key)) return resolvedCache.get(key)!
  let rgba: Rgba | null = null
  try {
    let css = key
    if (css.includes("var(")) css = resolveViaDom(css)
    if (css) rgba = parseViaCanvas(css)
  } catch {
    rgba = null // e.g. called before a document exists; stay graceful
  }
  resolvedCache.set(key, rgba)
  return rgba
}

// ---------------------------------------------------------------------------
// sRGB <-> OKLCH (Björn Ottosson's OKLab matrices)
// ---------------------------------------------------------------------------

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055

function srgbToOklch({ r, g, b, a }: Rgba): Oklch {
  const rl = srgbToLinear(r / 255)
  const gl = srgbToLinear(g / 255)
  const bl = srgbToLinear(b / 255)
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl)
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl)
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    l: L,
    c: Math.hypot(A, B),
    h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
    a,
  }
}

function oklchToRgb({ l, c, h, a }: Oklch): Rgba {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.291485548 * B
  const ls = l_ ** 3
  const ms = m_ ** 3
  const ss = s_ ** 3
  const clip = (v: number) => Math.min(255, Math.max(0, Math.round(
    linearToSrgb(Math.min(1, Math.max(0, v))) * 255
  )))
  return {
    r: clip(4.0767416621 * ls - 3.3077115913 * ms + 0.2309699292 * ss),
    g: clip(-1.2684380046 * ls + 2.6097574011 * ms - 0.3413193965 * ss),
    b: clip(-0.0041960863 * ls - 0.7034186147 * ms + 1.707614701 * ss),
    a,
  }
}

const css = ({ r, g, b, a }: Rgba): string =>
  a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${+a.toFixed(3)})`

/** Mixes an OKLCH color toward white by `pct` percent (what color-mix did). */
function mixTowardWhite(color: Oklch, pct: number): Oklch {
  return {
    ...color,
    l: color.l + (1 - color.l) * (pct / 100),
    c: color.c * (1 - pct / 100),
  }
}

// ---------------------------------------------------------------------------
// Public API: the three concrete strings each baseline mark paints with
// ---------------------------------------------------------------------------

export interface BaselineTone {
  /** Resting fill: soft pastel of the mark's own tone. */
  fill: string
  /** Highlight fill: the tone at full strength. */
  full: string
  /** Border tint (current-baseline bar only). */
  border: string
}

/**
 * Fixed pastel ramp for PAST baselines (stack >= 1), newest-first: literal
 * hexes (Tailwind 300/500 pairs) so every version is the same recognizable
 * color on every row and every browser - no derivation that could silently
 * wash out or fall back to gray. The strong partner is the highlight tone.
 */
const PAST_BASELINE_RAMP: ReadonlyArray<{ pastel: string; strong: string }> = [
  { pastel: "#f9a8d4", strong: "#ec4899" }, // pink
  { pastel: "#fcd34d", strong: "#f59e0b" }, // amber
  { pastel: "#6ee7b7", strong: "#10b981" }, // emerald
  { pastel: "#c4b5fd", strong: "#8b5cf6" }, // violet
  { pastel: "#fdba74", strong: "#f97316" }, // orange
  { pastel: "#67e8f9", strong: "#06b6d4" }, // cyan
]

export const DIRTY_LIGHT = "#e5e7eb" // gray-200

/**
 * Bitono pairs for the LIVE bar resting/progress surfaces, derived from the
 * phase color. The resting fill is a soft 80% pastel (so dark text on top
 * stays legible); the progress tint is the phase at full strength with a
 * baked 0.85 alpha, so the progress overlay never goes opaque and clashes
 * with the resting layer underneath.
 */
export interface BarTone {
  /** Opaque, very-light pastel of the phase. */
  light: string
  /** Full phase color at alpha 0.85 (consumer paints verbatim). */
  dark: string
}

export function barTones(color: string | undefined): BarTone {
  const base = resolveToRgba(color) ?? resolveToRgba(NEUTRAL_FALLBACK)!
  const tone = srgbToOklch(base)
  return {
    light: css(oklchToRgb(mixTowardWhite(tone, 80))),
    dark: css({ ...oklchToRgb(tone), a: 0.85 }),
  }
}

/**
 * Tones for one baseline mark. Stack 0 is the baseline IN FORCE and keeps
 * its phase tone (soft 25% pastel fill); older stacks take a FIXED pastel
 * ramp color by depth (pink, amber, emerald, ... cycling), so history is
 * instantly identifiable and versions tell each other apart everywhere.
 */
export function baselineTones(
  color: string | undefined,
  stack: number
): BaselineTone {
  if (stack > 0) {
    const entry = PAST_BASELINE_RAMP[(stack - 1) % PAST_BASELINE_RAMP.length]
    return { fill: entry.pastel, full: entry.strong, border: entry.pastel }
  }
  const base = resolveToRgba(color) ?? resolveToRgba(NEUTRAL_FALLBACK)!
  const tone = srgbToOklch(base)
  return {
    fill: css(oklchToRgb(mixTowardWhite(tone, 25))),
    full: css(oklchToRgb(tone)),
    border: css(oklchToRgb(mixTowardWhite(tone, 55))),
  }
}
