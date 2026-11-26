import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fontsFor, type FontSource } from '../src/shared/design/fonts'
import { newDesign, walk } from '../src/shared/design/model'
import { designToSvg } from '../src/shared/design/render'
import type { Design, DesignFile, Layer } from '../src/shared/design/types'
import { describeOps } from '../src/shared/history/describe'
import { applyDesignOp, designOps } from '../src/shared/ops/design'
import type { AgentOp, FilePayload } from '../src/shared/types'

const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
const fontsOf = (d: Design): Promise<FontSource> => fontsFor(d, {}, async () => liberation, liberation)

/** A fresh design file and the services the ops get (fonts measuring with Liberation Sans). */
async function fresh(preset = 'instagram'): Promise<{ file: DesignFile; services: { fonts: FontSource } }> {
  const design = newDesign(preset)
  return { file: { design, assets: {} }, services: { fonts: await fontsOf(design) } }
}

/** Applies ops one after another, each one's file feeding the next; returns the last result and file. */
async function run(file: DesignFile, services: { fonts?: FontSource }, ...ops: AgentOp[]) {
  let f = file
  let last: Awaited<ReturnType<typeof applyDesignOp>> | null = null
  for (const op of ops) {
    last = await applyDesignOp(f, op, services)
    if (last.file) f = last.file
  }
  return { file: f, result: last!.result as any, summary: last!.summary }
}

const layers = (f: DesignFile, board = 0): Layer[] => f.design.artboards[board].layers
const all = (f: DesignFile, board = 0): Layer[] => {
  const out: Layer[] = []
  walk(layers(f, board), l => out.push(l))
  return out
}
const byName = (f: DesignFile, name: string): Layer => {
  const hit = all(f).find(l => l.name === name)
  assert.ok(hit, `no layer named ${name}`)
  return hit
}
const box = (l: Layer) => ({ x: l.x, y: l.y, width: l.width, height: l.height })

/** The first bytes of a PNG: signature and IHDR, enough for its header to say how big it is. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  b.set([8, 6, 0, 0, 0], 24)
  return b
}
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('add a rect and a text, then read lists both with their ids', async () => {
  const { file, services } = await fresh()
  const a = await applyDesignOp(file, { op: 'add', type: 'rect', props: { x: 10, y: 20, width: 100, height: 50 } }, services)
  assert.equal(a.summary, 'added Rectangle 1')
  const [rectId] = (a.result as { ids: string[] }).ids
  const b = await applyDesignOp(a.file!, { op: 'add', type: 'text', props: { text: 'Hello there', x: 40, y: 300, size: 32 } }, services)
  const [textId] = (b.result as { ids: string[] }).ids
  assert.notEqual(rectId, textId)
  const read = await applyDesignOp(b.file!, { op: 'read' }, services)
  assert.equal(read.file, undefined, 'read changes nothing')
  const r = read.result as { artboards: { id: string; name: string; width: number; height: number }[]; layers: string[] }
  assert.deepEqual(r.artboards.map(a => [a.name, a.width, a.height]), [['Instagram post', 1080, 1080]])
  assert.equal(r.layers.length, 2)
  assert.equal(r.layers[0], `${rectId}  Rectangle 1  rect  10,20 100x50`)
  assert.match(r.layers[1], new RegExp(`^${textId}  Text 1  text  40,300 \\d+(\\.\\d+)?x\\d+(\\.\\d+)?  "Hello there"`))
  // the defaults every new layer gets
  const rect = layers(b.file!)[0]
  assert.deepEqual(
    [rect.visible, rect.locked, rect.opacity, rect.blend, rect.rotation, rect.scaleX, rect.scaleY],
    [true, false, 1, 'normal', 0, 1, 1]
  )
  // the plain lines
  const text = (await applyDesignOp(b.file!, { op: 'read', format: 'text' }, services)).result as { content: string }
  assert.ok(text.content.includes(`  ${rectId}  Rectangle 1  rect  10,20 100x50`), text.content)
  // the input file was never touched
  assert.equal(file.design.artboards[0].layers.length, 0)
})

test('read indents children by depth and reports missing fonts and overflow on text lines', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'Card' } },
    { op: 'add', type: 'text', props: { name: 'Body', text: 'A long sentence that cannot fit', width: 60, height: 10, font: 'Nowhere Sans' } },
    { op: 'group', layers: ['Card', 'Body'], name: 'Panel' }
  )
  const lines = ((await applyDesignOp(f, { op: 'read' }, services)).result as { layers: string[] }).layers
  assert.match(lines[0], /^\S+  Panel  group  /)
  assert.match(lines[1], /^  \S+  Card  rect  /)
  assert.match(lines[2], /^  \S+  Body  text  .*"A long sentence that cannot fit"  missing font, overflow$/)
})

test('set --layer Title with two layers named "Title" fails, listing both ids', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(file, services, { op: 'add', type: 'rect', props: { name: 'Title' } }, { op: 'add', type: 'rect', props: { name: 'Title' } })
  const ids = layers(f).map(l => l.id)
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Title', props: { x: 5 } }, services), {
    message: `2 layers are named "Title": ${ids.join(', ')}`
  })
  // by id it works, and the summary names the layer
  const r = await applyDesignOp(f, { op: 'set', layer: ids[1], props: { x: 5 } }, services)
  assert.equal(r.summary, 'set x on Title')
  assert.equal(layers(r.file!)[1].x, 5)
})

test('set with part on an instance writes overrides[innerId].text', async () => {
  const { file, services } = await fresh()
  const inner: Layer = {
    id: 'lbl', name: 'Label', type: 'text', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 100,
    height: 40, rotation: 0, scaleX: 1, scaleY: 1, mode: 'box', align: 'left', valign: 'top',
    runs: [{ text: 'Node', font: { family: 'Liberation Sans', weight: 400, style: 'normal' }, size: 16 }]
  }
  file.design.components.push({
    id: 'node', name: 'Node',
    root: { id: 'root', name: 'Node', type: 'group', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 100, height: 40, rotation: 0, scaleX: 1, scaleY: 1, children: [inner] }
  })
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'instance', props: { component: 'Node', name: 'Step', x: 50, y: 60 } },
    { op: 'set', layer: 'Step', part: 'Label', props: { text: 'Collect' } }
  )
  const inst = byName(f, 'Step')
  assert.equal(inst.type, 'instance')
  assert.deepEqual(inst.type === 'instance' && inst.overrides, { lbl: { text: 'Collect' } })
  assert.deepEqual(box(inst), { x: 50, y: 60, width: 100, height: 40 })
  // a part takes only what an instance can override
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Step', part: 'Label', props: { x: 3 } }, services), /can override text, fill, stroke, visible and image/)
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Step', part: 'Nope', props: { text: 'x' } }, services), /No layer "Nope" in Node/)
  // overrides as a whole: {} resets them, and each one is checked like a part's
  const reset = await applyDesignOp(f, { op: 'set', layer: 'Step', props: { overrides: {} } }, services)
  const plain = byName(reset.file!, 'Step')
  assert.deepEqual(plain.type === 'instance' && Object.keys(plain.overrides), [])
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Step', props: { overrides: { lbl: { text: 5 } } } }, services), /text must be text/)
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Step', props: { overrides: { lbl: { x: 1 } } } }, services), /can override text/)
})

test('group then move into the group then ungroup keeps the boxes', async () => {
  const { file, services } = await fresh()
  const { file: f0 } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'A', x: 10, y: 10, width: 50, height: 50 } },
    { op: 'add', type: 'ellipse', props: { name: 'B', x: 100, y: 40, width: 30, height: 60 } },
    { op: 'add', type: 'rect', props: { name: 'C', x: 300, y: 5, width: 20, height: 20 } }
  )
  const before = Object.fromEntries(all(f0).map(l => [l.name, box(l)]))
  const g = await applyDesignOp(f0, { op: 'group', layers: ['A', 'B'], name: 'Pair' }, services)
  const gid = (g.result as { id: string }).id
  assert.equal(g.summary, 'grouped 2 layers')
  const group = layers(g.file!).find(l => l.id === gid)!
  assert.equal(group.type, 'group')
  assert.deepEqual(box(group), { x: 10, y: 10, width: 120, height: 90 })
  assert.deepEqual(layers(g.file!).map(l => l.name), ['Pair', 'C'])
  const m = await applyDesignOp(g.file!, { op: 'move', layer: 'C', to: { parent: 'Pair' } }, services)
  assert.equal(m.summary, 'moved C')
  const moved = layers(m.file!)
  assert.equal(moved.length, 1)
  assert.deepEqual(moved[0].type === 'group' && moved[0].children.map(l => l.name), ['A', 'B', 'C'])
  assert.deepEqual(box(moved[0]), { x: 10, y: 5, width: 310, height: 95 }, 'the group fits its children again')
  const u = await applyDesignOp(m.file!, { op: 'ungroup', layer: 'Pair' }, services)
  assert.deepEqual(layers(u.file!).map(l => l.name), ['A', 'B', 'C'])
  assert.deepEqual(Object.fromEntries(all(u.file!).map(l => [l.name, box(l)])), before)
  assert.deepEqual((u.result as { ids: string[] }).ids, layers(u.file!).map(l => l.id))
})

test('moving a group moves its children; front, back, forward and backward reorder', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'C' } },
    { op: 'add', type: 'rect', props: { name: 'D' } },
    { op: 'add', type: 'rect', props: { name: 'A', x: 0, y: 0, width: 10, height: 10 } },
    { op: 'add', type: 'rect', props: { name: 'B', x: 20, y: 0, width: 10, height: 10 } },
    { op: 'group', layers: ['A', 'B'], name: 'G' },
    { op: 'set', layer: 'G', props: { x: 100, y: 50 } }
  )
  assert.deepEqual([byName(f, 'A').x, byName(f, 'A').y, byName(f, 'B').x, byName(f, 'B').y], [100, 50, 120, 50])
  const order = async (layer: string, to: unknown) =>
    layers((await applyDesignOp(f, { op: 'move', layer, to }, services)).file!).map(l => l.name).join(' ')
  assert.equal(layers(f).map(l => l.name).join(' '), 'C D G')
  assert.equal(await order('C', 'front'), 'D G C')
  assert.equal(await order('G', 'back'), 'G C D')
  assert.equal(await order('C', 'forward'), 'D C G')
  assert.equal(await order('G', 'backward'), 'C G D')
  await assert.rejects(applyDesignOp(f, { op: 'move', layer: 'G', to: { parent: 'A' } }, services), /isn't a group/)
  await assert.rejects(applyDesignOp(f, { op: 'move', layer: 'G', to: 'sideways' }, services), /front, back, forward, backward/)
})

test('align left to artboard puts x at 0, and align and distribute work on the selection', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'A', x: 50, y: 10, width: 100, height: 20 } },
    { op: 'add', type: 'rect', props: { name: 'B', x: 300, y: 200, width: 40, height: 40 } },
    { op: 'add', type: 'rect', props: { name: 'C', x: 500, y: 70, width: 60, height: 10 } }
  )
  const left = await applyDesignOp(f, { op: 'align', layers: ['A'], edge: 'left', to: 'artboard' }, services)
  assert.equal(byName(left.file!, 'A').x, 0)
  assert.equal(left.summary, 'aligned A')
  const centers = await applyDesignOp(f, { op: 'align', layers: ['A', 'B', 'C'], edge: 'middle', to: 'selection' }, services)
  // the selection runs from y 10 to 240: its middle is 125
  assert.deepEqual(['A', 'B', 'C'].map(n => byName(centers.file!, n)).map(l => l.y + l.height / 2), [125, 125, 125])
  const right = await applyDesignOp(f, { op: 'align', layers: ['A', 'B'], edge: 'right', to: 'artboard' }, services)
  assert.deepEqual(['A', 'B'].map(n => byName(right.file!, n)).map(l => l.x + l.width), [1080, 1080])
  // distribute: the outer two stay, the gaps between them come out equal
  const spread = await applyDesignOp(f, { op: 'distribute', layers: ['C', 'A', 'B'], axis: 'x' }, services)
  const [a, b, c] = ['A', 'B', 'C'].map(n => byName(spread.file!, n))
  assert.deepEqual([a.x, c.x], [50, 500])
  assert.equal(b.x - (a.x + a.width), c.x - (b.x + b.width))
  await assert.rejects(applyDesignOp(f, { op: 'distribute', layers: ['A', 'B'], axis: 'x' }, services), /at least 3 layers/)
  await assert.rejects(applyDesignOp(f, { op: 'align', layers: ['A'], edge: 'diagonal' }, services), /left, center, right, top, middle or bottom/)
})

test('duplicate gives every copied layer a new id and keeps connectors inside the copy pointing inside it', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'From', x: 0, y: 0, width: 10, height: 10 } },
    { op: 'add', type: 'rect', props: { name: 'To', x: 100, y: 0, width: 10, height: 10 } },
    { op: 'add', type: 'connector', props: { name: 'Link', from: 'From', to: 'To' } },
    { op: 'group', layers: ['From', 'To', 'Link'], name: 'Flow' }
  )
  const d = await applyDesignOp(f, { op: 'duplicate', layer: 'Flow', dx: 0, dy: 200 }, services)
  const ids = (d.result as { ids: string[] }).ids
  assert.equal(ids.length, 1)
  const everyId = all(d.file!).map(l => l.id)
  assert.equal(new Set(everyId).size, everyId.length, 'ids stay unique')
  const copy = layers(d.file!).find(l => l.id === ids[0])!
  assert.ok(copy.type === 'group')
  const [from, to, link] = copy.children
  assert.deepEqual([from.y, to.y], [200, 200])
  assert.ok(link.type === 'connector')
  assert.deepEqual([link.from.layer, link.to.layer], [from.id, to.id])
  assert.equal(d.summary, 'duplicated Flow')
})

test('delete removes the layer and connectors left pointing at it; allArtboards matches by name on every artboard', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'Logo' } },
    { op: 'add', type: 'rect', props: { name: 'Other' } },
    { op: 'add', type: 'connector', props: { from: 'Logo', to: 'Other' } },
    { op: 'artboard', action: 'add', name: 'Story', size: 'story' },
    { op: 'add', artboard: 'Story', type: 'rect', props: { name: 'Logo' } }
  )
  const gone = await applyDesignOp(f, { op: 'delete', layer: 'Logo' }, services)
  assert.deepEqual(layers(gone.file!).map(l => l.name), ['Other'])
  assert.equal(layers(gone.file!, 1).length, 1, 'only the first artboard by default')
  const set = await applyDesignOp(f, { op: 'set', layer: 'Logo', allArtboards: true, props: { fill: '#ff0000' } }, services)
  assert.equal(set.summary, 'set fill on 2 layers')
  for (const board of [0, 1]) assert.deepEqual(layers(set.file!, board).find(l => l.name === 'Logo')!.fill, { type: 'color', color: '#ff0000' })
  const del = await applyDesignOp(f, { op: 'delete', layer: 'Logo', allArtboards: true }, services)
  assert.equal(del.summary, 'deleted 2 layers')
  assert.equal(layers(del.file!, 1).length, 0)
  await assert.rejects(applyDesignOp(f, { op: 'set', layer: 'Nope', allArtboards: true, props: { x: 1 } }, services), /No layer "Nope" on any artboard/)
})

test('apply with a bad third op leaves the design unchanged and reports "op 3: ..."', async () => {
  const { file, services } = await fresh()
  const snapshot = structuredClone(file.design)
  await assert.rejects(
    applyDesignOp(
      file,
      {
        op: 'apply',
        ops: [
          { op: 'add', type: 'rect', props: { name: 'One' } },
          { op: 'add', type: 'rect', props: { name: 'Two' } },
          { op: 'set', layer: 'Missing', props: { x: 1 } },
          { op: 'add', type: 'rect', props: { name: 'Four' } }
        ]
      },
      services
    ),
    { message: 'op 3: No layer "Missing" on Instagram post' }
  )
  assert.deepEqual(file.design, snapshot)
  // a good batch is one result and one summary
  const ok = await applyDesignOp(
    file,
    { op: 'apply', ops: [{ op: 'add', type: 'rect' }, { op: 'add', type: 'ellipse' }, { op: 'add', type: 'text', props: { text: 'Hi' } }] },
    services
  )
  assert.equal(ok.summary, 'added 3 layers')
  const results = (ok.result as { results: { ids: string[] }[] }).results
  assert.deepEqual(results.flatMap(r => r.ids), layers(ok.file!).map(l => l.id))
  assert.deepEqual(layers(ok.file!).map(l => l.name), ['Rectangle 1', 'Ellipse 1', 'Text 1'])
  const mixed = await applyDesignOp(
    ok.file!,
    { op: 'apply', ops: [{ op: 'add', type: 'rect' }, { op: 'set', layer: 'Ellipse 1', props: { fill: '#00ff00' } }, { op: 'move', layer: 'Text 1', to: 'back' }] },
    services
  )
  assert.equal(mixed.summary, 'added Rectangle 2, set fill on Ellipse 1 and moved Text 1')
  await assert.rejects(applyDesignOp(file, { op: 'apply', ops: 'nope' }, services), /apply needs ops/)
})

test('adding a 9000x9000 PNG is refused; a small one becomes an asset at its own size', async () => {
  const { file, services } = await fresh()
  const big = Buffer.from(pngHeader(9000, 9000)).toString('base64')
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: big } }, services), {
    message: "Images over 50 megapixels can't be placed."
  })
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: `data:image/png;base64,${big}` } }, services), /50 megapixels/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: 'aGVsbG8=' } }, services), /PNG, JPEG, GIF or WebP/)
  const r = await applyDesignOp(file, { op: 'add', type: 'image', props: { data: `data:image/png;base64,${PNG_1x1}`, x: 5, y: 6 } }, services)
  const img = layers(r.file!)[0]
  assert.ok(img.type === 'image')
  assert.match(img.asset, /^assets\/[0-9a-f]{64}\.png$/)
  assert.deepEqual(box(img), { x: 5, y: 6, width: 1, height: 1 })
  assert.ok(r.file!.assets[img.asset] instanceof Uint8Array)
  assert.deepEqual(file.assets, {}, 'the input keeps its assets')
})

test('artboard resize 9000x10 is refused; artboards are added, resized, renamed and deleted', async () => {
  const { file, services } = await fresh()
  await assert.rejects(applyDesignOp(file, { op: 'artboard', action: 'resize', size: '9000x10' }, services), {
    message: 'Artboards can be at most 8192 px per side.'
  })
  await assert.rejects(applyDesignOp(file, { op: 'artboard', action: 'add', size: { width: 10, height: 9000 } }, services), /at most 8192/)
  const { file: f } = await run(
    file,
    services,
    { op: 'artboard', action: 'add', name: 'Wide', size: 'x' },
    { op: 'artboard', action: 'resize', artboard: 'Wide', size: '800x400' },
    { op: 'artboard', action: 'rename', artboard: 'Wide', name: 'Banner' }
  )
  assert.deepEqual(f.design.artboards.map(a => [a.name, a.width, a.height]), [['Instagram post', 1080, 1080], ['Banner', 800, 400]])
  const del = await applyDesignOp(f, { op: 'artboard', action: 'delete', artboard: 'Instagram post' }, services)
  assert.deepEqual(del.file!.design.artboards.map(a => a.name), ['Banner'])
  assert.equal(del.summary, 'deleted artboard Instagram post')
  await assert.rejects(applyDesignOp(del.file!, { op: 'artboard', action: 'delete' }, services), /at least one artboard/)
})

test('describeOps reads design ops in plain words', () => {
  assert.equal(describeOps(['add'], 'design'), 'Added layers')
  assert.equal(describeOps(['add', 'set', 'move', 'add'], 'design'), 'Added layers, changed layers and moved layers')
  assert.equal(describeOps(['set'], 'sheet'), 'Changed cells', 'other kinds keep their words')
})

test('a color style fills a rect, and changing the style later changes the rect', async () => {
  const { file, services } = await fresh()
  const { file: f, summary } = await run(
    file,
    services,
    { op: 'style', color: 'Brand=#1a73e8' },
    { op: 'add', type: 'rect', props: { name: 'Box', fill: { type: 'style', ref: 'Brand' } } },
    { op: 'add', type: 'rect', props: { name: 'Other', fill: 'style:Brand' } }
  )
  assert.equal(summary, 'added Other')
  assert.deepEqual(byName(f, 'Other').fill, { type: 'style', ref: 'Brand' })
  const draw = (d: DesignFile) => designToSvg(d.design, d.design.artboards[0].id, { fonts: services.fonts, assets: {}, mode: 'export' })
  assert.equal(draw(f).match(/fill="#1a73e8"/g)?.length, 2)
  const changed = await applyDesignOp(f, { op: 'style', color: { name: 'Brand', color: '#FF0000' } }, services)
  assert.equal(changed.summary, 'changed style Brand')
  assert.equal(draw(changed.file!).match(/fill="#ff0000"/g)?.length, 2)
  assert.doesNotMatch(draw(changed.file!), /#1a73e8/)
  // a text style, a missing style and removing one
  const t = await applyDesignOp(changed.file!, { op: 'style', text: { name: 'Heading', run: { font: { family: 'Liberation Sans', weight: 700, style: 'normal' }, size: 48 } } }, services)
  assert.deepEqual(t.file!.design.styles.text.map(s => s.name), ['Heading'])
  await assert.rejects(applyDesignOp(f, { op: 'add', type: 'rect', props: { fill: 'style:Nope' } }, services), /No color style "Nope"/)
  // a style in use can't be removed (Ruling 16): the layers using it are listed
  const ids = ['Box', 'Other'].map(n => byName(t.file!, n).id)
  await assert.rejects(applyDesignOp(t.file!, { op: 'style', remove: 'Brand' }, services), {
    message: `Layers use the style "Brand": ${ids.join(', ')}. Change their colors first.`
  })
  const freed = await run(t.file!, services, { op: 'set', layer: 'Box', props: { fill: '#000000' } }, { op: 'set', layer: 'Other', props: { fill: null } })
  const removed = await applyDesignOp(freed.file, { op: 'style', remove: 'Brand' }, services)
  assert.deepEqual(removed.file!.design.styles.colors, [])
  await assert.rejects(applyDesignOp(file, { op: 'style', color: 'Brand=blue' }, services), /#rrggbb/)
})

test('svg imports cleaned SVG as a group with new ids and gives SVG back', async () => {
  const { file, services } = await fresh()
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><script>alert(1)</script><rect id="r" width="40" height="20" fill="#336699"/><circle cx="70" cy="25" r="10"/></svg>'
  const r = await applyDesignOp(file, { op: 'svg', svg, name: 'Mark', x: 200, y: 100 }, services)
  const res = r.result as { id: string; removed: string[]; kept: string[] }
  assert.ok(res.removed.includes('a script'), JSON.stringify(res.removed))
  assert.equal(r.summary, 'imported SVG as Mark')
  const group = layers(r.file!)[0]
  assert.equal(group.id, res.id)
  assert.deepEqual([group.name, group.type, group.x, group.y], ['Mark', 'group', 200, 100])
  const everyId = all(r.file!).map(l => l.id)
  assert.equal(new Set(everyId).size, everyId.length)
  const got = await applyDesignOp(r.file!, { op: 'svg', get: 'Mark' }, services)
  assert.equal(got.file, undefined)
  const out = (got.result as { svg: string }).svg
  assert.match(out, /^<svg /)
  assert.match(out, /#336699/)
  assert.doesNotMatch(out, /script/)
  const whole = (await applyDesignOp(r.file!, { op: 'svg', get: true }, services)).result as { svg: string }
  assert.match(whole.svg, /width="1080"/)
})

test('add and set check their properties and keep ids unique', async () => {
  const { file, services } = await fresh()
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'star' }, services), /type must be one of/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: { colour: 'red' } }, services), /Unknown property "colour"/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: { x: 'left' } }, services), /x must be a number/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: { fill: 'reddish' } }, services), /fill must be/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'path' }, services), /path needs d/)
  await assert.rejects(applyDesignOp(file, { op: 'frobnicate' }, services), /Unknown op "frobnicate" for designs/)
  const ops: AgentOp[] = Array.from({ length: 30 }, () => ({ op: 'add', type: 'rect' }))
  const { file: f } = await run(file, services, ...ops)
  const ids = all(f).map(l => l.id)
  assert.equal(new Set(ids).size, 30)
  assert.equal(byName(f, 'Rectangle 30').type, 'rect')
  // a text layer's text, font and size, and a path's data
  const t = await run(file, services, { op: 'add', type: 'text', props: { name: 'T', text: 'Hi', font: { family: 'Liberation Sans', weight: 700 }, size: 40, color: '#123456' } }, { op: 'set', layer: 'T', props: { text: 'Bye', size: 20 } })
  const tl = byName(t.file, 'T')
  assert.ok(tl.type === 'text')
  assert.deepEqual(tl.runs.map(r => [r.text, r.size, r.font.family, r.font.weight, r.color]), [['Bye', 20, 'Liberation Sans', 700, { type: 'color', color: '#123456' }]])
  const p = await run(file, services, { op: 'add', type: 'path', props: { name: 'P', d: 'M0 0L10 10', width: 10, height: 10 } }, { op: 'set', layer: 'P', props: { width: 20 } })
  const pl = byName(p.file, 'P')
  assert.ok(pl.type === 'path')
  assert.equal(pl.d, 'M0 0L20 10', 'resizing a path scales its data to the box')
})

test('resizing a group scales what it holds; ungrouping carries its rotation and opacity onto its children', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'A', x: 0, y: 0, width: 10, height: 10 } },
    { op: 'add', type: 'path', props: { name: 'P', x: 20, y: 0, d: 'M0 0L10 10' } },
    { op: 'group', layers: ['A', 'P'], name: 'G' },
    { op: 'set', layer: 'G', props: { width: 60, height: 20 } }
  )
  assert.deepEqual(box(byName(f, 'A')), { x: 0, y: 0, width: 20, height: 20 })
  const p = byName(f, 'P')
  assert.deepEqual(box(p), { x: 40, y: 0, width: 20, height: 20 })
  assert.equal(p.type === 'path' && p.d, 'M0 0L20 20')
  const turned = await run(f, services, { op: 'set', layer: 'G', props: { rotation: 180, opacity: 0.5 } }, { op: 'ungroup', layer: 'G' })
  // turned half way about the group's center (30, 10): A's center (10, 10) lands at (50, 10)
  const a = byName(turned.file, 'A')
  assert.deepEqual([a.x, a.y, a.rotation, a.opacity], [40, 0, 180, 0.5])
})

test('a fill on text replaces its run colors, and ops work without fonts by estimating text', async () => {
  const { file } = await fresh()
  const { file: f } = await run(file, {}, { op: 'add', type: 'text', props: { name: 'T', text: 'Hello', size: 20, color: '#ff0000' } }, { op: 'set', layer: 'T', props: { fill: '#00ff00' } })
  const t = byName(f, 'T')
  assert.ok(t.type === 'text')
  assert.deepEqual([t.fill, t.runs[0].color], [{ type: 'color', color: '#00ff00' }, undefined])
  assert.ok(t.width > 0 && t.height > 0, 'estimated size')
  const lines = ((await applyDesignOp(f, { op: 'read' })).result as { layers: string[] }).layers
  assert.match(lines[0], /^\S+  T  text  0,0 \S+  "Hello"$/)
  await assert.rejects(applyDesignOp(f, { op: 'svg', get: 'T' }), /needs fonts/)
})

test('an apply batch takes its artboard as the default for every op in it', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(file, services, { op: 'artboard', action: 'add', name: 'Second' })
  const r = await applyDesignOp(f, { op: 'apply', artboard: 'Second', ops: [{ op: 'add', type: 'rect' }, { op: 'add', type: 'rect', artboard: 'Instagram post' }] }, services)
  assert.deepEqual([layers(r.file!, 0).length, layers(r.file!, 1).length], [1, 1])
  const text = (await applyDesignOp(r.file!, { op: 'read', format: 'text', allArtboards: true }, services)).result as { content: string }
  assert.match(text.content, /Layers on Instagram post:\n {2}\S+ {2}Rectangle 1 {2}rect/)
  assert.match(text.content, /Layers on Second:\n {2}\S+ {2}Rectangle 1 {2}rect/)
})

// Fix round 1 (Ruling 16)

/** A design with a component "Node" holding a text layer "lbl" and a rect "bg", instanced once as "Step". */
async function withNode() {
  const { file, services } = await fresh()
  const part = (id: string, type: 'rect' | 'text'): Layer =>
    type === 'text'
      ? { id, name: id, type, visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 100, height: 40, rotation: 0, scaleX: 1, scaleY: 1, mode: 'box', align: 'left', valign: 'top', runs: [{ text: 'Node', font: { family: 'Liberation Sans', weight: 400, style: 'normal' }, size: 16 }] }
      : { id, name: id, type, visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 100, height: 40, rotation: 0, scaleX: 1, scaleY: 1 }
  const comp = (id: string, name: string, kids: Layer[]) => ({
    id, name, root: { id: `${id}-root`, name, type: 'group' as const, visible: true, locked: false, opacity: 1, blend: 'normal' as const, x: 0, y: 0, width: 100, height: 40, rotation: 0, scaleX: 1, scaleY: 1, children: kids }
  })
  file.design.components.push(comp('node', 'Node', [part('lbl', 'text'), part('bg', 'rect')]), comp('pill', 'Pill', [part('cap', 'text')]))
  const { file: f } = await run(file, services, { op: 'add', type: 'instance', props: { component: 'Node', name: 'Step' } })
  return { file: f, services }
}

test('ungroup refuses while connectors are attached to the group', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'A' } },
    { op: 'add', type: 'rect', props: { name: 'B', x: 200 } },
    { op: 'group', layers: ['A'], name: 'G' },
    { op: 'add', type: 'connector', props: { name: 'Link', from: 'G', to: 'B' } }
  )
  const link = byName(f, 'Link').id
  await assert.rejects(applyDesignOp(f, { op: 'ungroup', layer: 'G' }, services), { message: `Connectors are attached to G: ${link}. Detach or delete them first.` })
  const { file: f2 } = await run(f, services, { op: 'delete', layer: 'Link' }, { op: 'ungroup', layer: 'G' })
  assert.deepEqual(layers(f2).map(l => l.name), ['A', 'B'])
})

test('overrides are keyed only by the component layers, never reach a prototype, and reset with a new component', async () => {
  const { file, services } = await withNode()
  // a __proto__ key, as JSON.parse makes it, is refused like any key that isn't a layer of the component
  const hostile = JSON.parse('{"__proto__": {"text": "x"}}')
  await assert.rejects(applyDesignOp(file, { op: 'set', layer: 'Step', props: { overrides: hostile } }, services), { message: 'No layer __proto__ in component Node.' })
  await assert.rejects(applyDesignOp(file, { op: 'set', layer: 'Step', props: { overrides: { nope: { text: 'x' } } } }, services), { message: 'No layer nope in component Node.' })
  await assert.rejects(applyDesignOp(file, { op: 'set', layer: 'Step', props: JSON.parse('{"__proto__": {"x": 1}}') }, services), /Unknown property "__proto__"/)
  assert.equal(({} as Record<string, unknown>).text, undefined, 'no prototype was touched')
  const ok = await applyDesignOp(file, { op: 'set', layer: 'Step', props: { overrides: { lbl: { text: 'Go' }, bg: { fill: '#ff0000' } } } }, services)
  const step = byName(ok.file!, 'Step')
  assert.ok(step.type === 'instance')
  assert.equal(Object.getPrototypeOf(step.overrides), null)
  assert.deepEqual({ ...step.overrides }, { lbl: { text: 'Go' }, bg: { fill: { type: 'color', color: '#ff0000' } } })
  // another component: the old overrides go, and the reply says so; overrides given with it are checked against it
  const swapped = await applyDesignOp(ok.file!, { op: 'set', layer: 'Step', props: { component: 'Pill' } }, services)
  const pill = byName(swapped.file!, 'Step')
  assert.ok(pill.type === 'instance')
  assert.deepEqual([pill.component, Object.keys(pill.overrides)], ['pill', []])
  assert.equal((swapped.result as { note?: string }).note, 'The overrides were reset for the new component.')
  const both = await applyDesignOp(ok.file!, { op: 'set', layer: 'Step', props: { component: 'Pill', overrides: { cap: { text: 'Hi' } } } }, services)
  const capped = byName(both.file!, 'Step')
  assert.deepEqual(capped.type === 'instance' && { ...capped.overrides }, { cap: { text: 'Hi' } })
  assert.equal((both.result as { note?: string }).note, undefined)
  await assert.rejects(applyDesignOp(ok.file!, { op: 'set', layer: 'Step', props: { component: 'Pill', overrides: { lbl: { text: 'x' } } } }, services), { message: 'No layer lbl in component Pill.' })
})

test('apply refuses more than 1,000 ops, nested applies and ops that are not ops', async () => {
  const { file, services } = await fresh()
  const many = Array.from({ length: 1001 }, () => ({ op: 'add', type: 'rect' }))
  await assert.rejects(applyDesignOp(file, { op: 'apply', ops: many }, services), /at most 1,000 ops/)
  const thousand = await applyDesignOp(file, { op: 'apply', ops: many.slice(1) }, services)
  assert.equal(layers(thousand.file!).length, 1000)
  await assert.rejects(applyDesignOp(file, { op: 'apply', ops: [{ op: 'add', type: 'rect' }, { op: 'apply', ops: [] }] }, services), { message: "op 2: apply can't hold another apply" })
  for (const bad of [null, 7, 'add', ['add'], { type: 'rect' }, { op: 5 }]) {
    await assert.rejects(applyDesignOp(file, { op: 'apply', ops: [{ op: 'add', type: 'rect' }, bad] }, services), { message: 'op 2: each op needs an op name' }, JSON.stringify(bad))
  }
  // hostile shapes in an op's own fields
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: [1, 2] }, services), /props must be an object/)
  await assert.rejects(applyDesignOp(file, { op: 'set', layer: 5, props: { x: 1 } }, services), /Name a layer/)
  await assert.rejects(applyDesignOp(file, { op: 'group', layers: { a: 1 } }, services), /needs layers/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: { timing: [1, 2] } }, services), /timing must be/)
})

test('a group never moves inside itself', async () => {
  const { file, services } = await fresh()
  const { file: f } = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'A' } },
    { op: 'group', layers: ['A'], name: 'Inner' },
    { op: 'group', layers: ['Inner'], name: 'Outer' }
  )
  await assert.rejects(applyDesignOp(f, { op: 'move', layer: 'Outer', to: { parent: 'Inner' } }, services), { message: "A group can't go inside itself" })
  await assert.rejects(applyDesignOp(f, { op: 'move', layer: 'Inner', to: { parent: 'Inner' } }, services), { message: "A group can't go inside itself" })
})

test('timing keeps only start and end, coordinates and sizes are clamped, and summaries cut long names', async () => {
  const { file, services } = await fresh()
  const t = await applyDesignOp(file, { op: 'add', type: 'rect', props: { name: 'T', timing: { start: 1, end: 3, tracks: [1], in: 'x' } } }, services)
  assert.deepEqual(byName(t.file!, 'T').timing, { start: 1, end: 3 })
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'rect', props: { timing: { start: 4, end: 2 } } }, services), { message: 'timing start must be at or before its end' })
  const far = await run(
    file,
    services,
    { op: 'add', type: 'rect', props: { name: 'Far', x: 1e9, y: -1e12, width: 1e9, height: 5, strokeWidth: 1e9 } },
    { op: 'add', type: 'text', props: { name: 'Big', text: 'Hi', size: 1e9 } }
  )
  const r = byName(far.file, 'Far')
  assert.deepEqual([r.x, r.y, r.width, r.height, r.strokeWidth], [1e7, -1e7, 1e5, 5, 1e5])
  const big = byName(far.file, 'Big')
  assert.equal(big.type === 'text' && big.runs[0].size, 1e5)
  const long = 'A very long layer name that keeps going and going'
  const s = await applyDesignOp(file, { op: 'add', type: 'rect', props: { name: long } }, services)
  assert.equal(s.summary, `added ${long.slice(0, 37)}...`)
  const a = await applyDesignOp(file, { op: 'artboard', action: 'add', name: long }, services)
  assert.equal(a.summary, `added artboard ${long.slice(0, 37)}...`)
})

test('JPEG, GIF and WebP headers are read for their size, and a truncated header is refused', async () => {
  const { file, services } = await fresh()
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
  const jpeg = (w: number, h: number) => {
    const b = new Uint8Array(32)
    b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3])
    return b
  }
  const gif = (w: number, h: number) => {
    const b = new Uint8Array(16)
    b.set([...'GIF89a'].map(c => c.charCodeAt(0)))
    b.set([w & 255, w >> 8, h & 255, h >> 8], 6)
    return b
  }
  const webp = (w: number, h: number) => {
    const b = new Uint8Array(32)
    b.set([...'RIFF'].map(c => c.charCodeAt(0)))
    b.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8)
    b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 24)
    return b
  }
  for (const [label, bytes, ext, w, h] of [['jpeg', jpeg(640, 480), 'jpg', 640, 480], ['gif', gif(32, 16), 'gif', 32, 16], ['webp', webp(300, 200), 'webp', 300, 200]] as const) {
    const r = await applyDesignOp(file, { op: 'add', type: 'image', props: { data: b64(bytes) } }, services)
    const img = layers(r.file!)[0]
    assert.ok(img.type === 'image', label)
    assert.match(img.asset, new RegExp(`^assets/[0-9a-f]{64}\\.${ext}$`), label)
    assert.deepEqual([img.width, img.height], [w, h], label)
  }
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: b64(jpeg(9000, 9000)) } }, services), { message: "Images over 50 megapixels can't be placed." })
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: b64(webp(16384, 16384)) } }, services), /50 megapixels/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: b64(pngHeader(10, 10).slice(0, 20)) } }, services), /PNG, JPEG, GIF or WebP/)
  await assert.rejects(applyDesignOp(file, { op: 'add', type: 'image', props: { data: b64(gif(10, 10).slice(0, 8)) } }, services), /PNG, JPEG, GIF or WebP/)
})

test('designOps works on a design payload and refuses others', async () => {
  const { file, services } = await fresh()
  const payload = { kind: 'design', file } as FilePayload
  const r = await designOps(payload, { op: 'add', type: 'rect' }, { path: 'x.gdesign', services })
  assert.ok(r.payload && r.payload.kind === 'design')
  assert.equal(r.payload.file.design.artboards[0].layers.length, 1)
  assert.equal(r.summary, 'added Rectangle 1')
  const read = await designOps(payload, { op: 'read' }, { path: 'x.gdesign' })
  assert.equal(read.payload, undefined)
  await assert.rejects(async () => designOps({ kind: 'text', text: '' }, { op: 'read' }, { path: 'x.txt' }), /not a design/)
})
