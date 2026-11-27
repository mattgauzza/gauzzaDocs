import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import JSZip from 'jszip'
import { assetName, designZipBytes, readDesignThumbnail, readDesignZip, scanZipEntries, zipLoads } from '../src/core/formats/design'
import { fontsFor } from '../src/shared/design/fonts'
import { newDesign, newId, resolveLayer, walk } from '../src/shared/design/model'
import { type Downgrade, designToSvg } from '../src/shared/design/render'
import type { Design, DesignFile, Layer } from '../src/shared/design/types'
import { validateDesign } from '../src/shared/design/validate'
import { applyDesignOp } from '../src/shared/ops/design'

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

test('a file that is not a zip at all is refused in plain words', async () => {
  const plain = { message: "This design file is damaged: it can't be read as a zip file." }
  await assert.rejects(readDesignZip(new Uint8Array(Buffer.from('this is not a zip'))), plain)
  await assert.rejects(readDesignZip(new Uint8Array(0)), plain)
})

test('hostile zips: too many entries', async () => {
  const z = new JSZip()
  z.file('design.json', JSON.stringify(newDesign('x')))
  for (let i = 0; i < 10_000; i++) z.file(`junk/${i}.txt`, '')
  const bytes = await z.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(readDesignZip(bytes), /too many entries/)
})

/** The zip with its end of central directory record's two entry counts set to `n`. */
function withDeclaredCount(bytes: Uint8Array, n: number): Buffer {
  const buf = Buffer.from(bytes)
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(at > 0)
  buf.writeUInt16LE(n, at + 8)
  buf.writeUInt16LE(n, at + 10)
  return buf
}

test('hostile zips: 10,001 entries are refused from the central directory, before JSZip builds any', async () => {
  const z = new JSZip()
  z.file('design.json', JSON.stringify(newDesign('x')))
  for (let i = 0; i < 10_000; i++) z.file(`j${i}`, '')
  const bytes = new Uint8Array(await z.generateAsync({ type: 'nodebuffer' }))
  const before = zipLoads.calls
  await assert.rejects(readDesignZip(bytes), { message: 'This design has too many entries (more than 10,000).' })
  assert.equal(await readDesignThumbnail(bytes), null)
  assert.equal(zipLoads.calls, before, 'JSZip never saw it')
  // a record that understates the count is caught by the walk, which stops at 10,001
  await assert.rejects(readDesignZip(withDeclaredCount(bytes, 5)), { message: 'This design has too many entries (more than 10,000).' })
  assert.equal(zipLoads.calls, before)
})

test('hostile zips: a record whose entry count disagrees with the directory is refused as damaged', async () => {
  const bytes = await zipOf({ 'design.json': JSON.stringify(newDesign('x')), 'a.txt': 'a', 'b.txt': 'b' })
  const before = zipLoads.calls
  const damaged = { message: "This design file is damaged: it can't be read as a zip file." }
  await assert.rejects(readDesignZip(withDeclaredCount(bytes, 2)), damaged)
  await assert.rejects(readDesignZip(withDeclaredCount(bytes, 4)), damaged)
  await assert.rejects(readDesignZip(withDeclaredCount(bytes, 60_000)), { message: 'This design has too many entries (more than 10,000).' })
  assert.equal(zipLoads.calls, before, 'JSZip never saw them')
  // the honest file still reads (cut short, it never reads past its end)
  assert.equal((await readDesignZip(bytes)).design.artboards.length, 1)
  for (const cut of [1, 10, 30]) assert.doesNotThrow(() => scanZipEntriesSafe(bytes.subarray(0, bytes.length - cut)))
})

/** scanZipEntries on a cut file: it may refuse it, but only with an Error of its own (never a RangeError from reading past the end). */
function scanZipEntriesSafe(bytes: Uint8Array): void {
  try {
    scanZipEntries(bytes)
  } catch (e) {
    if (e instanceof RangeError) throw e
  }
}

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

/** This thread's CPU time for `fn`, in ms (the smaller of wall and process CPU time where Node can't tell). */
function cpuMs(fn: () => unknown): number {
  const thread = (process as { threadCpuUsage?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage?.bind(process)
  const t0 = thread?.()
  const cpu = process.cpuUsage()
  const start = performance.now()
  fn()
  const wall = performance.now() - start
  if (t0 && thread) {
    const own = thread(t0)
    return (own.user + own.system) / 1000
  }
  const used = process.cpuUsage(cpu)
  return Math.min(wall, (used.user + used.system) / 1000)
}
const storedZip = async (json: string): Promise<Uint8Array> => {
  const z = new JSZip()
  z.file('design.json', json, { compression: 'STORE' })
  return z.generateAsync({ type: 'uint8array' })
}

test('validateDesign renames 100,000 repeats of one id in under a second (wV dup)', () => {
  const raw = rawDesign(Array.from({ length: 100_000 }, () => rrect('a')))
  let d: any
  const ms = cpuMs(() => (d = validateDesign(raw)))
  assert.ok(ms < 1000, `${Math.round(ms)} ms`)
  const ids = d.artboards[0].layers.map((l: Layer) => l.id)
  assert.equal(new Set(ids).size, 100_000)
  assert.deepEqual(ids.slice(0, 3), ['a', 'a-2', 'a-3'])
  // an id the file holds further on is never taken by a rename, however deep it is (wN rename)
  let deep: any = rrect('x_y', 'DEEP')
  for (let i = 0; i < 39; i++) deep = { ...base, id: `g${i}`, name: 'g', type: 'group', children: [deep] }
  const r = validateDesign(rawDesign([rrect('x y', 'TOP'), { ...base, id: 'c', name: 'c', type: 'connector', from: { layer: 'x_y' }, to: { layer: 'b' }, route: 'straight', arrow: 'end' }, rrect('b'), deep]))
  const all: Layer[] = []
  walk(r.artboards[0].layers, l => all.push(l))
  const c = all.find(l => l.id === 'c')
  assert.ok(c?.type === 'connector')
  assert.equal(all.find(l => l.id === c.from.layer)?.name, 'DEEP')
  assert.notEqual(all.find(l => l.name === 'TOP')?.id, 'x_y')
})

test('a design whose repairs would take it past 64 MB is refused, and one over 64 MB is never written (wV2, wN grow)', async () => {
  const TOO_LARGE = 'This design is too large to open (over 64 MB once repaired).'
  // 24 MB of runs that are only {}: each would gain a text, a font and a size
  const layer = (i: number): string => `{"type":"text","id":"t${i}","runs":[${Array(1000).fill('{}').join(',')}]}`
  const layers: string[] = []
  for (let size = 0, i = 0; size < 24 * 1024 * 1024; i++) {
    layers.push(layer(i))
    size += layers[i].length + 1
  }
  const runs = `{"format":1,"id":"d","artboards":[{"id":"ab","name":"B","width":100,"height":100,"background":null,"layers":[${layers.join(',')}]}]}`
  layers.length = 0
  assert.throws(() => validateDesign(JSON.parse(runs), [], runs.length), { message: TOO_LARGE })
  // 57 MB of rects missing their defaults, read through readDesignZip
  const name = 'n'.repeat(560)
  const rects = Array.from({ length: 100_000 }, (_, i) => `{"type":"rect","id":"r${i}","name":"${name}"}`)
  const json = `{"format":1,"id":"d","artboards":[{"id":"ab","name":"B","width":100,"height":100,"background":null,"layers":[${rects.join(',')}]}]}`
  assert.ok(json.length > 56 * 1024 * 1024 && json.length < 64 * 1024 * 1024)
  await assert.rejects(readDesignZip(await storedZip(json)), { message: TOO_LARGE })
  // the same rects with their defaults written out fit, and open
  const few = json.slice(0, json.indexOf(',{"type":"rect","id":"r1000"')) + ']}]}'
  const opened = await readDesignZip(await storedZip(few))
  assert.equal(opened.design.artboards[0].layers.length, 1000)
  // a design built past 64 MB in memory is refused on save, rather than written where it couldn't open again
  const big = newDesign('instagram')
  big.artboards[0].layers.push({ ...base, id: 'p', name: 'p', type: 'path', d: 'M0 0' + ' L1 1'.repeat(13 * 1024 * 1024) })
  await assert.rejects(designZipBytes({ design: big, assets: {} }), { message: 'This design is too large to save (its design.json would be over 64 MB).' })
})

test('unknown fields are kept to 32 levels and 8 MB in all; notes stop at 200; svg layers at 16 MB (wN deepunknown, wS)', async () => {
  const note = "a field this release doesn't know, nested past 32 levels or past 8 MB of such fields (dropped)"
  // nested 10,000 deep: dropped with a note, so saving and every op still work
  const deep = JSON.stringify(rawDesign([rrect('r')])).replace('"artboards":', `"future":${'['.repeat(10_000)}${']'.repeat(10_000)},"near":[[1]],"artboards":`)
  const f = await readDesignZip(await storedZip(deep))
  assert.deepEqual(f.notes, [note])
  assert.equal((f.design as any).future, undefined)
  assert.deepEqual((f.design as any).near, [[1]])
  const saved = await readDesignZip(await designZipBytes(f))
  assert.equal(saved.notes, undefined)
  const op = await applyDesignOp(f, { op: 'set', layer: 'r', props: { x: 3 } } as any)
  assert.deepEqual(op.result, { ids: ['r'] })
  // 32 levels are kept, 33 are not
  const levels = (n: number): unknown => JSON.parse('['.repeat(n - 1) + '1' + ']'.repeat(n - 1))
  const kept = validateDesign(rawDesign([rrect('r', 'R', { a: levels(32), b: levels(33) })]))
  const r = kept.artboards[0].layers[0] as any
  assert.deepEqual(r.a, levels(32))
  assert.equal(r.b, undefined)
  // nine unknown fields of 0.9 MB: eight fit in 8 MB, the ninth is dropped
  const more: Record<string, string> = {}
  for (let i = 0; i < 9; i++) more[`u${i}`] = String(i).repeat(943_720)
  const notes: string[] = []
  const big = validateDesign(rawDesign([rrect('r')], more), notes) as any
  assert.deepEqual(Object.keys(more).filter(k => k in big), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'])
  assert.deepEqual(notes, [note])
  // 300 different notes: the first 200, then how many more
  const odd = Array.from({ length: 300 }, (_, i) => ({ ...base, id: `s${i}`, name: 's', type: 'svg', svg: `<root${i}/>` }))
  const many: string[] = []
  validateDesign(rawDesign([rrect('r'), ...odd]), many)
  assert.equal(many.length, 201)
  assert.equal(many[0], 'an SVG layer that could not be cleaned (This is not an SVG: its root element is <root0>; dropped)')
  assert.equal(many[200], 'and 100 more')
  // svg layers stop at 16 MB of markup between them
  const pad = (i: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--${'p'.repeat(1024 * 1024)}--><rect id="r${i}" width="1" height="1"/></svg>`
  const svgs: string[] = []
  const s = validateDesign(rawDesign(Array.from({ length: 20 }, (_, i) => ({ ...base, id: `s${i}`, name: 's', type: 'svg', svg: pad(i) }))), svgs)
  assert.equal(s.artboards[0].layers.length, 15)
  assert.deepEqual(svgs, ['an SVG layer past 16 MB of SVG in this design (dropped) (5 times)'])
})

const UNKNOWN_NOTE = "a field this release doesn't know, nested past 32 levels or past 8 MB of such fields (dropped)"

test("a field a kind of object doesn't use is bounded like any unknown field, so saving and ops keep working (xE)", async () => {
  const DEEP = '"__DEEP__"'
  const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`
  const two = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
  const fill = (paint: Record<string, unknown>) => (d: any) => (d.artboards[0].layers[0].fill = paint)
  const cases: [string, (d: any) => void][] = [
    ['a color fill holding stops', fill({ type: 'color', color: '#ff0000', stops: '__DEEP__' })],
    ['a color fill holding an angle', fill({ type: 'color', color: '#ff0000', angle: '__DEEP__' })],
    ['a style fill holding a color', fill({ type: 'style', ref: 'Brand', color: '__DEEP__' })],
    ['a gradient holding a ref', fill({ type: 'linear', stops: two, ref: '__DEEP__' })],
    ['a gradient holding a color', fill({ type: 'radial', stops: two, color: '__DEEP__' })],
    ['a diagram node whose layer is not text', d => (d.artboards[0].diagrams = [{ name: 'D', nodes: [{ layer: '__DEEP__' }], links: [], containers: [] }])],
    ['a text style whose run holds text', d => (d.styles = { colors: [], text: [{ name: 'S', run: { font, size: 12, text: '__DEEP__' } }] })]
  ]
  for (const [label, tweak] of cases) {
    const d = rawDesign([rrect('r')])
    tweak(d)
    const f = await readDesignZip(await storedZip(JSON.stringify(d).replace(DEEP, deep)))
    assert.deepEqual(f.notes, [UNKNOWN_NOTE], label)
    const again = await readDesignZip(await designZipBytes(f))
    assert.equal(again.notes, undefined, label)
    const op = await applyDesignOp(f, { op: 'set', layer: 'r', props: { x: 3 } } as any)
    assert.deepEqual(op.result, { ids: ['r'] }, label)
  }
  // within the bounds they're kept as they are, and what the kind does use is still checked
  const kept = validateDesign(rawDesign([rrect('r', 'R', { fill: { type: 'color', color: '#ff0000', stops: [1, 2], ref: 'x' } })]))
  assert.deepEqual((kept.artboards[0].layers[0] as any).fill, { type: 'color', color: '#ff0000', stops: [1, 2], ref: 'x' })
  const node = rawDesign([rrect('r')])
  node.artboards[0].diagrams = [{ name: 'D', nodes: [{ layer: 7 }, { layer: 'r' }], links: [], containers: [] }]
  assert.deepEqual(validateDesign(node).artboards[0].diagrams?.[0].nodes, [{ layer: 7 }, { layer: 'r' }])
})

test('an unknown value far past 8 MB is dropped after about 8 MB of looking, with nothing held for the rest (xC)', () => {
  // 9,000,000 items: the commas between them alone pass 8 MB, so the list is dropped before any item is looked at
  const list = new Array(9_000_000).fill(0)
  const notes: string[] = []
  let d: any
  const ms = cpuMs(() => (d = validateDesign(rawDesign([rrect('r')], { future: list }), notes)))
  assert.ok(ms < 100, `9,000,000 items took ${Math.round(ms)} ms`)
  assert.equal(d.future, undefined)
  assert.deepEqual(notes, [UNKNOWN_NOTE])
  // 1,000 lists of 10,000: walked a list at a time, and dropped once they pass 8 MB
  const lists = Array.from({ length: 1000 }, () => new Array(10_000).fill(0))
  const later: string[] = []
  const ms2 = cpuMs(() => (d = validateDesign(rawDesign([rrect('r')], { future: lists, small: [[1]] }), later)))
  assert.ok(ms2 < 1000, `1,000 lists of 10,000 took ${Math.round(ms2)} ms`)
  assert.equal(d.future, undefined)
  assert.deepEqual(d.small, [[1]])
  assert.deepEqual(later, [UNKNOWN_NOTE])
  // an object whose keys pass 8 MB is dropped the same way; one just within it is kept whole
  const wide: Record<string, string> = {}
  for (let i = 0; i < 1_000_000; i++) wide[`k${i}`] = 'v'
  assert.equal((validateDesign(rawDesign([rrect('r')], { wide })) as any).wide, undefined)
  const fits: Record<string, string> = {}
  for (let i = 0; i < 100_000; i++) fits[`k${i}`] = 'v'
  assert.equal(Object.keys((validateDesign(rawDesign([rrect('r')], { fits })) as any).fits).length, 100_000)
})

test('a save says what stopped it, and refuses over 16 MB of SVG layers so a reopen never drops one', async () => {
  // too deep: a value nested 100,000 levels (only possible in memory: reading drops it)
  const deep = newDesign('instagram') as any
  deep.future = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)
  await assert.rejects(designZipBytes({ design: deep, assets: {} }), { message: 'This design is too deeply nested to save.' })
  // a part that contains itself
  const loop = newDesign('instagram') as any
  loop.future = {}
  loop.future.self = loop.future
  await assert.rejects(designZipBytes({ design: loop, assets: {} }), { message: "This design can't be saved: part of it contains itself." })
  // too large stays as it was
  const big = newDesign('instagram')
  big.artboards[0].layers.push({ ...base, id: 'p', name: 'p', type: 'path', d: 'M0 0' + ' L1 1'.repeat(13 * 1024 * 1024) })
  await assert.rejects(designZipBytes({ design: big, assets: {} }), { message: 'This design is too large to save (its design.json would be over 64 MB).' })
  // svg layers: four of 4,000,000 characters (16,000,000, within 16 MB) save and reopen whole; a fifth is refused
  const markup = (i: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--${'p'.repeat(4_000_000 - 100)}--><rect id="r${i}" width="1" height="1"/></svg>`
  const svgLayer = (i: number): Layer => ({ ...base, id: `s${i}`, name: 's', type: 'svg', svg: markup(i) })
  const four = newDesign('instagram')
  four.artboards[0].layers.push(svgLayer(0), svgLayer(1), svgLayer(2))
  four.components = [{ id: 'C', name: 'C', root: { ...base, id: 'g', name: 'g', type: 'group', children: [svgLayer(3)] } }]
  const back = await readDesignZip(await designZipBytes({ design: four, assets: {} }))
  assert.equal(back.notes, undefined)
  assert.equal(back.design.artboards[0].layers.length + back.design.components[0].root.children.length, 4)
  four.artboards[0].layers.push(svgLayer(4))
  await assert.rejects(designZipBytes({ design: four, assets: {} }), { message: 'This design is too large to save (its SVG layers come to over 16 MB).' })
})

test('a save past any limit reading enforces is refused in reading\'s own words, walked without recursion (yA, yS)', async () => {
  const saving = (reason: string) => ({ message: `This design can't be saved, since it couldn't be opened again: ${reason}.` })
  const group = (id: string, children: Layer[]): Layer => ({ ...base, id, name: id, type: 'group', children })
  const text = (id: string, runs: number, chars: number): Layer => ({
    ...base, id, name: id, type: 'text', mode: 'box', align: 'left', valign: 'top',
    runs: Array.from({ length: runs }, () => ({ text: 'a'.repeat(chars), font, size: 12 }))
  })
  const saved = async (layers: Layer[], more: Partial<Design> = {}) => {
    const d = newDesign('instagram')
    return designZipBytes({ design: { ...d, ...more, artboards: [{ ...d.artboards[0], layers }] }, assets: {} })
  }
  // groups 65 deep, 20,000 deep, and a group that holds itself
  let deep: Layer = rect('r', 'R')
  for (let i = 0; i < 64; i++) deep = group(`g${i}`, [deep])
  await assert.rejects(saved([deep]), saving('groups are nested more than 64 deep'))
  for (let i = 64; i < 20_000; i++) deep = group(`g${i}`, [deep])
  await assert.rejects(saved([deep]), saving('groups are nested more than 64 deep'))
  const self = group('self', [])
  ;(self as { children: Layer[] }).children.push(self, self)
  await assert.rejects(saved([self]), saving('groups are nested more than 64 deep'))
  // 1,001 runs, 100,001 characters in a layer, 1,000,001 in the design, 100,001 layers, an override of 100,001
  await assert.rejects(saved([text('t', 1001, 1)]), saving('layer t has more than 1,000 runs'))
  await assert.rejects(saved([text('t', 1, 100_001)]), saving('layer t holds more than 100,000 characters'))
  await assert.rejects(saved([...Array.from({ length: 10 }, (_, i) => text(`t${i}`, 1, 100_000)), text('x', 1, 1)]), saving('it holds more than 1,000,000 characters of text'))
  await assert.rejects(saved(Array.from({ length: 100_001 }, (_, i) => rect(`r${i}`, 'R'))), saving('it has more than 100,000 layers'))
  const root = group('root', [text('in', 1, 1)]) as Design['components'][number]['root']
  const inst: Layer = { ...base, id: 'i', name: 'i', type: 'instance', component: 'C', overrides: { in: { text: 'a'.repeat(100_001) } } }
  await assert.rejects(saved([inst], { components: [{ id: 'C', name: 'C', root }] }), saving('an override holds more than 100,000 characters'))
  // at each limit it saves, and opens again with nothing to note
  deep = rect('r', 'R')
  for (let i = 0; i < 63; i++) deep = group(`g${i}`, [deep])
  for (const layers of [[deep], [text('t', 1000, 1)], [text('t', 1, 100_000)], Array.from({ length: 10 }, (_, i) => text(`t${i}`, 1, 100_000))]) {
    assert.equal((await readDesignZip(await saved(layers))).notes, undefined)
  }
})

test('svg markup is capped once cleaned, so a file whose markup grows when cleaned opens and then saves (yH)', async () => {
  // four svg layers just under 16 MB between them as written, each with 100,000 apostrophes that cleaning writes as &apos;
  const CAP = 16 * 1024 * 1024
  const each = Math.floor(CAP / 4) - 10
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="1" y="9">${"'".repeat(100_000)}</text><path d="M0 0`
  const tail = '" stroke="#000" fill="none"/></svg>'
  const svg = head + ' L1 1'.repeat(Math.floor((each - head.length - tail.length) / 5)) + tail
  const raw = rawDesign([...Array.from({ length: 4 }, (_, i) => ({ ...base, id: `s${i}`, name: 's', type: 'svg', svg })), rrect('r')])
  assert.ok(svg.length * 4 <= CAP)
  const f = await readDesignZip(await storedZip(JSON.stringify(raw)))
  assert.deepEqual(f.notes, ['an SVG layer past 16 MB of SVG in this design (dropped)'])
  const kept = f.design.artboards[0].layers.filter(l => l.type === 'svg')
  assert.equal(kept.length, 3)
  assert.ok(kept.reduce((a, l) => a + (l.type === 'svg' ? l.svg.length : 0), 0) <= CAP)
  const again = await readDesignZip(await designZipBytes(f))
  assert.equal(again.notes, undefined)
  assert.equal(again.design.artboards[0].layers.filter(l => l.type === 'svg').length, 3)
})

test('ids past 64 characters are renamed without being kept as keys, so 3,000 of 20,000 characters read in under a second (yV)', () => {
  const pad = '!'.repeat(20_000 - 8)
  const layers = Array.from({ length: 3000 }, (_, i) => rrect(pad + String(i).padStart(8, '0')))
  // a connector naming one of them by its long id joins nothing (no id is that long, and none is followed from one)
  layers.push({ ...base, id: 'c', name: 'c', type: 'connector', from: { layer: layers[0].id }, to: { layer: layers[1].id }, route: 'straight', arrow: 'end' })
  const raw = rawDesign(layers)
  const notes: string[] = []
  let d: Design | undefined
  const ms = cpuMs(() => (d = validateDesign(raw, notes)))
  assert.ok(ms < 1000, `3,000 ids of 20,000 characters took ${Math.round(ms)} ms`)
  assert.deepEqual(notes, ['an id that was not valid (renamed) (3000 times)'])
  const ids = d!.artboards[0].layers.map(l => l.id)
  assert.equal(new Set(ids).size, 3001)
  assert.deepEqual(ids.slice(0, 2), [R56('_'), `${R56('_')}-2`])
  const c = d!.artboards[0].layers[3000]
  assert.ok(c.type === 'connector')
  assert.deepEqual([c.from.layer, c.to.layer], ['', ''])
})
const R56 = (s: string): string => s.repeat(56)

test('a save past 10,000 zip entries is refused, so it never writes a file reading refuses (Ruling 23)', async () => {
  const ENTRIES = 'This design has too many entries (more than 10,000).'
  const images = (n: number): DesignFile => {
    const design = newDesign('instagram')
    const assets: Record<string, Uint8Array> = {}
    for (let i = 0; i < n; i++) {
      const bytes = new Uint8Array([i & 255, i >> 8, 7])
      const asset = assetName(bytes, 'png')
      assets[asset] = bytes
      design.artboards[0].layers.push({ ...base, id: `i${i}`, name: 'I', type: 'image', asset })
    }
    return { design, assets }
  }
  // 9,998 assets, design.json and the assets/ folder are 10,000 entries: it saves, and opens again
  const f = images(9998)
  const back = await readDesignZip(await designZipBytes(f))
  assert.equal(Object.keys(back.assets).length, 9998)
  // a thumbnail, or one more asset, is one entry too many
  await assert.rejects(designZipBytes({ ...f, thumbnail: new Uint8Array([1]) }), { message: ENTRIES })
  await assert.rejects(designZipBytes(images(9999)), { message: ENTRIES })
  // reading words it the same way
  const z = new JSZip()
  z.file('design.json', JSON.stringify(newDesign('x')))
  for (let i = 0; i < 10_000; i++) z.file(`junk/${i}.txt`, '')
  await assert.rejects(readDesignZip(await z.generateAsync({ type: 'nodebuffer' })), { message: ENTRIES })
})

test('a save refuses what reading would repair or refuse, in reading\'s own words (Ruling 23)', async () => {
  const saved = (layers: Layer[], width = 1080) => {
    const d = newDesign('instagram')
    return designZipBytes({ design: { ...d, artboards: [{ ...d.artboards[0], width, layers }] }, assets: {} })
  }
  const link = (more: Record<string, unknown>): Layer =>
    ({ ...base, id: 'c', name: 'c', type: 'connector', from: { layer: 'r' }, to: { layer: 'r' }, route: 'straight', arrow: 'end', ...more }) as Layer
  const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ offset: i / (n - 1), color: '#000000' }))
  await assert.rejects(saved([rect('r', 'n'.repeat(1001))]), { message: 'Names can be at most 1,000 characters.' })
  await assert.rejects(saved([rect('r', 'R'), link({ label: 'l'.repeat(1001) })]), { message: 'Labels can be at most 1,000 characters.' })
  await assert.rejects(saved([{ ...rect('r', 'R'), fill: { type: 'linear', stops: stops(257) } }]), { message: 'Gradients can have at most 256 stops.' })
  await assert.rejects(saved([{ ...rect('r', 'R'), dash: Array(1001).fill(1) }]), { message: 'A dash can have at most 1,000 lengths.' })
  await assert.rejects(saved([rect('r', 'R'), link({ points: Array(10_001).fill([0, 0]) })]), { message: 'A connector can have at most 10,000 points.' })
  await assert.rejects(saved([], 9000), { message: 'Artboards can be at most 8192 px per side.' })
  // at each limit it saves and opens again with nothing repaired
  const at = [{ ...rect('r', 'n'.repeat(1000)), fill: { type: 'linear', stops: stops(256) }, dash: Array(1000).fill(1) } as Layer, link({ label: 'l'.repeat(1000), points: Array(10_000).fill([0, 0]) })]
  const back = await readDesignZip(await saved(at, 8192))
  assert.equal(back.notes, undefined)
  assert.deepEqual(back.design.artboards[0].layers, at)
})
