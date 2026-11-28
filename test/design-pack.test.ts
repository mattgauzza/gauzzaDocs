import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Fonts that travel with a design (design/keepFonts.ts): a font whose license allows it is packed once, one that
// doesn't is kept as outlines, and one that isn't here marks the layer. The "installed" fonts here are the Liberation
// files pdf.js ships, handed to the ops as fontBytes, so this runs the same on any system.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-pack-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-pack-work-'))
after(() => {
  for (const dir of [work, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const { designZipBytes, readDesignZip } = await import('../src/core/formats/design')
const { runOffline } = await import('../src/core/ops/index')
const { fontListing } = await import('../src/core/systemFonts')
const { canPack, fontsFor, packedFamily } = await import('../src/shared/design/fonts')
const { textFlags } = await import('../src/shared/design/keepFonts')
const { newDesign, walk } = await import('../src/shared/design/model')
const { designToSvg } = await import('../src/shared/design/render')
const { layoutText } = await import('../src/shared/design/text')
const { applyDesignOp } = await import('../src/shared/ops/design')
type DesignFile = import('../src/shared/design/types').DesignFile
type FontRef = import('../src/shared/design/types').FontRef
type TextLayer = import('../src/shared/design/types').TextLayer
type AgentOp = import('../src/shared/types').AgentOp

const dir = 'node_modules/pdfjs-dist/standard_fonts/'
const regular = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Regular.ttf'))
const bold = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Bold.ttf'))
const italic = new Uint8Array(fs.readFileSync(dir + 'LiberationSans-Italic.ttf'))

/** A copy of the font with its OS/2 fsType patched: 2 forbids embedding, so it can't be packed. */
function withFsType(bytes: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(bytes)
  const v = new DataView(out.buffer)
  for (let i = 0; i < v.getUint16(4); i++) {
    const rec = 12 + i * 16
    if (String.fromCharCode(...out.subarray(rec, rec + 4)) === 'OS/2') {
      v.setUint16(v.getUint32(rec + 8) + 8, value)
      return out
    }
  }
  throw new Error('no OS/2 table')
}
const locked = withFsType(italic, 2)

/** The fonts "installed here", by family: Brand (packable), Locked (its license forbids packing). */
let installed: Record<string, Uint8Array> = { brand: bold, locked }
let asked: string[] = []
const fontBytes = async (ref: FontRef): Promise<Uint8Array | null> => {
  asked.push(ref.family)
  return installed[ref.family.toLowerCase()] ?? null
}

/** An op as the editor applies it: fonts loaded for the design, the installed ones, and fontBytes to pack with. */
async function op(file: DesignFile, o: AgentOp): Promise<{ file: DesignFile; summary: string; result: any }> {
  const fetch = async (ref: FontRef) => installed[ref.family.toLowerCase()] ?? null
  let fonts = await fontsFor(file.design, file.assets, fetch, regular)
  let r = await applyDesignOp(file, o, { fonts, fontBytes })
  // as the editor does: an op that brings in a font is worked out again once it's loaded
  if (r.file) {
    fonts = await fontsFor(r.file.design, r.file.assets, fetch, regular)
    r = await applyDesignOp(file, o, { fonts, fontBytes })
  }
  return { file: r.file ?? file, summary: r.summary, result: r.result }
}

const blank = (): DesignFile => ({ design: newDesign('instagram'), assets: {} })
const texts = (f: DesignFile): TextLayer[] => {
  const out: TextLayer[] = []
  walk(f.design.artboards[0].layers, l => l.type === 'text' && out.push(l))
  return out
}
const fontAssets = (f: DesignFile) => Object.keys(f.assets).filter(k => /\.(ttf|otf|ttc)$/.test(k))
const words = 'Pack this font so the words wrap the same on every computer'
const addText = (font: unknown, extra: Record<string, unknown> = {}): AgentOp => ({
  op: 'add', type: 'text', props: { text: words, font, size: 20, width: 160, ...extra }
})
const lines = (l: TextLayer, fonts: Awaited<ReturnType<typeof fontsFor>>) => layoutText(l, fonts).lines.map(x => x.spans.map(s => s.text).join(''))

test('a font whose license allows it is packed once, under gd-<12 hex>, and draws the same with no fonts installed', async () => {
  assert.equal(canPack(bold), true)
  const brand = { family: 'Brand', weight: 700, style: 'normal' }
  const one = await op(blank(), addText(brand))
  const [t] = texts(one.file)
  assert.match(t.runs[0].font.asset ?? '', /^assets\/[0-9a-f]{64}\.ttf$/)
  assert.deepEqual(fontAssets(one.file), [t.runs[0].font.asset])
  assert.deepEqual(one.file.assets[t.runs[0].font.asset!], bold)
  assert.equal(t.glyphs, undefined)
  assert.equal(t.missingFont, undefined)
  assert.equal(one.summary, 'added Text 1', 'packing adds nothing to the summary')

  // a second layer in the same face points to the same file: no second copy
  const two = await op(one.file, addText(brand, { y: 300 }))
  const [a, b] = texts(two.file)
  assert.equal(b.runs[0].font.asset, a.runs[0].font.asset)
  assert.equal(fontAssets(two.file).length, 1)

  // on a PC with no fonts at all: the packed face, not the fallback, with the same line breaks
  const back = await readDesignZip(await designZipBytes(two.file))
  const none = await fontsFor(back.design, back.assets, async () => null, regular)
  const installedFonts = await fontsFor(two.file.design, two.file.assets, async r => (r.family === 'Brand' ? bold : null), regular)
  const [ra] = texts(back)
  const got = none.get(ra.runs[0].font)
  assert.ok(!got.missing)
  assert.equal(got.packedFamily, packedFamily(ra.runs[0].font.asset!))
  assert.match(got.packedFamily!, /^gd-[0-9a-f]{12}$/)
  assert.deepEqual(lines(ra, none), lines(a, installedFonts))
  const fallbackOnly = await fontsFor(newDesign('x'), {}, async () => null, regular)
  assert.notDeepEqual(lines(ra, none), lines({ ...ra, runs: [{ ...ra.runs[0], font: { family: 'Gone', weight: 400, style: 'normal' } }] }, fallbackOnly), 'the fallback would break differently')
  const svg = (f: DesignFile, fonts: typeof none) => designToSvg(f.design, f.design.artboards[0].id, { fonts, assets: f.assets, mode: 'raster' })
  assert.equal(svg(back, none), svg(two.file, installedFonts))
  assert.equal(textFlags(ra, none).missingFont, false)
})

test('a font whose license forbids packing keeps its outlines, which draw where the font is gone and follow the text', async () => {
  assert.equal(canPack(locked), false)
  const one = await op(blank(), addText({ family: 'Locked', weight: 400, style: 'italic' }))
  const [t] = texts(one.file)
  assert.equal(t.runs[0].font.asset, undefined)
  assert.equal(fontAssets(one.file).length, 0, 'never packed')
  assert.ok(typeof t.glyphs === 'string' && t.glyphs.length > 1000)
  assert.equal(t.missingFont, undefined)

  // elsewhere, with no such font: drawn from the outlines, and the layer says its font isn't installed
  const none = await fontsFor(one.file.design, one.file.assets, async () => null, regular)
  const drawn = designToSvg(one.file.design, one.file.design.artboards[0].id, { fonts: none, assets: {}, mode: 'raster' })
  assert.ok(drawn.includes(`d="${t.glyphs}"`), 'the stored outlines are drawn')
  assert.equal(textFlags(t, none).missingFont, true)

  // the outlines follow the text, its size and its box
  const changed = await op(one.file, { op: 'set', layer: t.id, props: { text: 'Other words' } })
  const [t2] = texts(changed.file)
  assert.ok(t2.glyphs && t2.glyphs !== t.glyphs)
  const wider = await op(changed.file, { op: 'set', layer: t.id, props: { size: 30 } })
  assert.ok(texts(wider.file)[0].glyphs !== t2.glyphs)
  // a move leaves them as they are (they're in the box's own coordinates)
  const moved = await op(wider.file, { op: 'set', layer: t.id, props: { x: 200 } })
  assert.equal(texts(moved.file)[0].glyphs, texts(wider.file)[0].glyphs)
})

test('a font that is nowhere marks the layer, and the mark clears once the font is found', async () => {
  const one = await op(blank(), addText({ family: 'Nowhere', weight: 400, style: 'normal' }))
  const [t] = texts(one.file)
  assert.equal(t.missingFont, true)
  assert.equal(t.glyphs, undefined)
  assert.equal(t.runs[0].font.asset, undefined)
  const save = installed
  installed = { ...installed, nowhere: bold }
  try {
    const later = await op(one.file, { op: 'add', type: 'rect' })
    const [t2] = texts(later.file)
    assert.equal(t2.missingFont, undefined)
    assert.match(t2.runs[0].font.asset ?? '', /\.ttf$/)
  } finally {
    installed = save
  }
})

test('ops that bring in no text ask for no fonts', async () => {
  const one = await op(blank(), addText({ family: 'Brand', weight: 700, style: 'normal' }))
  asked = []
  await op(one.file, { op: 'add', type: 'rect' })
  await op(one.file, { op: 'set', layer: texts(one.file)[0].id, props: { x: 40 } })
  assert.deepEqual(asked, [])
})

test('offline read measures with packed fonts and stored outlines, never listing the installed fonts', async () => {
  let f = (await op(blank(), addText({ family: 'Brand', weight: 700, style: 'normal' }, { name: 'Packed', height: 20 }))).file
  f = (await op(f, addText({ family: 'Locked', weight: 400, style: 'italic' }, { name: 'Outlined', height: 20, y: 300 }))).file
  f = (await op(f, addText({ family: 'Nowhere', weight: 400, style: 'normal' }, { name: 'Gone', y: 600 }))).file
  f = (await op(f, addText({ family: 'Brand', weight: 700, style: 'normal' }, { name: 'Roomy', height: 400, y: 700, text: 'Hi' }))).file
  const file = path.join(work, 'flags.gdesign')
  fs.writeFileSync(file, await designZipBytes(f))
  const calls = fontListing.calls
  const r = (await runOffline(file, { op: 'read' })) as { layers: string[] }
  assert.equal(fontListing.calls, calls, 'the installed fonts were never listed')
  const line = (name: string) => r.layers.find(l => l.split('  ')[1] === name) ?? ''
  assert.match(line('Packed'), /  overflow$/)
  assert.doesNotMatch(line('Packed'), /missing font/)
  assert.match(line('Outlined'), /  overflow$/)
  assert.doesNotMatch(line('Outlined'), /missing font/)
  assert.match(line('Gone'), /missing font/)
  assert.doesNotMatch(line('Roomy'), /overflow|missing font/)
})

test('a font that would take the design past its zip limits is kept as outlines instead', async () => {
  // a picture that brings the design within a font's size of 1 GB (only its size is ever read here)
  const big = 'assets/' + 'a'.repeat(64) + '.png'
  const f = blank()
  f.assets[big] = { byteLength: 1024 * 1024 * 1024 - 100_000, length: 1024 * 1024 * 1024 - 100_000 } as unknown as Uint8Array
  f.design.artboards[0].layers.push({
    id: 'pic', name: 'Pic', type: 'image', asset: big, visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0,
    width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1
  })
  assert.ok(bold.length > 100_000)
  const r = await op(f, addText({ family: 'Brand', weight: 700, style: 'normal' }))
  const [t] = texts(r.file)
  assert.equal(t.runs[0].font.asset, undefined)
  assert.equal(fontAssets(r.file).length, 0)
  assert.ok(t.glyphs && t.glyphs.length > 1000, 'outlines instead')
})
