import type { FontSource } from './fonts'
import { type Box, boxOf, union } from './geometry'
import { newId } from './model'
import {
  IDENTITY, type Matrix, type Seg, apply, det, evenOddToNonZero, isSimilarScale, mul, numbers, parsePath, parseTransform,
  pathBounds, pathToString, positiveWinding, transformPath, translate
} from './path'
import { type RenderOptions, layerToSvg } from './render'
import { sharedAssetName } from './sha256'
import {
  INKSCAPE_NS, MAX_PAINTS, MAX_SVG_BYTES, MAX_SVG_ELEMENTS, MAX_USE_DEPTH, PRESENTATION, SVG_NS, TOO_SLOW, XLINK_NS, allElements, cleanSvg,
  cleanSvgRoot, dataUriBytes, expandedSizes, elementChildren, hrefId, idMap, imageInfo, serializeSvg, urlRefs
} from './svgClean'
import { type PaintSpace, type Style, type Viewport, alphaOf, diagonal, len, paintOf, urlId } from './svgPaint'
import { applyStyles } from './svgFragment'
import { splitDeclarations } from './svgStyle'
import { cleanText, layoutText, num } from './text'
import type { BlendMode, Design, Layer, Paint, TextLayer, TextRun } from './types'
import { MAX_NAME } from './validate'

// SVG import: the cleaned SVG as one group of native layers, so a person can recolor and reshape it layer by layer.
// Shapes become paths with every transform baked in, gradients become gradient paints, clip paths clipped groups and
// <use> its copies. What the format can't hold (filters, masks, patterns, markers, text with complex layout) stays a
// cleaned `svg` layer, always drawn as an image, and `kept` says what and why.

type GroupLayer = Layer & { type: 'group' }
export interface ImportOptions {
  /** Measures text so its baseline lands exactly; without it the ascent is estimated. */
  fonts?: FontSource
  /** Ids already used in the design; new ids avoid them. */
  taken?: Set<string>
}
export interface ImportResult {
  group: GroupLayer
  removed: string[]
  kept: string[]
  assets: Record<string, Uint8Array>
}

interface Ctx extends Viewport {
  /** Layers made and elements copied into svg layers, those layers' markup and what they paint, against the import limits. */
  budget: { elements: number; bytes: number; json: number; paints: number }
  /** How many elements each element draws with its <use> expanded, for what svg layers copy. */
  sizes: Map<Element, number>
  ids: Map<string, Element>
  taken: Set<string>
  counts: Record<string, number>
  kept: string[]
  assets: Record<string, Uint8Array>
  /** The root viewport in px, which clips everything the SVG draws; null when the SVG has no size. */
  frame: Box | null
  fonts?: FontSource
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
const NOT_DRAWN = new Set([
  'defs', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'style', 'title', 'desc',
  'symbol', 'filter'
])
const INHERITED = new Set([
  'clip-rule', 'color', 'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'direction',
  'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule', 'font-family', 'font-size', 'font-size-adjust',
  'font-stretch', 'font-style', 'font-variant', 'font-weight', 'glyph-orientation-horizontal',
  'glyph-orientation-vertical', 'image-rendering', 'kerning', 'letter-spacing', 'marker', 'marker-end', 'marker-mid',
  'marker-start', 'paint-order', 'pointer-events', 'shape-rendering', 'stroke', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'text-anchor',
  'text-rendering', 'visibility', 'white-space', 'word-spacing', 'writing-mode'
])
const BLENDS = new Set([
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
])

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
const roundBox = (b: Box, f = r6): Box => ({ x: f(b.x), y: f(b.y), w: f(b.w), h: f(b.h) })
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3
/** Each element's transform, read once: a <use> draws its target again, and the target's attributes don't change. */
const TRANSFORMS = new WeakMap<Element, Matrix>()
const transformOf = (el: Element): Matrix => {
  let m = TRANSFORMS.get(el)
  if (!m) TRANSFORMS.set(el, (m = parseTransform(el.getAttribute('transform')) ?? IDENTITY))
  return m
}

function boxUnder(b: Box, m: Matrix): Box {
  const pts = [apply(m, b.x, b.y), apply(m, b.x + b.w, b.y), apply(m, b.x, b.y + b.h), apply(m, b.x + b.w, b.y + b.h)]
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x
  const h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}
const grow = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by })
const layersBox = (ls: Layer[]): Box => ls.map(l => boxOf(l)).reduce((a, b) => union(a, b))
/** True when the matrix keeps angles: a rotation and uniform scale, possibly mirrored. */
function conformal(m: Matrix): boolean {
  const k = Math.abs(det(m)) || 1
  return Math.abs(m[0] * m[0] + m[1] * m[1] - (m[2] * m[2] + m[3] * m[3])) <= 1e-9 * k && Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * k
}

/**
 * An element's own style, in the order it applies: its presentation attributes (null for `inherit`, which takes the
 * parent's value), then its style attribute's declarations. Read once per element: a <use> draws its target again,
 * and a long style attribute read per use would cost its length every time.
 */
const OWN_STYLES = new WeakMap<Element, [string, string | null][]>()
function ownStyle(el: Element): [string, string | null][] {
  let own = OWN_STYLES.get(el)
  if (!own) {
    own = []
    for (const a of Array.from(el.attributes)) {
      const k = a.localName ?? a.name
      if (a.namespaceURI || !PRESENTATION.has(k)) continue
      const v = a.value.trim()
      own.push([k, v === 'inherit' ? null : v])
    }
    for (const d of splitDeclarations(el.getAttribute('style') ?? '')) own.push([d.prop, d.value])
    OWN_STYLES.set(el, own)
  }
  return own
}

/** The element's computed style: what it inherits plus its own presentation attributes and leftover style. */
function styleOf(el: Element, parent: Style): Style {
  const s: Style = {}
  for (const k in parent) if (INHERITED.has(k)) s[k] = parent[k]
  for (const [k, v] of ownStyle(el)) {
    if (v !== null) s[k] = v
    else if (k in parent) s[k] = parent[k]
  }
  // relative font sizes resolve against the parent's
  const fs = /^\s*([\d.]+)\s*(em|%)\s*$/.exec(s['font-size'] ?? '')
  if (fs) s['font-size'] = `${parseFloat(fs[1]) * (fs[2] === '%' ? 0.01 : 1) * (len(parent['font-size'] ?? '16', 16) ?? 16)}px`
  return s
}

// Naming and layer basics

/** A layer's name from the element's label, data-name or id, cut to the 1,000 characters a name may hold. */
const labelOf = (el: Element): string | null =>
  [el.getAttributeNS(INKSCAPE_NS, 'label'), el.getAttribute('data-name'), el.getAttribute('id')].map(v => (v ?? '').trim()).find(Boolean)?.slice(0, MAX_NAME) ?? null

function nameOf(el: Element, kind: string, ctx: Ctx): string {
  const label = labelOf(el)
  if (label) return label
  ctx.counts[kind] = (ctx.counts[kind] ?? 0) + 1
  return `${kind} ${ctx.counts[kind]}`
}

function base(ctx: Ctx, name: string, b: Box, s: Style, drawn = true) {
  spend(ctx, 1)
  const blend = s['mix-blend-mode']?.trim().toLowerCase() ?? ''
  return {
    id: newId(ctx.taken),
    name,
    visible: s.display !== 'none' && (!drawn || (s.visibility !== 'hidden' && s.visibility !== 'collapse')),
    locked: false,
    opacity: alphaOf(s.opacity),
    blend: (BLENDS.has(blend) ? blend : 'normal') as BlendMode,
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    rotation: 0,
    scaleX: 1,
    scaleY: 1
  }
}

// Geometry

const M = (x: number, y: number): Seg => ({ c: 'M', v: [x, y] })
const Ln = (x: number, y: number): Seg => ({ c: 'L', v: [x, y] })
const Arc = (rx: number, ry: number, x: number, y: number): Seg => ({ c: 'A', v: [rx, ry, 0, 0, 1, x, y] })
const Z: Seg = { c: 'Z', v: [] }
const ellipse = (cx: number, cy: number, rx: number, ry: number): Seg[] => [
  M(cx + rx, cy), Arc(rx, ry, cx, cy + ry), Arc(rx, ry, cx - rx, cy), Arc(rx, ry, cx, cy - ry), Arc(rx, ry, cx + rx, cy), Z
]

/**
 * Each shape's outline (path data parsed, or a basic shape's), so a shape drawn by many <use> elements is read once.
 * The viewport a percentage resolves against is fixed for one import, and each import has elements of its own. Never
 * changed.
 */
const OUTLINES = new WeakMap<Element, Seg[] | null>()
/**
 * A shape's even-odd outline turned for the nonzero rule, per element, so a shape drawn by many <use> elements or
 * clipping many shapes is converted once (the check for crossings is quadratic in its edges). The conversion runs in
 * the shape's own user space, before any transform is baked in, so one result serves every use. Never changed.
 */
const NONZERO = new WeakMap<Element, ReturnType<typeof evenOddToNonZero>>()

function nonZeroOf(el: Element, segs: Seg[]): ReturnType<typeof evenOddToNonZero> {
  let out = NONZERO.get(el)
  if (out === undefined) {
    out = evenOddToNonZero(segs)
    NONZERO.set(el, out)
  }
  return out
}

/** A shape's outline in its own user space, or null when it draws nothing. */
function shapeSegs(el: Element, vp: Viewport): Seg[] | null {
  if (OUTLINES.has(el)) return OUTLINES.get(el)!
  const segs = outlineOf(el, vp)
  OUTLINES.set(el, segs)
  return segs
}

function outlineOf(el: Element, vp: Viewport): Seg[] | null {
  const L = (n: string, ref: number) => len(el.getAttribute(n), ref)
  switch (el.localName) {
    case 'path': {
      const parsed = parsePath(el.getAttribute('d'))
      return parsed.length ? parsed : null
    }
    case 'rect': {
      const x = L('x', vp.vw) ?? 0
      const y = L('y', vp.vh) ?? 0
      const w = L('width', vp.vw) ?? 0
      const h = L('height', vp.vh) ?? 0
      if (!(w > 0 && h > 0)) return null
      let rx = L('rx', vp.vw)
      let ry = L('ry', vp.vh)
      rx = rx !== null && rx >= 0 ? rx : ry !== null && ry >= 0 ? ry : 0
      ry = ry !== null && ry >= 0 ? ry : rx
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (!rx || !ry) return [M(x, y), Ln(x + w, y), Ln(x + w, y + h), Ln(x, y + h), Z]
      return [
        M(x + rx, y), Ln(x + w - rx, y), Arc(rx, ry, x + w, y + ry), Ln(x + w, y + h - ry), Arc(rx, ry, x + w - rx, y + h),
        Ln(x + rx, y + h), Arc(rx, ry, x, y + h - ry), Ln(x, y + ry), Arc(rx, ry, x + rx, y), Z
      ]
    }
    case 'circle': {
      const r = L('r', diagonal(vp)) ?? 0
      return r > 0 ? ellipse(L('cx', vp.vw) ?? 0, L('cy', vp.vh) ?? 0, r, r) : null
    }
    case 'ellipse': {
      let rx = L('rx', vp.vw)
      let ry = L('ry', vp.vh)
      rx = rx ?? ry ?? 0
      ry = ry ?? rx
      return rx > 0 && ry > 0 ? ellipse(L('cx', vp.vw) ?? 0, L('cy', vp.vh) ?? 0, rx, ry) : null
    }
    case 'line':
      return [M(L('x1', vp.vw) ?? 0, L('y1', vp.vh) ?? 0), Ln(L('x2', vp.vw) ?? 0, L('y2', vp.vh) ?? 0)]
    case 'polyline':
    case 'polygon': {
      const n = numbers(el.getAttribute('points') ?? '')
      if (n.length < 4) return null
      const segs: Seg[] = [M(n[0], n[1])]
      for (let i = 2; i + 1 < n.length; i += 2) segs.push(Ln(n[i], n[i + 1]))
      if (el.localName === 'polygon') segs.push(Z)
      return segs
    }
  }
  return null
}

/** The viewport a <symbol> (or nested svg) maps its viewBox into. */
function viewBoxMatrix(vb: number[], w: number, h: number, par: string | null): Matrix {
  const [x, y, vw, vh] = vb
  const p = (par ?? '').trim().split(/\s+/)
  const [align, mode] = p[0] === 'defer' ? [p[1], p[2]] : [p[0], p[1]]
  if (align === 'none') return [w / vw, 0, 0, h / vh, (-x * w) / vw, (-y * h) / vh]
  const s = mode === 'slice' ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh)
  const a = align || 'xMidYMid'
  const fx = a.includes('xMid') ? 0.5 : a.includes('xMax') ? 1 : 0
  const fy = a.includes('YMid') ? 0.5 : a.includes('YMax') ? 1 : 0
  return [s, 0, 0, s, -x * s + (w - vw * s) * fx, -y * s + (h - vh * s) * fy]
}
const viewBoxOf = (el: Element): number[] | null => {
  const vb = numbers(el.getAttribute('viewBox') ?? '')
  return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : null
}

/** A <use>'s placement of a <symbol>: the use's x and y, then the symbol's viewBox in the use's size. */
function symbolMatrix(use: Element, sym: Element, at: Matrix, vp: Viewport): Matrix {
  const vb = viewBoxOf(sym)
  if (!vb) return at
  const w = len(use.getAttribute('width') ?? sym.getAttribute('width') ?? '100%', vp.vw) ?? vp.vw
  const h = len(use.getAttribute('height') ?? sym.getAttribute('height') ?? '100%', vp.vh) ?? vp.vh
  return mul(at, viewBoxMatrix(vb, w, h, sym.getAttribute('preserveAspectRatio')))
}

const useMatrix = (use: Element, m: Matrix, vp: Viewport): Matrix =>
  mul(m, translate(len(use.getAttribute('x'), vp.vw) ?? 0, len(use.getAttribute('y'), vp.vh) ?? 0))

/** Text as it is drawn: the plain text of the element and its tspans. */
const textOf = (el: Element): string => el.textContent ?? ''

/** Bounds of what an element draws, where `m` maps its content (its own transform included) to px. */
function contentBounds(el: Element, m: Matrix, ctx: Ctx, depth = 0): Box | null {
  const tag = el.localName
  if (SHAPES.has(tag)) {
    const segs = shapeSegs(el, ctx)
    return segs ? pathBounds(transformPath(segs, m)) : null
  }
  const under = (c: Element, at: Matrix) => contentBounds(c, mul(at, transformOf(c)), ctx, depth)
  const all = (at: Matrix, of: Element) => {
    let b: Box | null = null
    for (const c of elementChildren(of)) {
      if (NOT_DRAWN.has(c.localName)) continue
      const cb = under(c, at)
      if (cb) b = b ? union(b, cb) : cb
    }
    return b
  }
  switch (tag) {
    case 'g':
    case 'switch':
      return all(m, el)
    case 'use': {
      const t = ctx.ids.get(hrefId(el) ?? '')
      if (!t || depth >= MAX_USE_DEPTH) return null
      const at = useMatrix(el, m, ctx)
      if (t.localName === 'symbol') return all(symbolMatrix(el, t, at, ctx), t)
      return contentBounds(t, mul(at, transformOf(t)), ctx, depth + 1)
    }
    case 'svg':
    case 'image': {
      const w = len(el.getAttribute('width'), ctx.vw) ?? (tag === 'svg' ? ctx.vw : 0)
      const h = len(el.getAttribute('height'), ctx.vh) ?? (tag === 'svg' ? ctx.vh : 0)
      return boxUnder({ x: len(el.getAttribute('x'), ctx.vw) ?? 0, y: len(el.getAttribute('y'), ctx.vh) ?? 0, w, h }, m)
    }
    case 'text': {
      const size = len(el.getAttribute('font-size'), 16) ?? 16
      const x = numbers(el.getAttribute('x') ?? '0')[0] ?? 0
      const y = numbers(el.getAttribute('y') ?? '0')[0] ?? 0
      const w = textOf(el).trim().length * size * 0.6
      return boxUnder({ x: x - w, y: y - size, w: 2 * w, h: size * 1.4 }, m)
    }
  }
  return null
}

/** Every id an element's attributes point at, through href or url(#id). */
function refsOf(el: Element): string[] {
  const out: string[] = []
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]
    if (a.localName === 'href' && a.value.startsWith('#')) out.push(a.value.slice(1))
    else if (a.value.includes('url(#')) for (const id of urlRefs(a.value)) out.push(id)
  }
  return out
}
const contains = (outer: Element, inner: Element): boolean => {
  for (let n: Node | null = inner; n; n = n.parentNode) if (n === outer) return true
  return false
}

/**
 * What an element needs from elsewhere in the document (gradients, filters, use targets), outermost only, and whether
 * anything it refers to can't come along (an id that isn't there, or an ancestor of the element itself).
 */
function referenced(el: Element, ctx: Ctx, also: string[] = []): { defs: Element[]; dangling: boolean } {
  const found: Element[] = []
  const seen = new Set<Element>()
  const queue: Element[] = []
  let dangling = false
  const need = (id: string) => {
    const t = ctx.ids.get(id)
    if (!t) dangling = true
    if (!t || seen.has(t)) return
    seen.add(t)
    if (contains(el, t)) return
    if (contains(t, el)) {
      dangling = true
      return
    }
    found.push(t)
    queue.push(t)
  }
  // what the element refers to, what it inherits a reference to, and what those refer to in turn
  for (const id of also) need(id)
  queue.push(el)
  for (let q = 0; q < queue.length; q++) {
    for (const e of allElements(queue[q])) for (const id of refsOf(e)) need(id)
  }
  // keep only the outermost: drop any whose ancestor is also needed
  const needed = new Set(found)
  const defs = found.filter(t => {
    for (let n = t.parentNode; n; n = n.parentNode) if (needed.has(n as Element)) return false
    return true
  })
  return { defs, dangling }
}

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
  '\u0085': '&#133;', '\u2028': '&#8232;'
}
/** The same escapes as cleanSvg's serializer, so composed markup is already in its form. */
const escAttr = (s: string): string => cleanText(s).replace(/[&<>"'\t\n\r\u0085\u2028]/g, c => ESC[c])

/** Most JSON the layers of one import may come to. */
const MAX_LAYER_JSON = 32 * 1024 * 1024

/** Charges a finished layer's JSON (a group without its children, which are charged as they're made). */
function charge<T extends Layer>(ctx: Ctx, layer: T): T {
  ctx.budget.json += JSON.stringify(layer.type === 'group' ? { ...layer, children: [] } : layer).length
  if (ctx.budget.json > MAX_LAYER_JSON) throw new Error('This SVG is too large to convert.')
  return layer
}

/** Charges the import's budget: every layer and every element an svg layer copies, and the svg layers' markup. */
function spend(ctx: Ctx, elements: number, bytes = 0): void {
  ctx.budget.elements += elements
  ctx.budget.bytes += bytes
  if (ctx.budget.elements > MAX_SVG_ELEMENTS) throw new Error('This SVG expands to too much (over 50,000 elements).')
  if (ctx.budget.bytes > MAX_SVG_BYTES) throw new Error('This SVG expands to too much (over 5 MB of SVG layers).')
}


/** The longest stroke the element or anything in it draws, in its user units. */
function strokeReach(el: Element, s: Style, vp: Viewport): number {
  let w = s.stroke && s.stroke !== 'none' ? (len(s['stroke-width'] ?? '1', diagonal(vp)) ?? 1) : 0
  for (const e of allElements(el)) {
    const sw = e.getAttribute('stroke-width')
    const st = e.getAttribute('stroke')
    if ((st && st !== 'none') || sw) w = Math.max(w, len(sw ?? '1', diagonal(vp)) ?? 1)
  }
  return w
}

/**
 * The element as a cleaned SVG layer, drawn as an image: its own markup in a document whose viewBox is the layer box
 * in px, under the transform and inherited style it had, with the definitions it refers to.
 */
function svgLayer(el: Element, ctm: Matrix, inh: Style, s: Style, why: string, ctx: Ctx, name?: string): Layer | null {
  const m = mul(ctm, transformOf(el))
  const k = Math.sqrt(Math.abs(det(m)))
  let box: Box | null
  const filter = ctx.ids.get(urlId(s.filter) ?? '')
  if (filter?.localName === 'filter') {
    const own = contentBounds(el, IDENTITY, ctx)
    const a = (n: string, d: string) => filter.getAttribute(n) ?? d
    let region: Box | null = null
    if (a('filterUnits', '') === 'userSpaceOnUse') {
      region = { x: len(a('x', '-10%'), ctx.vw) ?? 0, y: len(a('y', '-10%'), ctx.vh) ?? 0, w: len(a('width', '120%'), ctx.vw) ?? 0, h: len(a('height', '120%'), ctx.vh) ?? 0 }
    } else if (own) {
      const f = (n: string, d: string) => alphaFraction(a(n, d))
      region = { x: own.x + f('x', '-10%') * own.w, y: own.y + f('y', '-10%') * own.h, w: f('width', '120%') * own.w, h: f('height', '120%') * own.h }
    }
    box = region ? boxUnder(region, m) : null
  } else {
    box = contentBounds(el, m, ctx)
    if (box) {
      const markers = ['marker-start', 'marker-mid', 'marker-end'].some(p => urlId(s[p]))
      box = grow(box, strokeReach(el, s, ctx) * k * (markers ? 4 : 1))
    }
  }
  box = box ?? ctx.frame
  if (box && ctx.frame) box = intersect(box, ctx.frame)
  if (!box || !(box.w > 0) || !(box.h > 0)) return null
  box = roundBox(box, r3)
  const carried = Object.entries(inh).filter(([p]) => INHERITED.has(p) && PRESENTATION.has(p))
  // an inherited url(#id) (a fill or marker set on an ancestor) brings its definition along
  const { defs } = referenced(el, ctx, carried.flatMap(([, v]) => urlRefs(v)))
  // before anything is written out, what this layer would draw (every <use> expanded, as resolved in the source) is
  // charged, so an import that asks too much stops before composing any more
  const estimate = defs.reduce((a, d) => a + (ctx.sizes.get(d) ?? Infinity), ctx.sizes.get(el) ?? Infinity)
  spend(ctx, estimate)
  const inherited = carried.map(([p, v]) => ` ${p}="${escAttr(v)}"`).join('')
  const markup =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}" width="${num(box.w, 3)}" height="${num(box.h, 3)}" ` +
    `viewBox="${num(box.x, 3)} ${num(box.y, 3)} ${num(box.w, 3)} ${num(box.h, 3)}">` +
    (defs.length ? `<defs>${defs.map(d => serializeSvg(d, false)).join('')}</defs>` : '') +
    `<g transform="matrix(${ctm.map(v => num(v, 6)).join(' ')})"${inherited}>${serializeSvg(el, false)}</g></svg>`
  spend(ctx, 0, markup.length)
  // What is stored is always cleanSvg's own output: composed markup is cleaned again, never trusted as it is. The
  // layer ends up charged at least what that cleaning says it draws, which is what a browser will draw from it, and
  // what it paints goes against the import's paint budget.
  const { svg, drawn, painted } = cleanSvg(markup)
  if (drawn > estimate) spend(ctx, drawn - estimate)
  ctx.budget.paints += painted
  if (ctx.budget.paints > MAX_PAINTS) throw new Error(TOO_SLOW)
  const label = name ?? nameOf(el, 'SVG', ctx)
  ctx.kept.push(`${label}: kept as an SVG layer because ${why}`)
  return charge(ctx, { ...base(ctx, label, box, { ...s, opacity: '1' }), type: 'svg', svg })
}
const alphaFraction = (v: string): number => {
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%?)\s*$/i.exec(v)
  return m ? parseFloat(m[1]) / (m[2] ? 100 : 1) : 0
}

// Conversion

/** Why an element can't become native layers, or null. */
function unsupported(el: Element, s: Style, m: Matrix, ctx: Ctx): string | null {
  const tag = el.localName
  const refTag = (v: string | undefined) => ctx.ids.get(urlId(v) ?? '')?.localName
  if (tag === 'svg') return 'it is a nested SVG viewport'
  if (refTag(s.mask) === 'mask') return 'it uses a mask'
  if (s.filter && s.filter.trim() !== 'none' && (refTag(s.filter) === 'filter' || !urlId(s.filter))) return 'it uses a filter'
  if (SHAPES.has(tag) || tag === 'text') {
    if (refTag(s.fill) === 'pattern' || refTag(s.stroke) === 'pattern') return 'it is painted with a pattern'
  }
  if (SHAPES.has(tag) && ['marker', 'marker-start', 'marker-mid', 'marker-end'].some(p => refTag(s[p]) === 'marker')) return 'it has markers'
  if (tag === 'use' && ctx.ids.get(hrefId(el) ?? '')?.localName === 'svg') return 'it is a nested SVG viewport'
  if (tag === 'text') return textProblem(el, s, m)
  if (tag === 'image' && (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0)) return 'it is a rotated, skewed or flipped image'
  return null
}

function convert(el: Element, ctm: Matrix, inh: Style, ctx: Ctx, depth: number, as: { name?: string; noClip?: boolean } = {}): Layer | null {
  const tag = el.localName
  if (NOT_DRAWN.has(tag) || !(SHAPES.has(tag) || ['g', 'switch', 'use', 'image', 'text', 'svg'].includes(tag))) return null
  const s = styleOf(el, inh)
  const m = mul(ctm, transformOf(el))
  const why = unsupported(el, s, m, ctx)
  if (why) return svgLayer(el, ctm, inh, s, why, ctx, as.name)
  const clip = as.noClip ? null : ctx.ids.get(urlId(s['clip-path']) ?? '')
  if (clip?.localName === 'clipPath') {
    const shape = clipShape(clip, el, m, ctx)
    if (shape === 'empty') return null
    if (!shape) return svgLayer(el, ctm, inh, s, 'its clip path holds something other than shapes', ctx, as.name)
    const inner = convert(el, ctm, inh, ctx, depth, { ...as, noClip: true })
    if (!inner) return null
    shape.name = `${inner.name} clip`
    if (inner.type === 'group' && !inner.clip) {
      inner.clip = true
      inner.children.unshift(shape)
      const b = layersBox(inner.children)
      Object.assign(inner, { x: b.x, y: b.y, width: b.w, height: b.h })
      return inner
    }
    const b = layersBox([shape, inner])
    return charge(ctx, { ...base(ctx, `${inner.name} clipped`, b, {}), type: 'group', clip: true, children: [shape, inner] })
  }
  switch (tag) {
    case 'g':
    case 'switch':
      return groupLayer(el, m, s, ctx, depth, as.name ?? nameOf(el, 'Group', ctx), tag === 'switch')
    case 'use':
      return useLayer(el, m, s, ctx, depth, as.name)
    case 'image':
      return imageLayer(el, m, s, ctx, as.name ?? nameOf(el, 'Image', ctx))
    case 'text':
      return textLayer(el, m, s, ctx, as.name ?? nameOf(el, 'Text', ctx))
  }
  const out = shapeLayer(el, m, s, ctx, as.name)
  return typeof out === 'string' ? svgLayer(el, ctm, inh, s, out, ctx, as.name) : out
}

function groupLayer(el: Element, m: Matrix, s: Style, ctx: Ctx, depth: number, name: string, firstOnly: boolean): Layer | null {
  const children: Layer[] = []
  for (const c of elementChildren(el)) {
    const l = convert(c, m, s, ctx, depth)
    if (l) children.push(l)
    if (l && firstOnly) break
  }
  if (!children.length) return null
  return charge(ctx, { ...base(ctx, name, layersBox(children), s, false), type: 'group', children })
}

function useLayer(el: Element, m: Matrix, s: Style, ctx: Ctx, depth: number, name?: string): Layer | null {
  const target = ctx.ids.get(hrefId(el) ?? '')
  if (!target || depth >= MAX_USE_DEPTH) return null
  const at = useMatrix(el, m, ctx)
  const label = name ?? labelOf(el) ?? undefined
  let out: Layer | null
  if (target.localName === 'symbol') out = groupLayer(target, symbolMatrix(el, target, at, ctx), s, ctx, depth + 1, label ?? nameOf(target, 'Group', ctx), false)
  else out = convert(target, at, s, ctx, depth + 1, { name: label })
  if (out) {
    // the use's own opacity and blend apply to what it draws
    out.opacity *= alphaOf(s.opacity)
    const blend = s['mix-blend-mode']?.trim().toLowerCase() ?? ''
    if (BLENDS.has(blend)) out.blend = blend as BlendMode
    if (s.display === 'none') out.visible = false
  }
  return out
}

/** A clipPath as one path layer in px (its shapes' union), 'empty' when it clips everything away, null when it can't be. */
function clipShape(clip: Element, target: Element, m: Matrix, ctx: Ctx): (Layer & { type: 'path' }) | 'empty' | null {
  if (clip.getAttribute('clip-path')) return null
  let cm = mul(m, transformOf(clip))
  if (clip.getAttribute('clipPathUnits') === 'objectBoundingBox') {
    const bb = contentBounds(target, IDENTITY, ctx)
    if (!bb || !bb.w || !bb.h) return 'empty'
    cm = mul(cm, [bb.w, 0, 0, bb.h, bb.x, bb.y])
  }
  // what the clip path comes to depends only on it and where it lands (cm), so it's worked out once per place
  const outline = bakedAt(CLIPS, clip, cm.join(' '), (): Baked | 'empty' | null => {
    const cs = styleOf(clip, {})
    const segs: Seg[] = []
    for (const c of elementChildren(clip)) {
      if (c.localName === 'title' || c.localName === 'desc') continue
      let shape = c
      let at = mul(cm, transformOf(c))
      if (c.localName === 'use') {
        const t = ctx.ids.get(hrefId(c) ?? '')
        if (!t) continue
        shape = t
        at = mul(useMatrix(c, at, ctx), transformOf(t))
      }
      if (!SHAPES.has(shape.localName) || c.getAttribute('clip-path')) return null
      const st = styleOf(shape, styleOf(c, cs))
      if (st.display === 'none' || st.visibility === 'hidden') continue
      let raw = shapeSegs(shape, ctx)
      if (!raw) continue
      if (st['clip-rule'] === 'evenodd') {
        const nz = nonZeroOf(shape, raw)
        if (typeof nz === 'string') return null
        raw = nz
      }
      for (const seg of positiveWinding(transformPath(raw, at))) segs.push(seg)
    }
    const b = pathBounds(segs)
    return b ? bake(segs, b) : 'empty'
  })
  if (outline === null || outline === 'empty') return outline
  return charge(ctx, pathLayer(ctx, 'Clip', outline, {}, { type: 'color', color: '#000000' }))
}

/** An outline in px as a path layer holds it: its box, and its data relative to that box. */
interface Baked { box: Box; d: string }
function bake(px: Seg[], bounds: Box): Baked {
  const box = roundBox(bounds)
  return { box, d: pathToString(transformPath(px, translate(-box.x, -box.y))) }
}
/**
 * Baked outlines per element and place (its matrix, and for a shape whether its even-odd fill was turned), so a shape
 * drawn by many uses at one place, or a clip path clipping many shapes there, is transformed and written out once.
 * Each layer is still made on its own; the cache only spares redoing the same geometry. Never changed.
 */
const SHAPES_AT = new WeakMap<Element, Map<string, (Baked & { userBox: Box }) | null>>()
const CLIPS = new WeakMap<Element, Map<string, Baked | 'empty' | null>>()
function bakedAt<T>(cache: WeakMap<Element, Map<string, T>>, el: Element, key: string, make: () => T): T {
  let byPlace = cache.get(el)
  if (!byPlace) cache.set(el, (byPlace = new Map()))
  if (byPlace.has(key)) return byPlace.get(key)!
  const out = make()
  byPlace.set(key, out)
  return out
}

function pathLayer(ctx: Ctx, name: string, geo: Baked, s: Style, fill: Paint | null): Layer & { type: 'path' } {
  return { ...base(ctx, name, geo.box, s), type: 'path', d: geo.d, fill }
}

/** A shape as a path layer, null when it draws nothing, or the reason it has to stay SVG. */
function shapeLayer(el: Element, m: Matrix, s: Style, ctx: Ctx, as?: string): Layer | null | string {
  const raw = shapeSegs(el, ctx)
  if (!raw) return null
  let segs = raw
  const fillRaw = el.localName === 'line' ? 'none' : (s.fill ?? 'black')
  const evenOdd = s['fill-rule'] === 'evenodd' && fillRaw.trim() !== 'none'
  if (evenOdd) {
    const nz = nonZeroOf(el, raw)
    if (nz === 'crossing') return 'its even-odd fill has crossing outlines'
    if (nz === 'too detailed') return 'its even-odd fill is too detailed to convert (over 2,000 edges)'
    segs = nz
  }
  const geo = bakedAt(SHAPES_AT, el, `${m.join(' ')}${evenOdd ? ' e' : ''}`, () => {
    const userBox = pathBounds(raw)
    const px = transformPath(segs, m)
    const bounds = pathBounds(px)
    return bounds && userBox ? { ...bake(px, bounds), userBox } : null
  })
  if (!geo) return null
  const name = as ?? nameOf(el, 'Path', ctx)
  const layer = pathLayer(ctx, name, geo, s, null)
  const space: PaintSpace = { m, userBox: geo.userBox, box: geo.box }
  const fill = paintOf(fillRaw, s, alphaOf(s['fill-opacity']), space, ctx.ids, ctx)
  const stroke = paintOf(s.stroke ?? 'none', s, alphaOf(s['stroke-opacity']), space, ctx.ids, ctx)
  layer.fill = fill.paint
  for (const n of [fill.note, stroke.note]) if (n) ctx.kept.push(`${name}: ${n}`)
  const k = Math.sqrt(Math.abs(det(m)))
  const width = (len(s['stroke-width'] ?? '1', diagonal(ctx)) ?? 1) * k
  if (stroke.paint && width > 0) {
    layer.stroke = stroke.paint
    layer.strokeWidth = r6(width)
    const dash = (s['stroke-dasharray'] ?? 'none').trim()
    if (dash !== 'none') {
      let list = dash.split(/[\s,]+/).filter(Boolean).map(d => len(d, diagonal(ctx)) ?? NaN)
      if (list.length && list.every(d => d >= 0) && list.some(d => d > 0)) {
        if (list.length % 2) list = [...list, ...list]
        layer.dash = list.map(d => r6(d * k))
      }
    }
    if (!conformal(m)) ctx.kept.push(`${name}: its stroke width is approximated (it was scaled unevenly)`)
    const cap = s['stroke-linecap'] ?? 'butt'
    const join = s['stroke-linejoin'] ?? 'miter'
    if (cap !== 'butt' || join !== 'miter') ctx.kept.push(`${name}: its line caps and joins are drawn plain (${cap}, ${join})`)
  }
  return charge(ctx, layer)
}

function imageLayer(el: Element, m: Matrix, s: Style, ctx: Ctx, name: string): Layer | null {
  const href = Array.from(el.attributes).find(a => a.localName === 'href')?.value ?? ''
  const data = dataUriBytes(href)
  const info = data && imageInfo(data.bytes)
  if (!data || !info) return null
  const w = len(el.getAttribute('width'), ctx.vw) ?? info.width
  const h = len(el.getAttribute('height'), ctx.vh) ?? info.height
  if (!(w > 0 && h > 0)) return null
  const box = roundBox(boxUnder({ x: len(el.getAttribute('x'), ctx.vw) ?? 0, y: len(el.getAttribute('y'), ctx.vh) ?? 0, w, h }, m))
  const par = (el.getAttribute('preserveAspectRatio') ?? '').trim().split(/\s+/)
  const align = par[0] === 'defer' ? par[1] : par[0]
  const slice = (par[0] === 'defer' ? par[2] : par[1]) === 'slice'
  const fit = align === 'none' ? 'fill' : slice ? 'cover' : 'contain'
  if (align && align !== 'none' && align !== 'xMidYMid') ctx.kept.push(`${name}: its image alignment (${align}) is drawn centered`)
  const asset = sharedAssetName(data.bytes, info.type)
  ctx.assets[asset] = data.bytes
  return charge(ctx, { ...base(ctx, name, box, s), type: 'image', asset, fit })
}

// Text

const POSITIONED = ['x', 'y', 'dx', 'dy', 'rotate', 'textLength']

/** Why text has to stay SVG, or null when it's one simple line in one font and size. */
function textProblem(el: Element, s: Style, m: Matrix): string | null {
  if (!isSimilarScale(m) || m[0] < 0) return 'its text is rotated, skewed, stretched or flipped'
  if (['dx', 'dy', 'rotate', 'textLength'].some(a => el.hasAttribute(a))) return 'its text places letters one by one'
  if (numbers(el.getAttribute('x') ?? '').length > 1 || numbers(el.getAttribute('y') ?? '').length > 1) return 'its text places letters one by one'
  const fonts = new Set<string>()
  const check = (node: Element, st: Style, text: string): string | null => {
    if ((st['writing-mode'] ?? 'horizontal-tb').startsWith('vertical') || /^(tb|tb-rl)$/.test(st['writing-mode'] ?? '')) return 'its text runs vertically'
    if (!/^(auto|alphabetic|baseline)?$/.test((st['dominant-baseline'] ?? '').trim()) || node.hasAttribute('baseline-shift') || node.hasAttribute('alignment-baseline')) {
      return 'its text sits on a baseline other than the alphabetic one'
    }
    if (!text.trim()) return null
    if ((st.fill ?? 'black').trim() === 'none') return 'its text is outlined only'
    fonts.add([st['font-family'], st['font-size'], st['font-weight'], st['font-style']].join('|'))
    return null
  }
  let own = ''
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 || n.nodeType === 4) own += (n as CharacterData).data
  const first = check(el, s, own)
  if (first) return first
  for (const c of elementChildren(el)) {
    if (c.localName !== 'tspan') return c.localName === 'textPath' ? 'its text follows a path' : 'its text holds more than plain runs'
    if (POSITIONED.some(a => c.hasAttribute(a))) return 'its text places lines or letters one by one'
    if (elementChildren(c).length) return 'its text nests runs inside runs'
    const why = check(c, styleOf(c, s), textOf(c))
    if (why) return why
  }
  if (fonts.size > 1) return 'its text mixes fonts or sizes'
  return null
}

function fontRef(st: Style) {
  const family = (st['font-family'] ?? 'sans-serif').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'sans-serif'
  const w = (st['font-weight'] ?? 'normal').trim().toLowerCase()
  const weight = w === 'bold' || w === 'bolder' ? 700 : w === 'lighter' ? 300 : /^\d+$/.test(w) ? Math.min(1000, Math.max(1, +w)) : 400
  const style: 'normal' | 'italic' = /^(italic|oblique)/i.test(st['font-style'] ?? '') ? 'italic' : 'normal'
  return { family, weight, style }
}

function textLayer(el: Element, m: Matrix, s: Style, ctx: Ctx, name: string): Layer | null {
  const k = m[0]
  const preserve = el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space') === 'preserve'
  const parts: { text: string; st: Style }[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) parts.push({ text: (n as CharacterData).data, st: s })
    else if (n.nodeType === 1) parts.push({ text: textOf(n as Element), st: styleOf(n as Element, s) })
  }
  // SVG's default white space handling: newlines go, tabs become spaces, runs of spaces collapse, ends are trimmed
  let prevSpace = true
  for (const p of parts) {
    let t = preserve ? p.text.replace(/[\r\n\t]/g, ' ') : p.text.replace(/[\r\n]/g, '').replace(/\t/g, ' ').replace(/ +/g, ' ')
    if (!preserve && prevSpace) t = t.replace(/^ /, '')
    if (t) prevSpace = t.endsWith(' ')
    p.text = t
  }
  if (!preserve) {
    for (let i = parts.length - 1; i >= 0; i--) {
      parts[i].text = parts[i].text.replace(/ +$/, '')
      if (parts[i].text) break
    }
  }
  const used = parts.filter(p => p.text)
  if (!used.length) return null
  const size = (len(s['font-size'] ?? '16', 16) ?? 16) * k
  if (!(size > 0)) return null
  const x = (len(el.getAttribute('x') ?? '0', ctx.vw) ?? 0)
  const y = (len(el.getAttribute('y') ?? '0', ctx.vh) ?? 0)
  const [ax, ay] = apply(m, x, y)
  const anchor = (s['text-anchor'] ?? 'start').trim()
  const align = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left'
  const runs: TextRun[] = used.map(p => {
    const ls = len(p.st['letter-spacing'] ?? '0', 16)
    const run: TextRun = { text: p.text, font: fontRef(p.st), size: r6(size) }
    if (ls) run.letterSpacing = r6(ls * k)
    return run
  })
  const probe: TextLayer = {
    ...base(ctx, name, { x: 0, y: 0, w: 0, h: 0 }, s), type: 'text', runs, mode: 'point', align: 'left', valign: 'top'
  }
  // without fonts the width and ascent are estimates; the anchor (start, middle or end) stays exact either way
  let width = used.reduce((a, p) => a + p.text.length, 0) * size * 0.55
  let ascent = size * 0.9
  if (ctx.fonts) {
    const line = layoutText(probe, ctx.fonts).lines[0]
    if (line) {
      width = line.width
      ascent = line.y
    }
  }
  const box = roundBox({ x: ax - (align === 'center' ? width / 2 : align === 'right' ? width : 0), y: ay - ascent, w: width, h: size * 1.2 })
  const userBox: Box = { x: (box.x - m[4]) / k, y: (box.y - m[5]) / k, w: box.w / k, h: box.h / k }
  used.forEach((p, i) => {
    const paint = paintOf(p.st.fill ?? 'black', p.st, alphaOf(p.st['fill-opacity']), { m, userBox, box }, ctx.ids, ctx)
    runs[i].color = paint.paint ?? { type: 'color', color: '#000000' }
    if (paint.note) ctx.kept.push(`${name}: ${paint.note}`)
  })
  const layer: TextLayer = { ...probe, x: box.x, y: box.y, width: box.w, height: box.h, align }
  const stroke = paintOf(s.stroke ?? 'none', s, alphaOf(s['stroke-opacity']), { m, userBox: null, box }, ctx.ids, ctx)
  const sw = (len(s['stroke-width'] ?? '1', diagonal(ctx)) ?? 1) * k
  if (stroke.paint && sw > 0) {
    layer.stroke = stroke.paint
    layer.strokeWidth = r6(sw)
  }
  return charge(ctx, layer)
}

/** The root's mapping from its viewBox to px, and its size in px when it has one. */
function rootFrame(root: Element): { m: Matrix; vp: Viewport; frame: Box | null } {
  const size = (n: string) => {
    const v = root.getAttribute(n)
    return v && !v.trim().endsWith('%') ? len(v, 0) : null
  }
  let W = size('width')
  let H = size('height')
  const vb = viewBoxOf(root)
  if (vb) {
    if (W === null && H === null) [W, H] = [vb[2], vb[3]]
    else if (W === null) W = (H! * vb[2]) / vb[3]
    else if (H === null) H = (W * vb[3]) / vb[2]
    return { m: viewBoxMatrix(vb, W!, H!, root.getAttribute('preserveAspectRatio')), vp: { vw: vb[2], vh: vb[3] }, frame: { x: 0, y: 0, w: W!, h: H! } }
  }
  return { m: IDENTITY, vp: { vw: W ?? 300, vh: H ?? 150 }, frame: W !== null && H !== null ? { x: 0, y: 0, w: W, h: H } : null }
}

/**
 * Cleans SVG and converts it into one group named `name`: paths, groups, gradients, clipped groups, images (as assets)
 * and simple text, with anything else kept as a cleaned `svg` layer. The group's box is the union of its children's.
 */
export function importSvg(svg: string, name: string, opts: ImportOptions = {}): ImportResult {
  const { root, removed } = cleanSvgRoot(svg)
  const kept: string[] = []
  applyStyles(root, n => kept.push(n))
  const { m, vp, frame } = rootFrame(root)
  const ctx: Ctx = { ...vp, budget: { elements: 0, bytes: 0, json: 0, paints: 0 }, sizes: new Map(), ids: idMap(root), taken: opts.taken ?? new Set(), counts: {}, kept, assets: {}, frame, fonts: opts.fonts }
  ctx.sizes = expandedSizes(root, ctx.ids)
  const s = styleOf(root, {})
  const children: Layer[] = []
  for (const c of elementChildren(root)) {
    const l = convert(c, m, s, ctx, 0)
    if (l) children.push(l)
  }
  const b = children.length ? layersBox(children) : (frame ?? { x: 0, y: 0, w: 0, h: 0 })
  const group: GroupLayer = charge(ctx, { ...base(ctx, name, b, s, false), type: 'group', children })
  return { group, removed, kept, assets: ctx.assets }
}

/**
 * One layer as a standalone, clean SVG in its own coordinates: moved so its box starts at 0,0, with the root sized to
 * the box. It renders in export mode, so svg layers inside a group come out inline (as an image they'd be cleaned
 * away). An `svg` layer gives its own document at the layer's size.
 */
export function layerAsSvg(design: Design, layer: Layer, opts: RenderOptions): string {
  const b = boxOf(layer)
  const W = num(b.w, 3)
  const H = num(b.h, 3)
  if (layer.type === 'svg') {
    const { root } = cleanSvgRoot(String(layer.svg ?? ''))
    root.setAttribute('width', W)
    root.setAttribute('height', H)
    if (root.getAttribute('viewBox')) root.setAttribute('preserveAspectRatio', 'none')
    return cleanSvg(serializeSvg(root)).svg
  }
  const move = b.x || b.y ? ` transform="translate(${num(-b.x, 3)} ${num(-b.y, 3)})"` : ''
  const doc =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}"><g${move}>${layerToSvg(design, layer, { ...opts, mode: 'export' })}</g></svg>`
  return cleanSvg(doc).svg
}
