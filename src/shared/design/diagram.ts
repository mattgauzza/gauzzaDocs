import type { FontSource } from './fonts'
import { type Box, boxOf, centerOf, fin, layerIndex, transformedBounds, union } from './geometry'
import { newId, walk } from './model'
import { cleanText, layoutText } from './text'
import type { Artboard, Component, Design, Diagram, ElkGraph, Layer, Paint, TextLayer, TextRun } from './types'
import { MAX_NAME, TOO_LONG } from './validate'

// Diagrams that lay themselves out. A spec names nodes, the boxes that hold them (containers) and the links between
// them. Nodes are drawn as instances of a "Diagram node" component (a rounded rect and its centered label), boxes as
// groups with a labeled frame, and links as connectors. ELK places everything (core/design/layout.ts, in node only)
// and applyLayout writes the result onto the artboard, which keeps a record of each diagram (Artboard.diagrams)
// mapping the spec's ids to layer ids. Running the same spec again updates the layers it made, by spec id.

export type Direction = 'right' | 'down' | 'left' | 'up'
export interface DiagramSpec {
  name: string
  direction?: Direction
  /** room between nodes, in px (40 by default); the flow's steps are 1.5 times as far apart */
  spacing?: number
  nodes: { id: string; label: string; in?: string; icon?: string }[]
  links: { from: string; to: string; label?: string }[]
  containers?: { id: string; label: string; in?: string }[]
}
export interface Size { width: number; height: number }
/** What the layout needs measured: each node's box, each box's label and each link's label, and the pinned nodes. */
export interface DiagramSizes {
  /** by spec id */
  nodes: Record<string, Size>
  /** each box's label, by spec id: the box leaves room for it above what it holds */
  containers?: Record<string, Size>
  /** each link's label, in spec order */
  links?: (Size | undefined)[]
  /** where pinned nodes are, from the diagram's top left, by spec id */
  pinned?: Record<string, { x: number; y: number }>
}

/** Most nodes and boxes, and most links, one diagram may have. */
export const MAX_DIAGRAM_ITEMS = 1000
export const MAX_DIAGRAM_LINKS = 2000
export const DEFAULT_SPACING = 40
const DIRECTIONS: readonly Direction[] = ['right', 'down', 'left', 'up']
const BAD_DIRECTION = 'direction must be right, down, left or up'

// How a diagram looks: nodes at least 120x48 with 16 px around their label; boxes with 16 px inside their frame and
// their label at the top left; a new diagram centered on the artboard when it fits.
const NODE_PAD = 16
const NODE_MIN: Size = { width: 120, height: 48 }
const BOX_PAD = 16
const LABEL_TOP = 12
const LABEL_GAP = 12
const LINK_LABEL_SIZE = 14
const color = (c: string): Paint => ({ type: 'color', color: c })
const FONT = { family: 'Arial', weight: 400, style: 'normal' as const }
const BOX_FONT = { ...FONT, weight: 700 }

type GroupLayer = Layer & { type: 'group' }
type InstanceLayer = Layer & { type: 'instance' }
type ConnectorLayer = Layer & { type: 'connector' }
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
/** A label on one line, for a layer's name. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const count = (n: number): string => n.toLocaleString('en-US')

const basics = (id: string, name: string, b: Box) => ({
  id, name, visible: true, locked: false, opacity: 1, blend: 'normal' as const, x: b.x, y: b.y, width: b.w, height: b.h,
  rotation: 0, scaleX: 1, scaleY: 1
})

// ---------- the spec ----------

const ID = /^[^\s:]+$/
const EXPECTED = 'expected "node <id>: <label>", "box <id>: <label>" or "<from> -> <to>"'

/**
 * A spec from text, one item per line: `node <id>: <label> [in <box>]`, `box <id>: <label> [in <box>]` and
 * `<from> -> <to> [: <label>]`, plus `diagram <name>` and `direction <right|down|left|up>`. Ids have no spaces or
 * colons; a label left out is the id. "in <box>" at the end of a line places the item only when <box> is a box the
 * text declares, so "Check in time" stays a label. Blank lines and lines starting with # or // are skipped. Nothing
 * is checked against anything else here (checkSpec does that); a line that isn't one of these fails with its number.
 */
export function parseDiagramText(text: string): DiagramSpec {
  const spec: DiagramSpec = { name: '', nodes: [], links: [], containers: [] }
  const lines = String(text).split(/\r\n|\r|\n/)
  const boxes = new Set<string>()
  for (const line of lines) {
    const m = /^\s*box\s+([^\s:]+)/i.exec(line)
    if (m) boxes.add(m[1])
  }
  lines.forEach((raw, i) => {
    const line = raw.trim()
    const at = `line ${i + 1}`
    if (!line || line.startsWith('#') || line.startsWith('//')) return
    if (/^\S+\s*->/.test(line)) {
      const parts = line.split('->')
      if (parts.length > 2) throw new Error(`${at}: one link per line: <from> -> <to> [: <label>]`)
      const from = parts[0].trim()
      let to = parts[1].trim()
      let label: string | undefined
      const colon = to.indexOf(':')
      if (colon >= 0) {
        label = to.slice(colon + 1).trim()
        to = to.slice(0, colon).trim()
      }
      if (!ID.test(from) || !ID.test(to)) throw new Error(`${at}: ${EXPECTED}`)
      spec.links.push(label ? { from, to, label } : { from, to })
      return
    }
    let m = /^diagram\s+(.+)$/i.exec(line)
    if (m) {
      spec.name = m[1].trim()
      return
    }
    m = /^direction\s+(\S+)$/i.exec(line)
    if (m) {
      const d = m[1].toLowerCase() as Direction
      if (!DIRECTIONS.includes(d)) throw new Error(`${at}: ${BAD_DIRECTION}`)
      spec.direction = d
      return
    }
    m = /^(node|box)\s+([^\s:]+)\s*(.*)$/i.exec(line)
    if (!m) throw new Error(`${at}: ${EXPECTED}`)
    const [, kind, id, rest] = m
    let label = rest
    if (rest.startsWith(':')) label = rest.slice(1).trim()
    else if (rest && !/^in\s+\S+$/i.test(rest)) throw new Error(`${at}: ${EXPECTED}`)
    let inside: string | undefined
    const tail = /^(?:(.*?)\s+)?in\s+(\S+)$/i.exec(label)
    if (tail && boxes.has(tail[2])) {
      inside = tail[2]
      label = (tail[1] ?? '').trim()
    }
    const item = { id, label: label || id, ...(inside ? { in: inside } : {}) }
    if (kind.toLowerCase() === 'box') spec.containers!.push(item)
    else spec.nodes.push(item)
  })
  return spec
}

/** A label: text on its own, cleaned, at most 1,000 characters; the id when it's left out. */
function labelOf(v: unknown, id: string, what: string): string {
  if (v === undefined || v === null) return id
  if (typeof v !== 'string') throw new Error(`${what} label must be text`)
  const label = cleanText(v).replace(/\r\n?/g, '\n').trim()
  if (label.length > MAX_NAME) throw new Error(TOO_LONG.label)
  return label || id
}

/**
 * A spec checked and made plain: `v` is a spec (or its JSON), named `name` when that's given. Every id is text, held
 * once among nodes and boxes; every `in` names a box, and no box is inside itself; every link joins two nodes; labels
 * and names fit 1,000 characters; at most 1,000 nodes and boxes and 2,000 links. Throws a plain message otherwise.
 */
export function checkSpec(v: unknown, name?: unknown): DiagramSpec {
  let raw = v
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (e) {
      throw new Error(`spec must be JSON: ${(e as Error).message}`)
    }
  }
  if (!isObj(raw)) throw new Error('spec must be { name, nodes, links, containers? }')
  const given = name !== undefined && name !== null && name !== '' ? name : raw.name
  const title = typeof given === 'string' ? oneLine(cleanText(given)) : ''
  if (!title) throw new Error('diagram needs a name')
  if (title.length > MAX_NAME) throw new Error(TOO_LONG.name)
  const spec: DiagramSpec = { name: title, nodes: [], links: [], containers: [] }
  if (raw.direction !== undefined) {
    if (!DIRECTIONS.includes(raw.direction as Direction)) throw new Error(BAD_DIRECTION)
    spec.direction = raw.direction as Direction
  }
  if (raw.spacing !== undefined) {
    const s = typeof raw.spacing === 'string' && raw.spacing.trim() ? Number(raw.spacing) : raw.spacing
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1000) throw new Error('spacing must be a number from 0 to 1,000')
    spec.spacing = s
  }
  for (const [key, shape] of [['nodes', '{ id, label, in? }'], ['links', '{ from, to, label? }'], ['containers', '{ id, label, in? }']]) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`${key} must be a list of ${shape}`)
  }
  const nodes = list(raw.nodes)
  const boxes = list(raw.containers)
  const links = list(raw.links)
  if (nodes.length + boxes.length > MAX_DIAGRAM_ITEMS) throw new Error(`A diagram can have at most ${count(MAX_DIAGRAM_ITEMS)} nodes and boxes.`)
  if (links.length > MAX_DIAGRAM_LINKS) throw new Error(`A diagram can have at most ${count(MAX_DIAGRAM_LINKS)} links.`)
  if (!nodes.length) throw new Error('A diagram needs at least one node')
  const seen = new Set<string>()
  /** An id as it's kept: cleaned and on one line (references to it are read the same way). */
  const plain = (v: unknown): string => (typeof v === 'string' ? oneLine(cleanText(v)) : '')
  const idOf = (item: unknown, what: string, i: number): string => {
    const id = isObj(item) ? plain(item.id) : ''
    if (!id) throw new Error(`${what} ${i + 1} needs an id`)
    if (id.length > MAX_NAME) throw new Error('An id can be at most 1,000 characters.')
    if (seen.has(id)) throw new Error(`The id "${id}" is used twice`)
    seen.add(id)
    return id
  }
  const boxIds = boxes.map((b, i) => idOf(b, 'box', i))
  const nodeIds = nodes.map((n, i) => idOf(n, 'node', i))
  const known = new Set(boxIds)
  const inOf = (item: Obj, id: string, what: string): string | undefined => {
    if (item.in === undefined || item.in === null || item.in === '') return undefined
    const where = plain(item.in)
    if (!known.has(where)) throw new Error(`${what} "${id}" is in "${typeof item.in === 'string' ? item.in : String(typeof item.in)}", which is not a box`)
    return where
  }
  boxes.forEach((b, i) => {
    const o = b as Obj
    const id = boxIds[i]
    const at = inOf(o, id, 'box')
    spec.containers!.push({ id, label: labelOf(o.label, id, `box "${id}"`), ...(at ? { in: at } : {}) })
  })
  const parent = new Map(spec.containers!.map(c => [c.id, c.in]))
  for (const c of spec.containers!) {
    let at = c.in
    for (let steps = 0; at !== undefined; steps++) {
      if (at === c.id || steps > spec.containers!.length) throw new Error(`The box "${c.id}" is inside itself`)
      at = parent.get(at)
    }
  }
  nodes.forEach((n, i) => {
    const o = n as Obj
    const id = nodeIds[i]
    const at = inOf(o, id, 'node')
    const item: DiagramSpec['nodes'][number] = { id, label: labelOf(o.label, id, `node "${id}"`), ...(at ? { in: at } : {}) }
    if (o.icon !== undefined && o.icon !== null && o.icon !== '') {
      if (typeof o.icon !== 'string' || o.icon.length > MAX_NAME) throw new Error(`node "${id}" icon must be text of at most 1,000 characters`)
      item.icon = o.icon
    }
    spec.nodes.push(item)
  })
  const isNode = new Set(nodeIds)
  links.forEach((k, i) => {
    if (!isObj(k)) throw new Error(`link ${i + 1} must be { from, to, label? }`)
    const end = (v: unknown): string => {
      const id = plain(v)
      if (!isNode.has(id)) throw new Error(`link ${i + 1}: no node "${typeof v === 'string' ? v : String(typeof v)}"`)
      return id
    }
    const from = end(k.from)
    const to = end(k.to)
    const label = k.label === undefined || k.label === null || k.label === '' ? undefined : labelOf(k.label, '', `link ${i + 1}`)
    spec.links.push(label ? { from, to, label } : { from, to })
  })
  return spec
}

// ---------- measuring ----------

/** The diagram named `name` on the artboard, if it has one. */
export function diagramOn(board: Artboard, name: string): Diagram | undefined {
  return list<Diagram>(board.diagrams).find(d => isObj(d) && d.name === name)
}

/** The node component's label layer: the text its nodes override. */
function labelLayer(comp: Component | undefined): TextLayer | undefined {
  const root: unknown = comp?.root
  if (!isObj(root) || root.type !== 'group') return undefined
  return list<Layer>(root.children).find((l): l is TextLayer => isObj(l) && l.type === 'text' && Array.isArray(l.runs))
}

const textLayer = (id: string, name: string, b: Box, run: Omit<TextRun, 'text'>, text: string, how: Partial<TextLayer> = {}): TextLayer => ({
  ...basics(id, name, b), type: 'text', mode: 'point', align: 'left', valign: 'top', runs: [{ ...run, text }], ...how
})
const NODE_RUN = { font: FONT, size: 16, color: color('#0f172a') }
const BOX_RUN = { font: BOX_FONT, size: 14, color: color('#334155') }

/** How big `text` comes out in `style`'s first run, measured with `fonts` (estimated without them). */
function textSize(text: string, style: Omit<TextRun, 'text'>, fonts?: FontSource): Size {
  if (fonts) {
    const lay = layoutText(textLayer('m', 'm', { x: 0, y: 0, w: 0, h: 0 }, style, text), fonts)
    return { width: Math.max(0, ...lay.lines.map(l => l.width)), height: lay.height }
  }
  const size = fin(style.size, 16)
  const lines = text.split('\n')
  return { width: Math.max(...lines.map(s => s.length)) * size * 0.55, height: lines.length * size * fin(style.lineHeight, 1.2) }
}

/**
 * What diagramGraph needs measured for `spec` on `board`: every node the same size (the largest label in the node
 * component's text style, 16 px around it, at least 120x48), so instances draw their component at its own size and
 * no label is stretched; each box's label; each link's label (as the renderer draws it); and where pinned nodes are.
 */
export function diagramSizes(design: Design, board: Artboard, spec: DiagramSpec, fonts?: FontSource): DiagramSizes {
  const old = diagramOn(board, spec.name)
  const comp = (design.components ?? []).find(c => c.id === old?.nodeComponent)
  const style = labelLayer(comp)?.runs[0] ?? { ...NODE_RUN, text: '' }
  let w = NODE_MIN.width
  let h = NODE_MIN.height
  for (const n of spec.nodes) {
    const s = textSize(n.label, style, fonts)
    w = Math.max(w, Math.ceil(s.width + 2 * NODE_PAD))
    h = Math.max(h, Math.ceil(s.height + 2 * NODE_PAD))
  }
  const sizes: DiagramSizes = { nodes: {}, containers: {}, links: [] }
  for (const n of spec.nodes) sizes.nodes[n.id] = { width: w, height: h }
  for (const c of spec.containers ?? []) {
    const s = textSize(c.label, BOX_RUN, fonts)
    sizes.containers![c.id] = { width: Math.ceil(s.width), height: Math.ceil(s.height) }
  }
  // a link's label in the fallback font at 14 px with 4 px either side, as the renderer draws it
  const fb = fonts?.fallback
  const labelFonts: FontSource | undefined = fb && { fallback: fb, get: () => fb }
  sizes.links = spec.links.map(k => {
    if (!k.label) return undefined
    const s = textSize(k.label, { font: { ...FONT, family: fb?.family ?? FONT.family }, size: LINK_LABEL_SIZE }, labelFonts)
    return { width: Math.ceil(s.width + 8), height: Math.ceil(s.height) }
  })
  // pinned nodes stay where they are: ELK hears where, from the diagram's top left
  if (old) {
    const index = layerIndex(board.layers)
    const top = index.get(old.layer ?? '')
    const corner = top ? boxOf(top) : { x: 0, y: 0 }
    const wanted = new Set(spec.nodes.map(n => n.id))
    for (const n of list<Obj>(old.nodes)) {
      const l = isObj(n) && n.pinned === true && typeof n.id === 'string' && wanted.has(n.id) ? index.get(String(n.layer)) : undefined
      if (l) (sizes.pinned ??= {})[n.id as string] = { x: fin(l.x, 0) - corner.x, y: fin(l.y, 0) - corner.y }
    }
  }
  return sizes
}

// ---------- the graph ----------

const px = (v: number): string => String(Math.round(v * 100) / 100)

/**
 * The ELK graph for a spec: nodes as `n<i>`, boxes as `c<i>` (holding what's in them) and links as `e<i>`, in spec
 * order, so ids repeat nowhere whatever the labels are. Boxes leave room for their label on top and are at least as
 * wide as it; pinned nodes carry their position (elk.position) and the layers keep to it. Direction and spacing come
 * from the spec and apply inside every box too. layoutDiagram sets the algorithm and the coordinates.
 */
export function diagramGraph(spec: DiagramSpec, sizes: DiagramSizes): ElkGraph {
  const spacing = spec.spacing ?? DEFAULT_SPACING
  const options: Record<string, string> = {
    'elk.direction': (spec.direction ?? 'right').toUpperCase(),
    'elk.spacing.nodeNode': px(spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': px(spacing * 1.5),
    'elk.spacing.edgeNode': px(spacing / 2),
    'elk.layered.spacing.edgeNodeBetweenLayers': px(spacing / 2),
    'elk.spacing.edgeEdge': px(spacing / 4),
    'elk.spacing.edgeLabel': '4'
  }
  const elkId = new Map<string, string>()
  spec.nodes.forEach((n, i) => elkId.set(n.id, `n${i}`))
  const held = new Map<string, ElkGraph[]>([['', []]])
  const into = (parent: string | undefined, g: ElkGraph): void => {
    const key = parent ?? ''
    if (!held.has(key)) held.set(key, [])
    held.get(key)!.push(g)
  }
  const boxes: ElkGraph[] = []
  ;(spec.containers ?? []).forEach((c, i) => {
    const label = sizes.containers?.[c.id] ?? { width: 0, height: 0 }
    const top = LABEL_TOP + label.height + LABEL_GAP
    const g: ElkGraph = {
      id: `c${i}`,
      layoutOptions: {
        ...options,
        'elk.padding': `[top=${px(top)},left=${BOX_PAD},bottom=${BOX_PAD},right=${BOX_PAD}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${px(label.width + 2 * BOX_PAD)}, ${px(top + BOX_PAD)})`
      },
      children: []
    }
    held.set(c.id, g.children!)
    boxes.push(g)
  })
  ;(spec.containers ?? []).forEach((c, i) => into(c.in, boxes[i]))
  spec.nodes.forEach((n, i) => {
    const s = sizes.nodes[n.id] ?? NODE_MIN
    const pin = sizes.pinned?.[n.id]
    into(n.in, { id: `n${i}`, width: s.width, height: s.height, ...(pin ? { layoutOptions: { 'elk.position': `(${px(pin.x)}, ${px(pin.y)})` } } : {}) })
  })
  const edges: NonNullable<ElkGraph['edges']> = spec.links.map((k, i) => {
    const label = sizes.links?.[i]
    return {
      id: `e${i}`, sources: [elkId.get(k.from)!], targets: [elkId.get(k.to)!],
      ...(label ? { labels: [{ text: k.label, width: label.width, height: label.height }] } : {})
    }
  })
  const pinned = !!sizes.pinned && Object.keys(sizes.pinned).length > 0
  return {
    id: 'root',
    layoutOptions: {
      ...options,
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      ...(pinned ? { 'elk.layered.crossingMinimization.semiInteractive': 'true' } : {})
    },
    children: held.get('')!,
    edges
  }
}

// ---------- the layout, onto the artboard ----------

/** Every box ELK placed, by its id, and every edge's route as points (both in the root's coordinates). */
function placedOf(laidOut: ElkGraph): { boxes: Map<string, Box>; routes: Map<string, [number, number][]> } {
  const boxes = new Map<string, Box>()
  const routes = new Map<string, [number, number][]>()
  const stack: ElkGraph[] = [laidOut]
  while (stack.length) {
    const g = stack.pop()!
    if (!isObj(g)) continue
    if (g !== laidOut && typeof g.id === 'string') boxes.set(g.id, { x: fin(g.x, 0), y: fin(g.y, 0), w: fin(g.width, 0), h: fin(g.height, 0) })
    for (const e of list<NonNullable<ElkGraph['edges']>[number]>(g.edges)) {
      const pts: [number, number][] = []
      for (const s of list<Obj>(e?.sections)) {
        for (const p of [s.startPoint, ...list(s.bendPoints), s.endPoint]) {
          if (!isObj(p)) continue
          const q: [number, number] = [fin(p.x, 0), fin(p.y, 0)]
          const last = pts[pts.length - 1]
          if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q)
        }
      }
      if (typeof e?.id === 'string' && pts.length >= 2) routes.set(e.id, pts)
    }
    for (const k of list<ElkGraph>(g.children)) stack.push(k)
  }
  return { boxes, routes }
}

/** A connector's box from its route, or from its ends' centers when it has none. */
function fitConnector(c: ConnectorLayer, index: Map<string, Layer>): void {
  let pts: [number, number][] = Array.isArray(c.points) ? c.points : []
  if (pts.length < 2) {
    const ends = [c.from?.layer, c.to?.layer].map(id => index.get(id))
    if (!ends[0] || !ends[1]) return
    pts = ends.map(l => centerOf(boxOf(l!)))
  }
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  Object.assign(c, { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })
}

/** Fits a group to what it holds, as the ops do (a rotated or scaled group keeps its box). */
function fitGroup(g: GroupLayer): void {
  if (!g.children.length || fin(g.rotation, 0) || fin(g.scaleX, 1) !== 1 || fin(g.scaleY, 1) !== 1) return
  const b = g.children.map(l => transformedBounds(boxOf(l), l)).reduce((a, c) => union(a, c))
  Object.assign(g, { x: b.x, y: b.y, width: b.w, height: b.h })
}

/** A component name nothing has yet: "Diagram node", then "Diagram node 2" and on. */
function freeName(design: Design, base: string): string {
  const names = new Set((design.components ?? []).map(c => c.name))
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * The diagram's node component, sized to its nodes: the one it had (when it still has a label layer), or a new
 * "Diagram node": a rounded rect and a label centered in it. Its rect and label are fitted to `size`, so instances
 * of that size draw it as it is.
 */
function nodeComponent(design: Design, ref: unknown, size: Size, taken: Set<string>): { comp: Component; label: TextLayer } {
  const comps = (design.components ??= [])
  let comp = typeof ref === 'string' ? comps.find(c => c.id === ref) : undefined
  let label = labelLayer(comp)
  if (!comp || !label) {
    const name = freeName(design, 'Diagram node')
    const zero = { x: 0, y: 0, w: size.width, h: size.height }
    label = textLayer(newId(taken), 'Label', zero, NODE_RUN, 'Label', { mode: 'box', align: 'center', valign: 'middle' })
    const rect: Layer = { ...basics(newId(taken), 'Box', zero), type: 'rect', radius: 10, fill: color('#ffffff'), stroke: color('#94a3b8'), strokeWidth: 1.5 }
    comp = { id: newId(taken), name, root: { ...basics(newId(taken), name, zero), type: 'group', children: [rect, label] } }
    comps.push(comp)
  }
  const root = comp.root
  const x = fin(root.x, 0)
  const y = fin(root.y, 0)
  Object.assign(root, { x, y, width: size.width, height: size.height })
  const rect = root.children.find(l => isObj(l) && l.type === 'rect')
  if (rect) Object.assign(rect, { x, y, width: size.width, height: size.height })
  Object.assign(label, { x: x + NODE_PAD / 2, y, width: size.width - NODE_PAD, height: size.height })
  return { comp, label }
}

/**
 * Writes a laid-out diagram onto the artboard (`laidOut` is what layoutDiagram made of diagramGraph(spec, sizes)) and
 * returns the design, changed in place. The diagram is a group named after it, holding its boxes (each a group with
 * a frame and a label, holding its nodes and inner boxes), the nodes outside any box, and the links on top.
 *
 * Run again with the same name, it updates what it made by spec id: a node, box or link that stays keeps its layer
 * (and id) and whatever was changed on it by hand; new ones are added, missing ones removed along with connectors
 * joining them, and labels changed. The layout lands where the diagram was (on the nodes and boxes that stay); a new
 * diagram is centered on the artboard, or starts at its top left when it doesn't fit. Pinned nodes keep their place,
 * their boxes grow to hold them, and their links are left without points so they route to wherever they are.
 * `opts.taken` holds the ids in use (new ids never repeat one); `opts.sizes` are what diagramGraph was given.
 */
export function applyLayout(
  design: Design, artboard: string, spec: DiagramSpec, laidOut: ElkGraph, opts: { taken?: Set<string>; sizes?: DiagramSizes } = {}
): Design {
  const board = design.artboards.find(a => a.id === artboard)
  if (!board) throw new Error(`No artboard ${artboard}`)
  const taken = opts.taken ?? idsIn(design)
  const { boxes: placed, routes } = placedOf(laidOut)
  const at = (elk: string): Box => {
    const b = placed.get(elk)
    if (!b) throw new Error('The diagram could not be laid out: the layout left something out.')
    return b
  }
  const containers = spec.containers ?? []
  const nodeSize = at('n0')
  const size = { width: nodeSize.w, height: nodeSize.h }
  const diagrams = (board.diagrams ??= [])
  const old = diagramOn(board, spec.name)
  let index = layerIndex(board.layers)
  const present = (ref: unknown): Layer | undefined => (typeof ref === 'string' ? index.get(ref) : undefined)

  // what the diagram had, by spec id, where its layer still exists
  const oldNodes = new Map<string, { layer: Layer; pinned: boolean }>()
  for (const n of list<Obj>(old?.nodes)) {
    const l = isObj(n) && typeof n.id === 'string' ? present(n.layer) : undefined
    if (l) oldNodes.set(n.id as string, { layer: l, pinned: n.pinned === true })
  }
  const oldBoxes = new Map<string, GroupLayer>()
  for (const c of list<Obj>(old?.containers)) {
    const l = isObj(c) && typeof c.id === 'string' ? present(c.layer) : undefined
    if (l?.type === 'group') oldBoxes.set(c.id as string, l)
  }
  const oldLinks = new Map<string, Layer[]>()
  for (const k of list<Obj>(old?.links)) {
    const l = isObj(k) ? present(k.layer) : undefined
    if (!l) continue
    const key = `${String(k.from)}\u0000${String(k.to)}`
    if (!oldLinks.has(key)) oldLinks.set(key, [])
    oldLinks.get(key)!.push(l)
  }
  const oldTop = present(old?.layer)
  const top: GroupLayer | undefined = oldTop?.type === 'group' ? oldTop : undefined
  const pinned = new Set(spec.nodes.filter(n => oldNodes.get(n.id)?.pinned).map(n => n.id))

  // where the layout goes: where the nodes and boxes that stay already are, else centered on the artboard
  const pairs: [Box, Box][] = []
  spec.nodes.forEach((n, i) => {
    const was = oldNodes.get(n.id)
    if (was && !pinned.has(n.id)) pairs.push([boxOf(was.layer), at(`n${i}`)])
  })
  containers.forEach((c, i) => {
    const frame = oldBoxes.get(c.id)?.children[0]
    if (frame?.type === 'rect') pairs.push([boxOf(frame), at(`c${i}`)])
  })
  const W = fin(board.width, 0)
  const H = fin(board.height, 0)
  const lw = fin(laidOut.width, 0)
  const lh = fin(laidOut.height, 0)
  let ox: number
  let oy: number
  if (pairs.length) {
    ox = Math.min(...pairs.map(p => p[0].x)) - Math.min(...pairs.map(p => p[1].x))
    oy = Math.min(...pairs.map(p => p[0].y)) - Math.min(...pairs.map(p => p[1].y))
  } else if (top?.children.length) [ox, oy] = [fin(top.x, 0), fin(top.y, 0)]
  else [ox, oy] = [lw <= W ? Math.round((W - lw) / 2) : 0, lh <= H ? Math.round((H - lh) / 2) : 0]
  const moved = (b: Box): Box => ({ x: b.x + ox, y: b.y + oy, w: b.w, h: b.h })

  const { comp, label: compLabel } = nodeComponent(design, old?.nodeComponent, size, taken)

  // what's set aside before the old layers come out: what the user added to the diagram's group and to its boxes
  const ours = new Set<string>()
  for (const { layer } of oldNodes.values()) ours.add(layer.id)
  for (const g of oldBoxes.values()) ours.add(g.id)
  for (const ls of oldLinks.values()) for (const l of ls) ours.add(l.id)
  const boxExtras = new Map<string, Layer[]>()
  for (const [id, g] of oldBoxes) boxExtras.set(id, g.children.filter((l, i) => !ours.has(l.id) && !(i === 0 && l.type === 'rect') && !(i === 1 && l.type === 'text')))
  const oldFrames = new Map<string, { frame?: Layer; label?: Layer }>()
  for (const [id, g] of oldBoxes) oldFrames.set(id, { frame: g.children[0]?.type === 'rect' ? g.children[0] : undefined, label: g.children[1]?.type === 'text' ? g.children[1] : undefined })
  // every layer the diagram had comes out of wherever it is now (its group stays where it is)
  const prune = (ls: Layer[]): void => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]
      if (ours.has(l.id)) ls.splice(i, 1)
      else if (l.type === 'group') prune(l.children)
    }
  }
  prune(board.layers)
  // connectors left joining a node or box that's gone go too
  const keptNodes = new Set(spec.nodes.map(n => oldNodes.get(n.id)?.layer.id).filter(Boolean))
  const keptBoxes = new Set(containers.map(c => oldBoxes.get(c.id)?.id).filter(Boolean))
  const gone = new Set<string>()
  for (const { layer } of oldNodes.values()) if (!keptNodes.has(layer.id)) gone.add(layer.id)
  for (const g of oldBoxes.values()) if (!keptBoxes.has(g.id)) gone.add(g.id)
  const dropJoined = (ls: Layer[]): void => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]
      if (l.type === 'connector' && (gone.has(l.from?.layer) || gone.has(l.to?.layer))) ls.splice(i, 1)
      else if (l.type === 'group') dropJoined(l.children)
    }
  }
  if (gone.size) {
    dropJoined(board.layers)
    for (const extras of boxExtras.values()) dropJoined(extras)
  }

  // the nodes
  const nodeLayers = new Map<string, InstanceLayer>()
  spec.nodes.forEach((n, i) => {
    const was = oldNodes.get(n.id)?.layer
    const b = moved(at(`n${i}`))
    // a node that isn't an instance of the node component any more becomes one again, keeping its id
    const l: InstanceLayer =
      was?.type === 'instance' && was.component === comp.id
        ? was
        : { ...basics(was?.id ?? newId(taken), oneLine(n.label), b), type: 'instance', component: comp.id, overrides: {} }
    const spot = pinned.has(n.id) && was ? { x: fin(was.x, 0), y: fin(was.y, 0) } : b
    l.x = spot.x
    l.y = spot.y
    l.width = size.width
    l.height = size.height
    const had = isObj(l.overrides) ? l.overrides[compLabel.id] : undefined
    if (had?.text !== n.label) {
      l.overrides = { ...(isObj(l.overrides) ? l.overrides : {}), [compLabel.id]: { ...(had ?? {}), text: n.label } }
      l.name = oneLine(n.label)
    }
    nodeLayers.set(n.id, l)
  })

  // the boxes: each a group with its frame and label, then its inner boxes and nodes, then what the user added
  const boxLayers = new Map<string, GroupLayer>()
  containers.forEach((c, i) => {
    const was = oldBoxes.get(c.id)
    const b = moved(at(`c${i}`))
    const parts = oldFrames.get(c.id)
    const frame: Layer = parts?.frame ?? { ...basics(newId(taken), 'Frame', b), type: 'rect', radius: 12, fill: color('#f8fafc'), stroke: color('#cbd5e1'), strokeWidth: 1 }
    Object.assign(frame, { x: b.x, y: b.y, width: b.w, height: b.h })
    const s = opts.sizes?.containers?.[c.id]
    let text = parts?.label as TextLayer | undefined
    const relabeled = !text || text.runs.map(r => r.text).join('') !== c.label
    if (!text) text = textLayer(newId(taken), 'Label', { x: 0, y: 0, w: s?.width ?? 0, h: s?.height ?? 0 }, BOX_RUN, c.label)
    else if (relabeled) text.runs = [{ ...(text.runs[0] ?? BOX_RUN), text: c.label }]
    if (s) Object.assign(text, { width: s.width, height: s.height })
    const g: GroupLayer = was ?? { ...basics(newId(taken), oneLine(c.label), b), type: 'group', children: [] }
    if (relabeled) g.name = oneLine(c.label)
    g.children = [frame, text]
    boxLayers.set(c.id, g)
  })
  for (const c of containers) if (c.in) boxLayers.get(c.in)!.children.push(boxLayers.get(c.id)!)
  for (const n of spec.nodes) if (n.in) boxLayers.get(n.in)!.children.push(nodeLayers.get(n.id)!)
  for (const c of containers) boxLayers.get(c.id)!.children.push(...(boxExtras.get(c.id) ?? []))

  // frames grow to hold a pinned node or an inner box past them, innermost first; labels sit at their top left
  const depth = (c: { in?: string }): number => {
    let d = 0
    for (let at = c.in; at; at = containers.find(x => x.id === at)?.in) d++
    return d
  }
  for (const c of [...containers].sort((a, b) => depth(b) - depth(a))) {
    const g = boxLayers.get(c.id)!
    const [frame, text] = g.children as [Layer, TextLayer]
    const inner = [
      ...spec.nodes.filter(n => n.in === c.id).map(n => boxOf(nodeLayers.get(n.id)!)),
      ...containers.filter(x => x.in === c.id).map(x => boxOf(boxLayers.get(x.id)!.children[0]))
    ]
    if (inner.length) {
      const lh = opts.sizes?.containers?.[c.id]?.height ?? fin(text.height, 0)
      const need = inner.reduce((a, b) => union(a, b))
      const room = { x: need.x - BOX_PAD, y: need.y - (LABEL_TOP + lh + LABEL_GAP), w: need.w + 2 * BOX_PAD, h: need.h + LABEL_TOP + lh + LABEL_GAP + BOX_PAD }
      const b = union(boxOf(frame), room)
      Object.assign(frame, { x: b.x, y: b.y, width: b.w, height: b.h })
    }
    Object.assign(text, { x: fin(frame.x, 0) + BOX_PAD, y: fin(frame.y, 0) + LABEL_TOP })
    fitGroup(g)
  }

  // the diagram's group: its boxes and loose nodes, what the user added to it, and the links on top
  const group: GroupLayer = top ?? { ...basics(newId(taken), spec.name, moved({ x: 0, y: 0, w: lw, h: lh })), type: 'group', children: [] }
  const extras = group.children
  group.children = [
    ...containers.filter(c => !c.in).map(c => boxLayers.get(c.id)!),
    ...spec.nodes.filter(n => !n.in).map(n => nodeLayers.get(n.id)!),
    ...extras
  ]
  if (!top) board.layers.push(group)
  index = layerIndex(board.layers)
  const linkLayers: ConnectorLayer[] = spec.links.map((k, i) => {
    const queue = oldLinks.get(`${k.from}\u0000${k.to}`)
    const was = queue?.shift()
    const from = nodeLayers.get(k.from)!
    const to = nodeLayers.get(k.to)!
    let c: ConnectorLayer
    if (was?.type === 'connector') c = was
    else {
      const name = `${oneLine(spec.nodes.find(n => n.id === k.from)!.label)} to ${oneLine(spec.nodes.find(n => n.id === k.to)!.label)}`.slice(0, MAX_NAME)
      c = {
        ...basics(was?.id ?? newId(taken), name, { x: 0, y: 0, w: 0, h: 0 }), type: 'connector', from: { layer: from.id }, to: { layer: to.id },
        route: 'orthogonal', arrow: 'end', fill: null, stroke: color('#64748b'), strokeWidth: 1.5
      }
    }
    c.from = { ...(isObj(c.from) ? c.from : {}), layer: from.id }
    c.to = { ...(isObj(c.to) ? c.to : {}), layer: to.id }
    if (k.label) c.label = k.label
    else delete c.label
    const route = routes.get(`e${i}`)
    if (route && !pinned.has(k.from) && !pinned.has(k.to)) c.points = route.map(([x, y]) => [x + ox, y + oy])
    else delete c.points
    fitConnector(c, index)
    return c
  })
  group.children.push(...linkLayers)
  fitGroup(group)

  const record: Diagram = {
    ...(old ?? {}),
    name: spec.name,
    direction: spec.direction ?? 'right',
    spacing: spec.spacing ?? DEFAULT_SPACING,
    nodeComponent: comp.id,
    layer: group.id,
    nodes: spec.nodes.map(n => ({
      id: n.id, layer: nodeLayers.get(n.id)!.id, ...(n.in ? { container: n.in } : {}), ...(pinned.has(n.id) ? { pinned: true } : {}), ...(n.icon ? { icon: n.icon } : {})
    })),
    links: spec.links.map((k, i) => ({ from: k.from, to: k.to, layer: linkLayers[i].id, ...(k.label ? { label: k.label } : {}) })),
    containers: containers.map(c => ({ id: c.id, layer: boxLayers.get(c.id)!.id, ...(c.in ? { in: c.in } : {}) }))
  }
  if (old) diagrams[diagrams.indexOf(old)] = record
  else diagrams.push(record)
  return design
}

/** Every id a design holds, so new ones never repeat one. */
function idsIn(design: Design): Set<string> {
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

// ---------- after a change by hand ----------

/** Drops a connector's route, so it's drawn from wherever its ends are now, and fits its box to them. */
function unroute(c: ConnectorLayer, index: Map<string, Layer>): void {
  delete c.points
  fitConnector(c, index)
}

/**
 * After `moved` was moved or resized by hand: the diagram nodes it is or holds are pinned (tidy leaves them where they
 * are), and the links joining them lose their routes, so they're drawn straight or elbowed to wherever the nodes are
 * now and stay attached. A link that moved along with both its ends keeps its route, and so does a whole diagram
 * moved at once.
 */
export function pinMoved(board: Artboard, moved: Layer): void {
  const diagrams = list<Diagram>(board.diagrams)
  if (!diagrams.length) return
  const inside = new Set<string>()
  walk([moved], l => inside.add(l.id))
  let index: Map<string, Layer> | undefined
  for (const d of diagrams) {
    if (!isObj(d) || d.layer === moved.id) continue
    const nodes = list<Obj>(d.nodes).filter(n => isObj(n) && typeof n.layer === 'string' && inside.has(n.layer))
    if (!nodes.length) continue
    const links = list<Obj>(d.links).filter(isObj)
    if (nodes.length === list(d.nodes).length && links.every(k => typeof k.layer === 'string' && inside.has(k.layer))) continue
    for (const n of nodes) n.pinned = true
    const held = new Set(nodes.map(n => n.layer as string))
    index ??= layerIndex(board.layers)
    for (const k of links) {
      const c = index.get(String(k.layer))
      if (c?.type !== 'connector' || !Array.isArray(c.points)) continue
      if (!held.has(c.from?.layer) && !held.has(c.to?.layer)) continue
      if (inside.has(c.id) && inside.has(c.from?.layer) && inside.has(c.to?.layer)) continue
      unroute(c, index)
    }
  }
}

/**
 * The spec a diagram on the artboard stands for now: its record, with each label read from its layer (a node's text
 * override, a box's label), leaving out what's been deleted. What tidy lays out again.
 */
export function specOf(design: Design, board: Artboard, d: Diagram): DiagramSpec {
  const index = layerIndex(board.layers)
  const comp = (design.components ?? []).find(c => c.id === d.nodeComponent)
  const textId = labelLayer(comp)?.id
  const boxes: NonNullable<DiagramSpec['containers']> = []
  for (const c of list<Obj>(d.containers)) {
    const g = isObj(c) && typeof c.id === 'string' ? index.get(String(c.layer)) : undefined
    if (g?.type !== 'group') continue
    const text = g.children[1]?.type === 'text' ? g.children[1].runs.map(r => r.text).join('') : g.name
    boxes.push({ id: c.id as string, label: text || g.name, ...(typeof c.in === 'string' ? { in: c.in } : {}) })
  }
  const boxIds = new Set(boxes.map(b => b.id))
  for (const b of boxes) if (b.in && !boxIds.has(b.in)) delete b.in
  const nodes: DiagramSpec['nodes'] = []
  for (const n of list<Obj>(d.nodes)) {
    const l = isObj(n) && typeof n.id === 'string' ? index.get(String(n.layer)) : undefined
    if (!l) continue
    const text = l.type === 'instance' && textId ? l.overrides?.[textId]?.text : undefined
    const label = typeof text === 'string' && text ? text : l.name
    const at = typeof n.container === 'string' && boxIds.has(n.container) ? n.container : undefined
    nodes.push({ id: n.id as string, label, ...(at ? { in: at } : {}), ...(typeof n.icon === 'string' ? { icon: n.icon } : {}) })
  }
  const nodeIds = new Set(nodes.map(n => n.id))
  const links: DiagramSpec['links'] = []
  for (const k of list<Obj>(d.links)) {
    if (!isObj(k) || typeof k.from !== 'string' || typeof k.to !== 'string' || !nodeIds.has(k.from) || !nodeIds.has(k.to)) continue
    const c = index.get(String(k.layer))
    const label = c?.type === 'connector' ? c.label : typeof k.label === 'string' ? k.label : undefined
    links.push({ from: k.from, to: k.to, ...(label ? { label } : {}) })
  }
  return {
    name: d.name,
    ...(DIRECTIONS.includes(d.direction) ? { direction: d.direction } : {}),
    ...(typeof d.spacing === 'number' && Number.isFinite(d.spacing) && d.spacing >= 0 && d.spacing <= 1000 ? { spacing: d.spacing } : {}),
    nodes,
    links,
    containers: boxes
  }
}
