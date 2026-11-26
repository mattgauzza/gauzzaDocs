import type { Box } from './geometry'
import { IDENTITY, type Matrix, apply, det, mul, parseTransform } from './path'
import { hrefId } from './svgClean'
import { type RGBA, hexColor, parseColor } from './svgStyle'
import type { Paint } from './types'

// Lengths and paints for SVG import: colors, and SVG gradients as the design format's gradients. A linear gradient
// maps exactly under any transform (its lines of equal color stay parallel); a radial one is exact only when it stays a
// circle centered on the shape, and is approximated otherwise.

export type Style = Record<string, string>
/** The viewport percentages resolve against. */
export interface Viewport { vw: number; vh: number }

const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8 }

/** A length in px; a percentage of `ref`. Null when it doesn't parse. */
export function len(v: string | null | undefined, ref: number): number | null {
  if (v === null || v === undefined) return null
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v)
  if (!m) return null
  const n = parseFloat(m[1])
  const u = m[2].toLowerCase()
  if (u === '%') return (n / 100) * ref
  return Object.prototype.hasOwnProperty.call(UNITS, u) ? n * UNITS[u] : null
}
export const diagonal = (vp: Viewport): number => Math.sqrt((vp.vw * vp.vw + vp.vh * vp.vh) / 2)

/** The id in `url(#id)`, or null. */
export function urlId(v: string | undefined): string | null {
  const m = /^\s*url\(\s*(['"]?)#([^'")]+)\1\s*\)/i.exec(v ?? '')
  return m ? m[2] : null
}

/** An opacity (a number or a percentage), clamped to 0..1; 1 when missing or bad. */
export function alphaOf(v: string | undefined): number {
  if (v === undefined) return 1
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%?)\s*$/i.exec(v)
  if (!m) return 1
  const n = parseFloat(m[1]) / (m[2] ? 100 : 1)
  return Math.min(1, Math.max(0, n))
}

/** Where a paint is drawn: user space to px, the shape's box in its user space and the layer's box in px. */
export interface PaintSpace { m: Matrix; userBox: Box | null; box: Box }

const solid = (c: RGBA, alpha: number): Paint => ({ type: 'color', color: hexColor([c[0], c[1], c[2], c[3] * alpha]) })

/**
 * A fill or stroke value as a paint. `note` is set when a gradient could only be approximated; `pattern` when the
 * paint is a pattern, which the design format can't hold.
 */
export function paintOf(
  raw: string, s: Style, alpha: number, space: PaintSpace, ids: Map<string, Element>, vp: Viewport
): { paint: Paint | null; note?: string; pattern?: boolean } {
  const v = raw.trim()
  if (!v || v === 'none') return { paint: null }
  const id = urlId(v)
  if (id !== null) {
    const target = ids.get(id)
    if (target && (target.localName === 'linearGradient' || target.localName === 'radialGradient')) {
      return gradientPaint(target, alpha, space, ids, vp)
    }
    if (target && target.localName === 'pattern') return { paint: null, pattern: true }
    const fallback = v.replace(/^\s*url\([^)]*\)\s*/i, '')
    return fallback ? paintOf(fallback, s, alpha, space, ids, vp) : { paint: null }
  }
  const c = v.toLowerCase() === 'currentcolor' ? parseColor(s.color ?? 'black') : parseColor(v)
  return { paint: solid(c ?? [0, 0, 0, 1], alpha) }
}

/** A gradient attribute, following href to the gradients it inherits from. */
function gradAttr(el: Element, name: string, ids: Map<string, Element>): string | null {
  let cur: Element | undefined = el
  for (let i = 0; cur && i <= 8; i++) {
    const v = cur.getAttribute(name)
    if (v !== null && v !== '') return v
    const next = ids.get(hrefId(cur) ?? '')
    cur = next && /Gradient$/.test(next.localName) && next !== el ? next : undefined
  }
  return null
}

/** The stops of the first gradient along the href chain that has any. */
function gradStops(el: Element, ids: Map<string, Element>): { o: number; c: RGBA }[] {
  let cur: Element | undefined = el
  for (let i = 0; cur && i <= 8; i++) {
    const stops: Element[] = []
    for (let n = cur.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).localName === 'stop') stops.push(n as Element)
    if (stops.length) {
      let last = 0
      return stops.map(st => {
        const raw = st.getAttribute('offset') ?? '0'
        const o = Math.min(1, Math.max(last, alphaOf(raw.trim() ? raw : '0')))
        last = o
        const color = st.getAttribute('stop-color') ?? 'black'
        const c = color.trim().toLowerCase() === 'currentcolor' ? parseColor(st.getAttribute('color') ?? 'black') : parseColor(color)
        const a = alphaOf(st.getAttribute('stop-opacity') ?? undefined)
        const rgba = c ?? [0, 0, 0, 1]
        return { o, c: [rgba[0], rgba[1], rgba[2], rgba[3] * a] as RGBA }
      })
    }
    const next = ids.get(hrefId(cur) ?? '')
    cur = next && /Gradient$/.test(next.localName) && next !== el ? next : undefined
  }
  return []
}

const lerp = (a: RGBA, b: RGBA, t: number): RGBA => [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t) as RGBA

/** The color at `t` in 0..1 (padded outside), from the left (side -1) or right (side 1) where stops share an offset. */
function colorAt(stops: { o: number; c: RGBA }[], t: number, side: number): RGBA {
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (t < first.o || (t === first.o && side < 0)) return first.c
  if (t > last.o || (t === last.o && side > 0)) return last.c
  if (side < 0) {
    const j = stops.findIndex(s => s.o >= t)
    if (stops[j].o === t) return stops[j].c
    const a = stops[j - 1]
    return lerp(a.c, stops[j].c, (t - a.o) / (stops[j].o - a.o))
  }
  let j = stops.length - 1
  while (stops[j].o > t) j--
  if (stops[j].o === t || j === stops.length - 1) return stops[j].c
  const b = stops[j + 1]
  return lerp(stops[j].c, b.c, (t - stops[j].o) / (b.o - stops[j].o))
}

/** The color at gradient position `t` under a spread method (pad, repeat or reflect). */
function spreadColor(stops: { o: number; c: RGBA }[], t: number, side: number, spread: string): RGBA {
  if (spread === 'repeat') {
    let f = t - Math.floor(t)
    if (f === 0 && side < 0) f = 1 // the left side of a period boundary is the end of the previous period
    return colorAt(stops, f, side)
  }
  if (spread === 'reflect') {
    const q = t - 2 * Math.floor(t / 2)
    return q <= 1 ? colorAt(stops, q, side) : colorAt(stops, 2 - q, -side)
  }
  return colorAt(stops, t, side)
}

const MAX_PERIODS = 64
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * Stops for the design format's gradient, which runs 0..1 where the SVG gradient runs t0..t1. Every SVG stop inside the
 * span keeps its place and the ends take the color the SVG gradient has there, so the result is exact.
 */
function resample(stops: { o: number; c: RGBA }[], t0: number, t1: number, spread: string): { stops: { offset: number; color: string }[]; approx: boolean } {
  let approx = false
  let mode = spread === 'repeat' || spread === 'reflect' ? spread : 'pad'
  if (mode !== 'pad' && Math.floor(t1) - Math.floor(t0) > MAX_PERIODS) {
    mode = 'pad'
    approx = true
  }
  const marks = new Set<number>()
  if (mode === 'pad') {
    for (const s of stops) if (s.o > t0 && s.o < t1) marks.add(s.o)
  } else {
    for (let k = Math.floor(t0); k <= Math.floor(t1); k++) {
      if (k > t0 && k < t1) marks.add(k)
      for (const s of stops) {
        const t = k + (mode === 'reflect' && k % 2 !== 0 ? 1 - s.o : s.o)
        if (t > t0 && t < t1) marks.add(t)
      }
    }
  }
  const out: { offset: number; color: string }[] = []
  const push = (t: number, side: number) => {
    const offset = r6((t - t0) / (t1 - t0))
    const color = hexColor(spreadColor(stops, t, side, mode))
    const prev = out[out.length - 1]
    if (!prev || prev.offset !== offset || prev.color !== color) out.push({ offset, color })
  }
  push(t0, 1)
  for (const t of [...marks].sort((a, b) => a - b)) {
    push(t, -1)
    push(t, 1)
  }
  push(t1, -1)
  return { stops: out, approx }
}

/** A gradient coordinate: a fraction of the box for objectBoundingBox, else a length. */
function coord(v: string, bbox: boolean, ref: number): number {
  if (bbox) {
    const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%?)\s*$/i.exec(v)
    return m ? parseFloat(m[1]) / (m[2] ? 100 : 1) : 0
  }
  return len(v, ref) ?? 0
}

function gradientPaint(
  el: Element, alpha: number, space: PaintSpace, ids: Map<string, Element>, vp: Viewport
): { paint: Paint | null; note?: string } {
  const stops = gradStops(el, ids).map(s => ({ o: s.o, c: [s.c[0], s.c[1], s.c[2], s.c[3] * alpha] as RGBA }))
  if (!stops.length) return { paint: null }
  const lastColor = (): Paint => solid(stops[stops.length - 1].c, 1)
  if (stops.length === 1) return { paint: lastColor() }
  const attr = (n: string, d: string) => gradAttr(el, n, ids) ?? d
  const bbox = attr('gradientUnits', 'objectBoundingBox') !== 'userSpaceOnUse'
  const ub = space.userBox
  if (bbox && (!ub || !ub.w || !ub.h)) return { paint: null }
  const B: Matrix = bbox && ub ? [ub.w, 0, 0, ub.h, ub.x, ub.y] : IDENTITY
  const A = mul(space.m, mul(B, parseTransform(attr('gradientTransform', '')) ?? IDENTITY))
  const D = det(A)
  const spread = attr('spreadMethod', 'pad')
  const b = space.box
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const diag = Math.sqrt((vp.vw * vp.vw + vp.vh * vp.vh) / 2)
  if (!D || !Number.isFinite(D)) return { paint: lastColor() }

  if (el.localName === 'linearGradient') {
    const x1 = coord(attr('x1', '0%'), bbox, vp.vw)
    const y1 = coord(attr('y1', '0%'), bbox, vp.vh)
    const x2 = coord(attr('x2', '100%'), bbox, vp.vw)
    const y2 = coord(attr('y2', '0%'), bbox, vp.vh)
    const vx = x2 - x1
    const vy = y2 - y1
    const vv = vx * vx + vy * vy
    if (!vv) return { paint: lastColor() }
    // position along the gradient as a function of a px point: t(p) = (p - P1) . g, with g = A^-T v / |v|^2
    const [a, bb, c, d] = A
    const gx = (d * vx - bb * vy) / D / vv
    const gy = (-c * vx + a * vy) / D / vv
    const [px, py] = apply(A, x1, y1)
    const t = (x: number, y: number) => (x - px) * gx + (y - py) * gy
    const angle = Math.atan2(gy, gx)
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const half = (Math.abs(b.w * dx) + Math.abs(b.h * dy)) / 2
    const t0 = t(cx - dx * half, cy - dy * half)
    const t1 = t(cx + dx * half, cy + dy * half)
    if (!(t1 - t0 > 1e-12)) return { paint: solid(spreadColor(stops, t(cx, cy), 1, spread), 1) }
    const out = resample(stops, t0, t1, spread)
    const deg = Math.round(((angle * 180) / Math.PI) * 1e4) / 1e4
    return { paint: { type: 'linear', angle: deg === 0 ? 0 : deg, stops: out.stops }, note: out.approx ? 'its repeating gradient is drawn padded' : undefined }
  }

  const ccx = coord(attr('cx', '50%'), bbox, vp.vw)
  const ccy = coord(attr('cy', '50%'), bbox, vp.vh)
  const r = coord(attr('r', '50%'), bbox, diag)
  const fx = coord(attr('fx', attr('cx', '50%')), bbox, vp.vw)
  const fy = coord(attr('fy', attr('cy', '50%')), bbox, vp.vh)
  if (!(r > 0)) return { paint: lastColor() }
  const [C0, C1] = apply(A, ccx, ccy)
  const R = r * Math.sqrt(Math.abs(D))
  const Rb = Math.hypot(b.w, b.h) / 2
  if (!Rb) return { paint: solid(stops[0].c, 1) }
  const why: string[] = []
  const [a, bb, c, d] = A
  const scale = Math.sqrt(Math.abs(D))
  if (Math.abs(a * a + bb * bb - (c * c + d * d)) > 1e-6 * scale * scale || Math.abs(a * c + bb * d) > 1e-6 * scale * scale) why.push('stretched')
  const [F0, F1] = apply(A, fx, fy)
  if (Math.hypot(F0 - C0, F1 - C1) > 1e-6 * R) why.push('off center focus')
  if (Math.hypot(C0 - cx, C1 - cy) > 1e-3 * Math.max(1, Rb)) why.push('not centered on the shape')
  const out = resample(stops, 0, Rb / R, spread)
  if (out.approx) why.push('repeating')
  return { paint: { type: 'radial', stops: out.stops }, note: why.length ? `its radial gradient is approximated (${why.join(', ')})` : undefined }
}
