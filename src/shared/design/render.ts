import type { FontSource } from './fonts'
import { type Box, type Point, boundsOf, boxOf, connectorPath, fin, grow, layerIndex, midpoint, transformedBounds, union } from './geometry'
import { artboardOf, walk } from './model'
import { escapedLength, shortKey } from './svgClean'
import { type InlineCaches, cachedInline, inlineCaches, inlineSvg } from './svgFragment'
import {
  type GlyphCosts, OutlinesTooLong, cleanText, layoutText, num as n, outlineEstimate, runSize, textPaths, textRuns
} from './text'
import type { Artboard, Component, Design, Layer, Override, Paint, TextLayer, TextRun } from './types'

export { connectorPath } from './geometry'

// The one renderer. designToSvg is the only code that turns a design into SVG: the editor canvas, `gdocs look`,
// thumbnails and every export call it. The same input always gives the same bytes: every id comes from a layer id.
// Raster mode draws text as glyph outlines and skips hidden layers. Export mode keeps text live (naming the family,
// never embedding the font) unless outlines are asked for, and keeps hidden layers with display="none". An svg layer
// is an image in raster mode (the window never inlines outside SVG) and its cleaned fragment inline in export mode.
// One budget bounds what a drawing writes, so it never throws: past it, layers are left out and listed.

/** A layer a drawing left out, and why, for the reply. */
export interface Downgrade { layer: string; name: string; reason: string }

export interface RenderOptions {
  fonts: FontSource
  assets: Record<string, Uint8Array>
  mode: 'raster' | 'export'
  outlines?: boolean
  seconds?: number
  /** Each layer the drawing leaves out is added here once, with why. */
  downgrades?: Downgrade[]
}

/**
 * Most characters one drawing may write, over every part (shapes, text, images, names, instances and svg layers) in
 * either mode. Once a layer doesn't fit, it and every layer after it draw nothing and are listed as downgrades, so no
 * drawing builds a string past what one can hold.
 */
export const MAX_RENDER_OUTPUT = 128 * 1024 * 1024
/** Most instances one drawing expands: components can hold instances, so a small design could ask for millions. */
export const MAX_INSTANCES = 10_000
/** Longest a layer name is written (as data-name and as inkscape:label). */
export const MAX_NAME_OUTPUT = 1000
export const OVER_BUDGET = 'This layer was left out: the drawing passed 128 MB.'
export const TOO_MANY_INSTANCES = 'This instance was left out: the drawing passed 10,000 instances.'
export const NOT_DRAWN = 'This layer could not be drawn, so it was left out.'
export const SVG_NOT_CONVERTED = 'This SVG layer could not be converted for export, so it was left out.'
/** Most stops a gradient is written with (an import never makes more). */
const MAX_STOPS = 256

/**
 * Where a layer is drawn. `overrides` is the chain of override maps from the outermost instance in: the first that
 * holds a layer's id wins, so nothing is copied per instance. `ends` is where a connector finds the layers it joins.
 */
interface Scope { prefix: string; overrides: Record<string, Override>[]; top: boolean; ends: Ends; comps: string[] }
/** The layers a connector's ends are looked for in (the artboard's, or a component's root), indexed on first use. */
interface Ends { layers: Layer[]; index?: Map<string, Layer> }
interface Ctx {
  design: Design; opts: RenderOptions; defs: string[]; ids: Map<string, number>
  /** gradients written so far, by the shortKey of their signature (checked against the signature itself) */
  paints: Map<string, { sig: string; id: string }>
  /** keys of the gradients in the order they were added, so a layer left out can take its own back */
  paintLog: string[]
  /** svg layers inlined so far, which numbers each one's id prefix */
  svgs: number
  /** characters written so far, and whether MAX_RENDER_OUTPUT has been reached (after which nothing more is drawn) */
  used: number
  full: boolean
  /** instances expanded so far */
  instances: number
  /** svg layers converted for inlining (null: they couldn't be), so each is converted once per drawing */
  svgCache: InlineCaches
  /** downgrades already listed, by layer and reason */
  listed: Set<string>
  /** components by id, made on first use */
  comps?: Map<string, Component>
  /** each component's root as connector ends, made on first use, so instances share one index */
  compEnds: Map<Component, Ends>
  /** characters the layer being built may still write (what the drawing had left when it began) */
  room: number
  /**
   * Layers that didn't fit, with the overrides they were drawn under (failSig). What's left only shrinks as a drawing
   * goes on, so the same layer under the same overrides (another instance of its component) is left out at once.
   */
  failed: Map<Layer, Set<string>>
  /**
   * escaped lengths of path data and stored glyphs, by the layer that holds them, each measured once per drawing (never
   * keyed by the string: V8 hashes a string over 16,383 characters by its length alone, so same-length ones would
   * share one bucket)
   */
  escLens: { d: WeakMap<object, number>; glyphs: WeakMap<object, number> }
  /** what each glyph's outline has come to so far (see outlineEstimate) */
  glyphCosts: GlyphCosts
}

/** Thrown while a layer is built once what it adds passes the budget: the layer is left out without finishing. */
class OverBudget extends Error {}
/** The longest key (a layer id with its instance prefixes) a layer can be drawn with; validated designs stay far below. */
const MAX_KEY = 2048

/** The override a scope gives a layer: the outermost instance's first. */
function overrideIn(scope: Scope, id: string): Override | undefined {
  for (const map of scope.overrides) if (has(map, id)) return map[id]
  return undefined
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
  '\u0085': '&#133;', '\u2028': '&#8232;'
}
const ESCAPED = /[&<>"'\t\n\r\u0085\u2028]/g
const PIECE = 1 << 20
/**
 * Text or an attribute value made safe for XML. Tab, LF, CR, NEL and LINE SEPARATOR become references, so names read
 * back exactly (a parser turns them into spaces or line ends) and cleanSvg leaves the output byte for byte the same.
 * A long value is escaped a megabyte at a time (never splitting a surrogate pair), so no one replace holds millions
 * of matches.
 */
export const esc = (s: unknown): string => {
  const t = String(s ?? '')
  if (t.length <= PIECE) return cleanText(t).replace(ESCAPED, c => ENTITIES[c])
  const out: string[] = []
  for (let i = 0; i < t.length; ) {
    let j = Math.min(t.length, i + PIECE)
    const last = t.charCodeAt(j - 1)
    if (j < t.length && last >= 0xd800 && last <= 0xdbff) j++
    out.push(cleanText(t.slice(i, j)).replace(ESCAPED, c => ENTITIES[c]))
    i = j
  }
  return out.join('')
}
const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_')
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

const BLACK: Paint = { type: 'color', color: '#000000' }
const BLENDS = new Set([
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
])
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_NESTING = 16
const CONNECTOR_WIDTH = 2
const EMPTY_BOARD: Artboard = { id: '', name: '', width: 0, height: 0, background: null, layers: [] }

function nextId(ctx: Ctx, prefix: string, key: string): string {
  const k = `${prefix}-${key}`
  const count = (ctx.ids.get(k) ?? 0) + 1
  ctx.ids.set(k, count)
  return `${k}-${count}`
}

/**
 * Takes `size` characters from the drawing's budget. When they don't fit, false; and the budget counts as reached
 * (every later layer left out) only when they would have fitted an empty budget, so one layer too big to draw at all
 * leaves the rest of the drawing alone.
 */
function spend(ctx: Ctx, size: number): boolean {
  if (ctx.full) return false
  if (ctx.used + size > MAX_RENDER_OUTPUT) {
    if (size <= MAX_RENDER_OUTPUT) ctx.full = true
    return false
  }
  ctx.used += size
  return true
}

/**
 * A definition the drawing needs (a gradient, filter or marker, a few KB at most). Past the budget it stops the layer
 * that asked for it, which is then left out and gives its definitions back.
 */
function addDef(ctx: Ctx, def: string): void {
  if (ctx.used + def.length > MAX_RENDER_OUTPUT) {
    ctx.full = true
    throw new OverBudget('The drawing is full.')
  }
  ctx.defs.push(def)
  ctx.used += def.length
}

/** What a layer's drawing has added so far, so a layer left out partway can take it all back. */
interface Mark { defs: number; used: number; paints: number }
const mark = (ctx: Ctx): Mark => ({ defs: ctx.defs.length, used: ctx.used, paints: ctx.paintLog.length })
function rollBack(ctx: Ctx, m: Mark): void {
  ctx.defs.length = m.defs
  ctx.used = m.used
  for (const k of ctx.paintLog.splice(m.paints)) ctx.paints.delete(k)
}

/** Text a downgrade can hold, from whatever a layer field holds (never converted with String()). */
const plain = (v: unknown): string => (typeof v === 'string' ? cleanText(v.slice(0, MAX_NAME_OUTPUT)) : typeof v === 'number' ? String(v) : '')

/** Lists a layer as left out (once per layer and reason) and draws nothing for it. */
function leftOut(ctx: Ctx, l: Layer, reason: string): string {
  const id = plain(l?.id)
  const key = `${id}\u0000${reason}`
  if (!ctx.listed.has(key)) {
    ctx.listed.add(key)
    ctx.opts.downgrades?.push({ layer: id, name: plain(l?.name), reason })
  }
  return ''
}

/** How many characters base64 makes of `bytes` bytes. */
const base64Size = (bytes: number): number => 4 * Math.ceil(bytes / 3)
/**
 * About what one visible character's outline writes in raster mode (Liberation Sans: letters 550 to 1,600,
 * punctuation 110 to 140). It's charged before outlines are built, so a text too long to draw is left out without
 * building hundreds of megabytes first; what was charged beyond what was written is given back afterwards.
 */
const OUTLINE_PER_GLYPH = 500

/**
 * The object that holds `k` itself: the layer, or for a layer an instance draws with an override (made over it by
 * withOverride, which never sets markup, path data or glyphs), the layer under it. Null when nothing does.
 */
function holderOf(l: object, k: string): object | null {
  for (let o: object | null = l; o; o = Object.getPrototypeOf(o)) if (has(o, k)) return o
  return null
}

/**
 * The escaped length of a layer's path data or stored glyphs, measured once per drawing for the layer that holds them
 * (instances of a component share it).
 */
function escLen(ctx: Ctx, l: Layer, k: 'd' | 'glyphs'): number {
  const s = (l as unknown as Record<string, unknown>)[k]
  if (typeof s !== 'string') return 0
  const holder = holderOf(l, k)
  if (!holder) return escapedLength(s)
  const memo = ctx.escLens[k]
  let len = memo.get(holder)
  if (len === undefined) {
    len = escapedLength(s)
    memo.set(holder, len)
  }
  return len
}

/** The stored outlines a text layer is drawn with (its font missing and its text not overridden), or null. */
function storedGlyphs(fonts: FontSource, l: TextLayer, overrideText: string | undefined, runs: TextRun[]): string | null {
  return typeof l.glyphs === 'string' && l.glyphs && overrideText === undefined && runs.some(r => fonts.get(r.font).missing) ? l.glyphs : null
}

/** The least a text writes: stored outlines as escaped, else its characters, or (as outlines) what they'll come to. */
function textLeast(ctx: Ctx, l: TextLayer, overrideText: string | undefined, outlines: boolean, stored: boolean): number {
  const runs = textRuns(l, overrideText)
  const glyphs = stored ? storedGlyphs(ctx.opts.fonts, l, overrideText, runs) : null
  if (glyphs !== null) return escLen(ctx, l, 'glyphs')
  let chars = 0
  let drawn = 0
  for (const r of runs) {
    chars += r.text.length
    if (outlines) drawn += outlineEstimate(ctx.opts.fonts, r, r.text, OUTLINE_PER_GLYPH, ctx.glyphCosts)
  }
  return Math.max(chars, drawn)
}

/**
 * The least a layer's own drawing will write, read cheaply before it's built: an image's base64, path data as
 * escaped, text as escaped (export) or as outlines (raster), stored glyphs as escaped, a converted svg layer's
 * markup. A layer whose least doesn't fit is left out before any of it is built.
 */
function leastSize(ctx: Ctx, l: Layer, overrideText: string | undefined): number {
  if ((l.type === 'image' || l.type === 'paint') && typeof l.asset === 'string' && has(ctx.opts.assets, l.asset)) {
    return base64Size(ctx.opts.assets[l.asset]?.length ?? 0)
  }
  if (l.type === 'svg') {
    const svg = typeof l.svg === 'string' ? l.svg : ''
    return ctx.opts.mode === 'raster' ? base64Size(svg.length) : (cachedInline(ctx.svgCache, svg, holderOf(l, 'svg') ?? undefined)?.size ?? 0)
  }
  if (l.type === 'path') return escLen(ctx, l, 'd')
  if (l.type === 'text') return textLeast(ctx, l, overrideText, ctx.opts.mode === 'raster' || !!ctx.opts.outlines || !!l.outlines, true)
  return 0
}

/** The least a clip mask writes as clip geometry: path data as escaped, text as outlines. */
function clipLeast(ctx: Ctx, l: Layer, overrideText: string | undefined): number {
  if (l.type === 'path') return escLen(ctx, l, 'd')
  if (l.type === 'text') return textLeast(ctx, l, overrideText, true, false)
  return 0
}

/** A paint by the fields that draw it, never the whole object (which could hold any number of fields). */
const paintSig = (p: unknown): unknown => {
  if (!p || typeof p !== 'object') return p ?? null
  const q = p as Record<string, unknown>
  const stops = Array.isArray(q.stops) ? q.stops.slice(0, MAX_STOPS).map(s => [s?.offset, typeof s?.color === 'string' ? s.color : null]) : null
  return [q.type, typeof q.color === 'string' ? q.color : null, typeof q.ref === 'string' ? q.ref : null, q.angle, stops]
}
/** An override by the fields that draw it. */
const overrideSig = (o: Override | undefined): string =>
  o
    ? JSON.stringify([
        typeof o.text === 'string' ? o.text : null, paintSig(o.fill), paintSig(o.stroke),
        typeof o.visible === 'boolean' ? o.visible : null, typeof o.asset === 'string' ? o.asset : null
      ])
    : ''

/**
 * What a layer's drawing depends on beyond the layer itself: the override it's drawn with and, for a clip group, its
 * mask's. Null when it can't be told (then nothing is remembered).
 */
function failSig(src: Layer, scope: Scope): string | null {
  try {
    let sig = overrideSig(overrideIn(scope, src.id))
    if (src.type === 'group' && src.clip && Array.isArray(src.children) && src.children[0]) {
      sig += '\u0000' + overrideSig(overrideIn(scope, src.children[0].id))
    }
    return sig
  } catch {
    return null
  }
}

const boxAttrs = (b: Box): string => `x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"`

function base64(bytes: Uint8Array): string {
  const B = (globalThis as any).Buffer
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** An embedded image. xlink:href, which SVG 1.1 importers (Illustrator) need and HTML inlining maps too. */
const imageTag = (b: Box, fit: string, mime: string, bytes: Uint8Array): string =>
  `<image ${boxAttrs(b)} preserveAspectRatio="${fit}" xlink:href="data:${mime};base64,${base64(bytes)}"/>`

/** #rgb, #rrggbb or #rrggbbaa as a 6 digit color plus an opacity (SVG 1.1 has no 8 digit colors). Anything else is black. */
function color(c: unknown): { hex: string; alpha: number } {
  const m = typeof c === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim()) : null
  if (!m) return { hex: '#000000', alpha: 1 }
  let h = m[1].toLowerCase()
  if (h.length === 3) h = h.replace(/./g, x => x + x)
  return { hex: '#' + h.slice(0, 6), alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 }
}

/** A paint as one color: a style through design.styles.colors (unknown is black), a gradient by its first stop. */
function solid(ctx: Ctx, p: Paint): { hex: string; alpha: number } {
  if (p.type === 'color') return color(p.color)
  if (p.type === 'style') return color((Array.isArray(ctx.design.styles?.colors) ? ctx.design.styles.colors : []).find(c => c?.name === p.ref)?.color)
  return color(Array.isArray(p.stops) ? p.stops[0]?.color : undefined)
}

/** ` fill="..."` (or stroke) for a paint; gradients go into defs as g-<key>-<n>, over the box in user space. */
function paintAttr(ctx: Ctx, p: Paint | null | undefined, attr: 'fill' | 'stroke', key: string, b: Box): string {
  if (!p) return attr === 'fill' ? ' fill="none"' : ''
  if (p.type === 'linear' || p.type === 'radial') return ` ${attr}="url(#${gradient(ctx, p, key, b)})"`
  const c = solid(ctx, p)
  return ` ${attr}="${c.hex}"` + (c.alpha < 1 ? ` ${attr}-opacity="${n(c.alpha, 3)}"` : '')
}

function gradient(ctx: Ctx, p: Extract<Paint, { stops: unknown }>, key: string, b: Box): string {
  // the stops as written: at most 256, each a color at an offset (anything else in the paint can't change the output)
  const stops = (Array.isArray(p.stops) ? p.stops.slice(0, MAX_STOPS) : [])
    .map(s => {
      const c = color(s?.color)
      const at = Math.min(1, Math.max(0, fin(s?.offset, 0)))
      return `<stop offset="${n(at, 4)}" stop-color="${c.hex}"${c.alpha < 1 ? ` stop-opacity="${n(c.alpha, 3)}"` : ''}/>`
    })
    .join('')
  // 256 stops can make a signature too long to be a Map key of its own (see shortKey)
  const sig = `${key}|${p.type}|${n(fin(p.angle, 0), 4)}|${stops}|${b.x},${b.y},${b.w},${b.h}`
  const k = shortKey(sig)
  const known = ctx.paints.get(k)
  if (known && known.sig === sig) return known.id
  const id = nextId(ctx, 'g', key)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  if (p.type === 'linear') {
    // angle in degrees: 0 runs left to right, 90 top to bottom; the line spans the box like a CSS gradient
    const a = (fin(p.angle, 0) * Math.PI) / 180
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const half = (Math.abs(b.w * dx) + Math.abs(b.h * dy)) / 2
    addDef(
      ctx,
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - dx * half)}" y1="${n(cy - dy * half)}" ` +
        `x2="${n(cx + dx * half)}" y2="${n(cy + dy * half)}">${stops}</linearGradient>`
    )
  } else {
    const r = Math.hypot(b.w, b.h) / 2
    addDef(ctx, `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}">${stops}</radialGradient>`)
  }
  // a different signature with the same key (rare) keeps the first: this one is written again each time
  if (!known) {
    ctx.paints.set(k, { sig, id })
    ctx.paintLog.push(k)
  }
  return id
}

function strokeAttr(ctx: Ctx, l: Layer, key: string, b: Box, p: Paint | null | undefined, width = 1): string {
  const w = fin(l.strokeWidth, width)
  if (!p || w <= 0) return ''
  let s = paintAttr(ctx, p, 'stroke', key, b) + ` stroke-width="${n(w)}"`
  if (Array.isArray(l.dash) && l.dash.length) s += ` stroke-dasharray="${l.dash.map(d => n(Math.max(0, fin(d, 0)))).join(' ')}"`
  return s
}

/** Rotation about the box center, then scale about the box center. */
function transformOf(l: Layer): string {
  const b = boxOf(l)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const parts: string[] = []
  const r = fin(l.rotation, 0)
  if (r % 360 !== 0) parts.push(`rotate(${n(r, 4)} ${n(cx)} ${n(cy)})`)
  const sx = fin(l.scaleX, 1)
  const sy = fin(l.scaleY, 1)
  if (sx !== 1 || sy !== 1) parts.push(`translate(${n(cx)} ${n(cy)}) scale(${n(sx, 6)} ${n(sy, 6)}) translate(${n(-cx)} ${n(-cy)})`)
  return parts.join(' ')
}

/** Where a text layer's glyphs can reach: its box plus every span's ink (point text and overflow go past the box). */
function textExtent(fonts: FontSource, l: TextLayer, overrideText?: string): Box {
  const runs = textRuns(l, overrideText)
  let b = boxOf(l)
  for (const line of layoutText(l, fonts, overrideText).lines) {
    for (const s of line.spans) {
      const size = runSize(runs[s.run])
      const font = fonts.get(runs[s.run].font).font
      const k = size / (font?.unitsPerEm || 1000)
      const asc = fin(font?.ascent, 800) * k
      const desc = Math.abs(fin(font?.descent, -200)) * k
      const pad = size / 4 // overhangs past the advance and accents above the ascent
      b = union(b, { x: s.x - pad, y: line.y - asc - pad, w: s.width + 2 * pad, h: asc + desc + 2 * pad })
    }
  }
  return b
}

/** The area a layer draws in its own coordinates, before its filter: what the filter region has to cover. */
function extentOf(ctx: Ctx, l: Layer, overrideText: string | undefined, pts: Point[]): Box {
  if (l.type === 'connector') {
    if (!pts.length) return boxOf(l)
    const sw = fin(l.strokeWidth, CONNECTOR_WIDTH)
    let b = grow(boundsOf(pts), sw * 4) // arrowheads are 4 stroke widths
    const label = cleanText(String(l.label ?? '')).trim()
    if (label) b = union(b, labelParts(ctx, '', label, midpoint(pts), '#000000').rect)
    return b
  }
  let b = l.type === 'text' ? textExtent(ctx.opts.fonts, l, overrideText) : boxOf(l)
  if (l.type === 'group') {
    walk(l.children ?? [], d => {
      b = union(b, transformedBounds(d.type === 'text' ? textExtent(ctx.opts.fonts, d) : grow(boxOf(d), fin(d.strokeWidth, 0)), d))
    })
  }
  return grow(b, fin(l.strokeWidth, 0))
}

/**
 * An SVG 1.1 filter for the shadow and blur, as f-<key>-<n>. The region is in user space: the layer's drawn extent
 * grown by the shadow offset and three times each blur, so glyph shadows and blurs are never cut off.
 */
function filterFor(ctx: Ctx, l: Layer, key: string, extent: () => Box): string {
  const sh = l.shadow
  const blur = Math.max(0, fin(l.blur, 0))
  if (!sh && !blur) return ''
  const id = nextId(ctx, 'f', key)
  const shBlur = sh ? Math.max(0, fin(sh.blur, 0)) : 0
  const reach = (sh ? Math.abs(fin(sh.x, 0)) + Math.abs(fin(sh.y, 0)) + 3 * shBlur : 0) + 3 * blur + 2
  const region = `filterUnits="userSpaceOnUse" ${boxAttrs(grow(extent(), reach))}`
  let body = ''
  let input = 'SourceGraphic'
  if (sh) {
    // a shadow's blur is a radius, as in CSS: the deviation is half of it
    const c = color(sh.color)
    body +=
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(shBlur / 2)}"/><feOffset dx="${n(fin(sh.x, 0))}" dy="${n(fin(sh.y, 0))}" result="o"/>` +
      `<feFlood flood-color="${c.hex}" flood-opacity="${n(c.alpha, 3)}"/><feComposite in2="o" operator="in" result="s"/>` +
      `<feMerge result="m"><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>`
    input = 'm'
  }
  if (blur) body += `<feGaussianBlur in="${input}" stdDeviation="${n(blur)}"/>`
  addDef(ctx, `<filter id="${id}" ${region} color-interpolation-filters="sRGB">${body}</filter>`)
  return id
}

/**
 * A layer as an instance draws it. The overridden fields sit on an object made over the layer (its prototype), never
 * on a copy: a layer can hold any number of fields a later release added.
 */
function withOverride(l: Layer, o: Override | undefined): Layer {
  if (!o) return l
  const out = Object.create(l) as Layer & { asset?: string }
  if (o.fill !== undefined) out.fill = o.fill
  if (o.stroke !== undefined) out.stroke = o.stroke
  if (typeof o.visible === 'boolean') out.visible = o.visible
  if (typeof o.asset === 'string' && (l.type === 'image' || l.type === 'paint')) out.asset = o.asset
  return out
}

const offstage = (l: Layer, s: number | undefined): boolean =>
  s !== undefined && !!l.timing &&
  ((typeof l.timing.start === 'number' && s < l.timing.start) || (typeof l.timing.end === 'number' && s >= l.timing.end))

/** The opening attributes every layer group carries: id, name and Inkscape label (the name cut at 1,000 characters). */
const layerAttrs = (key: string, name: unknown): string => {
  const shown = esc(typeof name === 'string' ? name.slice(0, MAX_NAME_OUTPUT) : '')
  return `id="l-${key}" data-name="${shown}" inkscape:label="${shown}"`
}

/**
 * A layer's group and what it draws, within the drawing's budget: a layer that doesn't fit, or that fails to draw,
 * draws nothing and is listed, and takes back what it had added (definitions and budget). Once the budget is reached
 * every later layer is left out without being built, and a layer that didn't fit is left out at once when it comes
 * up again under the same overrides.
 */
function renderLayer(ctx: Ctx, src: Layer, scope: Scope): string {
  if (ctx.full) return leftOut(ctx, src, OVER_BUDGET)
  const seen = src && typeof src === 'object' ? ctx.failed.get(src) : undefined
  let sig: string | null | undefined
  if (seen) {
    sig = failSig(src, scope)
    if (sig !== null && seen.has(sig)) return leftOut(ctx, src, OVER_BUDGET)
  }
  const before = mark(ctx)
  const out = (reason: string): string => {
    rollBack(ctx, before)
    if (reason === OVER_BUDGET && src && typeof src === 'object') {
      if (sig === undefined) sig = failSig(src, scope)
      if (sig !== null) {
        const sigs = ctx.failed.get(src)
        if (sigs) sigs.add(sig)
        else ctx.failed.set(src, new Set([sig]))
      }
    }
    return leftOut(ctx, src, reason)
  }
  try {
    if (typeof src.id !== 'string') throw new Error('a layer without an id')
    const o = overrideIn(scope, src.id)
    const l = withOverride(src, o)
    const hidden = !l.visible || offstage(l, ctx.opts.seconds)
    if (hidden && ctx.opts.mode === 'raster') return ''
    const key = safeId(scope.prefix + l.id)
    if (key.length > MAX_KEY) throw new Error('an id too long to draw with')
    let a = layerAttrs(key, l.name)
    if (scope.top) a += ' inkscape:groupmode="layer"'
    if (hidden) a += ' display="none"'
    const opacity = Math.min(1, Math.max(0, fin(l.opacity, 1)))
    if (opacity < 1) a += ` opacity="${n(opacity, 3)}"`
    if (BLENDS.has(l.blend)) a += ` style="mix-blend-mode:${l.blend}"`
    const tf = l.type === 'connector' ? '' : transformOf(l)
    if (tf) a += ` transform="${tf}"`
    const overrideText = typeof o?.text === 'string' ? o.text : undefined
    const least = leastSize(ctx, l, overrideText)
    if (!spend(ctx, a.length + 8 + least)) return out(OVER_BUDGET)
    ctx.room = MAX_RENDER_OUTPUT - ctx.used + least
    const pts = l.type === 'connector' ? connectorPath(ctx.design, EMPTY_BOARD, l, endsIndex(scope.ends)) : []
    const fid = filterFor(ctx, l, key, () => extentOf(ctx, l, overrideText, pts))
    if (fid) a += ` filter="url(#${fid})"`
    const inner = content(ctx, l, key, scope, o, pts)
    // a group's or instance's layers paid for themselves; anything else pays for what it drew beyond its least, or
    // gets back what it was charged and didn't write
    if (l.type !== 'group' && l.type !== 'instance') {
      if (inner.length < least) ctx.used -= least - inner.length
      else if (!spend(ctx, inner.length - least)) return out(OVER_BUDGET)
    }
    return `<g ${a}>${inner}</g>`
  } catch (e) {
    return out(e instanceof OverBudget || e instanceof OutlinesTooLong ? OVER_BUDGET : NOT_DRAWN)
  }
}

function content(ctx: Ctx, l: Layer, key: string, scope: Scope, o: Override | undefined, pts: Point[]): string {
  switch (l.type) {
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'path':
      return shapeEl(ctx, l, key, true)
    case 'text':
      return textSvg(ctx, l, key, ctx.opts.fonts, typeof o?.text === 'string' ? o.text : undefined, o?.fill ?? undefined)
    case 'image':
    case 'paint':
      return imageEl(ctx, l.asset, l.fit, boxOf(l))
    case 'svg':
      // The window only ever draws outside SVG as an image; an export inlines it. Its ids are prefixed s1-, s2-, ...
      // by the order svg layers are drawn: the number ends at the dash, so no two prefixes can run into each other
      // (as layer ids a and a-b would), duplicate layer ids don't matter, and no id the renderer makes starts with s.
      if (ctx.opts.mode === 'export') return exportSvgLayer(ctx, l)
      return imageTag(boxOf(l), 'none', 'image/svg+xml', new TextEncoder().encode(typeof l.svg === 'string' ? l.svg : ''))
    case 'group':
      return groupSvg(ctx, l, key, scope)
    case 'instance':
      return instanceSvg(ctx, l, key, scope)
    case 'connector':
      return connectorSvg(ctx, l, key, pts)
  }
  return ''
}

/**
 * An svg layer's fragment inline. Each fragment is cleaned once per drawing (instances of a component share it), and
 * one that can't be converted draws nothing and is listed.
 */
function exportSvgLayer(ctx: Ctx, l: Layer & { type: 'svg' }): string {
  const out = inlineSvg(typeof l.svg === 'string' ? l.svg : '', boxOf(l), `s${++ctx.svgs}-`, ctx.svgCache, holderOf(l, 'svg') ?? undefined)
  return out || leftOut(ctx, l, SVG_NOT_CONVERTED)
}

/** A rect, ellipse, line or path element; painted, or bare geometry for a clip path. */
function shapeEl(ctx: Ctx, l: Layer, key: string, paint: boolean, tf = ''): string {
  const b = boxOf(l)
  // a path is drawn translated to its box, and a user-space gradient lives in the path's own space: offset it back
  const pb = l.type === 'path' ? { ...b, x: b.x - fin(l.x, 0), y: b.y - fin(l.y, 0) } : b
  const fill = paint ? paintAttr(ctx, l.fill, 'fill', key, pb) : ''
  const stroke = paint ? strokeAttr(ctx, l, key, pb, l.stroke) : ''
  const t = (inner = ''): string => {
    const all = [tf, inner].filter(Boolean).join(' ')
    return all ? ` transform="${all}"` : ''
  }
  switch (l.type) {
    case 'rect': {
      const r = Math.min(Math.max(0, fin(l.radius, 0)), b.w / 2, b.h / 2)
      return `<rect ${boxAttrs(b)}${r > 0 ? ` rx="${n(r)}" ry="${n(r)}"` : ''}${t()}${fill}${stroke}/>`
    }
    case 'ellipse':
      return `<ellipse cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" rx="${n(b.w / 2)}" ry="${n(b.h / 2)}"${t()}${fill}${stroke}/>`
    case 'line': {
      // a line runs corner to corner of its box; with no stroke it takes its fill as the stroke
      const s = paint ? strokeAttr(ctx, l, key, b, l.stroke ?? l.fill) : ''
      const x = fin(l.x, 0)
      const y = fin(l.y, 0)
      return `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x + fin(l.width, 0))}" y2="${n(y + fin(l.height, 0))}"${t()}${s}/>`
    }
    case 'path':
      return `<path d="${esc(l.d)}"${t(l.x || l.y ? `translate(${n(fin(l.x, 0))} ${n(fin(l.y, 0))})` : '')}${fill}${stroke}/>`
  }
  return ''
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', 'default'])
/** A family as CSS: bare when it's a run of identifiers, quoted otherwise. */
function cssFamily(f: string): string {
  const bare = f.split(' ').every(w => /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(w)) && !GENERIC_FAMILIES.has(f.toLowerCase())
  return bare ? f : `'${f.replace(/['\\]/g, '\\$&')}'`
}

/** Text as outlines or live `<text>`. A fill override (from an instance) replaces every run's color. */
function textSvg(ctx: Ctx, l: TextLayer, key: string, fonts: FontSource, overrideText?: string, fill?: Paint): string {
  const b = boxOf(l)
  const runs = textRuns(l, overrideText)
  const stroke = strokeAttr(ctx, l, key, b, l.stroke)
  const fillOf = (i: number): string => paintAttr(ctx, fill ?? runs[i]?.color ?? l.fill ?? BLACK, 'fill', key, b)
  const glyphs = storedGlyphs(fonts, l, overrideText, runs)
  if (glyphs !== null) {
    const move = b.x || b.y ? ` transform="translate(${n(b.x)} ${n(b.y)})"` : ''
    // the glyphs are drawn translated to the box, so their paints live in the box's own space
    const own: Box = { x: 0, y: 0, w: b.w, h: b.h }
    const paint = paintAttr(ctx, fill ?? runs[0]?.color ?? l.fill ?? BLACK, 'fill', key, own)
    return `<path d="${esc(glyphs)}"${move}${paint}${strokeAttr(ctx, l, key, own, l.stroke)}/>`
  }
  if (ctx.opts.mode === 'raster' || ctx.opts.outlines || l.outlines) {
    // built against what the drawing has left, so outlines too long to keep stop as soon as they pass it
    return textPaths(l, fonts, overrideText, 0, 0, { left: ctx.room, costs: ctx.glyphCosts })
      .map(p => `<path d="${p.d}"${fillOf(p.run)}${stroke}/>`)
      .join('')
  }
  const style = (i: number): string => {
    const r = runs[i]
    let s = ` font-family="${esc(cssFamily(String(r.font?.family ?? '')))}" font-size="${n(runSize(r))}"`
    if (fin(r.font?.weight, 400) !== 400) s += ` font-weight="${n(fin(r.font.weight, 400), 0)}"`
    if (r.font?.style === 'italic') s += ' font-style="italic"'
    if (fin(r.letterSpacing, 0)) s += ` letter-spacing="${n(fin(r.letterSpacing, 0))}"`
    return s + fillOf(i)
  }
  const lines = layoutText(l, fonts, overrideText).lines.map(line => {
    const at = `x="${n(line.x)}" y="${n(line.y)}"`
    if (line.spans.length === 1) return `<tspan ${at}${style(line.spans[0].run)}>${esc(line.spans[0].text)}</tspan>`
    const spans = line.spans.map(s => `<tspan x="${n(s.x)}"${style(s.run)}>${esc(s.text)}</tspan>`).join('')
    return `<tspan ${at}>${spans}</tspan>`
  })
  return `<text xml:space="preserve"${stroke}>${lines.join('')}</text>`
}

function imageEl(ctx: Ctx, asset: unknown, fit: string | undefined, b: Box): string {
  if (typeof asset !== 'string' || !has(ctx.opts.assets, asset)) return ''
  const bytes = ctx.opts.assets[asset]
  const ext = (/\.([a-z0-9]+)$/i.exec(asset)?.[1] ?? '').toLowerCase()
  const mime = has(MIME, ext) ? MIME[ext] : undefined
  if (!(bytes instanceof Uint8Array) || !mime) return ''
  return imageTag(b, fit === 'contain' ? 'xMidYMid meet' : fit === 'cover' ? 'xMidYMid slice' : 'none', mime, bytes)
}

/**
 * Children in order. With `clip`, the first child (when visible) is the mask: its layer group holds the clip path
 * (never drawn) and the rest are clipped to it. The mask is charged for before it's built, like a layer: one that
 * can't fit leaves the group out (thrown, so the group gives back what it took).
 */
function groupSvg(ctx: Ctx, g: Layer & { type: 'group' }, key: string, scope: Scope): string {
  const inner: Scope = { ...scope, top: false }
  const kids = Array.isArray(g.children) ? g.children : []
  const first = kids[0]
  const maskOverride = g.clip && kids.length > 1 ? overrideIn(scope, first.id) : undefined
  const mask = g.clip && kids.length > 1 ? withOverride(first, maskOverride) : null
  if (mask?.visible) {
    const id = nextId(ctx, 'c', key)
    const maskKey = safeId(scope.prefix + mask.id)
    const least = clipLeast(ctx, mask, typeof maskOverride?.text === 'string' ? maskOverride.text : undefined)
    if (!spend(ctx, least)) throw new OverBudget('The clip mask does not fit.')
    ctx.room = MAX_RENDER_OUTPUT - ctx.used + least
    const holder = `<g ${layerAttrs(maskKey, mask.name)}><clipPath id="${id}">${clipShape(ctx, mask, maskKey, scope)}</clipPath></g>`
    if (holder.length < least) ctx.used -= least - holder.length
    else if (!spend(ctx, holder.length - least)) throw new OverBudget('The clip mask does not fit.')
    return holder + `<g clip-path="url(#${id})">${kids.slice(1).map(k => renderLayer(ctx, k, inner)).join('')}</g>`
  }
  return kids.map(k => renderLayer(ctx, k, inner)).join('')
}

/** A layer as clip geometry: shapes and text outlines as they are, anything else as its box. */
function clipShape(ctx: Ctx, l: Layer, key: string, scope: Scope): string {
  const tf = transformOf(l)
  if (l.type === 'rect' || l.type === 'ellipse' || l.type === 'path') return shapeEl(ctx, l, key, false, tf)
  const t = tf ? ` transform="${tf}"` : ''
  if (l.type === 'text') {
    const text = overrideIn(scope, l.id)?.text
    const budget = { left: ctx.room, costs: ctx.glyphCosts }
    return `<path d="${textPaths(l, ctx.opts.fonts, typeof text === 'string' ? text : undefined, 0, 0, budget).map(p => p.d).join('')}"${t}/>`
  }
  return `<rect ${boxAttrs(boxOf(l))}${t}/>`
}

/**
 * The component's root mapped onto the instance box, with overrides by inner layer id. Unknown or cyclic: nothing.
 * Past MAX_INSTANCES expanded in one drawing, an instance is left out and listed.
 */
function instanceSvg(ctx: Ctx, l: Layer & { type: 'instance' }, key: string, scope: Scope): string {
  if (!ctx.comps) {
    ctx.comps = new Map()
    for (const c of Array.isArray(ctx.design.components) ? ctx.design.components : []) if (c && !ctx.comps.has(c.id)) ctx.comps.set(c.id, c)
  }
  const comp = ctx.comps.get(l.component)
  if (!comp?.root || scope.comps.includes(comp.id) || scope.comps.length >= MAX_NESTING) return ''
  if (++ctx.instances > MAX_INSTANCES) return leftOut(ctx, l, TOO_MANY_INSTANCES)
  const r = boxOf(comp.root)
  const b = boxOf(l)
  const sx = r.w ? b.w / r.w : 1
  const sy = r.h ? b.h / r.h : 1
  const tf = `translate(${n(b.x)} ${n(b.y)}) scale(${n(sx, 6)} ${n(sy, 6)})` + (r.x || r.y ? ` translate(${n(-r.x)} ${n(-r.y)})` : '')
  let ends = ctx.compEnds.get(comp)
  if (!ends) ctx.compEnds.set(comp, (ends = { layers: [comp.root] }))
  const inner: Scope = {
    prefix: key + '-',
    // the outer instances' overrides win over this one's: looked up in that order, never copied
    overrides: l.overrides && typeof l.overrides === 'object' ? [...scope.overrides, l.overrides] : scope.overrides,
    top: false,
    ends,
    comps: [...scope.comps, comp.id]
  }
  return `<g transform="${tf}">${renderLayer(ctx, comp.root, inner)}</g>`
}

/** The index of where connectors in a scope find their ends, made the first time one is drawn there. */
function endsIndex(ends: Ends): Map<string, Layer> {
  if (!ends.index) ends.index = layerIndex(ends.layers)
  return ends.index
}

/** An arrowhead as m-<key>-<n>, pointing along the line at the end (or back along it at the start). */
function marker(ctx: Ctx, key: string, hex: string, start: boolean): string {
  const id = nextId(ctx, 'm', key)
  const d = start ? 'M10 0L0 5L10 10Z' : 'M0 0L10 5L0 10Z'
  addDef(
    ctx,
    `<marker id="${id}" viewBox="0 0 10 10" refX="${start ? 0 : 10}" refY="5" markerWidth="4" markerHeight="4" ` +
      `markerUnits="strokeWidth" orient="auto"><path d="${d}" fill="${hex}"/></marker>`
  )
  return id
}

function connectorSvg(ctx: Ctx, l: Layer & { type: 'connector' }, key: string, pts: Point[]): string {
  if (pts.length < 2) return ''
  const paint = l.stroke ?? BLACK
  const ink = solid(ctx, paint).hex
  let markers = ''
  if (l.arrow === 'end' || l.arrow === 'both') markers += ` marker-end="url(#${marker(ctx, key, ink, false)})"`
  if (l.arrow === 'both') markers += ` marker-start="url(#${marker(ctx, key, ink, true)})"`
  const points = pts.map(p => `${n(p[0])},${n(p[1])}`).join(' ')
  let out = `<polyline points="${points}" fill="none"${strokeAttr(ctx, l, key, boundsOf(pts), paint, CONNECTOR_WIDTH)}${markers}/>`
  const label = cleanText(String(l.label ?? '')).trim()
  if (label) {
    const { layer, fonts, rect } = labelParts(ctx, key, label, midpoint(pts), ink)
    out += `<rect ${boxAttrs(rect)} fill="#ffffff"/>` + textSvg(ctx, layer, key, fonts)
  }
  return out
}

/** A connector label: the fallback font at 14 px, centered on the point, and its white backing. */
function labelParts(ctx: Ctx, key: string, label: string, [mx, my]: Point, hex: string): { layer: TextLayer; fonts: FontSource; rect: Box } {
  const fb = ctx.opts.fonts.fallback
  const fonts: FontSource = { fallback: fb, get: () => fb }
  const layer: TextLayer = {
    id: key, name: label, type: 'text', visible: true, locked: false, opacity: 1, blend: 'normal', x: mx, y: my, width: 0,
    height: 0, rotation: 0, scaleX: 1, scaleY: 1, mode: 'point', align: 'center', valign: 'middle',
    runs: [{ text: label, font: { family: fb.family, weight: 400, style: 'normal' }, size: 14, color: { type: 'color', color: hex } }]
  }
  const layout = layoutText(layer, fonts)
  const w = Math.max(0, ...layout.lines.map(l => l.width)) + 8
  const h = layout.height
  return { layer, fonts, rect: { x: mx - w / 2, y: my - h / 2, w, h } }
}

function newCtx(design: Design, opts: RenderOptions): Ctx {
  return {
    design, opts, defs: [], ids: new Map(), paints: new Map(), paintLog: [], svgs: 0, used: 0, full: false, instances: 0,
    svgCache: inlineCaches(), listed: new Set(), compEnds: new Map(), room: MAX_RENDER_OUTPUT, failed: new Map(),
    escLens: { d: new WeakMap(), glyphs: new WeakMap() }, glyphCosts: new WeakMap()
  }
}

/** The artboard's background; one that can't be drawn is left out like a layer (it's listed under the artboard). */
function background(ctx: Ctx, board: Artboard, W: string, H: string): string {
  if (!board.background) return ''
  const before = mark(ctx)
  try {
    const area = { x: 0, y: 0, w: fin(board.width, 0), h: fin(board.height, 0) }
    const bg = `<rect width="${W}" height="${H}"${paintAttr(ctx, board.background, 'fill', safeId('bg-' + plain(board.id)), area)}/>`
    if (spend(ctx, bg.length)) return bg
  } catch {
    // a background that can't be drawn is left out below
  }
  rollBack(ctx, before)
  return leftOut(ctx, board as unknown as Layer, NOT_DRAWN)
}

/**
 * One artboard as a standalone SVG document. Never throws for what its layers hold: a layer that can't be drawn, or
 * doesn't fit in MAX_RENDER_OUTPUT, is left out and listed in opts.downgrades. (validateDesign is what makes a design
 * read from a file safe to give it.)
 */
export function designToSvg(design: Design, artboardId: string, opts: RenderOptions): string {
  const board = artboardOf(design, artboardId)
  const ctx = newCtx(design, opts)
  const W = n(fin(board.width, 0))
  const H = n(fin(board.height, 0))
  const bg = background(ctx, board, W, H)
  const scope: Scope = { prefix: '', overrides: [], top: true, ends: { layers: board.layers }, comps: [] }
  const body = board.layers.map(l => renderLayer(ctx, l, scope)).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    (ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : '') + bg + body + '</svg>'
  )
}

/** One layer as its `<g>`, with any defs it needs inside it. Empty for a hidden layer in raster mode. */
export function layerToSvg(design: Design, layer: Layer, opts: RenderOptions): string {
  let board = design.artboards[0] ?? EMPTY_BOARD
  let top = false
  for (const a of design.artboards) {
    let found = false
    walk(a.layers, l => {
      if (l === layer || l.id === layer.id) found = true
    })
    if (found) {
      board = a
      top = a.layers.some(l => l === layer || l.id === layer.id)
      break
    }
  }
  const ctx = newCtx(design, opts)
  const out = renderLayer(ctx, layer, { prefix: '', overrides: [], top, ends: { layers: board.layers }, comps: [] })
  if (!out || !ctx.defs.length) return out
  const at = out.indexOf('>') + 1
  return out.slice(0, at) + `<defs>${ctx.defs.join('')}</defs>` + out.slice(at)
}
