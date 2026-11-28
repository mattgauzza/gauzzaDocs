import type { Box } from './geometry'
import { num } from './text'

// Path math for SVG import, with no dependency: affine matrices and the transform attribute, path data with every
// command (M L H V C S Q T A Z, absolute and relative), arcs as cubic curves, exact bounds, and turning an even-odd fill
// into the same shape under the nonzero rule (the design format has no fill rule).

/** [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f, as in SVG. */
export type Matrix = [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m after n: applying the result is applying n, then m. */
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0]
export const det = (m: Matrix): number => m[0] * m[3] - m[1] * m[2]

export function invert(m: Matrix): Matrix | null {
  const d = det(m)
  if (!d || !Number.isFinite(d)) return null
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]
}

/** Only a translate or a uniform scale (the same factor on both axes, no rotation or skew). */
export const isSimilarScale = (m: Matrix): boolean => m[1] === 0 && m[2] === 0 && m[0] === m[3] && m[0] !== 0

const NUM = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const SEP = /[\s,]*/y

/** The numbers in a list such as "1 2,3e2 -4". Stops at the first thing that isn't a number. */
export function numbers(s: string): number[] {
  const out: number[] = []
  let i = 0
  for (;;) {
    SEP.lastIndex = i
    SEP.exec(s)
    i = SEP.lastIndex
    NUM.lastIndex = i
    const m = NUM.exec(s)
    if (!m) break
    out.push(parseFloat(m[0]))
    i = NUM.lastIndex
  }
  return out
}

/** A transform attribute as one matrix, or null when it doesn't parse (SVG then ignores the whole attribute). */
export function parseTransform(s: string | null | undefined): Matrix | null {
  const src = String(s ?? '').trim()
  if (!src || src === 'none') return IDENTITY
  const re = /[\s,]*([a-zA-Z]+)\s*\(([^)]*)\)/y
  let m: Matrix = IDENTITY
  let i = 0
  while (i < src.length) {
    re.lastIndex = i
    const hit = re.exec(src)
    if (!hit) return null
    i = re.lastIndex
    const args = numbers(hit[2].replace(/(deg|px)/g, ''))
    const n = args.length
    let t: Matrix
    switch (hit[1]) {
      case 'matrix':
        if (n !== 6) return null
        t = args as Matrix
        break
      case 'translate':
        if (n !== 1 && n !== 2) return null
        t = translate(args[0], args[1] ?? 0)
        break
      case 'scale':
        if (n !== 1 && n !== 2) return null
        t = scale(args[0], args[1] ?? args[0])
        break
      case 'rotate': {
        if (n !== 1 && n !== 3) return null
        const r = (args[0] * Math.PI) / 180
        const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]
        t = n === 3 ? mul(translate(args[1], args[2]), mul(rot, translate(-args[1], -args[2]))) : rot
        break
      }
      case 'skewX':
        if (n !== 1) return null
        t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0]
        break
      case 'skewY':
        if (n !== 1) return null
        t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0]
        break
      default:
        return null
    }
    m = mul(m, t)
  }
  return m.every(Number.isFinite) ? m : null
}

/**
 * One absolute segment. M and L: [x y]. C: [x1 y1 x2 y2 x y]. Q: [x1 y1 x y]. A: [rx ry rotation large sweep x y]
 * with the flags as 0 or 1. Z: [].
 */
export interface Seg { c: 'M' | 'L' | 'C' | 'Q' | 'A' | 'Z'; v: number[] }

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/**
 * Path data as absolute M, L, C, Q, A and Z segments: H and V become L, S becomes C, T becomes Q, and a subpath that
 * goes on after Z starts with an explicit M. Like a browser, it keeps everything up to the first error.
 */
export function parsePath(d: string | null | undefined): Seg[] {
  const s = String(d ?? '')
  const out: Seg[] = []
  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let lastC: [number, number] | null = null // the second control point of the last C, for S
  let lastQ: [number, number] | null = null // the control point of the last Q, for T
  const flag = (): number | null => {
    SEP.lastIndex = i
    SEP.exec(s)
    i = SEP.lastIndex
    const ch = s[i]
    if (ch !== '0' && ch !== '1') return null
    i++
    return +ch
  }
  const number = (): number | null => {
    SEP.lastIndex = i
    SEP.exec(s)
    i = SEP.lastIndex
    NUM.lastIndex = i
    const m = NUM.exec(s)
    if (!m) return null
    i = NUM.lastIndex
    const v = parseFloat(m[0])
    return Number.isFinite(v) ? v : null
  }
  while (i < s.length) {
    SEP.lastIndex = i
    SEP.exec(s)
    i = SEP.lastIndex
    if (i >= s.length) break
    const ch = s[i]
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toUpperCase() in ARGS)) break
      cmd = ch
      i++
      if (!out.length && cmd.toUpperCase() !== 'M') break
      if (cmd === 'Z' || cmd === 'z') {
        if (out.length && out[out.length - 1].c !== 'Z') out.push({ c: 'Z', v: [] })
        cx = sx
        cy = sy
        lastC = lastQ = null
        continue
      }
    } else if (!cmd || cmd === 'Z' || cmd === 'z') break
    const up = cmd.toUpperCase()
    const rel = cmd !== up
    const a: number[] = []
    for (let k = 0; k < ARGS[up]; k++) {
      const v = up === 'A' && (k === 3 || k === 4) ? flag() : number()
      if (v === null) return out
      a.push(v)
    }
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    if (up !== 'M' && out.length && out[out.length - 1].c === 'Z') out.push({ c: 'M', v: [sx, sy] })
    let nextC: [number, number] | null = null
    let nextQ: [number, number] | null = null
    switch (up) {
      case 'M':
        cx = sx = a[0] + ox
        cy = sy = a[1] + oy
        out.push({ c: 'M', v: [cx, cy] })
        cmd = rel ? 'l' : 'L' // more pairs after a move are lines
        break
      case 'L':
      case 'H':
      case 'V':
        if (up === 'L') [cx, cy] = [a[0] + ox, a[1] + oy]
        else if (up === 'H') cx = a[0] + ox
        else cy = a[0] + oy
        out.push({ c: 'L', v: [cx, cy] })
        break
      case 'C':
      case 'S': {
        const ctl: [number, number] = up === 'C' ? [a[0] + ox, a[1] + oy] : lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy]
        const r = up === 'C' ? a.slice(2) : a
        const v: number[] = [ctl[0], ctl[1], r[0] + ox, r[1] + oy, r[2] + ox, r[3] + oy]
        out.push({ c: 'C', v })
        nextC = [v[2], v[3]]
        ;[cx, cy] = [v[4], v[5]]
        break
      }
      case 'Q':
      case 'T': {
        const ctl: [number, number] = up === 'Q' ? [a[0] + ox, a[1] + oy] : lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy]
        const r = up === 'Q' ? a.slice(2) : a
        const v: number[] = [ctl[0], ctl[1], r[0] + ox, r[1] + oy]
        out.push({ c: 'Q', v })
        nextQ = ctl
        ;[cx, cy] = [v[2], v[3]]
        break
      }
      case 'A': {
        const x = a[5] + ox
        const y = a[6] + oy
        const rx = Math.abs(a[0])
        const ry = Math.abs(a[1])
        if (x === cx && y === cy) break // an arc to its own start draws nothing
        out.push(rx && ry ? { c: 'A', v: [rx, ry, a[2], a[3], a[4], x, y] } : { c: 'L', v: [x, y] })
        ;[cx, cy] = [x, y]
        break
      }
    }
    lastC = nextC
    lastQ = nextQ
  }
  return out
}

/**
 * How many vertices path data has where markers can sit: one per command it draws (each move, segment and close, a
 * zero-length arc included), read the way parsePath reads it and stopping at the same first error. Linear, and it
 * builds nothing, so it can count a long path cheaply.
 */
export function pathVertices(d: string | null | undefined): number {
  const s = String(d ?? '')
  let n = 0
  let i = 0
  let cmd = ''
  const skip = () => {
    SEP.lastIndex = i
    SEP.exec(s)
    i = SEP.lastIndex
  }
  while (i < s.length) {
    skip()
    if (i >= s.length) break
    const ch = s[i]
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toUpperCase() in ARGS)) break
      cmd = ch
      i++
      if (!n && cmd.toUpperCase() !== 'M') break
      if (cmd === 'Z' || cmd === 'z') {
        n++
        continue
      }
    } else if (!cmd || cmd === 'Z' || cmd === 'z') break
    const up = cmd.toUpperCase()
    for (let k = 0; k < ARGS[up]; k++) {
      skip()
      if (up === 'A' && (k === 3 || k === 4)) {
        if (s[i] !== '0' && s[i] !== '1') return n
        i++
      } else {
        NUM.lastIndex = i
        if (!NUM.exec(s)) return n
        i = NUM.lastIndex
      }
    }
    n++
    if (up === 'M') cmd = cmd === 'm' ? 'l' : 'L' // more pairs after a move are lines
  }
  return n
}

/** An elliptical arc as cubic curves, each [x1 y1 x2 y2 x y], at most a quarter turn apiece (SVG 1.1 F.6.5). */
export function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, x2: number, y2: number
): number[][] {
  const phi = (rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]]
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, den ? num / den : 0))
  const cxp = (coef * rx * yp) / ry
  const cyp = (-coef * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const ux = (xp - cxp) / rx
  const uy = (yp - cyp) / ry
  const t1 = angle(1, 0, ux, uy)
  let dt = angle(ux, uy, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9))
  const step = dt / n
  const k = (4 / 3) * Math.tan(step / 4)
  const at = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos
  ]
  const tangent = (t: number): [number, number] => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos
  ]
  const out: number[][] = []
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step
    const b = a + step
    const [px, py] = at(a)
    const [qx, qy] = j === n - 1 ? [x2, y2] : at(b)
    const [ax, ay] = tangent(a)
    const [bx, by] = tangent(b)
    out.push([px + k * ax, py + k * ay, qx - k * bx, qy - k * by, qx, qy])
  }
  return out
}

/** Every arc as cubic curves. */
export function withoutArcs(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  for (const s of segs) {
    if (s.c === 'A') {
      const [rx, ry, rot, large, sweep, x, y] = s.v
      for (const c of arcToCubics(cx, cy, rx, ry, rot, !!large, !!sweep, x, y)) out.push({ c: 'C', v: c })
    } else out.push(s)
    ;[cx, cy, sx, sy] = advance(s, cx, cy, sx, sy)
  }
  return out
}

/** The current point and subpath start after a segment. */
function advance(s: Seg, cx: number, cy: number, sx: number, sy: number): [number, number, number, number] {
  if (s.c === 'Z') return [sx, sy, sx, sy]
  const x = s.v[s.v.length - 2]
  const y = s.v[s.v.length - 1]
  return s.c === 'M' ? [x, y, x, y] : [x, y, sx, sy]
}

/**
 * The path under a matrix. Arcs stay arcs under a translate or a uniform scale and become cubic curves under anything
 * else, since a skewed or stretched arc is no longer one SVG can write with its own parameters.
 */
export function transformPath(segs: Seg[], m: Matrix): Seg[] {
  const keepArcs = isSimilarScale(m)
  const src = keepArcs ? segs : withoutArcs(segs)
  const k = Math.abs(m[0])
  return src.map(s => {
    if (s.c === 'Z') return s
    if (s.c === 'A') {
      const [x, y] = apply(m, s.v[5], s.v[6])
      return { c: 'A', v: [s.v[0] * k, s.v[1] * k, s.v[2], s.v[3], s.v[4], x, y] }
    }
    const v: number[] = []
    for (let i = 0; i < s.v.length; i += 2) v.push(...apply(m, s.v[i], s.v[i + 1]))
    return { c: s.c, v }
  })
}

/** Where a cubic's (or quadratic's) derivative is zero on one axis, inside 0..1. */
function extrema(p0: number, p1: number, p2: number, p3?: number): number[] {
  const out: number[] = []
  if (p3 === undefined) {
    const den = p0 - 2 * p1 + p2
    if (den) out.push((p0 - p1) / den)
  } else {
    const a = -p0 + 3 * p1 - 3 * p2 + p3
    const b = 2 * (p0 - 2 * p1 + p2)
    const c = p1 - p0
    if (Math.abs(a) < 1e-12) {
      if (b) out.push(-c / b)
    } else {
      const disc = b * b - 4 * a * c
      if (disc >= 0) {
        const r = Math.sqrt(disc)
        out.push((-b + r) / (2 * a), (-b - r) / (2 * a))
      }
    }
  }
  return out.filter(t => t > 0 && t < 1)
}

const cubicAt = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
const quadAt = (t: number, p0: number, p1: number, p2: number): number => {
  const u = 1 - t
  return u * u * p0 + 2 * u * t * p1 + t * t * p2
}

/** The exact bounds of what the path draws (a lone move draws nothing), or null for an empty path. */
export function pathBounds(segs: Seg[]): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  for (const s of withoutArcs(segs)) {
    if (s.c === 'L' || s.c === 'C' || s.c === 'Q' || s.c === 'Z') add(cx, cy)
    if (s.c === 'L') add(s.v[0], s.v[1])
    else if (s.c === 'Z') add(sx, sy)
    else if (s.c === 'C') {
      const v = s.v
      add(v[4], v[5])
      for (const t of extrema(cx, v[0], v[2], v[4])) add(cubicAt(t, cx, v[0], v[2], v[4]), cubicAt(t, cy, v[1], v[3], v[5]))
      for (const t of extrema(cy, v[1], v[3], v[5])) add(cubicAt(t, cx, v[0], v[2], v[4]), cubicAt(t, cy, v[1], v[3], v[5]))
    } else if (s.c === 'Q') {
      const v = s.v
      add(v[2], v[3])
      for (const t of [...extrema(cx, v[0], v[2]), ...extrema(cy, v[1], v[3])]) add(quadAt(t, cx, v[0], v[2]), quadAt(t, cy, v[1], v[3]))
    }
    ;[cx, cy, sx, sy] = advance(s, cx, cy, sx, sy)
  }
  if (x0 === Infinity) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Path data with three decimals. */
export function pathToString(segs: Seg[]): string {
  return segs.map(s => s.c + s.v.map((v, i) => (s.c === 'A' && (i === 3 || i === 4) ? (v ? '1' : '0') : num(v, 3))).join(' ')).join('')
}

// Even-odd to nonzero. When no two contours cross and none crosses itself, orienting each contour by how deeply it is
// nested (even depth one way, odd depth the other) makes the nonzero rule fill exactly what the even-odd rule fills.

interface Contour { segs: Seg[]; pts: [number, number][]; closed: boolean }

/** The subpaths, each with its outline as a polygon (curves sampled), arcs already gone. */
function contours(segs: Seg[]): Contour[] {
  const out: Contour[] = []
  let cur: Contour | null = null
  let cx = 0
  let cy = 0
  for (const s of withoutArcs(segs)) {
    if (s.c === 'M') {
      cur = { segs: [s], pts: [[s.v[0], s.v[1]]], closed: false }
      out.push(cur)
    } else if (cur) {
      cur.segs.push(s)
      if (s.c === 'Z') cur.closed = true
      else if (s.c === 'L') cur.pts.push([s.v[0], s.v[1]])
      else {
        const v = s.v
        for (let k = 1; k <= 12; k++) {
          const t = k / 12
          cur.pts.push(
            s.c === 'C'
              ? [cubicAt(t, cx, v[0], v[2], v[4]), cubicAt(t, cy, v[1], v[3], v[5])]
              : [quadAt(t, cx, v[0], v[2]), quadAt(t, cy, v[1], v[3])]
          )
        }
      }
    }
    if (s.c === 'Z' && cur) [cx, cy] = cur.pts[0]
    else if (s.c !== 'Z') [cx, cy] = [s.v[s.v.length - 2], s.v[s.v.length - 1]]
  }
  return out
}

const signedArea = (pts: [number, number][]): number => {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function inside(pt: [number, number], poly: [number, number][]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** True when segments ab and cd cross at a point inside both (touching ends doesn't count). */
function crosses(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  const eps = 1e-9
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

/** Outlines with more edges than this aren't checked for crossings (the caller keeps such a shape as SVG). */
export const MAX_EDGES = 2000

/** Whether any two edges of the outlines cross (sweeping along x). */
function anyCrossing(cs: Contour[]): boolean {
  const edges: { a: [number, number]; b: [number, number]; lo: number; hi: number; c: number; i: number; n: number }[] = []
  cs.forEach((ct, c) => {
    const n = ct.pts.length
    for (let i = 0; i < n; i++) {
      const a = ct.pts[i]
      const b = ct.pts[(i + 1) % n]
      edges.push({ a, b, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), c, i, n })
    }
  })
  edges.sort((p, q) => p.lo - q.lo)
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    for (let j = i + 1; j < edges.length && edges[j].lo <= e.hi; j++) {
      const f = edges[j]
      if (e.c === f.c && (Math.abs(e.i - f.i) === 1 || Math.abs(e.i - f.i) === e.n - 1)) continue // neighbors share a point
      if (crosses(e.a, e.b, f.a, f.b)) return true
    }
  }
  return false
}

/** A subpath drawn the other way round. */
function reverseContour(ct: Contour): Seg[] {
  const draw = ct.segs.filter(s => s.c !== 'M' && s.c !== 'Z')
  const starts: [number, number][] = [[ct.segs[0].v[0], ct.segs[0].v[1]]]
  for (const s of draw) starts.push([s.v[s.v.length - 2], s.v[s.v.length - 1]])
  const out: Seg[] = [{ c: 'M', v: starts[starts.length - 1] }]
  for (let k = draw.length - 1; k >= 0; k--) {
    const s = draw[k]
    const [px, py] = starts[k]
    if (s.c === 'L') out.push({ c: 'L', v: [px, py] })
    else if (s.c === 'C') out.push({ c: 'C', v: [s.v[2], s.v[3], s.v[0], s.v[1], px, py] })
    else if (s.c === 'Q') out.push({ c: 'Q', v: [s.v[0], s.v[1], px, py] })
  }
  if (ct.closed) out.push({ c: 'Z', v: [] })
  return out
}

/**
 * The same shape for the nonzero rule as `segs` under the even-odd rule. 'crossing' when contours cross (the two rules
 * then can't be matched by orientation alone); 'too detailed' past 2,000 edges, where the check isn't made.
 */
export function evenOddToNonZero(segs: Seg[]): Seg[] | 'crossing' | 'too detailed' {
  const cs = contours(segs).filter(c => c.pts.length > 1)
  if (cs.reduce((a, c) => a + c.pts.length, 0) > MAX_EDGES) return 'too detailed'
  if (anyCrossing(cs)) return 'crossing'
  const out: Seg[] = []
  cs.forEach((ct, i) => {
    let depth = 0
    for (let j = 0; j < cs.length; j++) if (j !== i && inside(ct.pts[0], cs[j].pts)) depth++
    const area = signedArea(ct.pts)
    const want = depth % 2 === 0 ? 1 : -1
    for (const seg of area * want < 0 ? reverseContour(ct) : ct.segs) out.push(seg)
  })
  return out
}

/** The path drawn the other way round when its contours turn mostly clockwise in y-down space, so unions add up. */
export function positiveWinding(segs: Seg[]): Seg[] {
  const cs = contours(segs)
  const total = cs.reduce((a, c) => a + signedArea(c.pts), 0)
  return total >= 0 ? withoutArcs(segs) : cs.flatMap(reverseContour)
}
