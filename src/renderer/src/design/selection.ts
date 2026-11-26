import { type Box, type Point, boundsOf, boxOf, connectorPath, fin, layerIndex } from '../../../shared/design/geometry'
import type { Artboard, Design, Layer } from '../../../shared/design/types'

// The design canvas's hit testing and handle math, in artboard coordinates. Pure (no DOM), so it's tested on its own.
// Layers are stored in artboard coordinates and drawn through their own rotation and scale about their box center,
// inside every group's (render.ts transformOf); a connector has no transform of its own. Everything here follows that.

/** An SVG matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
/** Which way each handle points from the box center: -1 west or north, 1 east or south. */
const DIR: Record<Handle, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] }

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m after n: apply(multiply(m, n), p) === apply(m, apply(n, p)). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

/** The inverse, or null when the matrix squashes everything flat (a scale of 0). */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

export const apply = (m: Matrix, p: Point): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]

/** A layer's own rotation and scale about its box center, as the renderer draws it. */
export function ownMatrix(l: Layer): Matrix {
  if (l.type === 'connector') return IDENTITY
  const b = boxOf(l)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const r = (fin(l.rotation, 0) * Math.PI) / 180
  const sx = fin(l.scaleX, 1)
  const sy = fin(l.scaleY, 1)
  const [cos, sin] = [Math.cos(r), Math.sin(r)]
  const [a, b2, c, d] = [cos * sx, sin * sx, -sin * sy, cos * sy]
  return [a, b2, c, d, cx - (a * cx + c * cy), cy - (b2 * cx + d * cy)]
}

/** One layer as the canvas sees it: where it sits and whether a click can reach it. */
export interface Placed {
  layer: Layer
  /** The groups holding it, outermost first. */
  ancestors: Layer[]
  /** Its groups' transforms: from the space its x and y are in (its parent's) to the artboard. */
  outer: Matrix
  /** outer, then its own rotation and scale: from its box to the artboard. */
  matrix: Matrix
  /** Its box (a connector's is where its route runs). */
  box: Box
  /** Hidden or locked, itself or through a group. */
  hidden: boolean
  locked: boolean
}

/** A connector's route in its parent's space, or none when an end is missing (connectorPath never reads the design). */
const routeOf = (l: Layer, board: Artboard, index: Map<string, Layer>): Point[] =>
  connectorPath(null as unknown as Design, board, l, index)

/**
 * Every layer in `layers` and their groups, depth first in drawing order (back to front). With the artboard, a
 * connector's box is where its route runs.
 */
export function placeAll(layers: Layer[], board?: Artboard): Placed[] {
  const out: Placed[] = []
  const index = board ? layerIndex(board.layers) : null
  const go = (list: Layer[], outer: Matrix, ancestors: Layer[], hidden: boolean, locked: boolean): void => {
    for (const layer of list) {
      const matrix = multiply(outer, ownMatrix(layer))
      let box = boxOf(layer)
      if (layer.type === 'connector' && board && index) {
        const pts = routeOf(layer, board, index)
        if (pts.length) box = boundsOf(pts)
      }
      const h = hidden || !layer.visible
      const k = locked || !!layer.locked
      out.push({ layer, ancestors, outer, matrix, box, hidden: h, locked: k })
      if (layer.type === 'group' && Array.isArray(layer.children)) go(layer.children, matrix, [...ancestors, layer], h, k)
    }
  }
  go(layers, IDENTITY, [], false, false)
  return out
}

/** The four corners of a placed layer on the artboard: nw, ne, se, sw. */
export function corners(p: Placed): Point[] {
  const { x, y, w, h } = p.box
  return [apply(p.matrix, [x, y]), apply(p.matrix, [x + w, y]), apply(p.matrix, [x + w, y + h]), apply(p.matrix, [x, y + h])]
}

/** Where each of the eight handles sits on the artboard. */
export function handlePoints(p: Placed): Record<Handle, Point> {
  const { x, y, w, h } = p.box
  const out = {} as Record<Handle, Point>
  for (const k of HANDLES) out[k] = apply(p.matrix, [x + ((DIR[k][0] + 1) * w) / 2, y + ((DIR[k][1] + 1) * h) / 2])
  return out
}

/** Whether an artboard point falls inside a placed layer's box, as drawn. */
export function inside(p: Placed, pt: Point): boolean {
  const inv = invert(p.matrix)
  if (!inv) return false
  const [x, y] = apply(inv, pt)
  return x >= p.box.x && x <= p.box.x + p.box.w && y >= p.box.y && y <= p.box.y + p.box.h
}

/** The resize cursor for a handle, turned with the layer. */
export function handleCursor(p: Placed, k: Handle): string {
  const { x, y, w, h } = p.box
  const c = apply(p.matrix, [x + w / 2, y + h / 2])
  const at = handlePoints(p)[k]
  const deg = (((Math.atan2(at[1] - c[1], at[0] - c[0]) * 180) / Math.PI) % 180 + 180) % 180
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4]
}

/** How far the pointer moved from `from` to `to` (artboard points), in the space a layer's x and y are in. */
export function deltaIn(outer: Matrix, from: Point, to: Point): Point {
  const inv = invert(outer)
  if (!inv) return [0, 0]
  const a = apply(inv, from)
  const b = apply(inv, to)
  return [b[0] - a[0], b[1] - a[1]]
}

const distToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/**
 * Whether a layer that draws itself (not a group) covers `pt`: inside its box, or for lines and connectors within `tol`
 * of their stroke (a box gets no extra reach, so a click just outside a shape never picks it).
 */
function covers(l: Layer, m: Matrix, pt: Point, tol: number, board: Artboard, index: Map<string, Layer>): boolean {
  if (l.type === 'connector' || l.type === 'line') {
    const reach = tol + fin(l.strokeWidth, l.type === 'connector' ? 2 : 1) / 2
    const pts: Point[] =
      l.type === 'line' ? [[fin(l.x, 0), fin(l.y, 0)], [fin(l.x, 0) + fin(l.width, 0), fin(l.y, 0) + fin(l.height, 0)]] : routeOf(l, board, index)
    const on = pts.map(p => apply(m, p))
    return on.slice(1).some((p, i) => distToSegment(pt, on[i], p) <= reach)
  }
  const inv = invert(m)
  if (!inv) return false
  const [x, y] = apply(inv, pt)
  const b = boxOf(l)
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
}

/**
 * The topmost visible, unlocked layer that draws under `pt`, with the groups holding it (outermost first, the layer
 * last). A clipping group's mask isn't drawn, and what the group holds only shows inside it.
 */
function chainAt(board: Artboard, pt: Point, tol: number): Layer[] | null {
  const index = layerIndex(board.layers)
  const go = (list: Layer[], outer: Matrix): Layer[] | null => {
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i]
      if (!l || !l.visible || l.locked) continue
      const m = multiply(outer, ownMatrix(l))
      if (l.type === 'group') {
        let kids = Array.isArray(l.children) ? l.children : []
        const mask = kids[0]
        if (l.clip && kids.length > 1 && mask.visible) {
          if (!covers(mask, multiply(m, ownMatrix(mask)), pt, 0, board, index)) continue
          kids = kids.slice(1)
        }
        const below = go(kids, m)
        if (below) return [l, ...below]
      } else if (covers(l, m, pt, tol, board, index)) return [l]
    }
    return null
  }
  return go(board.layers, IDENTITY)
}

/**
 * What a click at `pt` selects: the topmost visible, unlocked layer drawn there, as the layer directly inside `scope`
 * (a group entered with a double-click) that holds it, or as its top-level layer when it isn't inside `scope`.
 * `tolerance` (artboard pixels) widens what counts as on a line or connector, so thin ones can be clicked.
 */
export function hitTest(board: Artboard, pt: Point, opts: { scope?: string | null; tolerance?: number } = {}): Layer | null {
  const chain = chainAt(board, pt, Math.max(0, opts.tolerance ?? 0))
  if (!chain) return null
  const i = opts.scope ? chain.findIndex(l => l.id === opts.scope) : -1
  return i >= 0 && i < chain.length - 1 ? chain[i + 1] : chain[0]
}

/** Whether a convex polygon and an upright box overlap (separating axes; touching counts). */
function overlaps(poly: Point[], r: Box): boolean {
  const box: Point[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
  const axes: Point[] = [[1, 0], [0, 1], ...poly.map((p, i): Point => {
    const q = poly[(i + 1) % poly.length]
    return [q[1] - p[1], p[0] - q[0]]
  })]
  for (const [ax, ay] of axes) {
    if (!ax && !ay) continue
    const span = (pts: Point[]) => {
      const v = pts.map(p => p[0] * ax + p[1] * ay)
      return [Math.min(...v), Math.max(...v)]
    }
    const [a0, a1] = span(poly)
    const [b0, b1] = span(box)
    if (a1 < b0 || b1 < a0) return false
  }
  return true
}

/**
 * The layers a marquee (an upright box on the artboard) selects: those directly inside `scope` (or at the top level)
 * whose boxes it touches, as they're drawn (turned and scaled). Hidden and locked layers are left out.
 */
export function marquee(board: Artboard, rect: Box, scope?: string | null): Layer[] {
  return placeAll(board.layers, board)
    .filter(p => (scope ? p.ancestors.at(-1)?.id === scope : !p.ancestors.length) && !p.hidden && !p.locked)
    .filter(p => overlaps(corners(p), rect))
    .map(p => p.layer)
}

/** Rounded to a millionth of a pixel, so the arithmetic leaves no 1e-14 behind. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * A layer's new box when its handle is dragged from `from` to `to` (points in the space its x and y are in: see
 * deltaIn and Placed.outer). The handle opposite stays where it is on the artboard, whatever the layer's rotation and
 * scale. `keepRatio` (Shift) keeps the shape: a corner scales along its diagonal, a side grows the other side about its
 * middle. Sides the drag changes never go below 1 px.
 */
export function resizeBox(l: Layer, k: Handle, from: Point, to: Point, keepRatio: boolean): Box {
  const b = boxOf(l)
  const [hx, hy] = DIR[k]
  const r = l.type === 'connector' ? 0 : (fin(l.rotation, 0) * Math.PI) / 180
  const nz = (v: number) => (Math.abs(v) < 1e-9 ? 1 : v)
  const sx = l.type === 'connector' ? 1 : nz(fin(l.scaleX, 1))
  const sy = l.type === 'connector' ? 1 : nz(fin(l.scaleY, 1))
  const [cos, sin] = [Math.cos(r), Math.sin(r)]
  // the drag along the layer's own axes, before its rotation and scale
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const ux = (dx * cos + dy * sin) / sx
  const uy = (-dx * sin + dy * cos) / sy
  let w = b.w + hx * ux
  let h = b.h + hy * uy
  if (keepRatio && b.w > 0 && b.h > 0) {
    let f = hx && hy ? 1 + (hx * ux * b.w + hy * uy * b.h) / (b.w * b.w + b.h * b.h) : hx ? w / b.w : h / b.h
    f = Math.max(f, 1 / b.w, 1 / b.h)
    ;[w, h] = [b.w * f, b.h * f]
  } else {
    if (hx) w = Math.max(1, w)
    if (hy) h = Math.max(1, h)
  }
  // the opposite handle (or the middle, across a side handle) stays put on the artboard
  const turn = (vx: number, vy: number): Point => [cos * sx * vx - sin * sy * vy, sin * sx * vx + cos * sy * vy]
  const c: Point = [b.x + b.w / 2, b.y + b.h / 2]
  const a = turn((-hx * b.w) / 2, (-hy * b.h) / 2)
  const n = turn((hx * w) / 2, (hy * h) / 2)
  const cx = c[0] + a[0] + n[0]
  const cy = c[1] + a[1] + n[1]
  return { x: r6(cx - w / 2), y: r6(cy - h / 2), w: r6(w), h: r6(h) }
}
