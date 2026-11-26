import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { assetName } from '../src/core/formats/design'
import { fontFaceBytes, listFontFaces } from '../src/core/systemFonts'
import { canPack, fontsFor, packedFamily } from '../src/shared/design/fonts'
import { newDesign } from '../src/shared/design/model'
import type { Design, FontRef, Layer } from '../src/shared/design/types'

const dir = 'node_modules/pdfjs-dist/standard_fonts/'
const regular = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Regular.ttf'))

const textLayer = (font: FontRef): Layer => ({
  id: 't1', name: 'T', type: 'text', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, width: 100,
  height: 20, rotation: 0, scaleX: 1, scaleY: 1, mode: 'point', align: 'left', valign: 'top',
  runs: [{ text: 'Hello', font, size: 16 }]
})
const designWith = (font: FontRef): Design => {
  const d = newDesign('instagram')
  d.artboards[0].layers.push(textLayer(font))
  return d
}

/** A copy of the font with the OS/2 fsType patched. */
function withFsType(bytes: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(bytes)
  const v = new DataView(out.buffer)
  const n = v.getUint16(4)
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    if (String.fromCharCode(...out.subarray(rec, rec + 4)) === 'OS/2') {
      v.setUint16(v.getUint32(rec + 8) + 8, value)
      return out
    }
  }
  throw new Error('no OS/2 table')
}

test('fontsFor resolves a packed asset with its packed family', async () => {
  const asset = assetName(regular, 'ttf')
  const ref: FontRef = { family: 'Whatever', weight: 400, style: 'normal', asset }
  const src = await fontsFor(designWith(ref), { [asset]: regular }, async () => null, regular)
  const got = src.get(ref)
  assert.ok(!got.missing)
  assert.equal(got.packedFamily, packedFamily(asset))
  assert.match(got.packedFamily!, /^gd-[0-9a-f]{12}$/)
  assert.ok(got.font.layout('Hi').glyphs.length === 2)
})

test('a family nothing can fetch resolves to the fallback and is missing', async () => {
  const ref: FontRef = { family: 'No Such Font', weight: 400, style: 'normal' }
  const src = await fontsFor(designWith(ref), {}, async () => null, regular)
  const got = src.get(ref)
  assert.equal(got.missing, true)
  assert.equal(got.font, src.fallback.font)
  assert.equal(src.get({ family: 'Never Asked', weight: 700, style: 'italic' }).missing, true)
})

test('fontsFor loads a fetched font', async () => {
  const ref: FontRef = { family: 'Liberation Sans', weight: 400, style: 'normal' }
  const src = await fontsFor(designWith(ref), {}, async () => regular, regular)
  const got = src.get(ref)
  assert.ok(!got.missing)
  assert.equal(got.packedFamily, undefined)
  assert.equal(got.family, 'Liberation Sans')
})

test('canPack follows the OS/2 fsType', () => {
  assert.equal(canPack(regular), true)
  assert.equal(canPack(withFsType(regular, 8)), true)
  assert.equal(canPack(withFsType(regular, 2)), false)
  assert.equal(canPack(withFsType(regular, 4)), false)
  assert.equal(canPack(new Uint8Array([1, 2, 3])), false)
})

test('fontFaceBytes returns null for an unknown family', async () => {
  assert.equal(await fontFaceBytes({ family: 'No Such Font Anywhere', weight: 400, style: 'normal' }), null)
})

const cambria = 'C:/Windows/Fonts/cambria.ttc'
test('listFontFaces lists the faces inside a collection', { skip: !fs.existsSync(cambria) }, async () => {
  const faces = await listFontFaces()
  const cam = faces.find(f => f.family === 'Cambria' && f.file.toLowerCase().endsWith('cambria.ttc'))
  const math = faces.find(f => f.family === 'Cambria Math')
  assert.equal(cam?.index, 0)
  assert.equal(math?.index, 1)
  const bytes = await fontFaceBytes({ family: 'Cambria', weight: 400, style: 'normal' })
  assert.ok(bytes && bytes.length > 1000)
})
