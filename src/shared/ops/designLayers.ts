import { type Box, boxOf, fin, transformedBounds, union } from '../design/geometry'
import { walk } from '../design/model'
import { parsePath, pathToString, scale as scaleMatrix, transformPath } from '../design/path'
import { sharedAssetName } from '../design/sha256'
import { MAX_IMAGE_PIXELS, dataUriBytes, imageInfo } from '../design/svgClean'
import { cleanText, layoutText } from '../design/text'
import type {
  Artboard, BlendMode, Component, Design, End, FontRef, Layer, Override, Paint, Shadow, TextLayer, TextRun, Timing
} from '../design/types'
import { MAX_DASH, MAX_NAME, MAX_POINTS, MAX_STOPS, TOO_LONG } from '../design/validate'
import type { AgentOp } from '../types'
import { OpError, type OpServices } from './types'

// The design ops' working parts: finding layers on an artboard, moving and resizing them (with what they hold), and
// reading and writing their properties from what an agent or the editor sends.

/** The design an op works on (a copy), its assets, and what the op was given to measure text with. */
export interface DesignDoc {
  design: Design
  assets: Record<string, Uint8Array>
  services: OpServices
}
export type GroupLayer = Layer & { type: 'group' }

/** "a", "a and b", "a, b and c": no Oxford comma. */
export const list = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

// ---------- finding layers ----------

/** Every layer on the board `ref` names: by id, else by name, else by a Group/Child path. */
export function hits(board: Artboard, ref: string): Layer[] {
  const all: { layer: Layer; path: string[] }[] = []
  walk(board.layers, (layer, _p, path) => all.push({ layer, path }))
  const byId = all.filter(e => e.layer.id === ref)
  if (byId.length) return byId.map(e => e.layer)
  const byName = all.filter(e => e.layer.name === ref)
  if (byName.length) return byName.map(e => e.layer)
  if (!ref.includes('/')) return []
  const want = ref.split('/')
  return all.filter(e => e.path.length === want.length && e.path.every((n, i) => n === want[i])).map(e => e.layer)
}

/** One layer on the board, by id, unique name or path; a name shared by several fails and lists their ids. */
export function layerOn(board: Artboard, ref: unknown): Layer {
  if (typeof ref !== 'string' || !ref) throw new OpError('Name a layer by its id, name or Group/Child path')
  const found = hits(board, ref)
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new OpError(`${found.length} layers are named "${ref}": ${found.map(l => l.id).join(', ')}`)
  throw new OpError(`No layer "${ref}" on ${board.name}`)
}

/** Where a layer sits: the list holding it, its place there and the group that list belongs to (null at the top). */
export function locate(board: Artboard, id: string): { list: Layer[]; index: number; parent: GroupLayer | null } {
  const find = (ls: Layer[], parent: GroupLayer | null): { list: Layer[]; index: number; parent: GroupLayer | null } | null => {
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]
      if (l.id === id) return { list: ls, index: i, parent }
      if (l.type === 'group') {
        const r = find(l.children, l)
        if (r) return r
      }
    }
    return null
  }
  const r = find(board.layers, null)
  if (!r) throw new OpError(`No layer ${id} on ${board.name}`)
  return r
}

export const contains = (outer: Layer, id: string): boolean => {
  let found = false
  walk([outer], l => {
    if (l.id === id) found = true
  })
  return found
}

/**
 * The next free "<Type> <n>" name on the board. A base that would take the name past 1,000 characters (a component's
 * long name, say) is cut first, so the name is never one reading would cut.
 */
export function nextName(board: Artboard, base: string): string {
  base = base.slice(0, MAX_NAME - 8)
  let most = 0
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`)
  walk(board.layers, l => {
    const m = re.exec(l.name)
    if (m) most = Math.max(most, Number(m[1]))
  })
  return `${base} ${most + 1}`
}

export function componentOf(doc: DesignDoc, ref: unknown): Component {
  const comps = doc.design.components ?? []
  const c = comps.find(x => x.id === ref) ?? comps.find(x => x.name === ref)
  if (!c) throw new OpError(comps.length ? `No component "${String(ref)}". Components: ${comps.map(x => x.name).join(', ')}` : `No component "${String(ref)}"`)
  return c
}

// ---------- geometry ----------

/** Where a layer draws, as an upright box: its box after its own rotation and scale. */
export const boundsOf = (l: Layer): Box => transformedBounds(boxOf(l), l)
export const boundsOfLayers = (ls: Layer[]): Box => ls.map(boundsOf).reduce((a, b) => union(a, b))

/**
 * Fits every group holding one of `ids` (and the groups themselves) to its children again, innermost first. Groups
 * that are rotated or scaled keep their box, so what they draw doesn't move.
 */
export function refit(board: Artboard, ids: Set<string>): void {
  const go = (ls: Layer[]): boolean => {
    let any = false
    for (const l of ls) {
      let hit = ids.has(l.id)
      if (l.type === 'group') {
        if (go(l.children)) hit = true
        if (hit && l.children.length && !fin(l.rotation, 0) && fin(l.scaleX, 1) === 1 && fin(l.scaleY, 1) === 1) {
          const b = boundsOfLayers(l.children)
          Object.assign(l, { x: b.x, y: b.y, width: b.w, height: b.h })
        }
      }
      if (hit) any = true
    }
    return any
  }
  go(board.layers)
}

/** Moves a layer and everything in it. Groups hold their children in artboard coordinates, so they move too. */
export function shift(l: Layer, dx: number, dy: number): void {
  if (!dx && !dy) return
  walk([l], x => {
    x.x = fin(x.x, 0) + dx
    x.y = fin(x.y, 0) + dy
    if (x.type === 'connector' && Array.isArray(x.points)) x.points = x.points.map(([px, py]) => [px + dx, py + dy] as [number, number])
  })
}

/** Resizes a layer to w x h from its top left. A group's children scale with it; a path's data scales to its box. */
export function resize(l: Layer, w: number, h: number): void {
  const b = boxOf(l)
  const sx = b.w ? w / b.w : 1
  const sy = b.h ? h / b.h : 1
  walk([l], x => {
    const nb = boxOf(x)
    const nw = x === l ? w : nb.w * sx
    const nh = x === l ? h : nb.h * sy
    x.x = b.x + (nb.x - b.x) * sx
    x.y = b.y + (nb.y - b.y) * sy
    if (x.type === 'path' && (nw !== nb.w || nh !== nb.h)) {
      x.d = pathToString(transformPath(parsePath(x.d), scaleMatrix(nb.w ? nw / nb.w : 1, nb.h ? nh / nb.h : 1)))
    }
    if (x.type === 'connector' && Array.isArray(x.points)) {
      x.points = x.points.map(([px, py]) => [b.x + (px - b.x) * sx, b.y + (py - b.y) * sy] as [number, number])
    }
    x.width = nw
    x.height = nh
  })
}

// ---------- property values ----------

const BLENDS: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
]
const COMMON = [
  'name', 'x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'opacity', 'blend', 'visible', 'locked', 'fill',
  'stroke', 'strokeWidth', 'dash', 'shadow', 'blur', 'timing'
]
export const TEXT_PROPS = ['text', 'runs', 'font', 'size', 'weight', 'italic', 'color', 'align', 'valign', 'mode', 'letterSpacing', 'lineHeight', 'outlines']
const BY_TYPE: Record<string, string[]> = {
  rect: ['radius'],
  ellipse: [],
  line: [],
  path: ['d'],
  text: TEXT_PROPS,
  image: ['data', 'asset', 'fit'],
  paint: ['data', 'asset', 'fit'],
  group: ['clip'],
  instance: ['component', 'overrides'],
  connector: ['from', 'to', 'label', 'route', 'arrow', 'points'],
  svg: []
}
const ALIASES: Record<string, string> = { w: 'width', h: 'height' }
/** The font a new text layer or run gets when none is named: installed on Windows and macOS, and metric twins elsewhere. */
export const DEFAULT_FONT: FontRef = { family: 'Arial', weight: 400, style: 'normal' }
/** Coordinates an op writes are clamped to +/- this, and sizes (width, height, font size, stroke width) to MAX_SIZE. */
export const MAX_COORD = 1e7
export const MAX_SIZE = 1e5
export const coord = (key: string, v: unknown): number => Math.min(MAX_COORD, Math.max(-MAX_COORD, number(key, v)))
const size = (key: string, v: unknown, min: number): number => Math.min(MAX_SIZE, number(key, v, min))
/** A number clamped to +/- `most`, as reading clamps it (rotation, scale, spacing and the like). */
const within = (key: string, v: unknown, most: number): number => Math.min(most, Math.max(-most, number(key, v)))

export const number = (key: string, v: unknown, min?: number, max?: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new OpError(`${key} must be a number`)
  if (min !== undefined && n < min) throw new OpError(`${key} must be ${min} or more`)
  if (max !== undefined && n > max) throw new OpError(`${key} must be ${max} or less`)
  return n
}
export const bool = (key: string, v: unknown): boolean => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'false') return v === 'true'
  throw new OpError(`${key} must be true or false`)
}
export const oneOf = <T extends string>(key: string, v: unknown, options: readonly T[]): T => {
  if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T
  throw new OpError(`${key} must be ${list(options.map(String)).replace(/ and ([^ ]+)$/, ' or $1')}`)
}
export const text = (key: string, v: unknown): string => {
  if (typeof v !== 'string') throw new OpError(`${key} must be text`)
  return cleanText(v)
}
/** A name on one line, never empty, and at most 1,000 characters (reading cuts a longer one). */
export const nameOf = (key: string, v: unknown): string => {
  const name = text(key, v).replace(/[\r\n\t]+/g, ' ').trim()
  if (!name) throw new OpError(`${key} must not be empty`)
  if (name.length > MAX_NAME) throw new OpError(TOO_LONG.name)
  return name
}

/** #rgb, #rrggbb or #rrggbbaa, lower case and at least six digits; null for anything else. */
export function hexColor(v: unknown): string | null {
  const m = typeof v === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim()) : null
  if (!m) return null
  const h = m[1].toLowerCase()
  return '#' + (h.length === 3 ? h.replace(/./g, c => c + c) : h)
}

function styleRef(doc: DesignDoc, name: string, key: string): Paint {
  if (!name) throw new OpError(`${key} names a color style without a name`)
  if (name.length > MAX_NAME) throw new OpError(TOO_LONG.name)
  if (name.startsWith('kit/')) return { type: 'style', ref: name }
  const colors = doc.design.styles?.colors ?? []
  if (!colors.some(c => c.name === name)) {
    throw new OpError(
      colors.length ? `No color style "${name}". Color styles: ${colors.map(c => c.name).join(', ')}` : `No color style "${name}". Add one with the style op first.`
    )
  }
  return { type: 'style', ref: name }
}

/** A paint from what an op says: #hex, style:<name>, none (or null), or a paint object. */
export function paintOf(doc: DesignDoc, key: string, v: unknown): Paint | null {
  const bad = () => new OpError(`${key} must be a color like #rrggbb, style:<name>, none or a paint ({ type: "color", color })`)
  if (v === null || v === 'none') return null
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^style:/i.test(s)) return styleRef(doc, s.slice(6).trim(), key)
    const c = hexColor(s)
    if (c) return { type: 'color', color: c }
    throw bad()
  }
  if (!v || typeof v !== 'object') throw bad()
  const p = v as Record<string, unknown>
  if (p.type === 'color') {
    const c = hexColor(p.color)
    if (!c) throw bad()
    return { type: 'color', color: c }
  }
  if (p.type === 'style') return styleRef(doc, typeof p.ref === 'string' ? p.ref : '', key)
  if (p.type === 'linear' || p.type === 'radial') {
    if (!Array.isArray(p.stops) || p.stops.length < 2) throw new OpError(`${key}: a gradient needs at least two stops`)
    if (p.stops.length > MAX_STOPS) throw new OpError(TOO_LONG.stops)
    const n = p.stops.length
    const stops = p.stops.map((s: unknown, i) => {
      const o = (s ?? {}) as Record<string, unknown>
      const color = hexColor(o.color)
      if (!color) throw new OpError(`${key}: stop ${i + 1} needs a color like #rrggbb`)
      return { offset: number(`${key} stop ${i + 1} offset`, o.offset ?? i / (n - 1), 0, 1), color }
    })
    const out: Paint = { type: p.type, stops }
    if (p.angle !== undefined) out.angle = within(`${key} angle`, p.angle, MAX_COORD)
    return out
  }
  throw bad()
}

export function fontOf(v: unknown, fallback: FontRef = DEFAULT_FONT): FontRef {
  const long = (s: unknown): boolean => typeof s === 'string' && s.trim().length > MAX_NAME
  if (typeof v === 'string' && v.trim()) {
    if (long(v)) throw new OpError(TOO_LONG.name)
    return { family: v.trim(), weight: fallback.weight, style: fallback.style }
  }
  if (v && typeof v === 'object') {
    const f = v as Record<string, unknown>
    if (typeof f.family !== 'string' || !f.family.trim()) throw new OpError('font needs a family')
    if (long(f.family) || long(f.postscript)) throw new OpError(TOO_LONG.name)
    const out: FontRef = {
      family: f.family.trim(),
      weight: f.weight === undefined ? 400 : number('font weight', f.weight, 1, 1000),
      style: f.style === undefined ? 'normal' : oneOf('font style', f.style, ['normal', 'italic'] as const)
    }
    if (typeof f.postscript === 'string' && f.postscript) out.postscript = f.postscript
    if (typeof f.asset === 'string' && f.asset) out.asset = f.asset
    return out
  }
  throw new OpError('font must be a family name or { family, weight, style }')
}

/** An image's bytes from a data URL or base64, stored as an asset named by its hash. Refused past 50 megapixels. */
export function imageAsset(doc: DesignDoc, v: unknown): { asset: string; width: number; height: number } {
  const s = typeof v === 'string' ? v.trim() : ''
  const data = /^data:/i.test(s) ? dataUriBytes(s) : /^[A-Za-z0-9+/\s]+={0,2}$/.test(s) ? dataUriBytes(`data:;base64,${s}`) : null
  const info = data && imageInfo(data.bytes)
  if (!data || !info || !info.width || !info.height) throw new OpError('An image must be a PNG, JPEG, GIF or WebP, given as a data URL or base64.')
  if (info.width * info.height > MAX_IMAGE_PIXELS) throw new OpError("Images over 50 megapixels can't be placed.")
  const asset = sharedAssetName(data.bytes, info.type)
  doc.assets[asset] = data.bytes
  return { asset, width: info.width, height: info.height }
}

export function existingAsset(doc: DesignDoc, v: unknown): string {
  if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(doc.assets, v)) throw new OpError(`No asset "${String(v)}" in this design`)
  return v
}

export function endOf(board: Artboard, key: string, v: unknown): End {
  if (typeof v === 'string') return { layer: layerOn(board, v).id }
  if (v && typeof v === 'object') {
    const e = v as Record<string, unknown>
    const out: End = { layer: layerOn(board, e.layer).id }
    if (e.side !== undefined) out.side = oneOf(`${key} side`, e.side, ['auto', 'top', 'right', 'bottom', 'left'] as const)
    return out
  }
  throw new OpError(`${key} must name a layer`)
}

function shadowOf(v: unknown): Shadow | undefined {
  if (v === null || v === 'none') return undefined
  if (!v || typeof v !== 'object') throw new OpError('shadow must be { x, y, blur, color } or none')
  const s = v as Record<string, unknown>
  const color = hexColor(s.color ?? '#00000040')
  if (!color) throw new OpError('shadow color must be like #rrggbb or #rrggbbaa')
  return { x: coord('shadow x', s.x ?? 0), y: coord('shadow y', s.y ?? 0), blur: size('shadow blur', s.blur ?? 0, 0), color }
}

/** A layer's start and end in seconds (nothing else is kept), the start at or before the end. */
function timingOf(v: unknown): Timing | undefined {
  if (v === null || v === 'none') return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpError('timing must be { start?, end? } in seconds, or none')
  const given = v as Record<string, unknown>
  const t: Timing = {}
  if (given.start !== undefined) t.start = Math.min(MAX_COORD, number('timing start', given.start, 0))
  if (given.end !== undefined) t.end = Math.min(MAX_COORD, number('timing end', given.end, 0))
  if (t.start !== undefined && t.end !== undefined && t.start > t.end) throw new OpError('timing start must be at or before its end')
  return t
}

/** What an instance can override on one of its parts, read from an op's props. */
export const OVERRIDE_PROPS = ['text', 'fill', 'stroke', 'visible', 'data', 'asset']

/** One part's override from props (text, fill, stroke, visible, and an image as data or asset), on top of `o`. */
export function overrideOf(doc: DesignDoc, props: Record<string, unknown>, o: Override = {}): Override {
  const out: Override = { ...o }
  for (const [k, v] of Object.entries(props)) {
    if (!OVERRIDE_PROPS.includes(k)) throw new OpError('An instance can override text, fill, stroke, visible and image of its parts')
    if (k === 'text') out.text = text('text', v)
    else if (k === 'fill' || k === 'stroke') {
      const p = paintOf(doc, k, v)
      if (p) out[k] = p
      else delete out[k]
    } else if (k === 'visible') out.visible = bool('visible', v)
    else if (k === 'data') out.asset = imageAsset(doc, v).asset
    else out.asset = existingAsset(doc, v)
  }
  return out
}

/**
 * A whole set of overrides for an instance of `comp`, keyed by the ids of the component's own layers; {} resets them.
 * Built without a prototype, so no key (__proto__ included) can reach one.
 */
function overridesOf(doc: DesignDoc, comp: Component, v: unknown): Record<string, Override> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpError('overrides must be an object keyed by inner layer id')
  const inner = new Set<string>()
  if (comp.root) walk([comp.root], l => inner.add(l.id))
  const out = Object.create(null) as Record<string, Override>
  for (const [id, o] of Object.entries(v as Record<string, unknown>)) {
    if (!inner.has(id)) throw new OpError(`No layer ${id} in component ${comp.name}.`)
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new OpError(`The override for ${id} must be an object`)
    out[id] = overrideOf(doc, o as Record<string, unknown>)
  }
  return out
}

export function runsOf(doc: DesignDoc, v: unknown): TextRun[] {
  if (!Array.isArray(v) || !v.length) throw new OpError('runs must be a list of { text, font, size, color? }')
  return v.map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>
    const run: TextRun = { text: text(`run ${i + 1} text`, r.text ?? ''), font: fontOf(r.font ?? DEFAULT_FONT.family), size: size(`run ${i + 1} size`, r.size ?? 24, 0.1) }
    if (r.color !== undefined) {
      const p = paintOf(doc, `run ${i + 1} color`, r.color)
      if (p) run.color = p
    }
    if (r.letterSpacing !== undefined) run.letterSpacing = within(`run ${i + 1} letterSpacing`, r.letterSpacing, MAX_SIZE)
    if (r.lineHeight !== undefined) run.lineHeight = size(`run ${i + 1} lineHeight`, r.lineHeight, 0)
    return run
  })
}

/** The props an op passes, with w and h read as width and height, and anything the layer type can't take refused. */
export function propsOf(op: AgentOp, type: string): Record<string, unknown> {
  const allowed = [...COMMON, ...(BY_TYPE[type] ?? [])]
  const raw = op.props === undefined ? {} : op.props
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpError('props must be an object')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = ALIASES[k] ?? k
    if (key === 'id' || key === 'type') throw new OpError(`A layer's ${key} can't be set`)
    if (!allowed.includes(key)) throw new OpError(`Unknown property "${k}" for a ${type} layer. It takes: ${allowed.join(', ')}`)
    out[key] = v
  }
  return out
}

/**
 * Writes props onto a layer. Text props reach every run; a new size of a path scales its data, and of a group its
 * children; x and y move a group's children with it. Coordinates are clamped to +/- MAX_COORD and sizes to MAX_SIZE.
 * Returns the names of what was written, for the summary; `notes` hears of anything else that changed with them.
 */
export function writeProps(doc: DesignDoc, board: Artboard, l: Layer, props: Record<string, unknown>, notes: string[] = []): string[] {
  const L = l as Layer & Record<string, unknown>
  const runs = (f: (r: TextRun) => void) => {
    if (l.type === 'text') for (const r of l.runs) f(r)
  }
  let w: number | undefined
  let h: number | undefined
  let dx = 0
  let dy = 0
  for (const [key, v] of Object.entries(props)) {
    switch (key) {
      case 'name':
        l.name = nameOf('name', v)
        break
      case 'x':
        dx = coord('x', v) - fin(l.x, 0)
        break
      case 'y':
        dy = coord('y', v) - fin(l.y, 0)
        break
      case 'width':
        w = size('width', v, 0)
        break
      case 'height':
        h = size('height', v, 0)
        break
      // clamped as reading clamps them, so a design comes back as it was saved
      case 'rotation':
        l.rotation = within(key, v, MAX_COORD)
        break
      case 'scaleX':
      case 'scaleY':
        L[key] = within(key, v, MAX_SIZE)
        break
      case 'strokeWidth':
      case 'blur':
      case 'radius':
        L[key] = size(key, v, 0)
        break
      case 'letterSpacing':
      case 'lineHeight': {
        const n = key === 'lineHeight' ? size(key, v, 0) : within(key, v, MAX_SIZE)
        runs(r => (r[key] = n))
        break
      }
      case 'opacity':
        l.opacity = number('opacity', v, 0, 1)
        break
      case 'blend':
        l.blend = oneOf('blend', v, BLENDS)
        break
      case 'visible':
      case 'locked':
      case 'clip':
      case 'outlines':
        L[key] = bool(key, v)
        break
      case 'fill':
      case 'stroke':
        L[key] = paintOf(doc, key, v)
        // a run's own color draws over the layer's fill, so a new fill on text takes their place
        if (key === 'fill') runs(r => delete r.color)
        break
      case 'dash': {
        if (v === null || v === 'none' || (Array.isArray(v) && !v.length)) {
          delete l.dash
          break
        }
        const lengths = Array.isArray(v) ? v : typeof v === 'string' ? v.trim().split(/[\s,]+/) : null
        if (!lengths) throw new OpError('dash must be a list of lengths')
        if (lengths.length > MAX_DASH) throw new OpError(TOO_LONG.dash)
        l.dash = lengths.map((x, i) => size(`dash ${i + 1}`, x, 0))
        break
      }
      case 'shadow': {
        const s = shadowOf(v)
        if (s) l.shadow = s
        else delete l.shadow
        break
      }
      case 'timing': {
        const t = timingOf(v)
        if (t) l.timing = t
        else delete l.timing
        break
      }
      case 'd':
        if (typeof v !== 'string' || !parsePath(v).length) throw new OpError('d must be SVG path data')
        L.d = v.trim()
        break
      case 'text':
        if (l.type === 'text') l.runs = [{ ...(l.runs[0] ?? { font: DEFAULT_FONT, size: 24 }), text: text('text', v) }]
        break
      case 'runs':
        if (l.type === 'text') l.runs = runsOf(doc, v)
        break
      case 'font':
        runs(r => (r.font = fontOf(v, r.font)))
        break
      case 'size': {
        const n = size('size', v, 0.1)
        runs(r => (r.size = n))
        break
      }
      case 'weight': {
        const n = number('weight', v, 1, 1000)
        runs(r => (r.font = { ...r.font, weight: n }))
        break
      }
      case 'italic': {
        const style = bool('italic', v) ? 'italic' : 'normal'
        runs(r => (r.font = { ...r.font, style }))
        break
      }
      case 'color': {
        const p = paintOf(doc, 'color', v)
        runs(r => {
          if (p) r.color = p
          else delete r.color
        })
        break
      }
      case 'align':
        L.align = oneOf('align', v, ['left', 'center', 'right', 'justify'] as const)
        break
      case 'valign':
        L.valign = oneOf('valign', v, ['top', 'middle', 'bottom'] as const)
        break
      case 'mode':
        L.mode = oneOf('mode', v, ['box', 'point'] as const)
        break
      case 'data': {
        // an image comes in at its own size, or keeps its shape when only one side is given
        const img = imageAsset(doc, v)
        L.asset = img.asset
        if (props.width === undefined && props.height === undefined) [w, h] = [img.width, img.height]
        else if (props.width === undefined) w = (img.width * size('height', props.height, 0)) / img.height
        else if (props.height === undefined) h = (img.height * size('width', props.width, 0)) / img.width
        break
      }
      case 'asset':
        L.asset = existingAsset(doc, v)
        break
      case 'fit':
        L.fit = oneOf('fit', v, ['fill', 'contain', 'cover'] as const)
        break
      case 'component': {
        // overrides are keyed by the old component's layers, so another component starts without them
        const id = componentOf(doc, v).id
        const had = L.overrides && typeof L.overrides === 'object' && Object.keys(L.overrides).length > 0
        if (id !== L.component && had && props.overrides === undefined) notes.push('The overrides were reset for the new component.')
        if (id !== L.component) L.overrides = {}
        L.component = id
        break
      }
      case 'overrides':
        break // after the loop, against the component the layer ends up with
      case 'from':
      case 'to':
        L[key] = endOf(board, key, v)
        break
      case 'label':
        L.label = text('label', v)
        if ((L.label as string).length > MAX_NAME) throw new OpError(TOO_LONG.label)
        break
      case 'route':
        L.route = oneOf('route', v, ['straight', 'orthogonal'] as const)
        break
      case 'arrow':
        L.arrow = oneOf('arrow', v, ['end', 'both', 'none'] as const)
        break
      case 'points':
        if (v === null || v === 'none') delete L.points
        else if (Array.isArray(v)) {
          if (v.length > MAX_POINTS) throw new OpError(TOO_LONG.points)
          L.points = v.map((p, i) => [coord(`point ${i + 1} x`, (p as unknown[])?.[0]), coord(`point ${i + 1} y`, (p as unknown[])?.[1])])
        } else throw new OpError('points must be a list of [x, y]')
        break
    }
  }
  if (props.overrides !== undefined) {
    if (l.type !== 'instance') throw new OpError('Only an instance has overrides')
    L.overrides = overridesOf(doc, componentOf(doc, l.component), props.overrides)
  }
  if (w !== undefined || h !== undefined) resize(l, Math.min(MAX_SIZE, w ?? fin(l.width, 0)), Math.min(MAX_SIZE, h ?? fin(l.height, 0)))
  shift(l, dx, dy)
  if (l.type === 'text') fitText(doc, l, props)
  return Object.keys(props)
}

/**
 * Point text takes the size of its lines; box text keeps its width and, when no height was given, takes the height its
 * lines need. Measured with the design's fonts when there are any, else estimated.
 */
function fitText(doc: DesignDoc, l: TextLayer, props: Record<string, unknown>): void {
  const point = l.mode === 'point'
  if (!point && (props.height !== undefined || (!TEXT_PROPS.some(k => k in props) && props.width === undefined))) return
  let width: number
  let height: number
  const fonts = doc.services.fonts
  if (fonts) {
    const lay = layoutText(l, fonts)
    width = Math.max(0, ...lay.lines.map(x => x.width))
    height = lay.height
  } else {
    const lines = l.runs.map(r => r.text).join('').split('\n')
    const size = Math.max(0, ...l.runs.map(r => r.size || 0))
    width = Math.max(...lines.map(s => s.length)) * size * 0.55
    height = lines.length * size * 1.2
  }
  // clamped like every size an op writes (a huge font can measure past it)
  if (point) l.width = Math.min(MAX_SIZE, Math.round(width * 100) / 100)
  l.height = Math.min(MAX_SIZE, Math.round(height * 100) / 100)
}
