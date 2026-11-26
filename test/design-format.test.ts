import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { assetName, designZipBytes, readDesignZip } from '../src/core/formats/design'
import { newDesign, newId, resolveLayer, walk } from '../src/shared/design/model'
import type { Design, DesignFile, Layer } from '../src/shared/design/types'

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
