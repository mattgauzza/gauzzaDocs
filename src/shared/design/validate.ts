import { MAX_ARTBOARD_SIDE } from './model'
import { cleanSvg } from './svgClean'
import type {
  Artboard, BlendMode, Component, Design, Diagram, End, FontRef, Layer, Override, Paint, Shadow, Styles, TextRun, Timing
} from './types'

// A design read from a file, checked against the schema in types.ts before anything else touches it. design.json is
// whatever a file holds, so every value is checked for its type and size, ids are made safe and unique, and anything
// that can't be drawn safely is dropped (and noted) or the file is refused. What comes out is a Design the renderer,
// the ops and the editor can trust.

/** Most layers one design may hold, counting every artboard and component. */
export const MAX_LAYERS = 100_000
/** Deepest groups may nest. */
export const MAX_DEPTH = 64
export const MAX_COMPONENTS = 10_000
/** Text: most runs in one layer, characters in one layer and characters in the whole design. */
export const MAX_RUNS = 1000
export const MAX_LAYER_TEXT = 100_000
export const MAX_DESIGN_TEXT = 1_000_000
/** Longest a name (or a connector label) may be; longer ones are cut. */
export const MAX_NAME = 1000
/** Coordinates are clamped to +/- this, sizes (width, height, font size, stroke width) to +/- MAX_SIZE, as the ops do. */
export const MAX_COORD = 1e7
export const MAX_SIZE = 1e5
/** Most stops a gradient keeps. */
export const MAX_STOPS = 256
/** An id: letters, digits, _ and -, at most 64 of them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const TYPES = new Set(['rect', 'ellipse', 'line', 'path', 'text', 'image', 'paint', 'group', 'instance', 'connector', 'svg'])
const DEFAULT_NAMES: Record<string, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', path: 'Path', text: 'Text', image: 'Image', paint: 'Paint',
  group: 'Group', instance: 'Instance', connector: 'Connector', svg: 'SVG'
}
const BLENDS = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
])

/** Throws "This design file is damaged: <reason>." */
function damaged(reason: string): never {
  throw new Error(`This design file is damaged: ${reason}.`)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
/** A value for a message, never converted with String() (an object's toString could be anything). */
const shown = (v: unknown): string => (typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : typeof v)

/** Ids as they're read: the first holder of a valid id keeps it; others get a new one made from it. */
interface Scope { raw: Map<string, string[]>; ids: Set<string> }
const newScope = (): Scope => ({ raw: new Map(), ids: new Set() })

class Reader {
  notes = new Map<string, number>()
  /** every id the file names, so a new id never takes one a later layer holds */
  reserved = new Set<string>()
  taken = new Set<string>()
  layers = 0
  text = 0
  /** references settled once every id is known */
  connectors: { end: End; scope: Scope }[] = []
  instances: { layer: Layer & { type: 'instance' }; raw: unknown }[] = []
  componentScopes = new Map<string, Scope>()
  componentIds = newScope()

  note(s: string): void {
    this.notes.set(s, (this.notes.get(s) ?? 0) + 1)
  }

  /** A safe, unique id for something that holds `raw`, recorded in `scope` so references to `raw` can follow it. */
  id(raw: unknown, scope?: Scope): string {
    let id: string
    if (typeof raw === 'string' && ID.test(raw) && !this.taken.has(raw)) id = raw
    else {
      this.note(typeof raw === 'string' && ID.test(raw) ? 'a repeated id (renamed)' : 'an id that was not valid (renamed)')
      const base = (typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) : '') || 'id'
      id = base
      for (let n = 2; this.taken.has(id) || this.reserved.has(id) || !ID.test(id); n++) id = `${base}-${n}`
    }
    this.taken.add(id)
    if (scope) {
      scope.ids.add(id)
      if (typeof raw === 'string') {
        const list = scope.raw.get(raw)
        if (list) list.push(id)
        else scope.raw.set(raw, [id])
      }
    }
    return id
  }

  /** A name on one line of at most MAX_NAME characters; a non-string becomes `fallback`. */
  name(raw: unknown, fallback: string): string {
    if (typeof raw !== 'string') {
      if (raw !== undefined) this.note('a name that was not text (replaced)')
      return fallback
    }
    if (raw.length > MAX_NAME) {
      this.note(`a name longer than ${MAX_NAME.toLocaleString('en-US')} characters (cut)`)
      return raw.slice(0, MAX_NAME)
    }
    return raw
  }
}

/** Where a reference in `scope` points now: the id itself when it's still held there, else the one id it became. */
function follow(scope: Scope, raw: string): string | undefined {
  if (scope.ids.has(raw)) return raw
  const list = scope.raw.get(raw)
  return list && list.length === 1 ? list[0] : undefined
}

// ---------- values ----------

function num(v: unknown, lo: number, hi: number, where: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) damaged(`${where} is not a number`)
  return Math.min(hi, Math.max(lo, v))
}
const optNum = (o: Obj, k: string, lo: number, hi: number, r: Reader, out: Obj): void => {
  if (!has(o, k) || o[k] === undefined) return
  const v = o[k]
  if (typeof v === 'number' && !Number.isNaN(v)) out[k] = Math.min(hi, Math.max(lo, v))
  else r.note(`a ${k} that was not a number (dropped)`)
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') damaged(`${where} is not true or false`)
  return v
}
const optBool = (o: Obj, k: string, r: Reader, out: Obj): void => {
  if (!has(o, k) || o[k] === undefined) return
  if (typeof o[k] === 'boolean') out[k] = o[k]
  else r.note(`a ${k} that was not true or false (dropped)`)
}
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T, r: Reader, what: string): T {
  if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T
  if (v !== undefined) r.note(`an unknown ${what} (${shown(v)}, replaced)`)
  return fallback
}
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') damaged(`${where} is not text`)
  return v
}
const isColor = (v: unknown): v is string => typeof v === 'string' && COLOR.test(v)

/**
 * A paint, or undefined when it can't be one. A gradient keeps at most 256 well-formed stops (offset 0..1, a color),
 * and with fewer than two it falls back to the color of the first (black when none).
 */
function paint(v: unknown, r: Reader): Paint | undefined {
  if (!isObj(v)) return undefined
  if (v.type === 'color') return isColor(v.color) ? { type: 'color', color: v.color } : undefined
  if (v.type === 'style') return typeof v.ref === 'string' && v.ref.length <= MAX_NAME ? { type: 'style', ref: v.ref } : undefined
  if (v.type !== 'linear' && v.type !== 'radial') return undefined
  const raw = Array.isArray(v.stops) ? v.stops : []
  const stops: { offset: number; color: string }[] = []
  for (const s of raw) {
    if (stops.length >= MAX_STOPS) {
      r.note(`a gradient with more than ${MAX_STOPS} stops (the rest dropped)`)
      break
    }
    if (!isObj(s) || !isColor(s.color) || typeof s.offset !== 'number' || Number.isNaN(s.offset)) {
      r.note('a gradient stop that was not well formed (dropped)')
      continue
    }
    stops.push({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color })
  }
  if (stops.length < 2) {
    r.note('a gradient with fewer than two stops (drawn as a color)')
    return { type: 'color', color: stops[0]?.color ?? '#000000' }
  }
  const out: Paint = { type: v.type, stops }
  if (typeof v.angle === 'number' && Number.isFinite(v.angle)) out.angle = Math.min(MAX_COORD, Math.max(-MAX_COORD, v.angle))
  return out
}
/** An optional paint field: null stays null (no paint), anything that isn't a paint is dropped. */
function optPaint(o: Obj, k: string, r: Reader, out: Obj): void {
  if (!has(o, k) || o[k] === undefined) return
  if (o[k] === null) {
    out[k] = null
    return
  }
  const p = paint(o[k], r)
  if (p) out[k] = p
  else r.note(`a ${k} that was not a paint (dropped)`)
}

function font(v: unknown, where: string, r: Reader): FontRef {
  if (!isObj(v)) damaged(`${where} has no font`)
  const out: FontRef = {
    family: r.name(str(v.family, `${where}'s font family`), 'Arial'),
    weight: num(v.weight ?? 400, 1, 1000, `${where}'s font weight`),
    style: oneOf(v.style, ['normal', 'italic'] as const, 'normal', r, 'font style')
  }
  if (typeof v.postscript === 'string') out.postscript = v.postscript.slice(0, MAX_NAME)
  if (typeof v.asset === 'string') out.asset = v.asset
  return out
}

/** A run's style (a text style's run, or a text run without its text). */
function runStyle(v: Obj, where: string, r: Reader): Omit<TextRun, 'text'> {
  const out: Omit<TextRun, 'text'> = { font: font(v.font, where, r), size: num(v.size, 0, MAX_SIZE, `${where}'s size`) }
  const o = out as unknown as Obj
  optPaint(v, 'color', r, o)
  if (o.color === null) delete o.color // a run color is a paint or absent
  optNum(v, 'letterSpacing', -MAX_SIZE, MAX_SIZE, r, o)
  optNum(v, 'lineHeight', 0, MAX_SIZE, r, o)
  return out
}

/** A layer's start and end in seconds, as the ops keep them (effects and keyframes come in a later release). */
function timing(v: unknown, r: Reader): Timing | undefined {
  if (!isObj(v)) {
    r.note('a timing that was not well formed (dropped)')
    return undefined
  }
  const out: Timing = {}
  if (typeof v.start === 'number' && Number.isFinite(v.start)) out.start = Math.min(MAX_COORD, Math.max(0, v.start))
  if (typeof v.end === 'number' && Number.isFinite(v.end)) out.end = Math.min(MAX_COORD, Math.max(0, v.end))
  if (out.start !== undefined && out.end !== undefined && out.start > out.end) {
    r.note('a timing that ended before it started (dropped)')
    return undefined
  }
  return out
}

function shadow(v: unknown): Shadow | undefined {
  if (!isObj(v) || !isColor(v.color)) return undefined
  const n = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && !Number.isNaN(x) ? Math.min(hi, Math.max(lo, x)) : 0)
  return { x: n(v.x, -MAX_COORD, MAX_COORD), y: n(v.y, -MAX_COORD, MAX_COORD), blur: n(v.blur, 0, MAX_SIZE), color: v.color }
}

// ---------- layers ----------

function layer(r: Reader, raw: unknown, depth: number, scope: Scope): Layer | null {
  if (!isObj(raw)) damaged('a layer is not an object')
  if (depth > MAX_DEPTH) damaged(`groups are nested more than ${MAX_DEPTH} deep`)
  if (++r.layers > MAX_LAYERS) damaged(`it has more than ${MAX_LAYERS.toLocaleString('en-US')} layers`)
  const type = raw.type
  if (typeof type !== 'string' || !TYPES.has(type)) damaged(`a layer has an unknown type (${shown(type)})`)
  const id = r.id(raw.id, scope)
  const where = `layer ${id}`
  const out: Obj = {
    id,
    name: r.name(raw.name, DEFAULT_NAMES[type]),
    type,
    visible: bool(raw.visible, `${where}'s visible`),
    locked: bool(raw.locked, `${where}'s locked`),
    opacity: num(raw.opacity, 0, 1, `${where}'s opacity`),
    blend: oneOf(raw.blend, [...BLENDS] as BlendMode[], 'normal', r, 'blend mode'),
    x: num(raw.x, -MAX_COORD, MAX_COORD, `${where}'s x`),
    y: num(raw.y, -MAX_COORD, MAX_COORD, `${where}'s y`),
    width: num(raw.width, -MAX_SIZE, MAX_SIZE, `${where}'s width`),
    height: num(raw.height, -MAX_SIZE, MAX_SIZE, `${where}'s height`),
    rotation: num(raw.rotation, -MAX_COORD, MAX_COORD, `${where}'s rotation`),
    scaleX: num(raw.scaleX, -MAX_SIZE, MAX_SIZE, `${where}'s scaleX`),
    scaleY: num(raw.scaleY, -MAX_SIZE, MAX_SIZE, `${where}'s scaleY`)
  }
  optPaint(raw, 'fill', r, out)
  optPaint(raw, 'stroke', r, out)
  optNum(raw, 'strokeWidth', 0, MAX_SIZE, r, out)
  optNum(raw, 'radius', 0, MAX_SIZE, r, out)
  optNum(raw, 'blur', 0, MAX_SIZE, r, out)
  if (has(raw, 'dash') && raw.dash !== undefined) {
    if (Array.isArray(raw.dash) && raw.dash.length <= 1000 && raw.dash.every(d => typeof d === 'number' && Number.isFinite(d))) {
      out.dash = (raw.dash as number[]).map(d => Math.min(MAX_SIZE, Math.max(0, d)))
    } else r.note('a dash that was not a list of lengths (dropped)')
  }
  if (has(raw, 'shadow') && raw.shadow !== undefined) {
    const s = shadow(raw.shadow)
    if (s) out.shadow = s
    else r.note('a shadow that was not well formed (dropped)')
  }
  if (has(raw, 'timing') && raw.timing !== undefined) {
    const t = timing(raw.timing, r)
    if (t) out.timing = t
  }
  switch (type) {
    case 'path':
      out.d = str(raw.d, `${where}'s path data`)
      break
    case 'text': {
      if (!Array.isArray(raw.runs)) damaged(`${where} has no runs`)
      if (raw.runs.length > MAX_RUNS) damaged(`${where} has more than ${MAX_RUNS.toLocaleString('en-US')} runs`)
      let chars = 0
      out.runs = raw.runs.map((run, i) => {
        if (!isObj(run)) damaged(`${where}'s run ${i + 1} is not an object`)
        const text = str(run.text, `${where}'s run ${i + 1} text`)
        chars += text.length
        return { text, ...runStyle(run, `${where}'s run ${i + 1}`, r) }
      })
      if (chars > MAX_LAYER_TEXT) damaged(`${where} holds more than ${MAX_LAYER_TEXT.toLocaleString('en-US')} characters`)
      if ((r.text += chars) > MAX_DESIGN_TEXT) damaged(`it holds more than ${MAX_DESIGN_TEXT.toLocaleString('en-US')} characters of text`)
      out.mode = oneOf(raw.mode, ['box', 'point'] as const, 'box', r, 'text mode')
      out.align = oneOf(raw.align, ['left', 'center', 'right', 'justify'] as const, 'left', r, 'alignment')
      out.valign = oneOf(raw.valign, ['top', 'middle', 'bottom'] as const, 'top', r, 'vertical alignment')
      optBool(raw, 'outlines', r, out)
      optBool(raw, 'missingFont', r, out)
      if (typeof raw.glyphs === 'string') out.glyphs = raw.glyphs
      break
    }
    case 'image':
    case 'paint':
      out.asset = str(raw.asset, `${where}'s asset`)
      if (raw.fit !== undefined) out.fit = oneOf(raw.fit, ['fill', 'contain', 'cover'] as const, 'fill', r, 'fit')
      break
    case 'group': {
      if (!Array.isArray(raw.children)) damaged(`${where} has no children`)
      out.children = raw.children.map(c => layer(r, c, depth + 1, scope)).filter((c): c is Layer => c !== null)
      optBool(raw, 'clip', r, out)
      break
    }
    case 'instance':
      out.component = str(raw.component, `${where}'s component`)
      out.overrides = {}
      r.instances.push({ layer: out as unknown as Layer & { type: 'instance' }, raw: raw.overrides })
      break
    case 'connector': {
      for (const k of ['from', 'to'] as const) {
        const e = raw[k]
        if (!isObj(e)) damaged(`${where}'s ${k} is not an end`)
        const end: End = { layer: str(e.layer, `${where}'s ${k} layer`) }
        if (e.side !== undefined) end.side = oneOf(e.side, ['auto', 'top', 'right', 'bottom', 'left'] as const, 'auto', r, 'side')
        out[k] = end
        r.connectors.push({ end, scope })
      }
      if (raw.label !== undefined) out.label = r.name(raw.label, '')
      out.route = oneOf(raw.route, ['straight', 'orthogonal'] as const, 'straight', r, 'route')
      out.arrow = oneOf(raw.arrow, ['end', 'both', 'none'] as const, 'end', r, 'arrow')
      if (raw.points !== undefined) {
        const pts = raw.points
        if (Array.isArray(pts) && pts.length <= 10_000 && pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)))) {
          out.points = (pts as [number, number][]).map(([px, py]) => [Math.min(MAX_COORD, Math.max(-MAX_COORD, px)), Math.min(MAX_COORD, Math.max(-MAX_COORD, py))])
        } else r.note("a connector's points that were not well formed (dropped)")
      }
      break
    }
    case 'svg': {
      // an svg layer is drawn and exported, so its markup is cleaned again: a file can hold any SVG
      const svg = str(raw.svg, `${where}'s svg`)
      try {
        out.svg = cleanSvg(svg).svg
      } catch (e) {
        r.note(`an SVG layer that could not be cleaned (${(e as Error).message.replace(/\.$/, '')}; dropped)`)
        return null
      }
      break
    }
  }
  return out as unknown as Layer
}

// ---------- the design ----------

function styles(v: unknown, r: Reader): Styles {
  const out: Styles = { colors: [], text: [] }
  if (!isObj(v)) {
    if (v !== undefined) r.note('styles that were not well formed (dropped)')
    return out
  }
  for (const c of Array.isArray(v.colors) ? v.colors : []) {
    if (isObj(c) && typeof c.name === 'string' && isColor(c.color)) out.colors.push({ name: r.name(c.name, ''), color: c.color })
    else r.note('a color style that was not well formed (dropped)')
  }
  for (const t of Array.isArray(v.text) ? v.text : []) {
    try {
      if (!isObj(t) || typeof t.name !== 'string' || !isObj(t.run)) throw new Error()
      out.text.push({ name: r.name(t.name, ''), run: runStyle(t.run, 'a text style', r) })
    } catch {
      r.note('a text style that was not well formed (dropped)')
    }
  }
  return out
}

function diagrams(v: unknown, scope: Scope, r: Reader): Diagram[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ref = (x: unknown): string | undefined => (typeof x === 'string' ? follow(scope, x) : undefined)
  const label = (x: unknown): string | undefined => (typeof x === 'string' ? x.slice(0, MAX_NAME) : undefined)
  const out: Diagram[] = []
  for (const d of v) {
    if (!isObj(d) || typeof d.name !== 'string') {
      r.note('a diagram that was not well formed (dropped)')
      continue
    }
    const nodes: Diagram['nodes'] = []
    for (const n of Array.isArray(d.nodes) ? d.nodes : []) {
      const layerId = isObj(n) ? ref(n.layer) : undefined
      if (!isObj(n) || typeof n.id !== 'string' || !layerId) continue
      const node: Diagram['nodes'][number] = { id: n.id.slice(0, MAX_NAME), layer: layerId }
      if (typeof n.container === 'string') node.container = n.container.slice(0, MAX_NAME)
      if (typeof n.pinned === 'boolean') node.pinned = n.pinned
      if (typeof n.icon === 'string') node.icon = n.icon.slice(0, MAX_NAME)
      nodes.push(node)
    }
    const links: Diagram['links'] = []
    for (const l of Array.isArray(d.links) ? d.links : []) {
      const layerId = isObj(l) ? ref(l.layer) : undefined
      if (!isObj(l) || typeof l.from !== 'string' || typeof l.to !== 'string' || !layerId) continue
      const link: Diagram['links'][number] = { from: l.from.slice(0, MAX_NAME), to: l.to.slice(0, MAX_NAME), layer: layerId }
      const text = label(l.label)
      if (text !== undefined) link.label = text
      links.push(link)
    }
    const containers: Diagram['containers'] = []
    for (const c of Array.isArray(d.containers) ? d.containers : []) {
      const layerId = isObj(c) ? ref(c.layer) : undefined
      if (!isObj(c) || typeof c.id !== 'string' || !layerId) continue
      const box: Diagram['containers'][number] = { id: c.id.slice(0, MAX_NAME), layer: layerId }
      if (typeof c.in === 'string') box.in = c.in.slice(0, MAX_NAME)
      containers.push(box)
    }
    out.push({
      name: r.name(d.name, 'Diagram'),
      direction: oneOf(d.direction, ['right', 'down', 'left', 'up'] as const, 'right', r, 'direction'),
      spacing: typeof d.spacing === 'number' && Number.isFinite(d.spacing) ? Math.min(MAX_SIZE, Math.max(0, d.spacing)) : 40,
      nodeComponent: typeof d.nodeComponent === 'string' ? (follow(r.componentIds, d.nodeComponent) ?? d.nodeComponent.slice(0, 64)) : '',
      nodes,
      links,
      containers
    })
  }
  return out
}

/** Gathers every id the file names, so ids made for repeated or broken ones never take one held later on. */
function reserve(r: Reader, v: unknown, depth = 0): void {
  if (depth > MAX_DEPTH + 4 || r.reserved.size > MAX_LAYERS + MAX_COMPONENTS) return
  if (Array.isArray(v)) for (const x of v) reserve(r, x, depth + 1)
  else if (isObj(v)) {
    if (typeof v.id === 'string' && ID.test(v.id)) r.reserved.add(v.id)
    for (const k of ['artboards', 'layers', 'children', 'components', 'root'] as const) if (has(v, k)) reserve(r, v[k], depth + 1)
  }
}

/**
 * A design from what a file holds (design.json, parsed), checked against the schema in types.ts. Returns a new Design
 * holding only the fields the schema knows:
 * - wrong types for required fields, unknown layer types, more than 100,000 layers, groups nested past 64, more than
 *   10,000 components, and text past 1,000 runs or 100,000 characters in a layer or 1,000,000 in the design refuse
 *   the file with "This design file is damaged: <reason>." (and an artboard over 8192 px with the usual message);
 * - ids that aren't 1 to 64 of [A-Za-z0-9_-], or repeat one held earlier, are renamed, and connector ends, diagram
 *   nodes, instances' components and override keys follow the rename wherever it's unambiguous;
 * - names past 1,000 characters are cut, and a name that isn't text gets a default;
 * - numbers are clamped as the ops clamp them (coordinates to +/-1e7, sizes to 1e5), gradients keep at most 256
 *   well-formed stops (falling back to a color with fewer than two), override keys that aren't layers of the
 *   instance's component are dropped, and svg layers are cleaned again (one that fails cleaning is dropped).
 * `notes`, when given, hears one plain line per kind of thing repaired or dropped, with a count.
 * Pure: the same input gives the same design.
 */
export function validateDesign(raw: unknown, notes?: string[]): Design {
  if (!isObj(raw) || raw.format !== 1) throw new Error('This design file is from a newer version of gauzzaDocs or is damaged')
  if (!Array.isArray(raw.artboards) || !raw.artboards.length) damaged('it has no artboards')
  const r = new Reader()
  reserve(r, raw)
  const rawComponents = raw.components === undefined ? [] : raw.components
  if (!Array.isArray(rawComponents)) damaged('its components are not a list')
  if (rawComponents.length > MAX_COMPONENTS) damaged(`it has more than ${MAX_COMPONENTS.toLocaleString('en-US')} components`)

  // components first: their ids are what instances refer to
  const components: Component[] = []
  for (const c of rawComponents) {
    if (!isObj(c)) damaged('a component is not an object')
    const id = r.id(c.id, r.componentIds)
    const scope = newScope()
    r.componentScopes.set(id, scope)
    const root = layer(r, c.root, 1, scope)
    if (!root || root.type !== 'group') damaged(`component ${id} has no group at its root`)
    components.push({ id, name: r.name(c.name, 'Component'), root })
  }

  const artboards: Artboard[] = []
  const pending: { board: Artboard; raw: unknown; scope: Scope }[] = []
  for (const a of raw.artboards) {
    if (!isObj(a)) damaged('an artboard is not an object')
    const id = r.id(a.id)
    const where = `artboard ${id}`
    const width = num(a.width, 1, Infinity, `${where}'s width`)
    const height = num(a.height, 1, Infinity, `${where}'s height`)
    if (width > MAX_ARTBOARD_SIDE || height > MAX_ARTBOARD_SIDE) throw new Error(`Artboards can be at most ${MAX_ARTBOARD_SIDE} px per side.`)
    if (!Array.isArray(a.layers)) damaged(`${where} has no layers`)
    const scope = newScope()
    let background: Paint | null = null
    if (a.background !== null && a.background !== undefined) {
      const p = paint(a.background, r)
      if (p) background = p
      else r.note('a background that was not a paint (dropped)')
    }
    const board: Artboard = {
      id, name: r.name(a.name, 'Artboard'), width, height, background,
      layers: a.layers.map(l => layer(r, l, 1, scope)).filter((l): l is Layer => l !== null)
    }
    if (isObj(a.animation)) {
      const an = a.animation
      if (typeof an.duration === 'number' && typeof an.fps === 'number' && typeof an.loop === 'boolean' && Number.isFinite(an.duration) && Number.isFinite(an.fps)) {
        board.animation = { duration: Math.min(MAX_SIZE, Math.max(0, an.duration)), fps: Math.min(60, Math.max(1, an.fps)), loop: an.loop }
      } else r.note('an animation that was not well formed (dropped)')
    }
    artboards.push(board)
    if (a.diagrams !== undefined) pending.push({ board, raw: a.diagrams, scope })
  }

  // references, now that every id is known
  for (const { board, raw: d, scope } of pending) {
    const list = diagrams(d, scope, r)
    if (list) board.diagrams = list
  }
  for (const { end, scope } of r.connectors) {
    const to = follow(scope, end.layer)
    end.layer = to ?? (ID.test(end.layer) ? end.layer : '')
  }
  for (const { layer: inst, raw: given } of r.instances) {
    inst.component = follow(r.componentIds, inst.component) ?? (ID.test(inst.component) ? inst.component : '')
    const scope = r.componentScopes.get(inst.component)
    if (given === undefined) continue
    if (!isObj(given)) {
      r.note('overrides that were not well formed (dropped)')
      continue
    }
    const overrides: Record<string, Override> = Object.create(null)
    for (const [key, o] of Object.entries(given)) {
      const inner = scope ? follow(scope, key) : undefined
      if (!inner || !isObj(o)) {
        r.note("an override for a layer its component doesn't have (dropped)")
        continue
      }
      const out: Override = {}
      if (typeof o.text === 'string') out.text = o.text.length > MAX_LAYER_TEXT ? damaged(`an override holds more than ${MAX_LAYER_TEXT.toLocaleString('en-US')} characters`) : o.text
      if (out.text !== undefined && (r.text += out.text.length) > MAX_DESIGN_TEXT) damaged(`it holds more than ${MAX_DESIGN_TEXT.toLocaleString('en-US')} characters of text`)
      for (const k of ['fill', 'stroke'] as const) {
        if (o[k] === undefined) continue
        const p = paint(o[k], r)
        if (p) out[k] = p
        else r.note(`an override ${k} that was not a paint (dropped)`)
      }
      if (typeof o.visible === 'boolean') out.visible = o.visible
      if (typeof o.asset === 'string') out.asset = o.asset
      overrides[inner] = out
    }
    inst.overrides = overrides
  }

  const design: Design = {
    format: 1,
    id: typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : 'design',
    artboards,
    components,
    styles: styles(raw.styles, r)
  }
  if (isObj(raw.kit) && typeof raw.kit.kitId === 'string' && Array.isArray(raw.kit.items)) {
    design.kit = {
      kitId: raw.kit.kitId.slice(0, MAX_NAME),
      items: raw.kit.items
        .filter((i): i is Obj => isObj(i) && typeof i.itemId === 'string' && typeof i.name === 'string')
        .map(i => ({ itemId: (i.itemId as string).slice(0, MAX_NAME), name: r.name(i.name, ''), copy: i.copy }))
    }
  }
  if (typeof raw.thumbnailStale === 'boolean') design.thumbnailStale = raw.thumbnailStale
  if (notes) for (const [s, n] of r.notes) notes.push(n > 1 ? `${s} (${n} times)` : s)
  return design
}
