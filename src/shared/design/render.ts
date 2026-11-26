import type { FontSource } from './fonts'
import { type Box, type Point, boundsOf, boxOf, connectorPath, fin, grow, midpoint, transformedBounds, union } from './geometry'
import { artboardOf, walk } from './model'
import { cleanText, layoutText, num as n, runSize, textPaths, textRuns } from './text'
import type { Artboard, Design, Layer, Override, Paint, TextLayer } from './types'

export { connectorPath } from './geometry'

// The one renderer. designToSvg is the only code that turns a design into SVG: the editor canvas, `gdocs look`,
// thumbnails and every export call it. The same input always gives the same bytes: every id comes from a layer id.
// Raster mode draws text as glyph outlines and skips hidden layers. Export mode keeps text live (naming the family,
// never embedding the font) unless outlines are asked for, and keeps hidden layers with display="none".

export interface RenderOptions {
  fonts: FontSource
  assets: Record<string, Uint8Array>
  mode: 'raster' | 'export'
  outlines?: boolean
  seconds?: number
}

interface Scope { prefix: string; overrides: Record<string, Override>; top: boolean; board: Artboard; comps: string[] }
interface Ctx { design: Design; opts: RenderOptions; defs: string[]; ids: Map<string, number>; paints: Map<string, string> }

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
/** Text or an attribute value made safe for XML. */
export const esc = (s: unknown): string => cleanText(String(s ?? '')).replace(/[&<>"']/g, c => ENTITIES[c])
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
  if (p.type === 'style') return color(ctx.design.styles?.colors?.find(c => c.name === p.ref)?.color)
  return color(p.stops?.[0]?.color)
}

/** ` fill="..."` (or stroke) for a paint; gradients go into defs as g-<key>-<n>, over the box in user space. */
function paintAttr(ctx: Ctx, p: Paint | null | undefined, attr: 'fill' | 'stroke', key: string, b: Box): string {
  if (!p) return attr === 'fill' ? ' fill="none"' : ''
  if (p.type === 'linear' || p.type === 'radial') return ` ${attr}="url(#${gradient(ctx, p, key, b)})"`
  const c = solid(ctx, p)
  return ` ${attr}="${c.hex}"` + (c.alpha < 1 ? ` ${attr}-opacity="${n(c.alpha, 3)}"` : '')
}

function gradient(ctx: Ctx, p: Extract<Paint, { stops: unknown }>, key: string, b: Box): string {
  const sig = `${key}|${JSON.stringify(p)}|${b.x},${b.y},${b.w},${b.h}`
  const known = ctx.paints.get(sig)
  if (known) return known
  const id = nextId(ctx, 'g', key)
  const stops = (Array.isArray(p.stops) ? p.stops : [])
    .map(s => {
      const c = color(s.color)
      const at = Math.min(1, Math.max(0, fin(s.offset, 0)))
      return `<stop offset="${n(at, 4)}" stop-color="${c.hex}"${c.alpha < 1 ? ` stop-opacity="${n(c.alpha, 3)}"` : ''}/>`
    })
    .join('')
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  if (p.type === 'linear') {
    // angle in degrees: 0 runs left to right, 90 top to bottom; the line spans the box like a CSS gradient
    const a = (fin(p.angle, 0) * Math.PI) / 180
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const half = (Math.abs(b.w * dx) + Math.abs(b.h * dy)) / 2
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - dx * half)}" y1="${n(cy - dy * half)}" ` +
        `x2="${n(cx + dx * half)}" y2="${n(cy + dy * half)}">${stops}</linearGradient>`
    )
  } else {
    const r = Math.hypot(b.w, b.h) / 2
    ctx.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}">${stops}</radialGradient>`)
  }
  ctx.paints.set(sig, id)
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
  ctx.defs.push(`<filter id="${id}" ${region} color-interpolation-filters="sRGB">${body}</filter>`)
  return id
}

function withOverride(l: Layer, o: Override | undefined): Layer {
  if (!o) return l
  const out = { ...l } as Layer & { asset?: string }
  if (o.fill !== undefined) out.fill = o.fill
  if (o.stroke !== undefined) out.stroke = o.stroke
  if (typeof o.visible === 'boolean') out.visible = o.visible
  if (typeof o.asset === 'string' && (l.type === 'image' || l.type === 'paint')) out.asset = o.asset
  return out
}

const offstage = (l: Layer, s: number | undefined): boolean =>
  s !== undefined && !!l.timing &&
  ((typeof l.timing.start === 'number' && s < l.timing.start) || (typeof l.timing.end === 'number' && s >= l.timing.end))

/** The opening attributes every layer group carries: id, name and Inkscape label. */
const layerAttrs = (key: string, name: unknown): string =>
  `id="l-${key}" data-name="${esc(name)}" inkscape:label="${esc(name)}"`

function renderLayer(ctx: Ctx, src: Layer, scope: Scope): string {
  const o = has(scope.overrides, src.id) ? scope.overrides[src.id] : undefined
  const l = withOverride(src, o)
  const hidden = !l.visible || offstage(l, ctx.opts.seconds)
  if (hidden && ctx.opts.mode === 'raster') return ''
  const key = safeId(scope.prefix + l.id)
  let a = layerAttrs(key, l.name)
  if (scope.top) a += ' inkscape:groupmode="layer"'
  if (hidden) a += ' display="none"'
  const opacity = Math.min(1, Math.max(0, fin(l.opacity, 1)))
  if (opacity < 1) a += ` opacity="${n(opacity, 3)}"`
  if (BLENDS.has(l.blend)) a += ` style="mix-blend-mode:${l.blend}"`
  const tf = l.type === 'connector' ? '' : transformOf(l)
  if (tf) a += ` transform="${tf}"`
  const overrideText = typeof o?.text === 'string' ? o.text : undefined
  const pts = l.type === 'connector' ? connectorPath(ctx.design, scope.board, l) : []
  const fid = filterFor(ctx, l, key, () => extentOf(ctx, l, overrideText, pts))
  if (fid) a += ` filter="url(#${fid})"`
  return `<g ${a}>${content(ctx, l, key, scope, o, pts)}</g>`
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
      return imageTag(boxOf(l), 'none', 'image/svg+xml', new TextEncoder().encode(String(l.svg ?? '')))
    case 'group':
      return groupSvg(ctx, l, key, scope)
    case 'instance':
      return instanceSvg(ctx, l, key, scope)
    case 'connector':
      return connectorSvg(ctx, l, key, pts)
  }
  return ''
}

/** A rect, ellipse, line or path element; painted, or bare geometry for a clip path. */
function shapeEl(ctx: Ctx, l: Layer, key: string, paint: boolean, tf = ''): string {
  const b = boxOf(l)
  const fill = paint ? paintAttr(ctx, l.fill, 'fill', key, b) : ''
  const stroke = paint ? strokeAttr(ctx, l, key, b, l.stroke) : ''
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
  if (typeof l.glyphs === 'string' && l.glyphs && overrideText === undefined && runs.some(r => fonts.get(r.font).missing)) {
    const move = b.x || b.y ? ` transform="translate(${n(b.x)} ${n(b.y)})"` : ''
    return `<path d="${esc(l.glyphs)}"${move}${fillOf(0)}${stroke}/>`
  }
  if (ctx.opts.mode === 'raster' || ctx.opts.outlines || l.outlines) {
    return textPaths(l, fonts, overrideText).map(p => `<path d="${p.d}"${fillOf(p.run)}${stroke}/>`).join('')
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
  const mime = MIME[(/\.([a-z0-9]+)$/i.exec(asset)?.[1] ?? '').toLowerCase()]
  if (!(bytes instanceof Uint8Array) || !mime) return ''
  return imageTag(b, fit === 'contain' ? 'xMidYMid meet' : fit === 'cover' ? 'xMidYMid slice' : 'none', mime, bytes)
}

/**
 * Children in order. With `clip`, the first child (when visible) is the mask: its layer group holds the clip path
 * (never drawn) and the rest are clipped to it.
 */
function groupSvg(ctx: Ctx, g: Layer & { type: 'group' }, key: string, scope: Scope): string {
  const inner: Scope = { ...scope, top: false }
  const kids = Array.isArray(g.children) ? g.children : []
  const first = kids[0]
  const mask = g.clip && kids.length > 1 ? withOverride(first, has(scope.overrides, first.id) ? scope.overrides[first.id] : undefined) : null
  if (mask?.visible) {
    const id = nextId(ctx, 'c', key)
    const maskKey = safeId(scope.prefix + mask.id)
    const holder = `<g ${layerAttrs(maskKey, mask.name)}><clipPath id="${id}">${clipShape(ctx, mask, maskKey, scope)}</clipPath></g>`
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
    const text = has(scope.overrides, l.id) ? scope.overrides[l.id].text : undefined
    return `<path d="${textPaths(l, ctx.opts.fonts, text).map(p => p.d).join('')}"${t}/>`
  }
  return `<rect ${boxAttrs(boxOf(l))}${t}/>`
}

/** The component's root mapped onto the instance box, with overrides by inner layer id. Unknown or cyclic: nothing. */
function instanceSvg(ctx: Ctx, l: Layer & { type: 'instance' }, key: string, scope: Scope): string {
  const comp = (ctx.design.components ?? []).find(c => c.id === l.component)
  if (!comp?.root || scope.comps.includes(comp.id) || scope.comps.length >= MAX_NESTING) return ''
  const r = boxOf(comp.root)
  const b = boxOf(l)
  const sx = r.w ? b.w / r.w : 1
  const sy = r.h ? b.h / r.h : 1
  const tf = `translate(${n(b.x)} ${n(b.y)}) scale(${n(sx, 6)} ${n(sy, 6)})` + (r.x || r.y ? ` translate(${n(-r.x)} ${n(-r.y)})` : '')
  const inner: Scope = {
    prefix: key + '-',
    overrides: { ...(l.overrides ?? {}), ...scope.overrides },
    top: false,
    board: { ...scope.board, layers: [comp.root] },
    comps: [...scope.comps, comp.id]
  }
  return `<g transform="${tf}">${renderLayer(ctx, comp.root, inner)}</g>`
}

/** An arrowhead as m-<key>-<n>, pointing along the line at the end (or back along it at the start). */
function marker(ctx: Ctx, key: string, hex: string, start: boolean): string {
  const id = nextId(ctx, 'm', key)
  const d = start ? 'M10 0L0 5L10 10Z' : 'M0 0L10 5L0 10Z'
  ctx.defs.push(
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
  return { design, opts, defs: [], ids: new Map(), paints: new Map() }
}

/** One artboard as a standalone SVG document. */
export function designToSvg(design: Design, artboardId: string, opts: RenderOptions): string {
  const board = artboardOf(design, artboardId)
  const ctx = newCtx(design, opts)
  const W = n(fin(board.width, 0))
  const H = n(fin(board.height, 0))
  const area = { x: 0, y: 0, w: fin(board.width, 0), h: fin(board.height, 0) }
  const bg = board.background ? `<rect width="${W}" height="${H}"${paintAttr(ctx, board.background, 'fill', safeId('bg-' + board.id), area)}/>` : ''
  const scope: Scope = { prefix: '', overrides: {}, top: true, board, comps: [] }
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
  const out = renderLayer(ctx, layer, { prefix: '', overrides: {}, top, board, comps: [] })
  if (!out || !ctx.defs.length) return out
  const at = out.indexOf('>') + 1
  return out.slice(0, at) + `<defs>${ctx.defs.join('')}</defs>` + out.slice(at)
}
