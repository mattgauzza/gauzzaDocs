import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { assetName } from '../src/core/formats/design'
import { fontFaceBytes, listFontFaces } from '../src/core/systemFonts'
import { canPack, closestWeight, fontsFor, isItalic, normWeight, packedFamily } from '../src/shared/design/fonts'
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

const bold = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Bold.ttf'))
const italic = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Italic.ttf'))

/** A .ttc holding the fonts, with each font's table offsets rebased to file positions. */
function makeTtc(fonts: Uint8Array[]): Uint8Array {
  const starts: number[] = []
  let pos = 12 + fonts.length * 4
  for (const f of fonts) {
    starts.push(pos)
    pos += (f.length + 3) & ~3
  }
  const out = new Uint8Array(pos)
  const v = new DataView(out.buffer)
  out.set([0x74, 0x74, 0x63, 0x66]) // ttcf
  v.setUint32(4, 0x00010000)
  v.setUint32(8, fonts.length)
  fonts.forEach((f, i) => {
    v.setUint32(12 + i * 4, starts[i])
    out.set(f, starts[i])
    const n = v.getUint16(starts[i] + 4)
    for (let t = 0; t < n; t++) {
      const rec = starts[i] + 12 + t * 16
      v.setUint32(rec + 8, v.getUint32(rec + 8) + starts[i])
    }
  })
  return out
}
const ttc = makeTtc([regular, bold])
const ref = (over: Partial<FontRef>): FontRef => ({ family: 'Liberation Sans', weight: 400, style: 'normal', ...over })

test('a collection: pick by postscript and by weight, and it can be packed', async () => {
  assert.equal(canPack(ttc), true)
  const r = ref({ weight: 700 })
  const asset = assetName(ttc, 'ttc')
  const d = designWith(r)
  d.artboards[0].layers.push({ ...textLayer(ref({ postscript: 'LiberationSans' })), id: 't2' })
  d.artboards[0].layers.push({ ...textLayer(ref({})), id: 't3' })
  const src = await fontsFor(d, {}, async () => ttc, regular)
  assert.equal(src.get(r).font.postscriptName, 'LiberationSans-Bold')
  assert.equal(src.get(ref({ postscript: 'LiberationSans' })).font.postscriptName, 'LiberationSans')
  assert.equal(src.get(ref({})).font.postscriptName, 'LiberationSans')
  assert.ok(asset.endsWith('.ttc'))
})

test('a packed face beats a fetched one of the same family', async () => {
  const asset = assetName(bold, 'ttf')
  const r = ref({ weight: 700, asset })
  const src = await fontsFor(designWith(r), { [asset]: bold }, async () => regular, regular)
  const got = src.get(r)
  assert.equal(got.font.postscriptName, 'LiberationSans-Bold')
  assert.equal(got.packedFamily, packedFamily(asset))
})

test('a packed collection with no matching family or postscript is skipped for fetch', async () => {
  const asset = assetName(ttc, 'ttc')
  const wrongFamily = ref({ family: 'Other Family', asset })
  const wrongPs = ref({ asset: asset + 'x', postscript: 'Nope' })
  const d = designWith(wrongFamily)
  d.artboards[0].layers.push({ ...textLayer(wrongPs), id: 't2' })
  const src = await fontsFor(d, { [asset]: ttc, [asset + 'x']: ttc }, async () => italic, regular)
  for (const r of [wrongFamily, wrongPs]) {
    const got = src.get(r)
    assert.equal(got.packedFamily, undefined)
    assert.equal(got.font.postscriptName, 'LiberationSans-Italic')
  }
  const none = await fontsFor(designWith(wrongFamily), { [asset]: ttc }, async () => null, regular)
  assert.equal(none.get(wrongFamily).missing, true)
})

test('an italic that does not exist gives the nearest upright weight', async () => {
  const src = await fontsFor(designWith(ref({ style: 'italic', weight: 700 })), {}, async () => ttc, regular)
  assert.equal(src.get(ref({ style: 'italic', weight: 700 })).font.postscriptName, 'LiberationSans-Bold')
  const it = await fontsFor(designWith(ref({ style: 'italic' })), {}, async () => makeTtc([regular, italic]), regular)
  assert.equal(it.get(ref({ style: 'italic' })).font.postscriptName, 'LiberationSans-Italic')
})

test('weights follow CSS font matching order and bad weights count as 400', () => {
  const pick = (ws: number[], t: number) => closestWeight(ws, t, w => w)
  assert.equal(pick([100, 300, 500, 700], 350), 300)
  assert.equal(pick([100, 300, 500, 700], 250), 100)
  assert.equal(pick([200, 300, 600], 400), 300)
  assert.equal(pick([200, 450, 600], 400), 450)
  assert.equal(pick([200, 300, 800], 600), 800)
  assert.equal(pick([200, 300, 500], 600), 500)
  assert.equal(normWeight(0), 400)
  assert.equal(normWeight(5000), 400)
  assert.equal(normWeight(NaN), 400)
  assert.equal(isItalic({ 'OS/2': { fsSelection: { italic: true } } }), true)
  assert.equal(isItalic({ 'OS/2': { fsSelection: 512 }, italicAngle: 0 }), true)
  assert.equal(isItalic({ 'OS/2': { fsSelection: 0 }, italicAngle: -12 }), false)
  assert.equal(isItalic({ italicAngle: -12 }), true)
})

test('canPack refuses a collection with too many faces', () => {
  const big = new Uint8Array(ttc)
  new DataView(big.buffer).setUint32(8, 257)
  assert.equal(canPack(big), false)
})

const bahn = 'C:/Windows/Fonts/bahnschrift.ttf'
test('a variable font lists several weights', { skip: !fs.existsSync(bahn) }, async () => {
  const faces = (await listFontFaces()).filter(f => f.family === 'Bahnschrift')
  assert.ok(new Set(faces.map(f => f.weight)).size >= 3)
  assert.ok(faces.every(f => f.postscript.startsWith('Bahnschrift-')))
  const bytes = await fontFaceBytes({ family: 'Bahnschrift', weight: 700, style: 'normal' })
  assert.ok(bytes && bytes.length > 1000)
})

const cambria ='C:/Windows/Fonts/cambria.ttc'
test('listFontFaces lists the faces inside a collection', { skip: !fs.existsSync(cambria) }, async () => {
  const faces = await listFontFaces()
  const cam = faces.find(f => f.family === 'Cambria' && f.file.toLowerCase().endsWith('cambria.ttc'))
  const math = faces.find(f => f.family === 'Cambria Math')
  assert.equal(cam?.index, 0)
  assert.equal(math?.index, 1)
  const bytes = await fontFaceBytes({ family: 'Cambria', weight: 400, style: 'normal' })
  assert.ok(bytes && bytes.length > 1000)
})
