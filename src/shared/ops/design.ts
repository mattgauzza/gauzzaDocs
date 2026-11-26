import { type Box, boxOf, centerOf, fin } from '../design/geometry'
import { MAX_ARTBOARD_SIDE, PRESETS, artboardOf, newId, walk } from '../design/model'
import { parsePath, pathBounds } from '../design/path'
import { designToSvg } from '../design/render'
import { cleanSvg } from '../design/svgClean'
import { importSvg, layerAsSvg } from '../design/svgImport'
import { cleanText, num as fmt, textReport } from '../design/text'
import type { Artboard, BlendMode, Component, Design, DesignFile, Layer, Override, Paint, TextRun } from '../design/types'
import type { AgentOp } from '../types'
import {
  DEFAULT_FONT, type DesignDoc, type GroupLayer, MAX_SIZE, boundsOf, boundsOfLayers, componentOf, contains, coord, endOf, fontOf,
  hexColor, hits, layerOn, list, locate, nameOf, nextName, number, oneOf, overrideOf, paintOf, propsOf, refit, shift, writeProps
} from './designLayers'
import { OpError, type OpHandler, type OpServices, str } from './types'

/**
 * Ops on designs (.gdesign). Every op takes `artboard` (an id or name; the first artboard by default). Layers are named
 * by `layer`: an id, a name that is unique on the artboard, or a Group/Child path.
 *   read { format? }                           -> { artboard, artboards, layers, styles, components }: one line per layer,
 *                                                 `id  name  type  x,y wxh  "text"  flags`, indented by depth
 *   read { format: "text", allArtboards? }      -> { content }: the same as plain lines (every artboard's with allArtboards)
 *   add { type, props?, parent?, index? }       -> { ids }
 *   set { layer, props, part?, allArtboards? }  -> { ids }   (`part` writes an instance's override for that inner layer)
 *   delete { layer, allArtboards? }             -> { ids }
 *   move { layer, to: front|back|forward|backward|{ parent, index? }, allArtboards? } -> { ids }
 *   group { layers, name? } -> { id }           ungroup { layer } -> { ids }
 *   align { layers, edge, to?: selection|artboard } -> { ids }      distribute { layers, axis: x|y } -> { ids }
 *   duplicate { layer, dx?, dy? }               -> { ids }
 *   artboard { action: add|resize|rename|delete, name?, size? } -> { id }
 *   style { color?: { name, color } | "Name=#hex", text?: { name, run }, remove?: name } -> { colors, text }
 *   svg { svg, name?, parent?, index?, x?, y? } -> { id, removed, kept }      svg { get: layer | true } -> { svg }
 *   apply { ops }                               -> { results }
 * Every op runs on a copy, so a failure changes nothing; `apply` runs its ops in order on one copy and stops at the
 * first failure with "op <n>: <message>". `summary` says what changed in a few plain words, for the undo step.
 * Pure apart from `services`: the design editor applies these live and core/ops to files on disk.
 */
export async function applyDesignOp(
  file: DesignFile, op: AgentOp, services: OpServices = {}
): Promise<{ result: unknown; file?: DesignFile; summary: string }> {
  const draft: Draft = {
    design: structuredClone(file.design),
    assets: { ...file.assets },
    taken: takenIds(file.design),
    changes: [],
    services
  }
  const result = await runOp(draft, op)
  const summary = describe(draft.changes)
  if (!draft.changes.length) return { result, summary }
  return { result, file: { ...file, design: draft.design, assets: draft.assets }, summary }
}

export const designOps: OpHandler = async (payload, op, ctx) => {
  if (payload.kind !== 'design') throw new OpError('not a design')
  const r = await applyDesignOp(payload.file, op, ctx.services ?? {})
  return { result: r.result, summary: r.summary, payload: r.file ? { ...payload, file: r.file } : undefined }
}

// ---------- the working copy and what changed ----------

interface Draft extends DesignDoc {
  /** every id in the design, so new ones never repeat one (ids deleted in the same batch stay taken) */
  taken: Set<string>
  changes: Change[]
}
/** One thing an op did: a verb and the layers it did it to ("set" with what: "fill"), or a whole phrase. */
interface Change { verb: string; names: string[]; what?: string }

type InstanceLayer = Layer & { type: 'instance' }

const OPS = ['read', 'add', 'set', 'delete', 'move', 'group', 'ungroup', 'align', 'distribute', 'duplicate', 'artboard', 'style', 'svg', 'apply']

async function runOp(d: Draft, op: AgentOp): Promise<unknown> {
  switch (op.op) {
    case 'read':
      return readOp(d, op)
    case 'add':
      return addOp(d, op)
    case 'set':
      return setOp(d, op)
    case 'delete':
      return deleteOp(d, op)
    case 'move':
      return moveOp(d, op)
    case 'group':
      return groupOp(d, op)
    case 'ungroup':
      return ungroupOp(d, op)
    case 'align':
      return alignOp(d, op)
    case 'distribute':
      return distributeOp(d, op)
    case 'duplicate':
      return duplicateOp(d, op)
    case 'artboard':
      return artboardOp(d, op)
    case 'style':
      return styleOp(d, op)
    case 'svg':
      return svgOp(d, op)
    case 'apply':
      return applyOp(d, op)
    default:
      throw new OpError(`Unknown op "${op.op}" for designs. Try: ${OPS.join(', ')}`)
  }
}

/** strokeWidth as "stroke width". */
const words = (key: string): string => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

/** A name as a summary shows it: at most 40 characters, on one line. */
const named = (name: string): string => {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 40 ? s.slice(0, 37) + '...' : s
}

/** The changes as one plain past-tense phrase: "added 3 layers", "set fill on Logo and moved Title". */
function describe(changes: Change[]): string {
  const merged: Change[] = []
  for (const c of changes) {
    const same = merged.find(m => m.verb === c.verb && m.what === c.what && m.names.length && c.names.length)
    if (same) for (const n of c.names) same.names.push(n)
    else merged.push({ ...c, names: [...c.names] })
  }
  const phrases = merged.map(c => {
    if (!c.names.length) return c.verb
    const subject = c.names.length === 1 ? named(c.names[0]) : `${c.names.length} layers`
    return c.what ? `${c.verb} ${c.what} on ${subject}` : `${c.verb} ${subject}`
  })
  const parts = [...new Set(phrases)]
  if (!parts.length) return 'no changes'
  if (parts.length > 4) return `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more changes`
  return list(parts)
}

function takenIds(design: Design): Set<string> {
  const ids = new Set<string>()
  for (const a of design.artboards) {
    ids.add(a.id)
    walk(a.layers, l => ids.add(l.id))
  }
  for (const c of design.components ?? []) {
    ids.add(c.id)
    if (c.root) walk([c.root], l => ids.add(l.id))
  }
  return ids
}

const boardOf = (d: Draft, op: AgentOp): Artboard => {
  const ref = op.artboard
  return artboardOf(d.design, ref === undefined || ref === null || ref === '' ? undefined : String(ref))
}

/** The layers an op targets with `layer`: one on the op's artboard, or with allArtboards one per artboard that has it. */
function targets(d: Draft, op: AgentOp): { board: Artboard; layer: Layer }[] {
  if (op.allArtboards !== true) {
    const board = boardOf(d, op)
    return [{ board, layer: layerOn(board, op.layer) }]
  }
  const ref = op.layer
  if (typeof ref !== 'string' || !ref) throw new OpError('Name a layer by its id, name or Group/Child path')
  const out: { board: Artboard; layer: Layer }[] = []
  for (const board of d.design.artboards) if (hits(board, ref).length) out.push({ board, layer: layerOn(board, ref) })
  if (!out.length) throw new OpError(`No layer "${ref}" on any artboard`)
  return out
}

/** The layers `layers` names on the op's artboard (a list, or names separated by commas), each once, back to front. */
function selection(d: Draft, op: AgentOp): { board: Artboard; layers: Layer[] } {
  const board = boardOf(d, op)
  const v = op.layers
  const refs = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []
  if (!refs.length) throw new OpError(`"${op.op}" needs layers (a list of layers)`)
  const chosen = new Set(refs.map(r => layerOn(board, r)))
  const layers: Layer[] = []
  walk(board.layers, l => {
    if (chosen.has(l)) layers.push(l)
  })
  return { board, layers }
}

/** Puts a layer into `parent` (a group, or the artboard) at `index` (0 is the back; the front by default). */
function insert(board: Artboard, layer: Layer, parentRef: unknown, index: unknown): void {
  let into = board.layers
  if (parentRef !== undefined && parentRef !== null && parentRef !== '') {
    const p = layerOn(board, parentRef)
    if (p.type !== 'group') throw new OpError(`"${p.name}" isn't a group`)
    into = p.children
  }
  const at = index === undefined || index === null || index === '' ? into.length : Math.round(number('index', index, 0))
  into.splice(Math.min(at, into.length), 0, layer)
}

// ---------- the ops ----------

function readOp(d: Draft, op: AgentOp): unknown {
  const board = boardOf(d, op)
  const linesOf = (b: Artboard): string[] => {
    const out: string[] = []
    walk(b.layers, (l, _p, path) => out.push('  '.repeat(path.length - 1) + layerLine(d, l)))
    return out
  }
  const styles = { colors: d.design.styles?.colors ?? [], text: d.design.styles?.text ?? [] }
  const components = (d.design.components ?? []).map(c => ({ id: c.id, name: c.name }))
  const artboards = d.design.artboards.map(a => ({ id: a.id, name: a.name, width: a.width, height: a.height }))
  if (str(op, 'format') !== 'text') {
    return { artboard: { id: board.id, name: board.name }, artboards, layers: linesOf(board), styles, components }
  }
  const out: string[] = ['Artboards:', ...artboards.map(a => `  ${a.id}  ${a.name}  ${fmt(a.width)}x${fmt(a.height)}`)]
  for (const b of op.allArtboards === true ? d.design.artboards : [board]) {
    const lines = linesOf(b)
    out.push(`Layers on ${b.name}:`, ...(lines.length ? lines.map(x => '  ' + x) : ['  (none)']))
  }
  if (styles.colors.length) out.push('Color styles:', ...styles.colors.map(c => `  ${c.name}  ${c.color}`))
  if (styles.text.length) {
    out.push('Text styles:', ...styles.text.map(s => `  ${s.name}  ${s.run.font.family} ${s.run.font.weight}${s.run.font.style === 'italic' ? ' italic' : ''} ${fmt(s.run.size)}`))
  }
  if (components.length) out.push('Components:', ...components.map(c => `  ${c.id}  ${c.name}`))
  return { content: out.join('\n') }
}

/**
 * `id  name  type  x,y wxh`, then where they apply the text in quotes, the component, the timing in seconds and flags
 * (missing font, overflow, hidden, locked).
 */
function layerLine(d: Draft, l: Layer): string {
  const one = (s: string) => cleanText(String(s ?? '')).replace(/\s*[\r\n]+\s*/g, ' ')
  let line = `${l.id}  ${one(l.name)}  ${l.type}  ${fmt(fin(l.x, 0))},${fmt(fin(l.y, 0))} ${fmt(fin(l.width, 0))}x${fmt(fin(l.height, 0))}`
  const flags: string[] = []
  if (l.type === 'text') {
    const all = one(l.runs.map(r => r.text).join(''))
    line += `  "${all.length > 60 ? all.slice(0, 57) + '...' : all}"`
    const fonts = d.services.fonts
    if (fonts) {
      const report = textReport(l, fonts)
      if (report.missingFont) flags.push('missing font')
      if (report.overflow) flags.push('overflow')
    } else if (l.missingFont) flags.push('missing font')
  }
  if (l.type === 'instance') line += `  of ${one((d.design.components ?? []).find(c => c.id === l.component)?.name ?? l.component)}`
  if (l.type === 'group' && l.clip) flags.push('clips to its first layer')
  if (l.timing && (l.timing.start !== undefined || l.timing.end !== undefined)) {
    line += `  ${fmt(fin(l.timing.start, 0))}s to ${l.timing.end === undefined ? 'end' : `${fmt(fin(l.timing.end, 0))}s`}`
  }
  if (!l.visible) flags.push('hidden')
  if (l.locked) flags.push('locked')
  return flags.length ? `${line}  ${flags.join(', ')}` : line
}

const TYPES = ['rect', 'ellipse', 'line', 'path', 'text', 'image', 'group', 'instance', 'connector'] as const
const TYPE_NAMES: Record<string, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', path: 'Path', text: 'Text', image: 'Image', group: 'Group', connector: 'Connector'
}

function addOp(d: Draft, op: AgentOp): unknown {
  const board = boardOf(d, op)
  const type = op.type
  if (type === 'svg') throw new OpError('Add SVG with the svg op, which cleans it first')
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) throw new OpError(`type must be one of ${list([...TYPES]).replace(/ and /, ' or ')}`)
  const props = propsOf(op, type)
  const base = {
    id: newId(d.taken), name: '', visible: true, locked: false, opacity: 1, blend: 'normal' as BlendMode, x: 0, y: 0, width: 100,
    height: 100, rotation: 0, scaleX: 1, scaleY: 1
  }
  const grey: Paint = { type: 'color', color: '#d9d9d9' }
  const black: Paint = { type: 'color', color: '#000000' }
  let layer: Layer
  let name = TYPE_NAMES[type]
  switch (type as (typeof TYPES)[number]) {
    case 'rect':
    case 'ellipse':
      layer = { ...base, type: type as 'rect' | 'ellipse', fill: grey }
      break
    case 'line':
      layer = { ...base, type: 'line', height: 0, fill: null, stroke: black, strokeWidth: 1 }
      break
    case 'path': {
      if (typeof props.d !== 'string' || !props.d.trim()) throw new OpError('A path needs d (SVG path data in its box)')
      const pb = pathBox(props.d)
      layer = { ...base, type: 'path', d: props.d.trim(), width: pb.w, height: pb.h, fill: black }
      break
    }
    case 'text':
      if (props.text === undefined && props.runs === undefined) throw new OpError('A text layer needs text')
      // box text when a width is given, point text (sized to its lines) otherwise
      layer = {
        ...base, type: 'text', mode: props.width !== undefined ? 'box' : 'point', align: 'left', valign: 'top',
        runs: [{ text: '', font: DEFAULT_FONT, size: 24 }]
      }
      break
    case 'image':
      if (props.data === undefined && props.asset === undefined) throw new OpError('An image needs data (a data URL or base64) or asset')
      layer = { ...base, type: 'image', asset: '', fit: 'fill' }
      break
    case 'group':
      layer = { ...base, type: 'group', width: 0, height: 0, children: [] }
      break
    case 'instance': {
      if (props.component === undefined) throw new OpError('An instance needs component (its id or name)')
      const c = componentOf(d, props.component)
      const r = c.root ? boxOf(c.root) : { x: 0, y: 0, w: 100, h: 100 }
      layer = { ...base, type: 'instance', component: c.id, overrides: {}, width: r.w, height: r.h }
      name = c.name
      break
    }
    case 'connector': {
      if (props.from === undefined || props.to === undefined) throw new OpError('A connector needs from and to (the layers it joins)')
      const from = endOf(board, 'from', props.from)
      const to = endOf(board, 'to', props.to)
      const [a, b] = [from, to].map(e => centerOf(boxOf(layerOn(board, e.layer))))
      layer = {
        ...base, type: 'connector', from, to, route: 'straight', arrow: 'end', fill: null, stroke: black, strokeWidth: 2,
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1])
      }
      break
    }
  }
  layer!.name = nextName(board, name)
  writeProps(d, board, layer!, props)
  insert(board, layer!, op.parent, op.index)
  refit(board, new Set([layer!.id]))
  d.changes.push({ verb: 'added', names: [layer!.name] })
  return { ids: [layer!.id] }
}

/** A path's box in its own coordinates: from 0,0 to the far edge of what it draws. */
function pathBox(dpath: string): Box {
  const segs = parsePath(dpath)
  if (!segs.length) throw new OpError('d must be SVG path data')
  const b = pathBounds(segs)
  return { x: 0, y: 0, w: b ? Math.max(0, b.x + b.w) : 0, h: b ? Math.max(0, b.y + b.h) : 0 }
}

function setOp(d: Draft, op: AgentOp): unknown {
  const found = targets(d, op)
  let what: string[] = []
  const notes: string[] = []
  for (const { board, layer } of found) {
    if (op.part !== undefined) what = setPart(d, layer, op)
    else {
      const props = propsOf(op, layer.type)
      if (!Object.keys(props).length) throw new OpError('"set" needs props (what to change)')
      what = writeProps(d, board, layer, props, notes)
      refit(board, new Set([layer.id]))
    }
  }
  d.changes.push({ verb: 'set', names: found.map(f => f.layer.name), what: what.length > 3 ? `${what.length} properties` : list(what.map(words)) })
  const ids = found.map(f => f.layer.id)
  return notes.length ? { ids, note: [...new Set(notes)].join(' ') } : { ids }
}

/** Writes an instance's override for one of its component's layers. */
function setPart(d: Draft, layer: Layer, op: AgentOp): string[] {
  if (layer.type !== 'instance') throw new OpError(`"${layer.name}" isn't an instance, so it has no parts`)
  const inner = partOf(componentOf(d, layer.component), op.part)
  const raw = op.props
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) throw new OpError('"set" needs props (what to change)')
  const props = raw as Record<string, unknown>
  const o: Override = overrideOf(d, props, layer.overrides?.[inner.id])
  ;(layer as InstanceLayer).overrides = { ...(layer.overrides ?? {}), [inner.id]: o }
  return [...new Set(Object.keys(props).map(k => (k === 'data' || k === 'asset' ? 'image' : k)))]
}

/** A layer inside a component, by id, name or path, for an override. */
function partOf(comp: Component, ref: unknown): Layer {
  if (typeof ref !== 'string' || !ref) throw new OpError('part must name a layer inside the component')
  const found = comp.root ? hits({ id: '', name: comp.name, width: 0, height: 0, background: null, layers: [comp.root] }, ref) : []
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new OpError(`${found.length} layers are named "${ref}" in ${comp.name}: ${found.map(l => l.id).join(', ')}`)
  throw new OpError(`No layer "${ref}" in ${comp.name}`)
}

function deleteOp(d: Draft, op: AgentOp): unknown {
  const found = targets(d, op)
  const ids: string[] = []
  for (const { board, layer } of found) {
    const at = locate(board, layer.id)
    at.list.splice(at.index, 1)
    const gone = new Set<string>()
    walk([layer], l => gone.add(l.id))
    // connectors left joining nothing go too
    const drop = (ls: Layer[]) => {
      for (let i = ls.length - 1; i >= 0; i--) {
        const l = ls[i]
        if (l.type === 'connector' && (gone.has(l.from?.layer) || gone.has(l.to?.layer))) {
          gone.add(l.id)
          ls.splice(i, 1)
        } else if (l.type === 'group') drop(l.children)
      }
    }
    drop(board.layers)
    ids.push(...gone)
    if (at.parent) refit(board, new Set([at.parent.id]))
  }
  d.changes.push({ verb: 'deleted', names: found.map(f => f.layer.name) })
  return { ids }
}

function moveOp(d: Draft, op: AgentOp): unknown {
  const found = targets(d, op)
  const to = op.to
  for (const { board, layer } of found) {
    const at = locate(board, layer.id)
    if (to === 'front' || to === 'back' || to === 'forward' || to === 'backward') {
      at.list.splice(at.index, 1)
      const i = to === 'front' ? at.list.length : to === 'back' ? 0 : to === 'forward' ? Math.min(at.index + 1, at.list.length) : Math.max(at.index - 1, 0)
      at.list.splice(i, 0, layer)
      continue
    }
    if (!to || typeof to !== 'object' || Array.isArray(to)) throw new OpError('to must be front, back, forward, backward or { parent, index }')
    const dest = to as Record<string, unknown>
    if (dest.parent !== undefined && dest.parent !== null && dest.parent !== '') {
      const p = layerOn(board, dest.parent)
      if (p.type !== 'group') throw new OpError(`"${p.name}" isn't a group`)
      if (contains(layer, p.id)) throw new OpError("A group can't go inside itself")
    }
    at.list.splice(at.index, 1)
    insert(board, layer, dest.parent, dest.index)
    refit(board, new Set([layer.id, ...(at.parent ? [at.parent.id] : [])]))
  }
  d.changes.push({ verb: 'moved', names: found.map(f => f.layer.name) })
  return { ids: found.map(f => f.layer.id) }
}

function groupOp(d: Draft, op: AgentOp): unknown {
  const { board, layers } = selection(d, op)
  const places = layers.map(l => locate(board, l.id))
  if (places.some(p => p.list !== places[0].list)) {
    throw new OpError('Layers to group must sit in the same group (or all at the top). Move them together first.')
  }
  const siblings = places[0].list
  // the group takes the place of the frontmost layer it holds
  const at = Math.max(...places.map(p => p.index)) - (layers.length - 1)
  for (const p of [...places].sort((a, b) => b.index - a.index)) siblings.splice(p.index, 1)
  const b = boundsOfLayers(layers)
  const group: GroupLayer = {
    id: newId(d.taken), name: op.name === undefined ? nextName(board, 'Group') : nameOf('name', op.name), type: 'group', visible: true,
    locked: false, opacity: 1, blend: 'normal', x: b.x, y: b.y, width: b.w, height: b.h, rotation: 0, scaleX: 1, scaleY: 1, children: layers
  }
  siblings.splice(at, 0, group)
  if (places[0].parent) refit(board, new Set([places[0].parent.id]))
  d.changes.push({ verb: 'grouped', names: layers.map(l => l.name) })
  return { id: group.id }
}

function ungroupOp(d: Draft, op: AgentOp): unknown {
  const board = boardOf(d, op)
  const g = layerOn(board, op.layer)
  if (g.type !== 'group') throw new OpError(`"${g.name}" isn't a group`)
  // the group goes, so a connector joining it would join nothing
  const attached: string[] = []
  walk(board.layers, l => {
    if (l.type === 'connector' && (l.from?.layer === g.id || l.to?.layer === g.id)) attached.push(l.id)
  })
  if (attached.length) throw new OpError(`Connectors are attached to ${g.name}: ${attached.join(', ')}. Detach or delete them first.`)
  const at = locate(board, g.id)
  const kids = g.children
  // what the group did to its children, carried onto them: rotation and scale about its center, opacity, hiding
  const [cx, cy] = centerOf(boxOf(g))
  const r = fin(g.rotation, 0)
  const sx = fin(g.scaleX, 1)
  const sy = fin(g.scaleY, 1)
  const a = (r * Math.PI) / 180
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6 // so a half turn doesn't leave 1e-15 behind
  for (const k of kids) {
    if (r || sx !== 1 || sy !== 1) {
      const [kx, ky] = centerOf(boxOf(k))
      const px = (kx - cx) * sx
      const py = (ky - cy) * sy
      shift(k, r6(cx + px * Math.cos(a) - py * Math.sin(a)) - kx, r6(cy + px * Math.sin(a) + py * Math.cos(a)) - ky)
      k.rotation = fin(k.rotation, 0) + r
      k.scaleX = fin(k.scaleX, 1) * sx
      k.scaleY = fin(k.scaleY, 1) * sy
    }
    k.opacity = fin(k.opacity, 1) * Math.min(1, Math.max(0, fin(g.opacity, 1)))
    if (!g.visible) k.visible = false
  }
  const dropped: string[] = []
  if (g.clip && kids.length > 1) dropped.push('clipping')
  if (g.shadow) dropped.push('shadow')
  if (fin(g.blur, 0)) dropped.push('blur')
  if (g.blend && g.blend !== 'normal') dropped.push('blend mode')
  if (g.timing) dropped.push('timing')
  at.list.splice(at.index, 1, ...kids)
  if (at.parent) refit(board, new Set([at.parent.id]))
  d.changes.push({ verb: 'ungrouped', names: [g.name] })
  const ids = kids.map(k => k.id)
  return dropped.length ? { ids, note: `Dropped the group's ${list(dropped)}, which applied to the group as a whole.` } : { ids }
}

function alignOp(d: Draft, op: AgentOp): unknown {
  const { board, layers } = selection(d, op)
  const edge = oneOf('edge', op.edge, ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const)
  const to = op.to === undefined ? (layers.length > 1 ? 'selection' : 'artboard') : oneOf('to', op.to, ['selection', 'artboard'] as const)
  const area: Box = to === 'artboard' ? { x: 0, y: 0, w: fin(board.width, 0), h: fin(board.height, 0) } : boundsOfLayers(layers)
  for (const l of layers) {
    const b = boundsOf(l)
    const dx = edge === 'left' ? area.x - b.x : edge === 'right' ? area.x + area.w - (b.x + b.w) : edge === 'center' ? area.x + area.w / 2 - (b.x + b.w / 2) : 0
    const dy = edge === 'top' ? area.y - b.y : edge === 'bottom' ? area.y + area.h - (b.y + b.h) : edge === 'middle' ? area.y + area.h / 2 - (b.y + b.h / 2) : 0
    shift(l, dx, dy)
  }
  refit(board, new Set(layers.map(l => l.id)))
  d.changes.push({ verb: 'aligned', names: layers.map(l => l.name) })
  return { ids: layers.map(l => l.id) }
}

function distributeOp(d: Draft, op: AgentOp): unknown {
  const { board, layers } = selection(d, op)
  if (layers.length < 3) throw new OpError('distribute needs at least 3 layers')
  const axis = oneOf('axis', op.axis, ['x', 'y'] as const)
  const start = (b: Box) => (axis === 'x' ? b.x : b.y)
  const size = (b: Box) => (axis === 'x' ? b.w : b.h)
  // the outer two stay where they are; the rest move so the gaps between neighbours are equal
  const items = layers.map(l => ({ l, b: boundsOf(l) })).sort((a, b) => start(a.b) - start(b.b))
  const first = items[0].b
  const last = items[items.length - 1].b
  const gap = (start(last) + size(last) - start(first) - items.reduce((a, i) => a + size(i.b), 0)) / (items.length - 1)
  let at = start(first)
  for (const { l, b } of items) {
    if (axis === 'x') shift(l, at - start(b), 0)
    else shift(l, 0, at - start(b))
    at += size(b) + gap
  }
  refit(board, new Set(layers.map(l => l.id)))
  d.changes.push({ verb: 'distributed', names: layers.map(l => l.name) })
  return { ids: layers.map(l => l.id) }
}

function duplicateOp(d: Draft, op: AgentOp): unknown {
  const board = boardOf(d, op)
  const src = layerOn(board, op.layer)
  const copy = structuredClone(src)
  // every layer in the copy gets a new id, and connectors inside it follow the copies of their ends
  const map = new Map<string, string>()
  walk([copy], l => {
    const id = newId(d.taken)
    map.set(l.id, id)
    l.id = id
  })
  walk([copy], l => {
    if (l.type !== 'connector') return
    if (l.from && map.has(l.from.layer)) l.from = { ...l.from, layer: map.get(l.from.layer)! }
    if (l.to && map.has(l.to.layer)) l.to = { ...l.to, layer: map.get(l.to.layer)! }
  })
  shift(copy, op.dx === undefined ? 0 : coord('dx', op.dx), op.dy === undefined ? 0 : coord('dy', op.dy))
  const at = locate(board, src.id)
  at.list.splice(at.index + 1, 0, copy)
  if (at.parent) refit(board, new Set([at.parent.id]))
  d.changes.push({ verb: 'duplicated', names: [src.name] })
  return { ids: [copy.id] }
}

/** A size from a preset name, "<w>x<h>" or { width, height }, at most 8192 px per side. */
function sizeOf(v: unknown): { width: number; height: number } {
  let width: number
  let height: number
  if (typeof v === 'string') {
    const key = v.trim().toLowerCase()
    const p = Object.prototype.hasOwnProperty.call(PRESETS, key) ? PRESETS[key] : undefined
    const m = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/.exec(key)
    if (p) ({ width, height } = p)
    else if (m) [width, height] = [Number(m[1]), Number(m[2])]
    else throw new OpError(`size must be <w>x<h> or one of ${Object.keys(PRESETS).join(', ')}`)
  } else if (v && typeof v === 'object') {
    const s = v as Record<string, unknown>
    width = number('width', s.width)
    height = number('height', s.height)
  } else throw new OpError('artboard needs size (<w>x<h> or a preset name)')
  if (!(width >= 1 && height >= 1)) throw new OpError('An artboard must be at least 1 px per side')
  if (width > MAX_ARTBOARD_SIDE || height > MAX_ARTBOARD_SIDE) throw new OpError(`Artboards can be at most ${MAX_ARTBOARD_SIDE} px per side.`)
  return { width, height }
}

function artboardOp(d: Draft, op: AgentOp): unknown {
  const action = oneOf('action', op.action, ['add', 'resize', 'rename', 'delete'] as const)
  const boards = d.design.artboards
  const fresh = (v: unknown): string => {
    const name = nameOf('name', v)
    if (boards.some(a => a.name === name)) throw new OpError(`There is already an artboard named "${name}"`)
    return name
  }
  if (action === 'add') {
    const first = boards[0]
    const size = op.size === undefined && first ? { width: first.width, height: first.height } : sizeOf(op.size)
    let n = boards.length + 1
    while (boards.some(a => a.name === `Artboard ${n}`)) n++
    const board: Artboard = {
      id: newId(d.taken), name: op.name === undefined ? `Artboard ${n}` : fresh(op.name), ...size, background: { type: 'color', color: '#ffffff' }, layers: []
    }
    boards.push(board)
    d.changes.push({ verb: `added artboard ${named(board.name)}`, names: [] })
    return { id: board.id }
  }
  const board = boardOf(d, op)
  if (action === 'resize') {
    const size = sizeOf(op.size)
    Object.assign(board, size)
    d.changes.push({ verb: `resized ${named(board.name)} to ${fmt(size.width)}x${fmt(size.height)}`, names: [] })
  } else if (action === 'rename') {
    const old = board.name
    board.name = fresh(op.name)
    d.changes.push({ verb: `renamed ${named(old)} to ${named(board.name)}`, names: [] })
  } else {
    if (boards.length === 1) throw new OpError('A design needs at least one artboard')
    boards.splice(boards.indexOf(board), 1)
    d.changes.push({ verb: `deleted artboard ${named(board.name)}`, names: [] })
  }
  return { id: board.id }
}

function styleOp(d: Draft, op: AgentOp): unknown {
  const styles = (d.design.styles ??= { colors: [], text: [] })
  styles.colors ??= []
  styles.text ??= []
  if (op.color === undefined && op.text === undefined && op.remove === undefined) throw new OpError('"style" needs color, text or remove')
  if (op.color !== undefined) {
    let name: string
    let value: unknown
    if (typeof op.color === 'string' && op.color.includes('=')) {
      const eq = op.color.indexOf('=')
      ;[name, value] = [nameOf('style name', op.color.slice(0, eq)), op.color.slice(eq + 1).trim()]
    } else if (op.color && typeof op.color === 'object') {
      const c = op.color as Record<string, unknown>
      ;[name, value] = [nameOf('style name', c.name), c.color]
    } else throw new OpError('color must be { name, color } or Name=#rrggbb')
    const color = hexColor(value)
    if (!color) throw new OpError('A color style needs a color like #rrggbb')
    const had = styles.colors.find(c => c.name === name)
    if (had) had.color = color
    else styles.colors.push({ name, color })
    d.changes.push({ verb: `${had ? 'changed' : 'added'} style ${named(name)}`, names: [] })
  }
  if (op.text !== undefined) {
    if (!op.text || typeof op.text !== 'object') throw new OpError('text must be { name, run: { font, size } }')
    const t = op.text as Record<string, unknown>
    const name = nameOf('style name', t.name)
    const r = (t.run ?? {}) as Record<string, unknown>
    const run: Omit<TextRun, 'text'> = { font: fontOf(r.font ?? DEFAULT_FONT.family), size: Math.min(MAX_SIZE, number('size', r.size ?? 24, 0.1)) }
    if (r.color !== undefined) {
      const p = paintOf(d, 'color', r.color)
      if (p) run.color = p
    }
    if (r.letterSpacing !== undefined) run.letterSpacing = number('letterSpacing', r.letterSpacing)
    if (r.lineHeight !== undefined) run.lineHeight = number('lineHeight', r.lineHeight, 0)
    const had = styles.text.find(s => s.name === name)
    if (had) had.run = run
    else styles.text.push({ name, run })
    d.changes.push({ verb: `${had ? 'changed' : 'added'} style ${named(name)}`, names: [] })
  }
  if (op.remove !== undefined) {
    const name = nameOf('style name', op.remove)
    if (!styles.colors.some(c => c.name === name) && !styles.text.some(s => s.name === name)) throw new OpError(`No style "${name}"`)
    const users = styleUsers(d.design, name)
    if (users.length) {
      const shown = users.length > 20 ? `${users.slice(0, 20).join(', ')} and ${users.length - 20} more` : users.join(', ')
      throw new OpError(`Layers use the style "${name}": ${shown}. Change their colors first.`)
    }
    styles.colors = styles.colors.filter(c => c.name !== name)
    styles.text = styles.text.filter(s => s.name !== name)
    d.changes.push({ verb: `removed style ${named(name)}`, names: [] })
  }
  return { colors: styles.colors.map(c => c.name), text: styles.text.map(s => s.name) }
}

/**
 * The ids of every layer that paints with the color style `name`: its fill or stroke, a text run's color, or an
 * instance's override of one, on any artboard or in a component.
 */
function styleUsers(design: Design, name: string): string[] {
  const uses = (p: unknown): boolean => !!p && typeof p === 'object' && (p as Paint).type === 'style' && (p as { ref?: unknown }).ref === name
  const out: string[] = []
  const roots = [...design.artboards.flatMap(a => a.layers), ...(design.components ?? []).flatMap(c => (c.root ? [c.root] : []))]
  walk(roots, l => {
    const overrides = l.type === 'instance' ? Object.values(l.overrides ?? {}) : []
    if (
      uses(l.fill) || uses(l.stroke) || (l.type === 'text' && (l.runs ?? []).some(r => uses(r?.color))) ||
      overrides.some(o => uses(o?.fill) || uses(o?.stroke))
    ) out.push(l.id)
  })
  return out
}

function svgOp(d: Draft, op: AgentOp): unknown {
  const board = boardOf(d, op)
  if (op.get !== undefined && op.get !== false) {
    const fonts = d.services.fonts
    if (!fonts) throw new OpError('Getting SVG needs fonts to measure text, and none were given')
    const opts = { fonts, assets: d.assets, mode: 'export' as const }
    if (op.get === true || op.get === '') return { svg: cleanSvg(designToSvg(d.design, board.id, opts)).svg }
    return { svg: layerAsSvg(d.design, layerOn(board, op.get), opts) }
  }
  if (typeof op.svg !== 'string' || !op.svg.trim()) throw new OpError('"svg" needs svg (the SVG text to import) or get (a layer)')
  const name = op.name === undefined ? nextName(board, 'SVG') : nameOf('name', op.name)
  const r = importSvg(op.svg, name, { fonts: d.services.fonts, taken: d.taken })
  Object.assign(d.assets, r.assets)
  const g = r.group
  shift(g, op.x === undefined ? 0 : coord('x', op.x) - g.x, op.y === undefined ? 0 : coord('y', op.y) - g.y)
  insert(board, g, op.parent, op.index)
  refit(board, new Set([g.id]))
  d.changes.push({ verb: `imported SVG as ${named(name)}`, names: [] })
  return { id: g.id, removed: r.removed, kept: r.kept }
}

/** Most ops one apply batch may hold. */
export const MAX_BATCH = 1000

async function applyOp(d: Draft, op: AgentOp): Promise<unknown> {
  if (!Array.isArray(op.ops)) throw new OpError('apply needs ops (a list of ops)')
  if (op.ops.length > MAX_BATCH) throw new OpError(`apply takes at most ${MAX_BATCH.toLocaleString('en-US')} ops at once; send the rest in another batch`)
  const results: unknown[] = []
  for (let i = 0; i < op.ops.length; i++) {
    const sub = op.ops[i] as AgentOp
    try {
      if (!sub || typeof sub !== 'object' || Array.isArray(sub) || typeof sub.op !== 'string') throw new OpError('each op needs an op name')
      if (sub.op === 'apply') throw new OpError("apply can't hold another apply")
      // the batch's artboard is each op's default
      results.push(await runOp(d, op.artboard !== undefined && sub.artboard === undefined ? { ...sub, artboard: op.artboard } : sub))
    } catch (e) {
      throw new OpError(`op ${i + 1}: ${(e as Error).message}`)
    }
  }
  return { results }
}
