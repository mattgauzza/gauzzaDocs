import { walk } from './model'
import type { Artboard, Design, Layer } from './types'

// Layer geometry for the renderer: boxes, their bounds after rotation and scale, and connector routes.

export type Point = [number, number]
export interface Box { x: number; y: number; w: number; h: number }

/** A finite number, else `d`. */
export const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** A layer's box with negative sizes flipped, so `w` and `h` are never negative. */
export function boxOf(l: { x: number; y: number; width: number; height: number }): Box {
  let x = fin(l.x, 0)
  let y = fin(l.y, 0)
  let w = fin(l.width, 0)
  let h = fin(l.height, 0)
  if (w < 0) [x, w] = [x + w, -w]
  if (h < 0) [y, h] = [y + h, -h]
  return { x, y, w, h }
}

export function boundsOf(pts: Point[]): Box {
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export const union = (a: Box, b: Box): Box =>
  boundsOf([[a.x, a.y], [a.x + a.w, a.y + a.h], [b.x, b.y], [b.x + b.w, b.y + b.h]])

export const grow = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by })

export const centerOf = (b: Box): Point => [b.x + b.w / 2, b.y + b.h / 2]

/** Where `area` lands after the layer's own scale and rotation about its box center, as an upright box. */
export function transformedBounds(area: Box, l: Layer): Box {
  const [cx, cy] = centerOf(boxOf(l))
  const sx = fin(l.scaleX, 1)
  const sy = fin(l.scaleY, 1)
  const r = (fin(l.rotation, 0) * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const corners: Point[] = [[area.x, area.y], [area.x + area.w, area.y], [area.x, area.y + area.h], [area.x + area.w, area.y + area.h]]
  return boundsOf(
    corners.map(([x, y]) => {
      const dx = (x - cx) * sx
      const dy = (y - cy) * sy
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as Point
    })
  )
}

type Side = 'top' | 'right' | 'bottom' | 'left'
function sideMid(b: Box, s: Side): Point {
  const [cx, cy] = centerOf(b)
  return s === 'top' ? [cx, b.y] : s === 'bottom' ? [cx, b.y + b.h] : s === 'left' ? [b.x, cy] : [b.x + b.w, cy]
}
/** Where the line from the box center toward `to` crosses the box edge. */
function edgeToward(b: Box, to: Point): Point {
  const [cx, cy] = centerOf(b)
  const dx = to[0] - cx
  const dy = to[1] - cy
  if (!dx && !dy) return [cx, cy]
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return [cx + dx * t, cy + dy * t]
}
const explicitSide = (s: unknown): Side | null => (s === 'top' || s === 'right' || s === 'bottom' || s === 'left' ? s : null)

/**
 * The connector's points: its own `points`, or a route between the attached layers' boxes. `straight` goes center to
 * center, clipped to each box (or from a named side's middle); `orthogonal` leaves and enters through sides with one
 * or two elbows. When either attached layer is missing there are no points, so the connector draws nothing.
 * `index` (from layerIndex) finds the ends without walking the artboard, for a caller routing many connectors.
 */
export function connectorPath(_design: Design, artboard: Artboard, layer: Layer, index?: Map<string, Layer>): Point[] {
  if (layer.type !== 'connector') return []
  if (Array.isArray(layer.points) && layer.points.length >= 2) return layer.points.map(p => [fin(p[0], 0), fin(p[1], 0)])
  const find = (id: string): Box | null => {
    if (index) {
      const l = typeof id === 'string' && id !== layer.id ? index.get(id) : undefined
      return l ? boxOf(l) : null
    }
    let hit: Box | null = null
    walk(artboard?.layers ?? [], l => {
      if (!hit && l.id === id && l.id !== layer.id) hit = boxOf(l)
    })
    return hit
  }
  const A = find(layer.from?.layer)
  const B = find(layer.to?.layer)
  if (!A || !B) return []
  const ca = centerOf(A)
  const cb = centerOf(B)
  const sa = explicitSide(layer.from.side)
  const sb = explicitSide(layer.to.side)
  if (layer.route !== 'orthogonal') {
    return [sa ? sideMid(A, sa) : edgeToward(A, cb), sb ? sideMid(B, sb) : edgeToward(B, ca)]
  }
  const dx = cb[0] - ca[0]
  const dy = cb[1] - ca[1]
  const across = Math.abs(dx) >= Math.abs(dy)
  const fromSide: Side = sa ?? (across ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top')
  const toSide: Side = sb ?? (across ? (dx >= 0 ? 'left' : 'right') : dy >= 0 ? 'top' : 'bottom')
  const p = sideMid(A, fromSide)
  const q = sideMid(B, toSide)
  const flat = (s: Side) => s === 'left' || s === 'right'
  if (flat(fromSide) && flat(toSide)) {
    if (p[1] === q[1]) return [p, q]
    const mx = (p[0] + q[0]) / 2
    return [p, [mx, p[1]], [mx, q[1]], q]
  }
  if (!flat(fromSide) && !flat(toSide)) {
    if (p[0] === q[0]) return [p, q]
    const my = (p[1] + q[1]) / 2
    return [p, [p[0], my], [q[0], my], q]
  }
  return flat(fromSide) ? [p, [q[0], p[1]], q] : [p, [p[0], q[1]], q]
}

/** Every layer in `layers` and their groups by id, the first in drawing order for an id held twice (as connectorPath finds). */
export function layerIndex(layers: Layer[]): Map<string, Layer> {
  const index = new Map<string, Layer>()
  const go = (list: unknown): void => {
    for (const l of Array.isArray(list) ? (list as Layer[]) : []) {
      if (!l || typeof l !== 'object') continue
      if (typeof l.id === 'string' && !index.has(l.id)) index.set(l.id, l)
      if (l.type === 'group') go(l.children)
    }
  }
  go(layers)
  return index
}

/** The point halfway along a polyline. */
export function midpoint(pts: Point[]): Point {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]))
  let half = lens.reduce((a, v) => a + v, 0) / 2
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) {
      const t = lens[i] ? half / lens[i] : 0
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]
    }
    half -= lens[i]
  }
  return pts[pts.length - 1]
}
