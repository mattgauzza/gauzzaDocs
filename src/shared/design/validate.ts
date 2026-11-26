import { MAX_ARTBOARD_SIDE } from './model'
import { cleanSvg } from './svgClean'
import type { Design, Layer, Override, Paint } from './types'

// A design read from a file, checked against the schema in types.ts before anything else touches it. design.json is
// whatever a file holds, so every field this release knows is checked for its type and size, ids are made safe and
// unique, simple slips are repaired, and anything that can't be drawn safely is dropped (and noted) or the file is
// refused. Fields this release doesn't know are kept as they are, so saving never strips what a later release wrote.

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
const BLENDS = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
] as const

/** Throws "This design file is damaged: <reason>." */
function damaged(reason: string): never {
  throw new Error(`This design file is damaged: ${reason}.`)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
/** A value for a message, never converted with String() (an object's toString could be anything). */
const shown = (v: unknown): string => (typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : typeof v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const isColor = (v: unknown): v is string => typeof v === 'string' && COLOR.test(v)

/** The largest design.json a design may come to once its repairs are written back (what reading accepts). */
export const MAX_REPAIRED = 64 * 1024 * 1024
export const TOO_LARGE_REPAIRED = 'This design is too large to open (over 64 MB once repaired).'
/** How deep, and how much in all, the values of fields this release doesn't know may be; past it they're dropped. */
export const MAX_UNKNOWN_DEPTH = 32
export const MAX_UNKNOWN_BYTES = 8 * 1024 * 1024
/** Most SVG markup the svg layers of one design may hold; layers past it are dropped. */
export const MAX_SVG_MARKUP = 16 * 1024 * 1024
/** Most different notes kept; past it they're counted as "and N more". */
const MAX_NOTES = 200

const keys = (s: string): Set<string> => new Set(s.split(' '))
const BASE_KEYS = 'id name type visible locked opacity blend x y width height rotation scaleX scaleY fill stroke strokeWidth dash radius shadow blur timing'
/** The fields this release reads, by kind of object. Anything else is kept as it is, within the unknown bounds. */
const KNOWN: Record<string, Set<string>> = {
  design: keys('format id artboards components styles kit thumbnailStale'),
  artboard: keys('id name width height background layers animation diagrams'),
  component: keys('id name root'),
  rect: keys(BASE_KEYS), ellipse: keys(BASE_KEYS), line: keys(BASE_KEYS),
  path: keys(`${BASE_KEYS} d`),
  text: keys(`${BASE_KEYS} runs mode align valign outlines glyphs missingFont`),
  image: keys(`${BASE_KEYS} asset fit`), paint: keys(`${BASE_KEYS} asset fit`),
  group: keys(`${BASE_KEYS} children clip`),
  instance: keys(`${BASE_KEYS} component overrides`),
  connector: keys(`${BASE_KEYS} from to label route arrow points`),
  svg: keys(`${BASE_KEYS} svg`),
  run: keys('text font size color letterSpacing lineHeight'),
  font: keys('family weight style postscript asset'),
  paintValue: keys('type color ref stops angle'),
  stop: keys('offset color'),
  override: keys('text fill stroke visible asset'),
  end: keys('layer side'),
  shadow: keys('x y blur color'),
  // tracks and text effects arrive in a later release: until then their values count as unknown
  timing: keys('start end in out'),
  animation: keys('duration fps loop'),
  // direction, spacing and nodeComponent aren't read here: they're kept like unknown fields, within the same bounds
  diagram: keys('name nodes links containers'),
  diagramPart: keys('layer'),
  styles: keys('colors text'),
  colorStyle: keys('name color'),
  textStyle: keys('name run'),
  kit: keys('kitId')
}
const NONE = new Set<string>()

/**
 * A copy of what the file holds for an object of kind `kind`, so the checked fields can be set over it. Fields this
 * release doesn't know are kept as they are (a later release may have written them), as long as each is at most 32
 * levels deep and they come to at most 8 MB in the whole design; past that they're dropped with a note. A `__proto__`
 * key is never kept: it's never data.
 */
function kept(o: Obj, kind: string, r: Reader): Obj {
  const known = Object.prototype.hasOwnProperty.call(KNOWN, kind) ? KNOWN[kind] : NONE
  const out: Obj = {}
  for (const k of Object.keys(o)) {
    if (k === '__proto__') continue
    if (!known.has(k) && !r.keepUnknown(o[k], k.length + 4)) continue
    out[k] = o[k]
  }
  return out
}

/** Ids as they're read: the first holder of a valid id keeps it; others get a new one made from it. */
interface Scope { raw: Map<string, string[]>; ids: Set<string> }
const newScope = (): Scope => ({ raw: new Map(), ids: new Set() })

class Reader {
  notes = new Map<string, number>()
  /** notes past MAX_NOTES different ones, counted */
  moreNotes = 0
  /** every id the file names, so a new id never takes one a later layer holds */
  reserved = new Set<string>()
  taken = new Set<string>()
  /** for each base a renamed id is made from, the next number to try, so renaming stays linear */
  nextNumber = new Map<string, number>()
  layers = 0
  text = 0
  svgMarkup = 0
  /** what the repaired design.json is estimated to come to: what was read, plus every default written back */
  size: number
  /** what the values of unknown fields kept so far come to */
  unknownBytes = 0
  /** references settled once every id is known */
  ends: { end: Obj; scope: Scope }[] = []
  instances: { layer: Obj; raw: unknown }[] = []
  componentScopes = new Map<string, Scope>()
  componentIds = newScope()

  constructor(size: number) {
    this.size = size
  }

  note(s: string): void {
    const n = this.notes.get(s)
    if (n !== undefined) this.notes.set(s, n + 1)
    else if (this.notes.size < MAX_NOTES) this.notes.set(s, 1)
    else this.moreNotes++
  }

  /** Counts what a repair writes back; past MAX_REPAIRED the design is refused. */
  grow(bytes: number): void {
    if ((this.size += bytes) > MAX_REPAIRED) throw new Error(TOO_LARGE_REPAIRED)
  }

  /**
   * Whether an unknown field can be kept: its value at most 32 levels deep, and it (`key` bytes for its name, then
   * its value) within what's left of the 8 MB.
   */
  keepUnknown(v: unknown, key = 0): boolean {
    const left = MAX_UNKNOWN_BYTES - this.unknownBytes
    if (v === null || typeof v !== 'object') {
      const bytes = key + (typeof v === 'string' ? v.length + 2 : 8)
      if (bytes > left) return this.dropUnknown()
      this.unknownBytes += bytes
      return true
    }
    let bytes = key
    const stack: [unknown, number][] = [[v, 1]]
    while (stack.length) {
      const [x, depth] = stack.pop()!
      if (typeof x === 'string') bytes += x.length + 2
      else if (Array.isArray(x)) {
        if (depth >= MAX_UNKNOWN_DEPTH && x.length) return this.dropUnknown()
        bytes += 2 + x.length
        for (const y of x) stack.push([y, depth + 1])
      } else if (x && typeof x === 'object') {
        const ks = Object.keys(x)
        if (depth >= MAX_UNKNOWN_DEPTH && ks.length) return this.dropUnknown()
        bytes += 2
        for (const k of ks) {
          bytes += k.length + 4
          stack.push([(x as Obj)[k], depth + 1])
        }
      } else bytes += 8
      if (bytes > left) return this.dropUnknown()
    }
    this.unknownBytes += bytes
    return true
  }

  private dropUnknown(): false {
    this.note(`a field this release doesn't know, nested past ${MAX_UNKNOWN_DEPTH} levels or past 8 MB of such fields (dropped)`)
    return false
  }

  /** A safe, unique id for something that holds `raw`, recorded in `scope` so references to `raw` can follow it. */
  id(raw: unknown, scope?: Scope): string {
    let id: string
    if (typeof raw === 'string' && ID.test(raw) && !this.taken.has(raw)) id = raw
    else {
      this.note(typeof raw === 'string' && ID.test(raw) ? 'a repeated id (renamed)' : 'an id that was not valid (renamed)')
      const base = (typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) : '') || 'id'
      id = base
      if (this.taken.has(id) || this.reserved.has(id) || !ID.test(id)) {
        let n = this.nextNumber.get(base) ?? 2
        while (this.taken.has(`${base}-${n}`) || this.reserved.has(`${base}-${n}`)) n++
        id = `${base}-${n}`
        this.nextNumber.set(base, n + 1)
      }
      if (typeof raw !== 'string') this.grow(id.length + 8)
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

  /** A name of at most MAX_NAME characters; a missing name or one that isn't text becomes `fallback`. */
  name(raw: unknown, fallback: string): string {
    if (typeof raw !== 'string') {
      this.note(raw === undefined ? 'a missing name (given a default)' : 'a name that was not text (given a default)')
      if (raw === undefined) this.grow(fallback.length + 10)
      return fallback
    }
    if (raw.length > MAX_NAME) {
      this.note(`a name longer than ${MAX_NAME.toLocaleString('en-US')} characters (cut)`)
      return raw.slice(0, MAX_NAME)
    }
    return raw
  }

  /** A true or false field: "true" and "false" are read as such, anything else missing or wrong becomes `fallback`. */
  bool(o: Obj, k: string, fallback: boolean): boolean {
    const v = o[k]
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') {
      this.note(`${k} written as text (read as ${v})`)
      return v === 'true'
    }
    this.note(v === undefined ? `${k} missing (set to ${fallback})` : `${k} that was not true or false (set to ${fallback})`)
    if (v === undefined) this.grow(k.length + 9)
    return fallback
  }

  /** A number, clamped: a numeric string is read as one; anything else missing or wrong becomes `fallback`. */
  num(o: Obj, k: string, fallback: number, lo: number, hi: number): number {
    const v = this.number(o[k], k)
    if (v === undefined) {
      this.note(o[k] === undefined ? `${k} missing (set to ${fallback})` : `${k} that was not a number (set to ${fallback})`)
      if (o[k] === undefined) this.grow(k.length + 4 + String(fallback).length)
      return fallback
    }
    return clamp(v, lo, hi)
  }

  /** The number a value holds (a numeric string read as one, noted), or undefined. */
  number(v: unknown, k: string): number | undefined {
    if (typeof v === 'number' && !Number.isNaN(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      this.note(`${k} written as text (read as a number)`)
      return Number(v)
    }
    return undefined
  }

  /** An optional number: kept (clamped) when it is one, dropped with a note when it isn't. */
  optNum(o: Obj, k: string, lo: number, hi: number): void {
    if (o[k] === undefined) return
    const v = this.number(o[k], k)
    if (v === undefined) {
      this.note(`${k} that was not a number (dropped)`)
      delete o[k]
    } else o[k] = clamp(v, lo, hi)
  }

  /** An optional true or false. */
  optBool(o: Obj, k: string): void {
    if (o[k] === undefined || typeof o[k] === 'boolean') return
    if (o[k] === 'true' || o[k] === 'false') {
      this.note(`${k} written as text (read as ${o[k]})`)
      o[k] = o[k] === 'true'
    } else {
      this.note(`${k} that was not true or false (dropped)`)
      delete o[k]
    }
  }

  /** One of `options`; anything else missing or unknown becomes `fallback`. */
  oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T, what: string): T {
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T
    this.note(v === undefined ? `${what} missing (set to ${fallback})` : `an unknown ${what} (set to ${fallback})`)
    if (v === undefined) this.grow(what.length + fallback.length + 6)
    return fallback
  }

  /** An optional field of one of `options`: kept when it is one, dropped with a note when it isn't. */
  optOneOf(o: Obj, k: string, options: readonly string[]): void {
    if (o[k] === undefined || (typeof o[k] === 'string' && options.includes(o[k] as string))) return
    this.note(`an unknown ${k} (dropped)`)
    delete o[k]
  }

  /** An optional string, cut at `most` characters; dropped when it isn't text. */
  optText(o: Obj, k: string, most = MAX_NAME): void {
    if (o[k] === undefined) return
    if (typeof o[k] !== 'string') {
      this.note(`${k} that was not text (dropped)`)
      delete o[k]
    } else if ((o[k] as string).length > most) {
      this.note(`${k} longer than ${most.toLocaleString('en-US')} characters (cut)`)
      o[k] = (o[k] as string).slice(0, most)
    }
  }
}

/** Where a reference in `scope` points now: the id itself when it's still held there, else the one id it became. */
function follow(scope: Scope, raw: string): string | undefined {
  if (scope.ids.has(raw)) return raw
  const list = scope.raw.get(raw)
  return list && list.length === 1 ? list[0] : undefined
}

// ---------- values ----------

/**
 * A paint, or undefined when it can't be one. A gradient keeps at most 256 well-formed stops (offset 0..1, a color),
 * and with fewer than two it falls back to the color of the first (black when none). Fields a later release adds to a
 * paint are kept.
 */
function paint(v: unknown, r: Reader): Paint | undefined {
  if (!isObj(v)) return undefined
  if (v.type === 'color') return isColor(v.color) ? ({ ...kept(v, 'paintValue', r), type: 'color', color: v.color } as Paint) : undefined
  if (v.type === 'style') return typeof v.ref === 'string' && v.ref.length <= MAX_NAME ? ({ ...kept(v, 'paintValue', r), type: 'style', ref: v.ref } as Paint) : undefined
  if (v.type !== 'linear' && v.type !== 'radial') return undefined
  const raw = Array.isArray(v.stops) ? v.stops : []
  const stops: Obj[] = []
  for (const s of raw) {
    if (stops.length >= MAX_STOPS) {
      r.note(`a gradient with more than ${MAX_STOPS} stops (the rest dropped)`)
      break
    }
    const offset = isObj(s) ? r.number(s.offset, 'a stop offset') : undefined
    if (!isObj(s) || !isColor(s.color) || offset === undefined) {
      r.note('a gradient stop that was not well formed (dropped)')
      continue
    }
    stops.push({ ...kept(s, 'stop', r), offset: clamp(offset, 0, 1), color: s.color })
  }
  if (stops.length < 2) {
    r.note('a gradient with fewer than two stops (drawn as a color)')
    return { type: 'color', color: (stops[0]?.color as string | undefined) ?? '#000000' }
  }
  const out: Obj = { ...kept(v, 'paintValue', r), type: v.type, stops }
  if (out.angle !== undefined) {
    const a = r.number(out.angle, 'a gradient angle')
    if (a === undefined || !Number.isFinite(a)) delete out.angle
    else out.angle = clamp(a, -MAX_COORD, MAX_COORD)
  }
  return out as unknown as Paint
}

/** An optional paint field: null stays null (no paint), anything that isn't a paint is dropped. */
function optPaint(o: Obj, k: string, r: Reader, nullable = true): void {
  if (o[k] === undefined) return
  if (o[k] === null && nullable) return
  const p = paint(o[k], r)
  if (p) o[k] = p
  else {
    r.note(`a ${k} that was not a paint (dropped)`)
    delete o[k]
  }
}

function font(v: unknown, r: Reader): Obj {
  if (!isObj(v)) {
    r.note('a text run without a font (given Arial)')
    r.grow(60)
    return { family: 'Arial', weight: 400, style: 'normal' }
  }
  const out = kept(v, 'font', r)
  if (typeof v.family === 'string' && v.family) out.family = r.name(v.family, 'Arial')
  else {
    r.note('a font without a family (given Arial)')
    out.family = 'Arial'
  }
  out.weight = r.num(v, 'weight', 400, 1, 1000)
  out.style = r.oneOf(v.style, ['normal', 'italic'] as const, 'normal', 'font style')
  r.optText(out, 'postscript')
  if (out.asset !== undefined && typeof out.asset !== 'string') {
    r.note('a font asset that was not text (dropped)')
    delete out.asset
  }
  return out
}

/** A run's style (a text style's run, or a text run beside its text). */
function runStyle(v: Obj, r: Reader): Obj {
  const out = kept(v, 'run', r)
  out.font = font(v.font, r)
  out.size = r.num(v, 'size', 24, 0, MAX_SIZE)
  optPaint(out, 'color', r, false)
  r.optNum(out, 'letterSpacing', -MAX_SIZE, MAX_SIZE)
  r.optNum(out, 'lineHeight', 0, MAX_SIZE)
  return out
}

/**
 * A layer's timing: start and end in seconds (start at or before end), its entrance and exit effects and its keyframe
 * tracks and text effects (a later release's), each kept when it has the right type.
 */
function timing(v: unknown, r: Reader): Obj | undefined {
  if (!isObj(v)) {
    r.note('a timing that was not well formed (dropped)')
    return undefined
  }
  const out = kept(v, 'timing', r)
  r.optNum(out, 'start', 0, MAX_COORD)
  r.optNum(out, 'end', 0, MAX_COORD)
  if (typeof out.start === 'number' && typeof out.end === 'number' && out.start > out.end) {
    r.note('a timing that ended before it started (its end dropped)')
    delete out.end
  }
  r.optText(out, 'in')
  r.optText(out, 'out')
  if (out.tracks !== undefined && !Array.isArray(out.tracks)) {
    r.note('timing tracks that were not a list (dropped)')
    delete out.tracks
  }
  return out
}

function shadow(v: unknown, r: Reader): Obj | undefined {
  if (!isObj(v) || !isColor(v.color)) return undefined
  const out = kept(v, 'shadow', r)
  out.x = r.num(v, 'x', 0, -MAX_COORD, MAX_COORD)
  out.y = r.num(v, 'y', 0, -MAX_COORD, MAX_COORD)
  out.blur = r.num(v, 'blur', 0, 0, MAX_SIZE)
  return out
}

// ---------- layers ----------

/** A layer, checked and repaired; null when it can't be kept (it's dropped, with a note). */
function layer(r: Reader, raw: unknown, depth: number, scope: Scope): Layer | null {
  if (!isObj(raw)) damaged('a layer is not an object')
  if (depth > MAX_DEPTH) damaged(`groups are nested more than ${MAX_DEPTH} deep`)
  if (++r.layers > MAX_LAYERS) damaged(`it has more than ${MAX_LAYERS.toLocaleString('en-US')} layers`)
  const type = raw.type
  if (typeof type !== 'string' || !TYPES.has(type)) damaged(`a layer has an unknown type (${shown(type)})`)
  const out = kept(raw, type, r)
  out.id = r.id(raw.id, scope)
  const where = `layer ${out.id}`
  out.name = r.name(raw.name, DEFAULT_NAMES[type])
  out.visible = r.bool(raw, 'visible', true)
  out.locked = r.bool(raw, 'locked', false)
  out.opacity = r.num(raw, 'opacity', 1, 0, 1)
  out.blend = r.oneOf(raw.blend, BLENDS, 'normal', 'blend mode')
  out.x = r.num(raw, 'x', 0, -MAX_COORD, MAX_COORD)
  out.y = r.num(raw, 'y', 0, -MAX_COORD, MAX_COORD)
  out.width = r.num(raw, 'width', 0, -MAX_SIZE, MAX_SIZE)
  out.height = r.num(raw, 'height', 0, -MAX_SIZE, MAX_SIZE)
  out.rotation = r.num(raw, 'rotation', 0, -MAX_COORD, MAX_COORD)
  out.scaleX = r.num(raw, 'scaleX', 1, -MAX_SIZE, MAX_SIZE)
  out.scaleY = r.num(raw, 'scaleY', 1, -MAX_SIZE, MAX_SIZE)
  optPaint(out, 'fill', r)
  optPaint(out, 'stroke', r)
  r.optNum(out, 'strokeWidth', 0, MAX_SIZE)
  r.optNum(out, 'radius', 0, MAX_SIZE)
  r.optNum(out, 'blur', 0, MAX_SIZE)
  if (out.dash !== undefined) {
    const d = out.dash
    if (Array.isArray(d) && d.length <= 1000 && d.every(x => r.number(x, 'a dash length') !== undefined)) {
      out.dash = d.map(x => clamp(r.number(x, 'a dash length') ?? 0, 0, MAX_SIZE))
    } else {
      r.note('a dash that was not a list of lengths (dropped)')
      delete out.dash
    }
  }
  if (out.shadow !== undefined) {
    const s = shadow(out.shadow, r)
    if (s) out.shadow = s
    else {
      r.note('a shadow that was not well formed (dropped)')
      delete out.shadow
    }
  }
  if (out.timing !== undefined) {
    const t = timing(out.timing, r)
    if (t) out.timing = t
    else delete out.timing
  }
  switch (type) {
    case 'path':
      if (typeof raw.d !== 'string') {
        r.note('path data that was not text (the path draws nothing)')
        out.d = ''
      }
      break
    case 'text': {
      let runs = raw.runs
      if (!Array.isArray(runs)) {
        r.note('a text layer without runs (left empty)')
        r.grow(10)
        runs = []
      }
      const list = runs as unknown[]
      if (list.length > MAX_RUNS) damaged(`${where} has more than ${MAX_RUNS.toLocaleString('en-US')} runs`)
      let chars = 0
      out.runs = list
        .filter(run => {
          if (isObj(run)) return true
          r.note('a text run that was not an object (dropped)')
          return false
        })
        .map(run => {
          const o = run as Obj
          let text = o.text
          if (typeof text !== 'string') {
            r.note('run text that was not text (left empty)')
            if (text === undefined) r.grow(10)
            text = ''
          }
          chars += (text as string).length
          return { ...runStyle(o, r), text }
        })
      if (chars > MAX_LAYER_TEXT) damaged(`${where} holds more than ${MAX_LAYER_TEXT.toLocaleString('en-US')} characters`)
      if ((r.text += chars) > MAX_DESIGN_TEXT) damaged(`it holds more than ${MAX_DESIGN_TEXT.toLocaleString('en-US')} characters of text`)
      out.mode = r.oneOf(raw.mode, ['box', 'point'] as const, 'box', 'text mode')
      out.align = r.oneOf(raw.align, ['left', 'center', 'right', 'justify'] as const, 'left', 'alignment')
      out.valign = r.oneOf(raw.valign, ['top', 'middle', 'bottom'] as const, 'top', 'vertical alignment')
      r.optBool(out, 'outlines')
      r.optBool(out, 'missingFont')
      if (out.glyphs !== undefined && typeof out.glyphs !== 'string') {
        r.note('stored glyphs that were not text (dropped)')
        delete out.glyphs
      }
      break
    }
    case 'image':
    case 'paint':
      if (typeof raw.asset !== 'string') {
        r.note('an image without an asset (dropped)')
        return null
      }
      r.optOneOf(out, 'fit', ['fill', 'contain', 'cover'])
      break
    case 'group': {
      let children = raw.children
      if (!Array.isArray(children)) {
        r.note('a group without children (left empty)')
        r.grow(14)
        children = []
      }
      out.children = (children as unknown[]).map(c => layer(r, c, depth + 1, scope)).filter((c): c is Layer => c !== null)
      r.optBool(out, 'clip')
      break
    }
    case 'instance':
      if (typeof raw.component !== 'string') {
        r.note('an instance without a component (it draws nothing)')
        r.grow(16)
        out.component = ''
      }
      if (raw.overrides === undefined) r.grow(15)
      out.overrides = {}
      r.instances.push({ layer: out, raw: raw.overrides })
      break
    case 'connector': {
      for (const k of ['from', 'to'] as const) {
        const e = raw[k]
        const end = isObj(e) ? kept(e, 'end', r) : {}
        if (typeof end.layer !== 'string') {
          r.note('a connector end without a layer (it joins nothing)')
          r.grow(20)
          end.layer = ''
        }
        r.optOneOf(end, 'side', ['auto', 'top', 'right', 'bottom', 'left'])
        out[k] = end
        r.ends.push({ end, scope })
      }
      r.optText(out, 'label')
      out.route = r.oneOf(raw.route, ['straight', 'orthogonal'] as const, 'straight', 'route')
      out.arrow = r.oneOf(raw.arrow, ['end', 'both', 'none'] as const, 'end', 'arrow')
      if (out.points !== undefined) {
        const pts = out.points
        if (Array.isArray(pts) && pts.length <= 10_000 && pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)))) {
          out.points = (pts as [number, number][]).map(([px, py]) => [clamp(px, -MAX_COORD, MAX_COORD), clamp(py, -MAX_COORD, MAX_COORD)])
        } else {
          r.note("a connector's points that were not well formed (dropped)")
          delete out.points
        }
      }
      break
    }
    case 'svg': {
      // an svg layer is drawn and exported, so its markup is cleaned again: a file can hold any SVG
      if (typeof raw.svg !== 'string') {
        r.note('an SVG layer without markup (dropped)')
        return null
      }
      // the svg layers of one design hold at most 16 MB of markup between them, so reading one cleans at most that
      if ((r.svgMarkup += raw.svg.length) > MAX_SVG_MARKUP) {
        r.note('an SVG layer past 16 MB of SVG in this design (dropped)')
        return null
      }
      try {
        out.svg = cleanSvg(raw.svg).svg
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

function styles(v: unknown, r: Reader): Obj {
  if (!isObj(v)) {
    if (v !== undefined) r.note('styles that were not well formed (dropped)')
    else r.grow(30)
    return { colors: [], text: [] }
  }
  const out = kept(v, 'styles', r)
  const colors: Obj[] = []
  for (const c of Array.isArray(v.colors) ? v.colors : []) {
    if (isObj(c) && typeof c.name === 'string' && isColor(c.color)) colors.push({ ...kept(c, 'colorStyle', r), name: r.name(c.name, ''), color: c.color })
    else r.note('a color style that was not well formed (dropped)')
  }
  const text: Obj[] = []
  for (const t of Array.isArray(v.text) ? v.text : []) {
    if (isObj(t) && typeof t.name === 'string' && isObj(t.run)) text.push({ ...kept(t, 'textStyle', r), name: r.name(t.name, ''), run: runStyle(t.run, r) })
    else r.note('a text style that was not well formed (dropped)')
  }
  out.colors = colors
  out.text = text
  return out
}

/** Diagrams as a later release keeps them: each part kept, and the layer each names following any rename. */
function diagrams(v: unknown, scope: Scope, r: Reader): Obj[] | undefined {
  if (!Array.isArray(v)) {
    r.note('diagrams that were not a list (dropped)')
    return undefined
  }
  const parts = (list: unknown, what: string): Obj[] => {
    if (!Array.isArray(list)) return []
    const out: Obj[] = []
    for (const p of list) {
      if (!isObj(p)) {
        r.note(`a diagram ${what} that was not an object (dropped)`)
        continue
      }
      const o = kept(p, 'diagramPart', r)
      if (typeof o.layer === 'string') o.layer = follow(scope, o.layer) ?? o.layer
      out.push(o)
    }
    return out
  }
  const out: Obj[] = []
  for (const d of v) {
    if (!isObj(d)) {
      r.note('a diagram that was not an object (dropped)')
      continue
    }
    const o = kept(d, 'diagram', r)
    o.name = r.name(d.name, 'Diagram')
    o.nodes = parts(d.nodes, 'node')
    o.links = parts(d.links, 'link')
    o.containers = parts(d.containers, 'container')
    if (typeof o.nodeComponent === 'string') o.nodeComponent = follow(r.componentIds, o.nodeComponent) ?? o.nodeComponent
    out.push(o)
  }
  return out
}

/**
 * Gathers every id the file names, however deep (walked with a stack, not recursion), so ids made for repeated or
 * broken ones never take one held anywhere in the file.
 */
function reserve(r: Reader, v: unknown): void {
  const stack: unknown[] = [v]
  while (stack.length) {
    const x = stack.pop()
    if (Array.isArray(x)) for (const y of x) stack.push(y)
    else if (isObj(x)) {
      if (typeof x.id === 'string' && ID.test(x.id)) r.reserved.add(x.id)
      for (const k of ['artboards', 'layers', 'children', 'components', 'root'] as const) if (k in x) stack.push(x[k])
    }
  }
}

function artboard(r: Reader, a: unknown, pending: { board: Obj; raw: unknown; scope: Scope }[]): Obj {
  if (!isObj(a)) damaged('an artboard is not an object')
  const out = kept(a, 'artboard', r)
  out.id = r.id(a.id)
  out.name = r.name(a.name, 'Artboard')
  out.width = r.num(a, 'width', 1080, 1, Infinity)
  out.height = r.num(a, 'height', 1080, 1, Infinity)
  if ((out.width as number) > MAX_ARTBOARD_SIDE || (out.height as number) > MAX_ARTBOARD_SIDE) {
    throw new Error(`Artboards can be at most ${MAX_ARTBOARD_SIDE} px per side.`)
  }
  if (a.background === undefined || a.background === null) {
    if (a.background === undefined) r.grow(18)
    out.background = null
  } else {
    const p = paint(a.background, r)
    if (!p) r.note('a background that was not a paint (dropped)')
    out.background = p ?? null
  }
  let layers = a.layers
  if (!Array.isArray(layers)) {
    r.note('an artboard without layers (left empty)')
    r.grow(12)
    layers = []
  }
  const scope = newScope()
  out.layers = (layers as unknown[]).map(l => layer(r, l, 1, scope)).filter((l): l is Layer => l !== null)
  if (out.animation !== undefined) {
    if (isObj(out.animation)) {
      const an = kept(out.animation, 'animation', r)
      an.duration = r.num(out.animation, 'duration', 0, 0, MAX_SIZE)
      an.fps = r.num(out.animation, 'fps', 30, 1, 60)
      an.loop = r.bool(out.animation, 'loop', false)
      out.animation = an
    } else {
      r.note('an animation that was not well formed (dropped)')
      delete out.animation
    }
  }
  if (out.diagrams !== undefined) pending.push({ board: out, raw: out.diagrams, scope })
  return out
}

/**
 * A design from what a file holds (design.json, parsed), checked against the schema in types.ts. Returns a new
 * Design; `notes`, when given, hears one plain line per kind of thing repaired or dropped, with a count.
 *
 * - Kept as they are: every field this release doesn't know, at any level (a later release's data must survive a
 *   save here), within the bounds below, and the known fields of later releases (timing effects and tracks,
 *   animation, diagrams, kit).
 * - Repaired, with a note: "true" and "false" read as booleans and numeric strings as numbers; a missing or wrong
 *   scalar gets its default (visible true, locked false, opacity 1, blend normal, rotation 0, scale 1, position and
 *   size 0, and so on); ids that aren't 1 to 64 of [A-Za-z0-9_-], or repeat one held earlier, are renamed, and
 *   connector ends, diagram layers, instances' components and override keys follow wherever it's unambiguous;
 *   names past 1,000 characters are cut and one that isn't text gets a default; numbers are clamped as the ops clamp
 *   them (coordinates to +/-1e7, sizes to 1e5); gradients keep at most 256 good stops, falling back to a color with
 *   fewer than two.
 * - Dropped, with a note: optional fields of the wrong type, override keys that aren't layers of the instance's
 *   component, images without an asset, and svg layers that fail cleaning again.
 * - Refused ("This design file is damaged: <reason>."): structural damage (no artboards, a layer or artboard that
 *   isn't an object, a layer of unknown type, a component without a group at its root) and size past the limits
 *   (100,000 layers, groups 64 deep, 10,000 components, 1,000 runs or 100,000 characters in a layer, 1,000,000 in
 *   the design). An artboard over 8192 px gets the usual message.
 *
 * - Bounded: the values of unknown fields are kept to 32 levels deep and 8 MB in all, svg layers to 16 MB of markup
 *   between them, and notes to 200 different ones ("and N more"). `size` is the length of the design.json read (when
 *   known): what the repairs write back is added to it, and past 64 MB the design is refused ("This design is too
 *   large to open (over 64 MB once repaired).") so a file can never grow past what it can be read back from.
 *
 * Pure: the same input gives the same design.
 */
export function validateDesign(raw: unknown, notes?: string[], size = 0): Design {
  if (!isObj(raw) || raw.format !== 1) throw new Error('This design file is from a newer version of gauzzaDocs or is damaged')
  if (!Array.isArray(raw.artboards) || !raw.artboards.length) damaged('it has no artboards')
  const r = new Reader(size)
  reserve(r, raw)
  const rawComponents = raw.components === undefined ? [] : raw.components
  if (!Array.isArray(rawComponents)) damaged('its components are not a list')
  if (rawComponents.length > MAX_COMPONENTS) damaged(`it has more than ${MAX_COMPONENTS.toLocaleString('en-US')} components`)

  // components first: their ids are what instances refer to
  const components: Obj[] = []
  for (const c of rawComponents) {
    if (!isObj(c)) damaged('a component is not an object')
    const out = kept(c, 'component', r)
    out.id = r.id(c.id, r.componentIds)
    const scope = newScope()
    r.componentScopes.set(out.id as string, scope)
    const root = layer(r, c.root, 1, scope)
    if (!root || root.type !== 'group') damaged(`component ${out.id} has no group at its root`)
    out.root = root
    out.name = r.name(c.name, 'Component')
    components.push(out)
  }

  const pending: { board: Obj; raw: unknown; scope: Scope }[] = []
  const artboards = raw.artboards.map(a => artboard(r, a, pending))

  // references, now that every id is known
  for (const { board, raw: d, scope } of pending) {
    const list = diagrams(d, scope, r)
    if (list) board.diagrams = list
    else delete board.diagrams
  }
  for (const { end, scope } of r.ends) {
    const ref = end.layer as string
    end.layer = follow(scope, ref) ?? (ID.test(ref) ? ref : '')
  }
  for (const { layer: inst, raw: given } of r.instances) {
    const ref = inst.component as string
    inst.component = follow(r.componentIds, ref) ?? (ID.test(ref) ? ref : '')
    const scope = r.componentScopes.get(inst.component as string)
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
      const out = kept(o, 'override', r)
      if (out.text !== undefined) {
        if (typeof out.text !== 'string') {
          r.note('override text that was not text (dropped)')
          delete out.text
        } else {
          if (out.text.length > MAX_LAYER_TEXT) damaged(`an override holds more than ${MAX_LAYER_TEXT.toLocaleString('en-US')} characters`)
          if ((r.text += out.text.length) > MAX_DESIGN_TEXT) damaged(`it holds more than ${MAX_DESIGN_TEXT.toLocaleString('en-US')} characters of text`)
        }
      }
      optPaint(out, 'fill', r, false)
      optPaint(out, 'stroke', r, false)
      r.optBool(out, 'visible')
      if (out.asset !== undefined && typeof out.asset !== 'string') {
        r.note('an override image that was not text (dropped)')
        delete out.asset
      }
      overrides[inner] = out as Override
    }
    inst.overrides = overrides
  }

  const design = kept(raw, 'design', r)
  design.format = 1
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) {
    r.note('a design id that was not valid (replaced)')
    design.id = 'design'
  }
  design.artboards = artboards
  design.components = components
  design.styles = styles(raw.styles, r)
  if (design.kit !== undefined) {
    const k = design.kit
    // its items are a later release's data, kept like any unknown field (so within the same bounds); a kit whose items
    // can't be kept is dropped whole
    const out = isObj(k) && typeof k.kitId === 'string' && Array.isArray(k.items) && k.items.every(isObj) ? kept(k, 'kit', r) : null
    if (out && Array.isArray(out.items)) design.kit = out
    else if (out) delete design.kit
    else {
      r.note('a brand kit link that was not well formed (dropped)')
      delete design.kit
    }
  }
  if (design.thumbnailStale !== undefined) r.optBool(design, 'thumbnailStale')
  if (notes) {
    for (const [s, n] of r.notes) notes.push(n > 1 ? `${s} (${n} times)` : s)
    if (r.moreNotes) notes.push(`and ${r.moreNotes.toLocaleString('en-US')} more`)
  }
  // every object above was checked field by field against the schema; this is where the result meets its type
  return design as unknown as Design
}
