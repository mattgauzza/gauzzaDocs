import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { layoutDiagram, onceRetrying } from '../src/core/design/layout'
import { designZipBytes, readDesignZip } from '../src/core/formats/design'
import { parseDiagramText } from '../src/shared/design/diagram'
import { fontsFor, type FontSource } from '../src/shared/design/fonts'
import { type Box, boxOf } from '../src/shared/design/geometry'
import { newDesign, walk } from '../src/shared/design/model'
import { designToSvg } from '../src/shared/design/render'
import type { Design, DesignFile, Diagram, Layer } from '../src/shared/design/types'
import { applyDesignOp } from '../src/shared/ops/design'
import type { OpServices } from '../src/shared/ops/types'
import type { AgentOp } from '../src/shared/types'

const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
const fontsOf = (d: Design): Promise<FontSource> => fontsFor(d, {}, async () => liberation, liberation)

/** A fresh letter page, and the services the ops get: fonts measuring with Liberation Sans, and ELK as the layout. */
async function fresh(): Promise<{ file: DesignFile; services: OpServices }> {
  const design = newDesign('letter')
  return { file: { design, assets: {} }, services: { fonts: await fontsOf(design), layout: layoutDiagram } }
}

async function run(file: DesignFile, services: OpServices, ...ops: AgentOp[]) {
  let f = file
  let last: Awaited<ReturnType<typeof applyDesignOp>> | null = null
  for (const op of ops) {
    last = await applyDesignOp(f, op, services)
    if (last.file) f = last.file
  }
  return { file: f, result: last!.result as any, summary: last!.summary }
}

const all = (f: DesignFile): Layer[] => {
  const out: Layer[] = []
  walk(f.design.artboards[0].layers, l => out.push(l))
  return out
}
const byId = (f: DesignFile, id: string): Layer => {
  const hit = all(f).find(l => l.id === id)
  assert.ok(hit, `no layer ${id}`)
  return hit
}
const diagramOf = (f: DesignFile, name = 'Proposal'): Diagram => {
  const d = f.design.artboards[0].diagrams?.find(x => x.name === name)
  assert.ok(d, `no diagram ${name}`)
  return d
}
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const within = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
/** Whether a point lies on a box's edge (within half a pixel). */
const onEdge = ([x, y]: [number, number], b: Box): boolean => {
  const inX = x >= b.x - 0.5 && x <= b.x + b.w + 0.5
  const inY = y >= b.y - 0.5 && y <= b.y + b.h + 0.5
  const near = (v: number, e: number) => Math.abs(v - e) <= 0.5
  return (inX && (near(y, b.y) || near(y, b.y + b.h))) || (inY && (near(x, b.x) || near(x, b.x + b.w)))
}

/** Matt's proposal: a shared agent, and one space per client holding a job and its forecast and deck. */
const proposal = () => ({
  name: 'Proposal',
  direction: 'down' as const,
  containers: [
    { id: 'shared', label: 'Shared agent' },
    { id: 'a', label: 'Client A' },
    { id: 'b', label: 'Client B' }
  ],
  nodes: [
    { id: 'agent', label: 'agent', in: 'shared' },
    { id: 'a-job', label: 'job', in: 'a' },
    { id: 'a-deck', label: 'forecast and deck', in: 'a' },
    { id: 'b-job', label: 'job', in: 'b' },
    { id: 'b-deck', label: 'forecast and deck', in: 'b' }
  ],
  links: [
    { from: 'a-job', to: 'a-deck' },
    { from: 'b-job', to: 'b-deck' },
    { from: 'agent', to: 'a-job', label: 'runs' },
    { from: 'agent', to: 'b-job', label: 'runs' }
  ]
})

/** The text an instance shows: its override of the component's text layer. */
function labelOf(f: DesignFile, layer: Layer): string | undefined {
  assert.ok(layer.type === 'instance')
  const comp = f.design.components.find(c => c.id === layer.component)
  assert.ok(comp, 'the node component exists')
  let textId = ''
  walk([comp.root], l => {
    if (l.type === 'text' && !textId) textId = l.id
  })
  return layer.overrides[textId]?.text
}

test("Matt's proposal: 5 nodes in 3 boxes with their links, laid out without overlaps and each node inside its box", async () => {
  const { file, services } = await fresh()
  const r = await applyDesignOp(file, { op: 'diagram', spec: proposal() }, services)
  assert.equal(r.summary, 'drew diagram Proposal (5 nodes, 3 boxes, 4 links)')
  const res = r.result as { id: string; nodes: Record<string, string>; links: string[] }
  const f = r.file!
  // every spec id maps to a layer of its own, though two labels repeat
  assert.deepEqual(Object.keys(res.nodes), ['agent', 'a-job', 'a-deck', 'b-job', 'b-deck'])
  assert.equal(new Set(Object.values(res.nodes)).size, 5)
  assert.equal(res.links.length, 4)
  const group = byId(f, res.id)
  assert.deepEqual([group.type, group.name], ['group', 'Proposal'])
  // nodes are instances of one "Diagram node" component, drawn at its own size, with the label as the text override
  const nodes = Object.values(res.nodes).map(id => byId(f, id))
  assert.ok(nodes.every(l => l.type === 'instance'))
  assert.deepEqual(nodes.map(l => labelOf(f, l)), ['agent', 'job', 'forecast and deck', 'job', 'forecast and deck'])
  assert.deepEqual(nodes.map(l => l.name), ['agent', 'job', 'forecast and deck', 'job', 'forecast and deck'])
  const comp = f.design.components.find(c => c.name === 'Diagram node')
  assert.ok(comp && nodes.every(l => l.type === 'instance' && l.component === comp.id))
  for (const n of nodes) assert.deepEqual([n.width, n.height], [comp.root.width, comp.root.height])
  assert.ok(comp.root.width >= 120 && comp.root.height >= 48)
  // no two node boxes overlap
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(!overlaps(boxOf(nodes[i]), boxOf(nodes[j])), `${i} and ${j} overlap`)
  // three boxes, each a group with a labeled frame, and every node inside its box
  const d = diagramOf(f)
  assert.equal(d.containers.length, 3)
  const boxes = Object.fromEntries(d.containers.map(c => [c.id, byId(f, c.layer)]))
  for (const [id, label] of [['shared', 'Shared agent'], ['a', 'Client A'], ['b', 'Client B']]) {
    const g = boxes[id]
    assert.ok(g.type === 'group', id)
    assert.equal(g.name, label)
    const [frame, text] = g.children
    assert.equal(frame.type, 'rect')
    assert.ok(text.type === 'text' && text.runs.map(x => x.text).join('') === label)
    assert.ok(within(boxOf(text), boxOf(frame)), `${id}'s label sits in its frame`)
  }
  for (const n of d.nodes) assert.ok(within(boxOf(byId(f, n.layer)), boxOf((boxes[n.container!] as any).children[0])), `${n.id} sits inside ${n.container}`)
  // links are connectors routed by the layout: points from the edge sections, starting and ending on the node edges
  for (const [i, link] of proposal().links.entries()) {
    const c = byId(f, res.links[i])
    assert.ok(c.type === 'connector')
    assert.deepEqual([c.from.layer, c.to.layer], [res.nodes[link.from], res.nodes[link.to]])
    assert.ok(c.points && c.points.length >= 2, 'routed')
    assert.ok(onEdge(c.points[0], boxOf(byId(f, res.nodes[link.from]))), `link ${i} starts on its node`)
    assert.ok(onEdge(c.points[c.points.length - 1], boxOf(byId(f, res.nodes[link.to]))), `link ${i} ends on its node`)
    assert.equal(c.label, link.label)
  }
  // the whole diagram sits on the page, and it draws, saves and opens again with nothing repaired
  for (const l of all(f)) assert.ok(within(boxOf(l), { x: 0, y: 0, w: 816, h: 1056 }), `${l.name} is on the page`)
  const svg = designToSvg(f.design, f.design.artboards[0].id, { fonts: services.fonts!, assets: {}, mode: 'export' })
  assert.match(svg, /forecast and deck/)
  assert.match(svg, /Client B/)
  const back = await readDesignZip(await designZipBytes(f))
  assert.equal(back.notes, undefined)
  assert.deepEqual(back.design.artboards[0].diagrams, f.design.artboards[0].diagrams)
})

test('the same spec run again with one label changed keeps every layer id and changes only that label', async () => {
  const { file, services } = await fresh()
  const first = await run(file, services, { op: 'diagram', spec: proposal() })
  const before = new Map(all(first.file).map(l => [l.id, l]))
  const spec = proposal()
  spec.nodes[0].label = 'helper'
  const again = await applyDesignOp(first.file, { op: 'diagram', spec }, services)
  assert.equal(again.summary, 'redrew diagram Proposal (5 nodes, 3 boxes, 4 links)')
  assert.deepEqual(again.result, first.result)
  const after = all(again.file!)
  assert.deepEqual(after.map(l => l.id).sort(), [...before.keys()].sort())
  // only that node's label (and name) changed; every box stayed where it was (a group is compared by its own fields)
  const own = (l: Layer) => (l.type === 'group' ? { ...l, children: l.children.map(c => c.id) } : l)
  for (const l of after) {
    const was = before.get(l.id)!
    assert.deepEqual(boxOf(l), boxOf(was), `${l.name} kept its box`)
    if (l.id === first.result.nodes.agent) {
      assert.deepEqual([labelOf(again.file!, l), l.name], ['helper', 'helper'])
      assert.deepEqual({ ...l, name: '', overrides: {} }, { ...was, name: '', overrides: {} })
    } else assert.deepEqual(own(l), own(was), `${l.name} is as it was`)
  }
  assert.equal(again.file!.design.components.length, 1, 'the node component is reused')
})

test('running again adds new nodes and removes missing ones with their links, keeping the ids of what stays', async () => {
  const { file, services } = await fresh()
  const first = await run(file, services, { op: 'diagram', spec: proposal() })
  const spec = proposal()
  spec.nodes = spec.nodes.filter(n => n.id !== 'b-deck')
  spec.links = spec.links.filter(l => l.to !== 'b-deck')
  spec.containers.push({ id: 'c', label: 'Client C' })
  spec.nodes.push({ id: 'c-job', label: 'job', in: 'c' })
  spec.links.push({ from: 'agent', to: 'c-job' })
  const r = await run(first.file, services, { op: 'diagram', spec })
  assert.equal(r.summary, 'redrew diagram Proposal (5 nodes, 4 boxes, 4 links)')
  const ids = new Set(all(r.file).map(l => l.id))
  for (const id of ['agent', 'a-job', 'a-deck', 'b-job']) assert.equal(r.result.nodes[id], first.result.nodes[id], `${id} kept its layer`)
  assert.ok(!ids.has(first.result.nodes['b-deck']), 'b-deck is gone')
  assert.ok(!ids.has(first.result.links[1]), 'and so is its link')
  assert.deepEqual(r.result.links.slice(0, 3), [first.result.links[0], first.result.links[2], first.result.links[3]])
  assert.ok(ids.has(r.result.nodes['c-job']) && ids.has(r.result.links[3]))
  const d = diagramOf(r.file)
  assert.deepEqual(d.containers.map(c => c.id), ['shared', 'a', 'b', 'c'])
  // a box with a new label keeps its group, renamed, and its label shows the new text
  spec.containers[1].label = 'Client Alpha'
  const relabeled = await run(r.file, services, { op: 'diagram', spec })
  const box = byId(relabeled.file, r.result.containers.a) as Layer & { type: 'group' }
  assert.equal(box.name, 'Client Alpha')
  assert.ok(box.children[1].type === 'text' && box.children[1].runs[0].text === 'Client Alpha')
  // a connector the user drew to the removed node goes with it
  const drawn = await run(first.file, services, { op: 'add', type: 'rect', props: { name: 'Note', x: 700, y: 900, width: 50, height: 50 } }, { op: 'add', type: 'connector', props: { name: 'Mine', from: 'Note', to: first.result.nodes['b-deck'] } })
  const gone = await run(drawn.file, services, { op: 'diagram', spec })
  assert.ok(!all(gone.file).some(l => l.name === 'Mine'))
  // deleting the diagram's group forgets the diagram, so the same name draws afresh
  const deleted = await run(first.file, services, { op: 'delete', layer: first.result.id })
  assert.deepEqual(deleted.file.design.artboards[0].diagrams, [])
  assert.equal((await run(deleted.file, services, { op: 'diagram', spec: proposal() })).summary, 'drew diagram Proposal (5 nodes, 3 boxes, 4 links)')
  // tidy with every node deleted says so
  const emptied = await run(first.file, services, ...Object.values(first.result.nodes as Record<string, string>).map(id => ({ op: 'delete', layer: id })))
  await assert.rejects(applyDesignOp(emptied.file, { op: 'tidy', diagram: 'Proposal' }, services), {
    message: 'Every node of the diagram "Proposal" was deleted. Draw it again with the diagram op.'
  })
})

test('moving a node with set clears its links\' points and pins it, and tidy keeps its x and y', async () => {
  const { file, services } = await fresh()
  const first = await run(file, services, { op: 'diagram', spec: proposal() })
  const { nodes, links } = first.result as { nodes: Record<string, string>; links: string[] }
  const moved = await run(first.file, services, { op: 'set', layer: nodes['a-deck'], props: { x: 600, y: 900 } })
  const pts = (f: DesignFile, id: string) => (byId(f, id) as Layer & { points?: unknown }).points
  assert.equal(pts(moved.file, links[0]), undefined, 'the link to it re-routes')
  assert.ok(pts(moved.file, links[1]) && pts(moved.file, links[2]), 'links elsewhere keep their routes')
  assert.equal(diagramOf(moved.file).nodes.find(n => n.id === 'a-deck')!.pinned, true)
  assert.ok(!diagramOf(moved.file).nodes.find(n => n.id === 'a-job')!.pinned)
  // tidy lays the rest out again around it
  const tidy = await run(moved.file, services, { op: 'tidy', diagram: 'Proposal' })
  assert.equal(tidy.summary, 'tidied diagram Proposal')
  const deck = byId(tidy.file, nodes['a-deck'])
  assert.deepEqual([deck.x, deck.y], [600, 900])
  assert.deepEqual(tidy.result.nodes, nodes)
  assert.equal(pts(tidy.file, links[0]), undefined, 'a link to a pinned node is routed when drawn')
  assert.ok(pts(tidy.file, links[1]) && pts(tidy.file, links[2]))
  // its box grows to hold it
  const box = byId(tidy.file, diagramOf(tidy.file).containers.find(c => c.id === 'a')!.layer) as Layer & { type: 'group' }
  assert.ok(within(boxOf(deck), boxOf(box.children[0])))
  // move (to the front of its box) pins too; unpinning lets tidy place it again
  const front = await run(first.file, services, { op: 'move', layer: nodes['b-job'], to: 'front' })
  assert.equal(diagramOf(front.file).nodes.find(n => n.id === 'b-job')!.pinned, true)
  assert.equal(pts(front.file, links[1]), undefined)
  const loose = await run(tidy.file, services, { op: 'tidy', diagram: 'Proposal', unpin: true })
  assert.ok(diagramOf(loose.file).nodes.every(n => !n.pinned))
  assert.ok(pts(loose.file, links[0]))
  // a fill set on a node moves nothing, so it pins nothing
  const filled = await run(first.file, services, { op: 'set', layer: nodes.agent, part: 'Label', props: { fill: '#ff0000' } })
  assert.ok(diagramOf(filled.file).nodes.every(n => !n.pinned))
})

/** No two nodes overlap, and no box's frame covers a node it doesn't hold (directly or in an inner box). */
function assertClear(f: DesignFile, what: string): void {
  const d = diagramOf(f)
  const nodes = d.nodes.map(n => ({ id: n.id, in: n.container, box: boxOf(byId(f, n.layer)) }))
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) assert.ok(!overlaps(nodes[i].box, nodes[j].box), `${what}: ${nodes[i].id} and ${nodes[j].id} overlap`)
  }
  const parent = new Map(d.containers.map(c => [c.id, c.in]))
  const holds = (box: string, at: string | undefined): boolean => {
    for (; at; at = parent.get(at)) if (at === box) return true
    return false
  }
  for (const c of d.containers) {
    const frame = boxOf((byId(f, c.layer) as Layer & { type: 'group' }).children[0])
    for (const n of nodes) if (!holds(c.id, n.in)) assert.ok(!overlaps(frame, n.box), `${what}: ${c.id}'s frame covers ${n.id}`)
  }
}

test('tidy lays the rest out around pinned nodes: nothing overlaps them, and no frame covers another box\'s nodes', async () => {
  const { file, services } = await fresh()
  // a node pinned right on top of its neighbour in the same box
  const first = await run(file, services, { op: 'diagram', spec: proposal() })
  const { nodes } = first.result as { nodes: Record<string, string> }
  const job = byId(first.file, nodes['a-job'])
  const crowded = await run(first.file, services, { op: 'set', layer: nodes['a-deck'], props: { x: job.x + 30, y: job.y + 20 } })
  assert.ok(overlaps(boxOf(byId(crowded.file, nodes['a-deck'])), boxOf(job)), 'it starts on top of its neighbour')
  const tidied = await run(crowded.file, services, { op: 'tidy', diagram: 'Proposal' })
  assert.deepEqual([byId(tidied.file, nodes['a-deck']).x, byId(tidied.file, nodes['a-deck']).y], [job.x + 30, job.y + 20])
  assertClear(tidied.file, 'next to a neighbour')
  assert.match(tidied.result.note, /links are drawn as plain elbows around nodes placed by hand, so they may cross a box\.$/)
  // a node pinned inside another box's area, in each direction of flow: whatever is in the way is pushed along it
  for (const direction of ['down', 'right', 'up', 'left'] as const) {
    const drawn = await run(file, services, { op: 'diagram', spec: { ...proposal(), direction } })
    const ids = drawn.result.nodes as Record<string, string>
    const deck = byId(drawn.file, ids['a-deck'])
    const moved = await run(drawn.file, services, { op: 'set', layer: ids['b-job'], props: { x: deck.x, y: deck.y } })
    const tidy = await run(moved.file, services, { op: 'tidy', diagram: 'Proposal' })
    const pinned = byId(tidy.file, ids['b-job'])
    assert.deepEqual([pinned.x, pinned.y], [deck.x, deck.y], direction)
    assertClear(tidy.file, direction)
    // what was in the way moved along the flow
    const after = boxOf(byId(tidy.file, ids['a-deck']))
    const along = { down: after.y > deck.y, up: after.y < deck.y, right: after.x > deck.x, left: after.x < deck.x }[direction]
    assert.ok(along, `${direction}: a-deck moved along the flow`)
  }
  // with nothing pinned the layout is ELK's own, so tidy changes nothing
  const again = await run(first.file, services, { op: 'tidy', diagram: 'Proposal' })
  for (const l of all(first.file)) assert.deepEqual(boxOf(byId(again.file, l.id)), boxOf(l), l.name)
  assert.equal(again.result.note, undefined)
})

test('a failed ELK load is forgotten, so the next layout tries again', async () => {
  let calls = 0
  const load = onceRetrying(async () => {
    calls++
    if (calls === 1) throw new Error('ELK did not load')
    return `engine ${calls}`
  })
  await assert.rejects(load(), { message: 'ELK did not load' })
  assert.equal(await load(), 'engine 2')
  assert.equal(await load(), 'engine 2', 'a load that worked is kept')
  assert.equal(calls, 2)
})

test('parseDiagramText reads one node, box or link per line', () => {
  const spec = parseDiagramText(
    [
      'diagram Proposal',
      'direction down',
      '# a comment, and a blank line',
      '',
      'box shared: Shared agent',
      'box a: Client A',
      'box inner: Inner in a',
      'node agent: agent in shared',
      '  node a-job: job in a',
      'node a-deck: forecast and deck in a',
      'node login: Sign in',
      'node check: Check in time',
      'node bare',
      'a-job -> a-deck',
      'agent->a-job: runs it'
    ].join('\n')
  )
  assert.deepEqual(spec, {
    name: 'Proposal',
    direction: 'down',
    containers: [
      { id: 'shared', label: 'Shared agent' },
      { id: 'a', label: 'Client A' },
      { id: 'inner', label: 'Inner', in: 'a' }
    ],
    nodes: [
      { id: 'agent', label: 'agent', in: 'shared' },
      { id: 'a-job', label: 'job', in: 'a' },
      { id: 'a-deck', label: 'forecast and deck', in: 'a' },
      { id: 'login', label: 'Sign in' },
      { id: 'check', label: 'Check in time' },
      { id: 'bare', label: 'bare' }
    ],
    links: [
      { from: 'a-job', to: 'a-deck' },
      { from: 'agent', to: 'a-job', label: 'runs it' }
    ]
  })
  assert.throws(() => parseDiagramText('node a: A\nwhat is this'), { message: 'line 2: expected "node <id>: <label>", "box <id>: <label>" or "<from> -> <to>"' })
  assert.throws(() => parseDiagramText('a -> b -> c'), { message: 'line 1: one link per line: <from> -> <to> [: <label>]' })
  assert.throws(() => parseDiagramText('direction sideways'), { message: 'line 1: direction must be right, down, left or up' })
})

test('the diagram op takes text, and checks the spec before laying anything out', async () => {
  const { file, services } = await fresh()
  const text = 'box a: Client A\nnode job: job in a\nnode deck: forecast and deck in a\njob -> deck'
  const r = await run(file, services, { op: 'diagram', name: 'Flow', text })
  assert.equal(r.summary, 'drew diagram Flow (2 nodes, 1 box, 1 link)')
  assert.deepEqual(Object.keys(r.result.nodes), ['job', 'deck'])
  const bad: [unknown, string | RegExp][] = [
    [{ nodes: [{ id: 'x', label: 'X' }] }, 'diagram needs a name'],
    [{ name: 'D', nodes: [] }, 'A diagram needs at least one node'],
    [{ name: 'D', nodes: [{ id: 'x' }, { id: 'x' }] }, 'The id "x" is used twice'],
    [{ name: 'D', nodes: [{ id: 'x', in: 'nope' }] }, 'node "x" is in "nope", which is not a box'],
    [{ name: 'D', nodes: [{ id: 'x' }], links: [{ from: 'x', to: 'y' }] }, 'link 1: no node "y"'],
    [{ name: 'D', nodes: [{ id: 'x' }], containers: [{ id: 'p', in: 'q' }, { id: 'q', in: 'p' }] }, 'The box "p" is inside itself'],
    [{ name: 'D', direction: 'sideways', nodes: [{ id: 'x' }] }, 'direction must be right, down, left or up'],
    [{ name: 'D', nodes: [{ id: 'x', label: 'l'.repeat(1001) }] }, 'Labels can be at most 1,000 characters.'],
    [{ name: 'n'.repeat(1001), nodes: [{ id: 'x' }] }, 'Names can be at most 1,000 characters.'],
    [{ name: 'D', nodes: Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}` })) }, 'A diagram can have at most 1,000 nodes and boxes.'],
    ['{not json', /^spec must be JSON/]
  ]
  for (const [spec, message] of bad) {
    await assert.rejects(applyDesignOp(file, { op: 'diagram', spec }, services), { message }, JSON.stringify(spec).slice(0, 60))
  }
  await assert.rejects(applyDesignOp(file, { op: 'diagram', name: 'D', text: 'node x: X\nx -> y' }, services), { message: 'link 1: no node "y"' })
  await assert.rejects(applyDesignOp(file, { op: 'diagram', name: 'D' }, services), { message: 'diagram needs spec (JSON) or text' })
  // layout runs in node only: without it the op says so, and changes nothing
  await assert.rejects(applyDesignOp(file, { op: 'diagram', spec: proposal() }, { fonts: services.fonts }), {
    message: "Diagram layout isn't available here. Run this with the gdocs command or in gauzzaDocs."
  })
  await assert.rejects(applyDesignOp(file, { op: 'tidy', diagram: 'Nope' }, services), { message: 'No diagram "Nope" on Letter page' })
  // a layout past 100,000 px per side would be cut on reading, so it's refused
  const wide: OpServices = { ...services, layout: async g => ({ ...(await layoutDiagram(g)), width: 100_001 }) }
  await assert.rejects(applyDesignOp(file, { op: 'diagram', spec: proposal() }, wide), {
    message: /^That diagram would be 100001x\d+ px, and a diagram can be at most 100,000 px per side\. Split it, or try another direction\.$/
  })
  // the new layers count against the limits like any other op's
  const full = await fresh()
  const at = { visible: true, locked: false, opacity: 1, blend: 'normal' as const, x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 }
  full.file.design.artboards[0].layers.push(...Array.from({ length: 99_995 }, (_, i): Layer => ({ ...at, id: `r${i}`, name: 'R', type: 'rect' })))
  await assert.rejects(applyDesignOp(full.file, { op: 'diagram', name: 'D', text: 'node a: A\nnode b: B\na -> b' }, full.services), {
    message: "That would leave a design that can't be opened: it has more than 100,000 layers."
  })
})

test('layoutDiagram runs ELK in node with every node and edge placed in artboard terms', async () => {
  const graph = {
    id: 'root',
    layoutOptions: { 'elk.direction': 'RIGHT' },
    children: [
      { id: 'c0', children: [{ id: 'n0', width: 120, height: 48 }, { id: 'n1', width: 120, height: 48 }] },
      { id: 'n2', width: 120, height: 48 }
    ],
    edges: [
      { id: 'e0', sources: ['n0'], targets: ['n1'] },
      { id: 'e1', sources: ['n1'], targets: ['n2'] }
    ]
  }
  const out = await layoutDiagram(graph)
  assert.notEqual(out, graph, 'the graph given is left as it was')
  assert.equal((graph.children[0] as any).x, undefined)
  const c0 = out.children!.find(c => c.id === 'c0')!
  const n1 = c0.children!.find(c => c.id === 'n1')!
  const n2 = out.children!.find(c => c.id === 'n2')!
  // positions are on the root's terms, so a node in a box is placed inside it
  assert.ok(n1.x! >= c0.x! && n1.x! + n1.width! <= c0.x! + c0.width!)
  // an edge from inside the box to outside it starts at n1's right side and ends at n2's left
  const e1 = out.edges!.find(e => e.id === 'e1')!
  const s = e1.sections![0]
  assert.equal(s.startPoint.x, n1.x! + n1.width!)
  assert.equal(s.endPoint.x, n2.x!)
})
