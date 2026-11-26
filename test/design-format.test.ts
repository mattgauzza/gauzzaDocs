import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import JSZip from 'jszip'
import { assetName, designZipBytes, readDesignZip } from '../src/core/formats/design'
import { fontsFor } from '../src/shared/design/fonts'
import { newDesign, newId, resolveLayer, walk } from '../src/shared/design/model'
import { type Downgrade, designToSvg } from '../src/shared/design/render'
import type { Design, DesignFile, Layer } from '../src/shared/design/types'
import { validateDesign } from '../src/shared/design/validate'

const base = {
  visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 10, height: 10,
  rotation: 0, scaleX: 1, scaleY: 1
} as const
const rect = (id: string, name: string): Layer => ({ ...base, id, name, type: 'rect', fill: { type: 'color', color: '#ff0000' } })
const font = { family: 'Inter', weight: 400, style: 'normal' as const }

function richFile(): DesignFile {
  const design = newDesign('instagram')
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5])
  const asset = assetName(png, 'png')
  design.artboards[0].layers = [
    rect('r1', 'Box'),
    { ...base, id: 't1', name: 'Title', type: 'text', mode: 'box', align: 'left', valign: 'top', runs: [{ text: 'Hello', font, size: 48 }] },
    { ...base, id: 'g1', name: 'Group', type: 'group', children: [rect('c1', 'A'), { ...base, id: 'i1', name: 'Pic', type: 'image', asset, fit: 'cover' }] }
  ]
  return { design, assets: { [asset]: png } }
}

test('newDesign makes presets, logo and custom sizes', () => {
  const d = newDesign('instagram')
  assert.equal(d.artboards.length, 1)
  assert.equal(d.artboards[0].width, 1080)
  assert.equal(d.artboards[0].height, 1080)
  assert.equal(d.artboards[0].name, 'Instagram post')
  assert.deepEqual(d.artboards[0].background, { type: 'color', color: '#ffffff' })
  assert.equal(d.format, 1)
  assert.deepEqual(d.components, [])
  assert.deepEqual(d.styles, { colors: [], text: [] })
  assert.equal(newDesign('logo').artboards[0].background, null)
  const c = newDesign('640x480').artboards[0]
  assert.equal(c.width, 640)
  assert.equal(c.name, '640x480')
  assert.throws(() => newDesign('poster'), /Unknown size "poster"\. Use one of: instagram, .*or <w>x<h>/)
  assert.throws(() => newDesign('9000x100'), /Artboards can be at most 8192 px per side\./)
  assert.notEqual(newDesign('x').id, newDesign('x').id)
})

test('newId is eight base36 characters and avoids taken ids', () => {
  assert.match(newId(), /^[0-9a-z]{8}$/)
  const taken = new Set<string>()
  for (let i = 0; i < 500; i++) newId(taken)
  assert.equal(taken.size, 500)
})

test('round trip keeps the design and stores assets uncompressed', async () => {
  const f = richFile()
  const bytes = await designZipBytes(f)
  const back = await readDesignZip(bytes)
  assert.deepEqual(back.design, f.design)
  assert.deepEqual(back.assets, f.assets)
  const zip = await JSZip.loadAsync(bytes)
  const name = Object.keys(f.assets)[0]
  assert.equal((zip.files[name] as unknown as { _data: { compression: { magic: string } } })._data.compression.magic, '\x00\x00')
  assert.equal((zip.files['design.json'] as unknown as { _data: { compression: { magic: string } } })._data.compression.magic, '\x08\x00')
})

test('saving with a base copies missing assets and drops unreferenced ones', async () => {
  const f = richFile()
  const thumb = new Uint8Array([1, 2, 3])
  const onDisk = await designZipBytes({ ...f, thumbnail: thumb })
  const stray = assetName(new Uint8Array([9]), 'png')
  const next = await designZipBytes({ design: f.design, assets: { [stray]: new Uint8Array([9]) } }, onDisk)
  const back = await readDesignZip(next)
  assert.deepEqual(Object.keys(back.assets), Object.keys(f.assets))
  assert.deepEqual(back.thumbnail, thumb)
})

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip()
  for (const [k, v] of Object.entries(files)) z.file(k, v)
  return z.generateAsync({ type: 'nodebuffer' })
}

test('hostile zips: too many entries', async () => {
  const z = new JSZip()
  z.file('design.json', JSON.stringify(newDesign('x')))
  for (let i = 0; i < 10_000; i++) z.file(`junk/${i}.txt`, '')
  const bytes = await z.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(readDesignZip(bytes), /too many entries/)
})

test('hostile zips: a declared size over 1 GB is refused before inflating', async () => {
  const buf = Buffer.from(await zipOf({ 'design.json': JSON.stringify(newDesign('x')) }))
  let patched = 0
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      buf.writeUInt32LE(0xfffffff0, i + 24)
      patched++
    }
  }
  assert.equal(patched, 1)
  await assert.rejects(readDesignZip(buf), /too large/)
})

test('hostile zips: a deflate bomb that declares a small size is stopped while inflating', async () => {
  const z = new JSZip()
  z.file('design.json', ' '.repeat(70 * 1024 * 1024), { compression: 'DEFLATE' })
  const buf = Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  assert.ok(buf.length < 1024 * 1024)
  for (let i = 0; i + 46 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) buf.writeUInt32LE(100, i + 24)
  const before = process.memoryUsage().arrayBuffers
  await assert.rejects(readDesignZip(buf), /too large.*design\.json is over 64 MB/)
  // Aborted at the cap: far less than the 70 MB the entry really holds is left behind.
  assert.ok(process.memoryUsage().arrayBuffers - before < 70 * 1024 * 1024)
})

test('reading refuses artboards over 8192 px', async () => {
  const d = newDesign('x')
  d.artboards[0].width = 9000
  await assert.rejects(readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) })), /Artboards can be at most 8192 px per side\./)
})

test('saving refuses a missing asset and a malformed pointer', async () => {
  const d = newDesign('x')
  const ghost = `assets/${'a'.repeat(64)}.png`
  d.artboards[0].layers = [{ ...base, id: 'p1', name: 'Pic', type: 'image', asset: ghost }]
  await assert.rejects(designZipBytes({ design: d, assets: {} }), new RegExp(`Asset ${ghost} is missing\\.`))
  d.artboards[0].layers = [{ ...base, id: 'p2', name: 'Pic', type: 'image', asset: '../secret.png' }]
  await assert.rejects(designZipBytes({ design: d, assets: {} }), /Layer p2 points outside assets\//)
})

test('hostile zips: entries outside the format are ignored', async () => {
  const bytes = await zipOf({
    'design.json': JSON.stringify(newDesign('x')),
    '../../x.txt': 'no',
    'assets/../../x': 'no',
    '/abs.txt': 'no',
    'other.txt': 'no'
  })
  const back = await readDesignZip(bytes)
  assert.deepEqual(back.assets, {})
  assert.equal(back.thumbnail, undefined)
})

test('a layer pointing outside assets/ is refused', async () => {
  const d: Design = newDesign('x')
  d.artboards[0].layers = [{ ...base, id: 'bad1', name: 'Pic', type: 'image', asset: '../secret.png' }]
  await assert.rejects(readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) })), /Layer bad1 points outside assets\//)
  d.artboards[0].layers = [{ ...base, id: 'bad2', name: 'P', type: 'paint', asset: 'assets/abc.png' }]
  await assert.rejects(readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) })), /Layer bad2 points outside assets\//)
  d.artboards[0].layers = [{ ...base, id: 'bad3', name: 'T', type: 'text', mode: 'point', align: 'left', valign: 'top',
    runs: [{ text: 'a', font: { ...font, asset: '/etc/passwd' }, size: 10 }] }]
  await assert.rejects(readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) })), /Layer bad3 points outside assets\//)
  // (an override must name a layer of its component, or validation drops it before the asset is looked at)
  d.components = [{ id: 'c', name: 'C', root: { ...base, id: 'cg', name: 'G', type: 'group', children: [{ ...base, id: 'x', name: 'X', type: 'image', asset: `assets/${'a'.repeat(64)}.png` }] } }]
  d.artboards[0].layers = [{ ...base, id: 'bad4', name: 'I', type: 'instance', component: 'c', overrides: { x: { asset: '../y' } } }]
  await assert.rejects(readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) })), /Layer bad4 points outside assets\//)
})

test('resolveLayer matches id, name and path, and reports ambiguity', () => {
  const d = newDesign('x')
  const ab = d.artboards[0].id
  d.artboards[0].layers = [
    rect('a1', 'Title'),
    rect('a2', 'Title'),
    { ...base, id: 'g1', name: 'Group', type: 'group', children: [rect('c1', 'Child')] }
  ]
  assert.throws(() => resolveLayer(d, ab, 'Title'), (e: Error) => /2 layers are named "Title"/.test(e.message) && e.message.includes('a1') && e.message.includes('a2'))
  assert.equal(resolveLayer(d, ab, 'a2').id, 'a2')
  assert.equal(resolveLayer(d, ab, 'Group/Child').id, 'c1')
  assert.equal(resolveLayer(d, ab, 'Child').id, 'c1')
  assert.throws(() => resolveLayer(d, ab, 'Nope'), /No layer "Nope" on X post/)
  const seen: string[] = []
  walk(d.artboards[0].layers, (l, parent, path) => seen.push(`${l.id}:${parent?.id ?? '-'}:${path.join('/')}`))
  assert.deepEqual(seen, ['a1:-:Title', 'a2:-:Title', 'g1:-:Group', 'c1:g1:Group/Child'])
})

// Ruling 18: design.json is validated on read

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A design as a file could hold it: anything JSON can say. */
const rawDesign = (layers: any[], more: Record<string, unknown> = {}): any => ({ ...JSON.parse(JSON.stringify(newDesign('instagram'))), ...more, artboards: [{ id: 'ab', name: 'Board', width: 1080, height: 1080, background: null, layers }] })
const rrect = (id: any, name: any = 'R', extra: Record<string, unknown> = {}): any => ({ ...base, id, name, type: 'rect', fill: { type: 'color', color: '#ff0000' }, ...extra })
const BAD = () => JSON.parse('{"toString":1}')
const damaged = (re: string | RegExp) => (e: Error) => e.message.startsWith('This design file is damaged: ') && (typeof re === 'string' ? e.message.includes(re) : re.test(e.message))
const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
/** designToSvg in both modes: it must never throw, and stay within its budget. */
async function drawBoth(f: { design: Design; assets: Record<string, Uint8Array> }): Promise<{ out: string; downgrades: Downgrade[] }[]> {
  const fonts = await fontsFor(f.design, f.assets, async () => liberation, liberation)
  return (['raster', 'export'] as const).map(mode => {
    const downgrades: Downgrade[] = []
    const out = designToSvg(f.design, f.design.artboards[0].id, { fonts, assets: f.assets, mode, downgrades })
    assert.ok(out.length <= 128 * 1024 * 1024 + 1_000_000, `${mode}: ${out.length}`)
    return { out, downgrades }
  })
}

test('validateDesign keeps a well-formed design exactly as it is', () => {
  const f = richFile()
  const d = f.design
  d.components = [{ id: 'comp', name: 'Card', root: { ...base, id: 'croot', name: 'Card', type: 'group', children: [{ ...base, id: 'ct', name: 'Label', type: 'text', mode: 'box', align: 'left', valign: 'top', runs: [{ text: 'x', font, size: 12 }] }] } }]
  d.artboards[0].layers.push(
    { ...base, id: 'inst', name: 'Card 1', type: 'instance', component: 'comp', overrides: { ct: { text: 'Hello' } } },
    { ...base, id: 'conn', name: 'Link', type: 'connector', from: { layer: 'r1' }, to: { layer: 'inst', side: 'left' }, route: 'orthogonal', arrow: 'both', label: 'go' },
    { ...base, id: 'p1', name: 'Wave', type: 'path', d: 'M0 0L10 10', fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#ffffff80' }] }, dash: [2, 1], timing: { start: 0, end: 2 } }
  )
  d.styles = { colors: [{ name: 'Brand', color: '#1a73e8' }], text: [{ name: 'H1', run: { font, size: 48 } }] }
  const notes: string[] = []
  const out = validateDesign(JSON.parse(JSON.stringify(d)), notes)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(JSON.stringify(d)))
  assert.deepEqual(notes, [])
})

test('validateDesign keeps what a later release wrote: it round-trips through readDesignZip and designZipBytes unchanged', async () => {
  // timing effects and keyframe tracks, an artboard animation, a diagram, a brand kit, and fields this release doesn't
  // know on a layer, a run, a paint, an override, the artboard and the design itself
  const d: any = JSON.parse(JSON.stringify(newDesign('instagram')))
  d.future = { x: 1 }
  d.kit = { kitId: 'brand', items: [{ itemId: 'logo', name: 'Logo', copy: { layers: [1, 2] }, later: true }] }
  d.thumbnailStale = true
  d.components = [{ id: 'comp', name: 'Card', future: 'c', root: { ...base, id: 'croot', name: 'Card', type: 'group', children: [{ ...base, id: 'ct', name: 'Label', type: 'text', mode: 'box', align: 'left', valign: 'top', runs: [{ text: 'x', font, size: 12 }] }] } }]
  const board = d.artboards[0]
  board.animation = { duration: 6, fps: 30, loop: true, easing: 'smooth' }
  board.diagrams = [{ name: 'Flow', direction: 'right', spacing: 40, nodeComponent: 'comp', nodes: [{ id: 'a', layer: 'r1', pinned: true }], links: [], containers: [], future: 7 }]
  board.future = [1, 'two']
  board.layers = [
    rrect('r1', 'Box', {
      future: { x: 1 },
      fill: { type: 'linear', angle: 30, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff', midpoint: 0.4 }], interpolation: 'oklab' },
      timing: { start: 0.5, end: 3, in: 'rise', out: 'fade', tracks: [{ prop: 'opacity', keys: [[0, 0], [0.5, 1]], ease: 'out' }], text: { effect: 'word-swap', hold: 1.2 } }
    }),
    { ...base, id: 'i1', name: 'Card 1', type: 'instance', component: 'comp', overrides: { ct: { text: 'Hi', future: 'o' } } },
    { ...base, id: 't1', name: 'T', type: 'text', mode: 'box', align: 'left', valign: 'top', runs: [{ text: 'a', font: { ...font, axes: { wdth: 90 } }, size: 12, effect: 'glow' }] }
  ]
  const notes: string[] = []
  assert.deepEqual(JSON.parse(JSON.stringify(validateDesign(JSON.parse(JSON.stringify(d)), notes))), d)
  assert.deepEqual(notes, [])
  const read = await readDesignZip(await zipOf({ 'design.json': JSON.stringify(d) }))
  assert.equal(read.notes, undefined)
  const saved = await JSZip.loadAsync(await designZipBytes(read))
  assert.deepEqual(JSON.parse(await saved.files['design.json'].async('string')), d)
})

test('validateDesign repairs simple slips with a note, and refuses only structural damage', () => {
  // a hand-edited file: "visible": "true", "opacity": "0.5" and no blend
  const edited = rrect('r1', 'A', { visible: 'true', opacity: '0.5', x: '12', locked: 'false' })
  delete edited.blend
  const notes: string[] = []
  const d = validateDesign(rawDesign([edited]), notes)
  const r = d.artboards[0].layers[0]
  assert.deepEqual([r.visible, r.opacity, r.blend, r.x, r.locked], [true, 0.5, 'normal', 12, false])
  assert.deepEqual(notes.sort(), [
    'blend mode missing (set to normal)', 'locked written as text (read as false)', 'opacity written as text (read as a number)',
    'visible written as text (read as true)', 'x written as text (read as a number)'
  ])
  // missing or wrong scalars get their defaults
  const bare: any = { id: 'b', type: 'rect', name: 'B', visible: 'maybe', x: {} }
  const repaired = validateDesign(rawDesign([bare])).artboards[0].layers[0]
  assert.deepEqual(
    [repaired.visible, repaired.locked, repaired.opacity, repaired.blend, repaired.x, repaired.y, repaired.width, repaired.rotation, repaired.scaleX, repaired.scaleY],
    [true, false, 1, 'normal', 0, 0, 0, 0, 1, 1]
  )
  // a text without runs, a group without children, a run without a font: repaired; an image without an asset: dropped
  const more = validateDesign(rawDesign([
    { ...rrect('t1'), type: 'text', runs: 'hi' },
    { ...rrect('g'), type: 'group', children: {} },
    { ...rrect('t2'), type: 'text', runs: [{ text: 'x', size: '18' }] },
    { ...rrect('img'), type: 'image' }
  ]))
  const [t1, g, t2] = more.artboards[0].layers
  assert.ok(t1.type === 'text' && t1.runs.length === 0)
  assert.ok(g.type === 'group' && g.children.length === 0)
  assert.ok(t2.type === 'text' && t2.runs[0].font.family === 'Arial' && t2.runs[0].size === 18)
  assert.equal(more.artboards[0].layers.length, 3)
  // structural damage still refuses the file
  assert.throws(() => validateDesign(rawDesign([5])), damaged('a layer is not an object'))
  assert.throws(() => validateDesign(rawDesign([{ ...rrect('r1'), type: 'star' }])), damaged('a layer has an unknown type (star)'))
  assert.throws(() => validateDesign({ ...rawDesign([]), artboards: [] }), damaged('it has no artboards'))
  assert.throws(() => validateDesign({ ...rawDesign([]), artboards: {} }), damaged('it has no artboards'))
  assert.throws(() => validateDesign({ ...rawDesign([]), artboards: [7] }), damaged('an artboard is not an object'))
  assert.throws(() => validateDesign({ ...rawDesign([]), format: 2 }), /newer version of gauzzaDocs or is damaged/)
  assert.throws(() => validateDesign(rawDesign([], { components: [{ id: 'c', name: 'C', root: rrect('notgroup') }] })), damaged('component c has no group at its root'))
})

test('the hand-edited file opens through readDesignZip with its repairs noted', async () => {
  const edited = rrect('r1', 'A', { visible: 'true', opacity: '0.5' })
  delete edited.blend
  const f = await readDesignZip(await zipOf({ 'design.json': JSON.stringify(rawDesign([edited])) }))
  const r = f.design.artboards[0].layers[0]
  assert.deepEqual([r.visible, r.opacity, r.blend], [true, 0.5, 'normal'])
  assert.deepEqual(f.notes?.sort(), ['blend mode missing (set to normal)', 'opacity written as text (read as a number)', 'visible written as text (read as true)'])
})

test('validateDesign: ids are safe and unique, and references follow a rename where they can', () => {
  const notes: string[] = []
  const comp = (id: any, root: string, inner: any) => ({ id, name: 'C', root: { ...base, id: root, name: 'C', type: 'group', children: [rrect(inner)] } })
  const raw = rawDesign(
    [
      rrect('a b'),
      rrect('x'),
      rrect('x'),
      rrect(BAD(), BAD()),
      rrect('k'.repeat(110_000)),
      { ...base, id: 'c1', name: 'L', type: 'connector', from: { layer: 'a b' }, to: { layer: 'x' }, route: 'straight', arrow: 'end' },
      { ...base, id: 'i1', name: 'I', type: 'instance', component: 'c d', overrides: JSON.parse('{"in ner":{"text":"ok"},"nope":{"text":"x"},"__proto__":{"text":"p"}}') },
      { ...base, id: 'i2', name: 'I', type: 'instance', component: 'c2', overrides: {} }
    ],
    { components: [comp('c d', 'r1', 'in ner'), comp('c2', 'r2', 'other'), comp('c2', 'r3', 'other2')] }
  )
  const d = validateDesign(raw, notes)
  const ids = d.artboards[0].layers.map(l => l.id)
  assert.deepEqual(ids.slice(0, 5), ['a_b', 'x', 'x-2', 'id', 'k'.repeat(56)])
  assert.ok(ids.every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)))
  const link = d.artboards[0].layers[5]
  assert.ok(link.type === 'connector')
  assert.deepEqual([link.from.layer, link.to.layer], ['a_b', 'x'], 'the renamed end follows; the repeated one stays with the first')
  assert.deepEqual(d.components.map(c => c.id), ['c_d', 'c2', 'c2-2'])
  const [i1, i2] = d.artboards[0].layers.slice(6)
  assert.ok(i1.type === 'instance' && i2.type === 'instance')
  assert.deepEqual([i1.component, i2.component], ['c_d', 'c2'])
  assert.equal(Object.getPrototypeOf(i1.overrides), null)
  assert.deepEqual({ ...i1.overrides }, { in_ner: { text: 'ok' } })
  assert.equal(({} as Record<string, unknown>).text, undefined, 'no prototype was touched')
  assert.equal(d.artboards[0].layers[3].name, 'Rectangle', 'a name that is not text gets a default')
  assert.ok(notes.includes('an id that was not valid (renamed) (5 times)'), JSON.stringify(notes))
  assert.ok(notes.includes('a repeated id (renamed) (2 times)'), JSON.stringify(notes))
  assert.ok(notes.some(n => n.startsWith("an override for a layer its component doesn't have (dropped)")), JSON.stringify(notes))
  // pure: the same input gives the same design
  assert.deepEqual(JSON.stringify(validateDesign(raw)), JSON.stringify(d))
})

test('validateDesign: names are cut, numbers clamped, gradients kept to 256 good stops', () => {
  const notes: string[] = []
  const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ offset: i / n, color: '#ff0000' }))
  const raw = rawDesign([
    rrect('n', 'N'.repeat(2000), { x: 1e9, y: JSON.parse('-1e999'), width: 1e9, height: -1e9, rotation: 5, strokeWidth: 1e9 }),
    rrect('g1', 'G', { fill: { type: 'linear', angle: BAD(), stops: stops(300) } }),
    rrect('g2', 'G', { fill: { type: 'radial', stops: [null, { offset: 'a', color: '#fff' }, { color: 'red', offset: 0 }] } }),
    rrect('g3', 'G', { fill: { type: 'linear', stops: [{ offset: 2, color: '#123456' }] } }),
    rrect('g4', 'G', { stroke: { type: 'mystery' } })
  ])
  raw.artboards[0].background = { type: 'linear', stops: [null] }
  const d = validateDesign(raw, notes)
  const [n, g1, g2, g3, g4] = d.artboards[0].layers
  assert.equal(n.name.length, 1000)
  assert.deepEqual([n.x, n.y, n.width, n.height, n.strokeWidth], [1e7, -1e7, 1e5, -1e5, 1e5])
  assert.ok(g1.fill?.type === 'linear' && g1.fill.stops.length === 256 && g1.fill.angle === undefined)
  assert.deepEqual(g2.fill, { type: 'color', color: '#000000' })
  assert.deepEqual(g3.fill, { type: 'color', color: '#123456' })
  assert.equal(g4.stroke, undefined)
  assert.deepEqual(d.artboards[0].background, { type: 'color', color: '#000000' })
  assert.ok(notes.includes('a gradient with fewer than two stops (drawn as a color) (3 times)'), JSON.stringify(notes))
})

test('validateDesign: text past 1,000 runs, 100,000 characters in a layer or 1,000,000 in a design is damage', () => {
  const textLayer = (id: string, runs: { text: string }[]) => ({ ...base, id, name: 'T', type: 'text', mode: 'box', align: 'left', valign: 'top', runs: runs.map(r => ({ ...r, font, size: 12 })) })
  assert.throws(() => validateDesign(rawDesign([textLayer('t', Array.from({ length: 1001 }, () => ({ text: 'a' })))])), damaged('layer t has more than 1,000 runs'))
  assert.throws(() => validateDesign(rawDesign([textLayer('t', [{ text: 'a'.repeat(100_001) }])])), damaged('layer t holds more than 100,000 characters'))
  const many = Array.from({ length: 11 }, (_, i) => textLayer(`t${i}`, [{ text: 'a'.repeat(99_999) }]))
  assert.throws(() => validateDesign(rawDesign(many)), damaged('it holds more than 1,000,000 characters of text'))
  assert.equal(validateDesign(rawDesign(many.slice(0, 10))).artboards[0].layers.length, 10)
})

test('validateDesign: svg layers are cleaned again, and one that fails cleaning is dropped with a note', () => {
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  const bomb = svg(`<defs><pattern id="P2">${'<rect width="1" height="1"/>'.repeat(100)}</pattern><pattern id="P1">${'<rect width="1" height="1" fill="url(#P2)"/>'.repeat(100)}</pattern></defs>${'<rect width="1" height="1" fill="url(#P1)"/>'.repeat(100)}`)
  const notes: string[] = []
  const d = validateDesign(rawDesign([
    { ...base, id: 's1', name: 'S', type: 'svg', svg: svg('<script>alert(1)</script><rect width="1" height="1"/>') },
    { ...base, id: 's2', name: 'S', type: 'svg', svg: bomb },
    rrect('after')
  ]), notes)
  assert.deepEqual(d.artboards[0].layers.map(l => l.id), ['s1', 'after'])
  const s1 = d.artboards[0].layers[0]
  assert.ok(s1.type === 'svg' && !s1.svg.includes('script'))
  assert.ok(notes.some(n => n.startsWith('an SVG layer that could not be cleaned (This SVG would take too long to draw')), JSON.stringify(notes))
})

test('validateDesign: at most 100,000 layers, 64 levels of groups and 10,000 components', () => {
  assert.throws(() => validateDesign(rawDesign(Array.from({ length: 100_001 }, (_, i) => rrect(`r${i}`)))), damaged('it has more than 100,000 layers'))
  let deep: any = rrect('leaf')
  for (let i = 0; i < 64; i++) deep = { ...base, id: `g${i}`, name: 'G', type: 'group', children: [deep] }
  assert.throws(() => validateDesign(rawDesign([deep])), damaged('groups are nested more than 64 deep'))
  assert.equal(validateDesign(rawDesign([deep.children[0]])).artboards[0].layers.length, 1)
  const comps = Array.from({ length: 10_001 }, (_, i) => ({ id: `c${i}`, name: 'C', root: { ...base, id: `cr${i}`, name: 'C', type: 'group', children: [] } }))
  assert.throws(() => validateDesign(rawDesign([], { components: comps })), damaged('it has more than 10,000 components'))
})

test("the reviewer's designs read through readDesignZip, and designToSvg never throws on what comes out (rA, rD, rE, rF, rG)", async () => {
  const read = async (d: any, files: Record<string, Uint8Array> = {}) => {
    const z = new JSZip()
    z.file('design.json', JSON.stringify(d))
    for (const [k, v] of Object.entries(files)) z.file(k, v)
    return readDesignZip(await z.generateAsync({ type: 'uint8array' }))
  }
  // rA: names and ids no String() can convert, a background with a null stop, a style with a null color
  const a = await read(rawDesign([rrect('r', BAD()), rrect(BAD(), 'n'), rrect('r2', ['x', BAD()]), { ...base, id: 'g', name: 'g', type: 'group', children: [rrect('r3', BAD())] }, rrect('after', 'after')], {
    styles: { colors: [null], text: [] }
  }))
  assert.ok(a.notes?.length)
  for (const r of await drawBoth(a)) {
    assert.match(r.out, /data-name="after"/)
    assert.deepEqual(r.downgrades, [])
  }
  const bg = rawDesign([rrect('after', 'after')])
  bg.artboards[0].background = { type: 'style', ref: 'x' }
  bg.styles = { colors: [null], text: [] }
  for (const r of await drawBoth(await read(bg))) assert.match(r.out, /data-name="after"/)
  // rA E and rE: 100,000 override keys over nested instances are dropped (none is a layer of the component)
  const keys: Record<string, unknown> = {}
  for (let i = 0; i < 100_000; i++) keys[`k${i}`] = { visible: true }
  const nested = rawDesign([{ ...base, id: 'top', name: 'top', type: 'instance', component: 'C1', overrides: keys }], {
    components: [
      { id: 'C0', name: 'C0', root: { ...base, id: 'g0', name: 'g0', type: 'group', children: [rrect('r0', 'r0')] } },
      { id: 'C1', name: 'C1', root: { ...base, id: 'g1', name: 'g1', type: 'group', children: Array.from({ length: 1000 }, (_, i) => ({ ...base, id: `a${i}`, name: 'a', type: 'instance', component: 'C0', overrides: {} })) } }
    ]
  })
  const e = await read(nested)
  const top = e.design.artboards[0].layers[0]
  assert.ok(top.type === 'instance' && Object.keys(top.overrides).length === 0)
  for (const r of await drawBoth(e)) assert.equal(r.out.split('data-name="r0"').length - 1, 1000)
  // rE stops: a gradient of 100,000 stops shared by 1,000 instances keeps 256
  const stops = Array.from({ length: 100_000 }, (_, i) => ({ offset: i / 100_000, color: '#ff0000' }))
  const s = await read(rawDesign(Array.from({ length: 1000 }, (_, i) => ({ ...base, id: `i${i}`, name: 'i', type: 'instance', component: 'C', overrides: {} })), {
    components: [{ id: 'C', name: 'C', root: { ...base, id: 'g', name: 'g', type: 'group', children: [rrect('r', 'r', { fill: { type: 'linear', angle: 0, stops } })] } }]
  }))
  const sr = s.design.components[0].root.children[0]
  assert.ok(sr.fill?.type === 'linear' && sr.fill.stops.length === 256)
  await drawBoth(s)
  // rD: 2,000,000 characters of text, and rF: 5,000 runs, refuse the file
  const textLayer = (id: string, text: string, runs = 1) => ({ ...base, id, name: 't', type: 'text', mode: 'area', align: 'left', valign: 'top', width: 1000, height: 1000, runs: Array.from({ length: runs }, () => ({ text, font, size: 12, color: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } })) })
  await assert.rejects(read(rawDesign([textLayer('t', 'W&'.repeat(1_000_000))])), damaged('layer t holds more than 100,000 characters'))
  await assert.rejects(read(rawDesign([textLayer('k'.repeat(110_000), 'x', 5000)])), damaged('more than 1,000 runs'))
  // rF within limits: a 110,000-character id is renamed, and 1,000 runs with their own gradient draw
  const f = await read(rawDesign([textLayer('k'.repeat(110_000), 'x', 1000)]))
  assert.equal(f.design.artboards[0].layers[0].id, 'k'.repeat(56))
  for (const r of await drawBoth(f)) assert.ok(r.out.length < 2_000_000, `${r.out.length}`)
  // rG: a 100 MB photo too big to draw on its own leaves the rest of the drawing alone
  const big = new Uint8Array(100 * 1024 * 1024)
  big.set([0x89, 0x50, 0x4e, 0x47])
  const asset = `assets/${'b'.repeat(64)}.png`
  const g = await read(rawDesign([{ ...base, id: 'photo', name: 'photo', type: 'image', asset, fit: 'fill' }, rrect('title', 'title'), rrect('logo', 'logo')]), { [asset]: big })
  for (const r of await drawBoth(g)) {
    assert.deepEqual(r.downgrades.map(x => x.layer), ['photo'])
    assert.match(r.out, /data-name="title".*data-name="logo"/)
  }
})
