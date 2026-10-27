import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flash, Limit, Measure, Style, TurnTokens } from '../types'

const measure = atom({ plugin: 'usage-band', key: 'measure' } as const, null)
const turn = atom({ plugin: 'usage-band', key: 'turn' } as const, null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const phase = atom({ plugin: 'usage-band', key: 'phase' } as const, 0)
const style = atom({ plugin: 'usage-band', key: 'style' } as const, 'unicode')
const flash = atom({ plugin: 'usage-band', key: 'flash' } as const, null)

// One hue per metric; RED takes over only when a metric is in trouble
const HUE = { five: '#5cc4d6', seven: '#e8a25f', ctx: '#9aa5f5', cache: '#72cf9f' }
const RED = '#e5685f'
const TRACK = '#4a4f5c'
const FRAME_MS = 200
// How often a session checks the shared store for a newer limit reading
const POLL_MS = 15_000
// A figure that changes sweeps its shine once: SHINE_S on the desktop, SWEEP frames in the
// terminal (8 cells and the glow's run-out). The flash is cleared once both are long over.
const SHINE_S = 1.6
const SWEEP = 13
const FLASH_MS = 5_000
const PREVIEW = 'usage-band-preview'

export const GLYPHS: Record<Style, { ctx: string; hit: string; fill: string; track: string }> = {
  nerd: { ctx: '\u{F0328} ', hit: '\u{F04FE} ', fill: '■', track: '■' },
  unicode: { ctx: '≡ ', hit: '● ', fill: '■', track: '■' },
  ascii: { ctx: 'ctx ', hit: 'hit ', fill: '#', track: '-' },
}

// Terminals known to ship Nerd Font symbols without the user installing a font
const NERD_BUILTIN = new Set(['ghostty'])

export const detectStyle = (setting: string, termProgram: string | undefined): Style => {
  if (setting === 'nerd' || setting === 'unicode' || setting === 'ascii') return setting
  return NERD_BUILTIN.has((termProgram ?? '').toLowerCase()) ? 'nerd' : 'unicode'
}

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

export const fmtLeft = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export const hitRate = (t: TurnTokens): number | null => {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? null : Math.round((t.cacheRead / total) * 100)
}

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const ch = (v: number) => Math.round(v + (target - v) * Math.abs(t)).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

// Nearest xterm-256 color, to preview how a 256-color terminal shows the band
export const to256 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const levels = [0, 95, 135, 175, 215, 255]
  const nearest = (v: number) => levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
  const cube = rgb.map(nearest)
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const g = Math.min(238, Math.max(8, 8 + Math.round((avg - 8) / 10) * 10))
  const dist = (c: readonly number[]) => c.reduce((s, v, i) => s + (v - rgb[i]!) ** 2, 0)
  const pick = dist(cube) <= dist([g, g, g]) ? cube : [g, g, g]
  return `#${pick.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// A window whose reset time has passed is empty until the next reading says otherwise
export const windowOf = (m: Measure | null, kind: string, at: number): Limit | undefined => {
  const l = m?.rateLimits.find(r => r.kind === kind)
  if (l?.resetsAt && at > 0 && Date.parse(l.resetsAt) <= at) return { kind, percentUsed: 0 }
  return l
}

export type Span = { text: string; color?: string; dim?: boolean }

const LIMITS = ['five_hour', 'seven_day'] as const

// The figures a flash is keyed by, as the band shows them
export const figures = (m: Measure | null, at: number): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const kind of LIMITS) {
    const l = windowOf(m, kind, at)
    if (l) out[kind] = String(Math.round(l.percentUsed))
  }
  if (m) out.ctx = fmtTokens(m.context.tokens ?? 0)
  return out
}
export type Look = { style: Style; colors: 'true' | '256' }

const SEP: Span = { text: '  ' }

export const width = (spans: Span[]) => spans.reduce((n, s) => n + [...s.text].length, 0)

// A bar whose filled part runs from a deep shade of its color to a bright one,
// with a soft highlight sweeping left to right on top; a null frame draws it at rest
export const bar = (pct: number, cells: number, color: string, frame: number | null, s: Style = 'unicode'): Span[] => {
  const g = GLYPHS[s]
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  // Same period for every bar, so all highlights travel in step
  const pos = frame === null ? -2 : frame % (cells + 5)
  const spans: Span[] = []
  for (let i = 0; i < filled; i++) {
    const shade = filled === 1 ? 0 : -0.15 + (0.35 * i) / (filled - 1)
    const glow = i === pos ? 0.55 : i === pos - 1 || i === pos + 1 ? 0.25 : 0
    spans.push({ text: g.fill, color: lighten(lighten(color, shade), glow) })
  }
  if (cells > filled) spans.push({ text: g.track.repeat(cells - filled), color: TRACK })
  return spans
}

// detail 2: bars + countdowns; 1: no bars; 0: bare numbers
export const layout = (
  m: Measure | null,
  t: TurnTokens | null,
  at: number,
  detail: 0 | 1 | 2,
  frame: number | null = 0,
  look: Look = { style: 'unicode', colors: 'true' },
  lit: readonly string[] = LIMITS,
): Span[] => {
  const g = GLYPHS[look.style]
  const groups: Span[][] = []

  const limit = (label: string, l: Limit | undefined, hue: string) => {
    if (!l) return
    const f = lit.includes(l.kind) ? frame : null
    const pct = Math.round(l.percentUsed)
    const color = pct >= 80 ? RED : hue
    const out: Span[] = [{ text: `${label} `, color }]
    if (detail === 2) out.push(...bar(pct, 8, color, f, look.style), { text: ' ' })
    out.push({ text: `${pct}%`, color })
    if (detail >= 1 && l.resetsAt) out.push({ text: ` · ${fmtLeft(Date.parse(l.resetsAt) - at)}`, dim: true })
    groups.push(out)
  }
  limit('5h', windowOf(m, 'five_hour', at), HUE.five)
  limit('7d', windowOf(m, 'seven_day', at), HUE.seven)

  if (m) {
    const pct = m.context.percent ?? 0
    const color = pct >= 80 ? RED : HUE.ctx
    groups.push([
      { text: g.ctx, color },
      { text: fmtTokens(m.context.tokens ?? 0), color },
      { text: `/${fmtTokens(m.context.window)}`, dim: true },
    ])
  }

  const hit = t ? hitRate(t) : null
  if (hit !== null) {
    const color = hit < 50 ? RED : HUE.cache
    groups.push([
      { text: g.hit, color },
      { text: `${hit}%`, color },
    ])
  }

  const spans = groups.flatMap((grp, i) => (i === 0 ? grp : [SEP, ...grp]))
  return look.colors === '256' ? spans.map(s => (s.color ? { ...s, color: to256(s.color) } : s)) : spans
}

const fit = (m: Measure | null, t: TurnTokens | null, at: number, cols: number, frame: number | null, look: Look, lit: readonly string[]) =>
  ([2, 1, 0] as const).map(d => layout(m, t, at, d, frame, look, lit)).find(s => width(s) <= cols) ??
  layout(m, t, at, 0, frame, look, lit)


// ---- Desktop: the band is one SVG drawn as a plain image. The SMIL shine runs in an image too,
// and an image redraws in place, where an interactive (framed) SVG reloads its frame and blinks
// the whole band on every redraw.

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// CAP: the band the figures' cap height occupies (Inter 13px on baseline 19.5);
// icons, dots and the inner rule are sized to it so the row reads one height
const CAP = { top: 9.75, h: 10 }
const D = { h: 30, gap: 30, inner: 7, sm: 13, md: 13, base: 13, barW: 76, barH: 6 }
// Advance widths in em for Inter with tabular figures (SF Pro, the fallback, runs within a few %).
// Each text also sets textLength to this width, so a font that runs wider or narrower only
// changes letter spacing and never pushes into the next element.
const ADVANCE: Record<string, number> = { h: 0.58, d: 0.6, m: 0.9, K: 0.64, M: 0.84, '%': 0.84, '/': 0.36, '.': 0.27, ' ': 0.26 }
// Extra space between letters, in px; textLength spreads it evenly across each string
const TRACKING = 0.2
const textW = (v: string, size: number) =>
  [...v].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.62 : (ADVANCE[c] ?? 0.6)), 0) * size +
  TRACKING * Math.max(0, [...v].length - 1)

// Text tinted toward the hue: deeper on light backgrounds, lighter on dark ones
const pinW = (v: string, size: number) => `textLength="${textW(v, size).toFixed(1)}" lengthAdjust="spacing"`
const ink = (hue: string, x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${esc(v)}</text>`
const mute = (x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="mute">${esc(v)}</text>`

// One pass of the shine over [x, x + w], clipped to the lit part; it plays as the image loads,
// so it runs again only when the band is drawn with this group's figure changed
const sweep = (clip: string, x: number, y: number, h: number, w: number) =>
  `<g clip-path="url(#${clip})"><rect x="${x - 18}" y="${y}" width="18" height="${h}" fill="url(#shine)">` +
  `<animate attributeName="x" values="${x - 18};${x + w}" dur="${SHINE_S}s" fill="freeze"/></rect></g>`

// stat: type, icons and rules; motion: bars and dots with their shine
type Layers = { stat: string; motion: string }
type Group = { width: number; draw: (x: number) => Layers }

// 5h 60% ▬▬▬▬── 1h49m: the figure first, so the state reads before the bar
// 5h ▬▬▬▬▬▬──── 69% │ 1h31m: label, bar, figure, then when it resets
const limitGroup = (id: string, label: string, l: Limit, hue: string, at: number, shine: boolean): Group => {
  const pct = Math.round(l.percentUsed)
  const color = pct >= 80 ? RED : hue
  const pctText = `${pct}%`
  const left = l.resetsAt ? fmtLeft(Date.parse(l.resetsAt) - at) : ''
  const labelW = textW(label, D.base) + D.inner
  const pctW = textW(pctText, D.base)
  const width = labelW + D.barW + D.inner + pctW + (left ? D.inner * 2 + 1 + textW(left, D.sm) : 0)
  const fillW = Math.max(pct > 0 ? D.barH : 0, Math.min(D.barW, (D.barW * pct) / 100))
  return {
    width,
    draw: x => {
      const bx = x + labelW
      const y = (D.h - D.barH) / 2
      const r = D.barH / 2
      const px = bx + D.barW + D.inner
      const motion = [
        `<defs><clipPath id="c-${id}"><rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}"/></clipPath></defs>`,
        `<rect x="${bx}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${r}" class="track" style="--h:${color}"/>`,
        `<rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}" fill="${lighten(color, -0.12)}"/>`,
        // The shine crosses the whole bar once, showing only over the fill, so bars that change
        // together sweep in step
        shine ? sweep(`c-${id}`, bx, y, D.barH, D.barW) : '',
      ]
      const stat = [ink(color, x, 19.5, label, D.base), ink(color, px, 19.5, pctText, D.base)]
      if (left) {
        const rx = px + pctW + D.inner
        stat.push(`<rect x="${rx}" y="${CAP.top}" width="1" height="${CAP.h}" class="rule"/>`, mute(rx + 1 + D.inner, 19.5, left, D.sm))
      }
      return { stat: stat.join(''), motion: motion.join('') }
    },
  }
}

// Three stacked sheets: the context window
const layersIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round">` +
  `<path d="M5 0.6 L9.4 2.8 L5 5 L0.6 2.8 Z" fill="${color}" fill-opacity="0.25"/>` +
  `<path d="M0.6 5.2 L5 7.4 L9.4 5.2"/><path d="M0.6 7.2 L5 9.4 L9.4 7.2"/></g>`

// A target: how much of the prompt the cache hit
const targetIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="${color}"/></g>`

// Icons are drawn in a CAP.h square, outer stroke edge included
const ICON = CAP.h

// icon · NUMBER suffix
const typeGroup = (icon: (c: string) => string, hue: string, num: string, suffix: string): Group => {
  const lw = ICON + 6
  const nw = textW(num, D.md)
  const sw = suffix ? textW(suffix, D.sm) + 1 : 0
  return {
    width: lw + nw + sw,
    draw: x => {
      const nx = x + lw
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${icon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          (suffix ? mute(nx + nw + 1, 19.5, suffix, D.sm) : ''),
        motion: '',
      }
    },
  }
}

// Context as a 2×10 dot matrix: one dot per 1/20 of the window (50K of 1M), filling the top
// row left to right before the bottom one, with the same shine over the lit dots
// Rows sit so the dots' outer edges meet the CAP band: CAP.top + r and CAP.top + CAP.h - r
const DOTS = { cols: 10, pitch: 5, r: 1.6, rows: [11.35, 18.15] }
const ctxGroup = (hue: string, tokens: number, window: number, pct: number, shine: boolean): Group => {
  const lit = Math.min(DOTS.cols * 2, Math.round((pct / 100) * DOTS.cols * 2))
  const num = fmtTokens(tokens)
  const suffix = `/${fmtTokens(window)}`
  const lw = ICON + 6
  const matrixW = DOTS.cols * DOTS.pitch
  return {
    width: lw + matrixW + D.inner + textW(num, D.md) + 1 + textW(suffix, D.sm),
    draw: x => {
      const mx = x + lw
      const dot = (i: number) =>
        `<circle cx="${mx + DOTS.pitch / 2 + (i % DOTS.cols) * DOTS.pitch}" cy="${DOTS.rows[Math.floor(i / DOTS.cols)]}" r="${DOTS.r}"/>`
      const on = Array.from({ length: lit }, (_, i) => dot(i)).join('')
      const off = Array.from({ length: DOTS.cols * 2 - lit }, (_, i) => dot(lit + i)).join('')
      const nx = mx + matrixW + D.inner
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${layersIcon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          mute(nx + textW(num, D.md) + 1, 19.5, suffix, D.sm),
        motion:
          `<defs><clipPath id="c-ctx">${on}</clipPath></defs>` +
          `<g class="track" style="--h:${hue}">${off}</g>` +
          `<g fill="${lighten(hue, -0.12)}">${on}</g>` +
          (shine ? sweep('c-ctx', mx, 8, 14, matrixW) : ''),
      }
    },
  }
}

// An image takes its color scheme from the app; a frame (should the band ever be framed) whose color scheme differs from the app's
// gets an opaque canvas behind it (white in a dark app). Declaring both schemes lets it follow the
// app and stay transparent.
const SVG_HEAD =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.track{fill:var(--h);fill-opacity:.22}` +
  `.ink{fill:var(--l)}.mute{fill:#8b8f97;font-weight:400}.rule{fill:#000;fill-opacity:.1}.sep{fill:#000;fill-opacity:.2}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.rule{fill:#fff;fill-opacity:.13}.sep{fill:#fff;fill-opacity:.22}}` +
  `</style>` +
  `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`

const wrap = (width: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${D.h}" viewBox="0 0 ${width} ${D.h}" style="color-scheme:light dark;background:transparent">${SVG_HEAD}${body}</svg>`

export type Part = Layers & { width: number; alt: string }

export const desktopParts = (m: Measure | null, t: TurnTokens | null, at: number, lit: readonly string[] = []): Part[] => {
  const groups: { g: Group; alt: string }[] = []
  const five = windowOf(m, 'five_hour', at)
  const seven = windowOf(m, 'seven_day', at)
  if (five) groups.push({ g: limitGroup('5h', '5h', five, HUE.five, at, lit.includes('five_hour')), alt: `5-hour limit ${Math.round(five.percentUsed)}% used` })
  if (seven) groups.push({ g: limitGroup('7d', '7d', seven, HUE.seven, at, lit.includes('seven_day')), alt: `7-day limit ${Math.round(seven.percentUsed)}% used` })
  if (m) {
    const pct = m.context.percent ?? 0
    groups.push({
      g: ctxGroup(pct >= 80 ? RED : HUE.ctx, m.context.tokens ?? 0, m.context.window, pct, lit.includes('ctx')),
      alt: `context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`,
    })
  }
  const hit = t ? hitRate(t) : null
  if (hit !== null) groups.push({ g: typeGroup(targetIcon, hit < 50 ? RED : HUE.cache, `${hit}%`, ''), alt: `cache hit ${hit}%` })
  return groups.map(({ g, alt }) => {
    const width = Math.ceil(g.width + 2)
    return { ...g.draw(1), width, alt }
  })
}

// One SVG for the whole band, so every shine runs on the same clock. Groups sit D.gap apart
// with a hairline centred in each gap; the one inside a limit group is shorter and fainter.
// lit names the figures whose shine plays as this drawing loads.
export const desktopSvg = (m: Measure | null, t: TurnTokens | null, at: number, lit: readonly string[] = []) => {
  let x = 0
  const body: string[] = []
  desktopParts(m, t, at, lit).forEach((p, i) => {
    if (i > 0) body.push(`<rect x="${Math.round(x - D.gap / 2)}" y="7" width="1" height="16" class="sep"/>`)
    body.push(`<g transform="translate(${x} 0)">${p.stat}${p.motion}</g>`)
    x += p.width + D.gap
  })
  const width = Math.max(1, Math.ceil(x - D.gap))
  return { svg: wrap(width, body.join('')), width, height: D.h }
}

export const describe = (m: Measure | null, t: TurnTokens | null, at = 0) => {
  const parts: string[] = []
  const five = windowOf(m, 'five_hour', at)
  const seven = windowOf(m, 'seven_day', at)
  if (five) parts.push(`5-hour limit ${Math.round(five.percentUsed)}% used`)
  if (seven) parts.push(`7-day limit ${Math.round(seven.percentUsed)}% used`)
  if (m) parts.push(`context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`)
  const hit = t ? hitRate(t) : null
  if (hit !== null) parts.push(`cache hit ${hit}%`)
  return parts.join(', ')
}

// The desktop app redraws the band, and its frame blinks, on every write a drawing reads. So a
// reading is only written when it changes what the band shows: a new token count that rounds to
// the same figure, or a clock tick that leaves every countdown as it was, writes nothing.
const shown = (m: Measure | null, t: TurnTokens | null, at: number) => desktopSvg(m, t, at).svg

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const [m, t, was, f] = [await read($, measure), await read($, turn), await read($, now), await read($, flash)]
  // A spent flash is dropped, so a later redraw (a countdown moving on) plays no shine
  if (f && at - f.at >= FLASH_MS) await update($, flash, () => null)
  if (was && shown(m, t, was) === shown(m, t, at)) return
  await update($, now, () => at)
}

// The engine's limits come from this session's last response, so a session left idle never sees
// what other sessions spend. Every session publishes its readings to the plugin's store, one file
// they all share, and adopts any newer one it finds there.
const SHARED = 'limits'
type Shared = { at: number; rateLimits: Limit[] }

const isShared = (v: unknown): v is Shared =>
  typeof v === 'object' && v !== null && typeof (v as Shared).at === 'number' && Array.isArray((v as Shared).rateLimits)

const publish = async ($: EngineInterface, rateLimits: Limit[], at: number) => {
  const held = await $.store.get(SHARED)
  if (isShared(held) && held.at >= at) return
  await $.store.set(SHARED, { at, rateLimits } satisfies Shared)
}

const adopt = async ($: EngineInterface, seenAt: number): Promise<number> => {
  const held = await $.store.get(SHARED)
  if (!isShared(held) || held.at <= seenAt || held.rateLimits.length === 0) return seenAt
  const m = await read($, measure)
  if (!m) return seenAt
  await setMeasure($, { context: m.context, rateLimits: held.rateLimits })
  return held.at
}

const setMeasure = async ($: EngineInterface, next: Measure) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (m && shown(m, t, at) === shown(next, t, at)) return
  const [was, is] = [figures(m, at), figures(next, at)]
  const keys = Object.keys(is).filter(k => is[k] !== was[k])
  if (keys.length > 0) {
    const [clock, frame] = [await $.clock.now(), await read($, phase)]
    await update($, flash, () => ({ keys, at: clock, frame }))
  }
  await update($, measure, () => next)
}

const setTurn = async ($: EngineInterface, next: TurnTokens) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (t && shown(m, t, at) === shown(m, next, at)) return
  await update($, turn, () => next)
}

// Shown by the preview when the session has no reading yet
const SAMPLE_MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
}
const SAMPLE_TURN: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }

const PROFILES: { name: string; look: Look }[] = [
  { name: 'Ghostty', look: { style: 'nerd', colors: 'true' } },
  { name: 'iTerm2 / Warp / WezTerm / kitty', look: { style: 'unicode', colors: 'true' } },
  { name: 'macOS Terminal (256 colors)', look: { style: 'unicode', colors: '256' } },
  { name: 'ascii fallback', look: { style: 'ascii', colors: '256' } },
]

// Icon set override, read from USAGE_BAND_ICONS. It is an environment variable rather than a
// plugin option so a fresh install has nothing to configure.
const ICONS_ENV = 'USAGE_BAND_ICONS'

export const WELCOME =
  'usage-band is on: your 5h and 7d limits, context window and cache hit rate now show above the prompt. ' +
  'The limits fill in after Claude’s first reply.'

export const register: Register = on => {
  let setting = 'auto'
  // The terminal animates by redrawing; started by its first draw, so a desktop-only session
  // never runs it. A reload drops the timer and this flag together.
  let isAnimating = false
  // When the limits this session shows were read, by whichever session read them
  let seenAt = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    setting = ((await $.env.get('USAGE_BAND_ICONS')) ?? 'auto').trim().toLowerCase() || 'auto'
    const term = await $.env.get('TERM_PROGRAM')
    await update($, style, () => detectStyle(setting, term))
    await $.command.register({
      name: PREVIEW,
      description: 'Preview how the usage band looks in different terminals',
    })
    // One welcome after install, so a new user knows what appeared above the prompt
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(WELCOME, { timeoutMs: 12_000 })
    }
    const usage = await $.session.usage()
    await setMeasure($, { context: usage.context, rateLimits: usage.rateLimits })
    seenAt = await adopt($, seenAt)
    await tick($)
    $.clock.every(POLL_MS, async () => {
      seenAt = await adopt($, seenAt)
      await tick($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    // Limits this session's responses left unchanged keep whatever newer reading was adopted
    const moved = e.changed.includes('rateLimits')
    const held = await read($, measure)
    const m: Measure = {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits:
        moved || !held
          ? e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
          : held.rateLimits,
    }
    await setMeasure($, m)
    if (moved && m.rateLimits.length > 0) {
      seenAt = await $.clock.now()
      await publish($, m.rateLimits, seenAt)
    }
    await tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; subagent runs raise their own turn.complete
    if (e.agentId === undefined && e.usage) {
      const u = e.usage
      await setTurn($, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      })
    }
    return next(e)
  })

  on('command.run', { command: PREVIEW }, async () => ({
    text: `usage-band style preview (${ICONS_ENV}: ${setting})`,
  }))

  on('ui.render', { component: 'CommandOutput', props: { command: PREVIEW } }, async ($, e) => {
    const m = (await read($, measure)) ?? SAMPLE_MEASURE
    const t = (await read($, turn)) ?? SAMPLE_TURN
    const at = await read($, now)
    const current = await read($, style)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS_ENV}: {setting} → using {current}
        </Text>
        {PROFILES.map(p => (
          <Box key={p.name} flexDirection="column" marginTop={1}>
            <Text dimColor>{p.name}</Text>
            <Box flexDirection="row">
              {layout(m, t, at, 2, 3, p.look).map((s, i) => (
                <Text key={`s${i}`} color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, measure)
    const t = await read($, turn)
    const at = await read($, now)
    const f = await read($, flash)
    if (e.props.hasSurvey || (m === null && t === null)) return next(e)

    // Desktop and mobile animate inside the SVG, so they never read the frame counter
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Svg } = $.ui.resolve(e)
      const { svg, width, height } = desktopSvg(m, t, at, f?.keys)
      return (
        <Box flexDirection="row" justifyContent="center" flexGrow={1} paddingX={1}>
          <Svg source={svg} alt={describe(m, t, at)} width={width} height={height} />
        </Box>
      )
    }

    if (!isAnimating) {
      isAnimating = true
      // Frames advance only while a sweep is under way, so a resting band is never redrawn
      $.clock.every(FRAME_MS, async () => {
        const [held, p] = [await read($, flash), await read($, phase)]
        if (held && p - held.frame < SWEEP) await update($, phase, n => (n ?? 0) + 1)
      })
    }
    const p = await read($, phase)
    const frame = f && p - f.frame < SWEEP ? p - f.frame : null
    // The terminal font decides icons; other surfaces (vscode) get the plain set
    const s = e.surface === 'terminal' ? await read($, style) : 'unicode'
    const spans = fit(m, t, at, e.props.bodyColumns - 2, frame, { style: s, colors: 'true' }, f?.keys ?? [])
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
        {spans.map((sp, i) => (
          <Text key={`s${i}`} color={sp.color} dimColor={sp.dim}>
            {sp.text}
          </Text>
        ))}
      </Box>
    )
  })
}
