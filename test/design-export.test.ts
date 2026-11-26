import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { BLEND_NOTE, MAX_PNG_PIXELS, MAX_PNG_SIDE, RENDER_NEEDS_APP, exportDesign, type ExportDeps } from '../src/core/design/export'
import { designZipBytes } from '../src/core/formats/design'
import { runOffline } from '../src/core/ops'
import { type FontSource, fontsFor } from '../src/shared/design/fonts'
import { newDesign } from '../src/shared/design/model'
import { designToSvg } from '../src/shared/design/render'
import { cleanSvg } from '../src/shared/design/svgClean'
import type { Design, DesignFile, Layer } from '../src/shared/design/types'
import { applyDesignOp } from '../src/shared/ops/design'
import type { AgentOp } from '../src/shared/types'

const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
const fontsOf = (d: Design): Promise<FontSource> => fontsFor(d, {}, async () => liberation, liberation)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-design-export-'))
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
let n = 0
/** A new empty folder for one test's files. */
const folder = (): string => fs.mkdtempSync(path.join(dir, `t${++n}-`))

/** The deps exportDesign gets in the app or the CLI, here over a design in memory (the ops measure with Liberation Sans). */
async function inMemory(file: DesignFile, extra: Partial<ExportDeps> = {}): Promise<ExportDeps & { ops: AgentOp[] }> {
  const services = { fonts: await fontsOf(file.design) }
  const ops: AgentOp[] = []
  return {
    ops,
    run: async op => {
      ops.push(op)
      return (await applyDesignOp(file, op, services)).result
    },
    ...extra
  }
}

/** Applies ops in turn and gives the file they make. */
async function build(file: DesignFile, ...ops: AgentOp[]): Promise<DesignFile> {
  const services = { fonts: await fontsOf(file.design), layout: undefined }
  let f = file
  for (const op of ops) f = (await applyDesignOp(f, op, services)).file ?? f
  return f
}

const base = { visible: true, locked: false, opacity: 1, blend: 'normal' as const, rotation: 0, scaleX: 1, scaleY: 1 }
const svgLayerOf = (id: string, svg: string, x = 0): Layer => ({ ...base, id, name: id, type: 'svg', svg, x, y: 0, width: 400, height: 400 })
/** A legal svg fragment drawing `count` elements (its root and a group among them). */
const fragment = (count: number, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="${color}">${'<rect width="1" height="1"/>'.repeat(count - 2)}</g></svg>`
/** Element names in some SVG text. */
const elements = (svg: string): number => (svg.match(/<[A-Za-z]/g) ?? []).length

// ---------- Step 1: the brief's tests ----------

test('an export-mode SVG of a design with an imported svg layer holds no script, no on* handler and no http reference', async () => {
  const hostile =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200" onload="alert(1)">' +
    '<script>alert(2)</script><defs><filter id="soft"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
    '<g filter="url(#soft)" onclick="alert(3)"><rect width="100" height="100" fill="#3366cc"/>' +
    '<image href="http://example.com/x.png" width="10" height="10"/><a xlink:href="https://example.com"><circle r="5"/></a></g></svg>'
  let file: DesignFile = { design: newDesign('logo'), assets: {} }
  file = await build(file, { op: 'svg', svg: hostile, name: 'Mark' })
  assert.ok(JSON.stringify(file.design).includes('"type":"svg"'), 'the filtered group came in as an svg layer')
  // the file round trip: written, then exported from disk as the CLI does without the app
  const out = folder()
  const p = path.join(out, 'Mark.gdesign')
  fs.writeFileSync(p, await designZipBytes(file))
  const r = await exportDesign(p, { format: 'svg' }, { run: op => runOffline(p, op) })
  assert.deepEqual(r.files, [path.join(out, 'Mark.svg')])
  const svg = fs.readFileSync(r.files[0], 'utf8')
  assert.match(svg, /<filter /, 'the svg layer is inline')
  assert.doesNotMatch(svg, /<script/i)
  assert.doesNotMatch(svg, /\son\w+\s*=/i)
  // the namespaces are names, not references: anything else naming http is
  assert.doesNotMatch(svg.replace(/\sxmlns(:\w+)?="[^"]*"/g, ''), /http/i)
})

test('png: --scale 2 of an 8192 artboard passes; --width 20000 is refused with the limit', async () => {
  const file: DesignFile = { design: newDesign('8192x8192'), assets: {} }
  const drawn: { width: number; height: number; svg: string }[] = []
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const deps = await inMemory(file, {
    rasterize: async (svg, width, height) => {
      drawn.push({ svg, width, height })
      return png
    }
  })
  const out = folder()
  const p = path.join(out, 'Big.gdesign')
  const r = await exportDesign(p, { format: 'png', scale: 2 }, deps)
  assert.deepEqual(r.files, [path.join(out, 'Big.png')])
  assert.deepEqual(new Uint8Array(fs.readFileSync(r.files[0])), png)
  assert.deepEqual([drawn[0].width, drawn[0].height], [16384, 16384])
  assert.equal(MAX_PNG_SIDE, 16384)
  assert.equal(MAX_PNG_PIXELS, 16384 * 16384)
  // drawn as the editor draws it (raster mode), at the pixel size, over the artboard's own view box
  assert.match(drawn[0].svg, /^<svg [^>]*width="16384" height="16384" viewBox="0 0 8192 8192"/)
  await assert.rejects(exportDesign(p, { format: 'png', width: 20000 }, deps), /16,384 px per side.*20,000 x 20,000/)
  // a tall artboard at a modest width would still be too tall
  const tall = await build({ design: newDesign('100x8192'), assets: {} })
  await assert.rejects(exportDesign(p, { format: 'png', width: 1000 }, await inMemory(tall, { rasterize: async () => png })), /1,000 x 81,920/)
  assert.equal(drawn.length, 1, 'nothing past the limit was drawn')
})

test('the downgrade list for a design using multiply blend names the blend note', async () => {
  const file = await build(
    { design: newDesign('logo'), assets: {} },
    { op: 'add', type: 'rect', props: { name: 'Glow', width: 400, height: 400, fill: '#ff0066', blend: 'multiply' } }
  )
  const r = await exportDesign(path.join(folder(), 'Glow.gdesign'), { format: 'svg' }, await inMemory(file))
  assert.equal(BLEND_NOTE, 'Blend modes may be flattened by tools other than browsers and Inkscape.')
  assert.ok(r.downgrades.includes(BLEND_NOTE), r.downgrades.join('\n'))
  // a PNG holds the blend as the browser drew it
  const png = await exportDesign(path.join(folder(), 'Glow.gdesign'), { format: 'png' }, await inMemory(file, { rasterize: async () => new Uint8Array(4) }))
  assert.ok(!png.downgrades.includes(BLEND_NOTE))
})

// ---------- the rulings ----------

test('png needs the app: with nothing to draw it, the Global Constraints sentence', async () => {
  const file: DesignFile = { design: newDesign('logo'), assets: {} }
  await assert.rejects(exportDesign(path.join(folder(), 'X.gdesign'), { format: 'png' }, await inMemory(file)), { message: RENDER_NEEDS_APP })
  assert.equal(RENDER_NEEDS_APP, 'Start gauzzaDocs to render designs. Editing and SVG export work without it.')
})

test('file names: one artboard is <stem>, several are <stem> <artboard> each, --artboard picks one, --out a folder takes the names', async () => {
  const one = { design: newDesign('logo'), assets: {} }
  let out = folder()
  let r = await exportDesign(path.join(out, 'Solo.gdesign'), { format: 'svg' }, await inMemory(one))
  assert.deepEqual(r.files, [path.join(out, 'Solo.svg')])

  const two = await build(
    { design: newDesign('logo'), assets: {} },
    { op: 'artboard', action: 'rename', name: 'Front: v2' },
    { op: 'artboard', action: 'add', name: 'Back', size: '400x300' }
  )
  out = folder()
  const p = path.join(out, 'Card.gdesign')
  r = await exportDesign(p, { format: 'svg' }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(out, 'Card Front v2.svg'), path.join(out, 'Card Back.svg')])
  assert.match(fs.readFileSync(r.files[1], 'utf8'), /width="400" height="300"/)
  // --artboard: that one, named after it
  r = await exportDesign(p, { format: 'svg', artboard: 'Back', out: undefined }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(out, 'Card Back.svg')])
  // --out a folder: the same names in it
  const into = folder()
  r = await exportDesign(p, { format: 'svg', out: into }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(into, 'Card Front v2.svg'), path.join(into, 'Card Back.svg')])
  // --out a file: only for one artboard
  const refusal = 'This design has 2 artboards. Pick one with --artboard, or give --out a folder.'
  const deps = await inMemory(two)
  await assert.rejects(exportDesign(p, { format: 'svg', out: path.join(into, 'x.svg') }, deps), { message: refusal })
  await assert.rejects(exportDesign(p, { format: 'svg', out: '-' }, deps), { message: refusal })
  assert.equal(fs.existsSync(path.join(into, 'x.svg')), false)
  r = await exportDesign(p, { format: 'svg', artboard: 'Back', out: path.join(into, 'x.svg') }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(into, 'x.svg')])
  // --out - prints one artboard's SVG and writes nothing
  r = await exportDesign(p, { format: 'svg', artboard: 'Back', out: '-' }, await inMemory(two))
  assert.deepEqual(r.files, [])
  assert.match(r.content ?? '', /^<svg [^>]*width="400" height="300"/)
  // names that come out the same once made safe for a file, and a name with nothing left, fall back to the id
  const clash = await build(
    { design: newDesign('logo'), assets: {} },
    { op: 'artboard', action: 'rename', name: 'A/B' },
    { op: 'artboard', action: 'add', name: 'A:B' },
    { op: 'artboard', action: 'add', name: '???' }
  )
  out = folder()
  r = await exportDesign(path.join(out, 'Z.gdesign'), { format: 'svg' }, await inMemory(clash))
  const ids = clash.design.artboards.map(a => a.id)
  assert.deepEqual(r.files, [path.join(out, 'Z A B.svg'), path.join(out, `Z A B ${ids[1]}.svg`), path.join(out, `Z ${ids[2]}.svg`)])
})

test('every svg export is cleaned, with room for each svg layer: two legal 30,000 element layers export, and svg --get of their group works', async () => {
  const design = newDesign('1000x1000')
  const group: Layer = {
    ...base, id: 'pair', name: 'Pair', type: 'group', x: 0, y: 0, width: 800, height: 400,
    children: [svgLayerOf('left', fragment(30_000, '#112233')), svgLayerOf('right', fragment(30_000, '#445566'), 400)]
  }
  design.artboards[0].layers.push(group)
  const file: DesignFile = { design, assets: {} }
  const fonts = await fontsOf(design)
  // one cleaning at the outside limits would refuse the drawing
  const raw = designToSvg(design, design.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.ok(elements(raw) > 60_000)
  assert.throws(() => cleanSvg(raw), /too many elements \(over 50,000\)/)
  const t0 = Date.now()
  const r = await exportDesign(path.join(folder(), 'Pair.gdesign'), { format: 'svg' }, await inMemory(file))
  const svg = fs.readFileSync(r.files[0], 'utf8')
  assert.ok(elements(svg) > 60_000)
  assert.deepEqual(r.leftOut, [])
  const got = (await applyDesignOp(file, { op: 'svg', get: 'Pair' }, { fonts })).result as { svg: string }
  assert.ok(elements(got.svg) > 60_000)
  const whole = (await applyDesignOp(file, { op: 'svg', get: true }, { fonts })).result as { svg: string }
  assert.ok(elements(whole.svg) > 60_000)
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`)
})

/** Every file in a folder, with its bytes. */
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]))

test('a refused or failed export writes nothing and leaves an export already there as it was', async () => {
  const two = await build(
    { design: newDesign('1000x1000'), assets: {} },
    { op: 'artboard', action: 'rename', name: 'A' },
    { op: 'artboard', action: 'add', name: 'B', size: '100x8192' }
  )
  const out = folder()
  const p = path.join(out, 'X.gdesign')
  fs.writeFileSync(path.join(out, 'X A.png'), 'the export from before')
  fs.writeFileSync(path.join(out, 'X A.svg'), 'the export from before')
  const before = snapshot(out)
  // the second artboard past the PNG limit: refused before anything is drawn
  let drawn = 0
  const png = { rasterize: async () => (drawn++, new Uint8Array(4)) }
  await assert.rejects(exportDesign(p, { format: 'png', width: 1000 }, await inMemory(two, png)), /16,384 px per side.*1,000 x 81,920/)
  assert.equal(drawn, 0)
  assert.deepEqual(snapshot(out), before)
  // the second artboard's drawing fails, after the first was made
  const failing = await inMemory(two, { rasterize: async (_svg, w) => (w === 100 ? Promise.reject(new Error('no memory')) : new Uint8Array(4)) })
  await assert.rejects(exportDesign(p, { format: 'png' }, failing), /no memory/)
  assert.deepEqual(snapshot(out), before)
  // the second artboard's SVG can't be cleaned
  const deps = await inMemory(two)
  const run = deps.run
  deps.run = async op => {
    const r = (await run(op)) as Record<string, unknown>
    return op.artboard === two.design.artboards[1].id && !op.plan ? { ...r, svg: '<html>not svg</html>' } : r
  }
  await assert.rejects(exportDesign(p, { format: 'svg' }, deps), /not an SVG/)
  assert.deepEqual(snapshot(out), before)
  // and one that works replaces the old file whole, leaving nothing else behind
  const r = await exportDesign(p, { format: 'svg' }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(out, 'X A.svg'), path.join(out, 'X B.svg')])
  assert.deepEqual(fs.readdirSync(out).sort(), ['X A.png', 'X A.svg', 'X B.svg'])
  assert.match(fs.readFileSync(path.join(out, 'X A.svg'), 'utf8'), /^<svg /)
})

test('--out ending in a path separator is a folder, made when it is not there', async () => {
  const two = await build({ design: newDesign('logo'), assets: {} }, { op: 'artboard', action: 'add', name: 'Back', size: '400x300' })
  const base = folder()
  const into = path.join(base, 'made', 'here') + path.sep
  const r = await exportDesign(path.join(base, 'Card.gdesign'), { format: 'svg', out: into }, await inMemory(two))
  assert.deepEqual(r.files, [path.join(base, 'made', 'here', 'Card Logo.svg'), path.join(base, 'made', 'here', 'Card Back.svg')])
  const one = path.join(base, 'solo') + '/'
  const s = await exportDesign(path.join(base, 'Solo.gdesign'), { format: 'svg', out: one }, await inMemory({ design: newDesign('logo'), assets: {} }))
  assert.deepEqual(s.files, [path.join(base, 'solo', 'Solo.svg')])
})

test('the clean allows what the renderer drew: 30,000 plain layers export, and svg --get of their group works', async () => {
  const design = newDesign('1000x1000')
  const children: Layer[] = Array.from({ length: 30_000 }, (_, i) => ({
    ...base, id: `r${i}`, name: `Dot ${i}`, type: 'rect', x: i % 1000, y: Math.floor(i / 1000) * 10, width: 1, height: 1,
    fill: { type: 'color', color: '#123456' }
  }))
  design.artboards[0].layers.push({ ...base, id: 'many', name: 'Many', type: 'group', x: 0, y: 0, width: 1000, height: 300, children })
  const file: DesignFile = { design, assets: {} }
  const fonts = await fontsOf(design)
  const raw = designToSvg(design, design.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.ok(elements(raw) > 60_000)
  assert.throws(() => cleanSvg(raw), /too many elements \(over 50,000\)/, 'the outside limits alone would refuse it')
  const t0 = Date.now()
  const r = await exportDesign(path.join(folder(), 'Dots.gdesign'), { format: 'svg' }, await inMemory(file))
  assert.ok(elements(fs.readFileSync(r.files[0], 'utf8')) > 60_000)
  const got = (await applyDesignOp(file, { op: 'svg', get: 'Many' }, { fonts })).result as { svg: string }
  assert.ok(elements(got.svg) > 60_000)
  const whole = (await applyDesignOp(file, { op: 'svg', get: true }, { fonts })).result as { svg: string }
  assert.ok(elements(whole.svg) > 60_000)
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`)
})

test('the clean allows what the renderer drew: text of 5,000 lines and many 256-stop gradients export', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `Line ${i + 1}`).join('\n')
  const text = (id: string, x: number): Layer => ({
    ...base, id, name: id, type: 'text', x, y: 0, width: 80, height: 60_000, mode: 'point', align: 'left', valign: 'top',
    runs: [{ text: lines, font: { family: 'Liberation Sans', weight: 400, style: 'normal' }, size: 10 }]
  })
  // one text layer of 5,000 lines, then eleven on one artboard: past the outside limit and any fixed allowance a layer
  for (const count of [1, 11]) {
    const design = newDesign('1000x1000')
    for (let i = 0; i < count; i++) design.artboards[0].layers.push(text(`t${i}`, i * 90))
    const r = await exportDesign(path.join(folder(), 'Lines.gdesign'), { format: 'svg' }, await inMemory({ design, assets: {} }))
    assert.deepEqual(r.leftOut, [])
    assert.ok(elements(fs.readFileSync(r.files[0], 'utf8')) > 5000 * count)
  }
  // a rect filled with a 256-stop gradient, 300 times: 257 elements of gradient each
  const design = newDesign('1000x1000')
  const stops = Array.from({ length: 256 }, (_, i) => ({ offset: i / 255, color: i % 2 ? '#1a73e8' : '#f4b400' }))
  for (let i = 0; i < 300; i++) {
    design.artboards[0].layers.push({ ...base, id: `g${i}`, name: `G${i}`, type: 'rect', x: i, y: i, width: 100, height: 100, fill: { type: 'linear', angle: 30, stops } })
  }
  const r = await exportDesign(path.join(folder(), 'Stops.gdesign'), { format: 'svg' }, await inMemory({ design, assets: {} }))
  assert.ok(elements(fs.readFileSync(r.files[0], 'utf8')) > 300 * 257)
})

test('the renderer counts its own elements and paintings the way the clean does', async () => {
  const { elementCount } = await import('../src/shared/design/svgClean')
  const { layoutDiagram } = await import('../src/core/design/layout')
  let f: DesignFile = { design: newDesign('1000x1000'), assets: {} }
  const services = { fonts: await fontsOf(f.design), layout: layoutDiagram }
  const ops: AgentOp[] = [
    { op: 'diagram', name: 'Flow', text: 'node a: Start\nnode b: Next\nbox x: Group\nnode c: In the box in x\na -> b : yes\nb -> c' },
    { op: 'add', type: 'rect', props: { name: 'A', x: 600, width: 50, height: 50 } },
    { op: 'add', type: 'rect', props: { name: 'B', x: 900, width: 50, height: 50 } },
    { op: 'add', type: 'connector', props: { from: 'A', to: 'B', label: 'both ways', arrow: 'both' } },
    { op: 'add', type: 'ellipse', props: { name: 'Mask', x: 600, y: 600, width: 100, height: 100 } },
    { op: 'add', type: 'rect', props: { name: 'Fill', x: 600, y: 600, width: 200, height: 80, fill: '#ff6600' } },
    { op: 'group', layers: ['Mask', 'Fill'], name: 'Clipped' },
    { op: 'set', layer: 'Clipped', props: { clip: true } },
    { op: 'add', type: 'text', props: { name: 'Word', text: 'Clip', x: 100, y: 800, size: 80 } },
    { op: 'add', type: 'rect', props: { name: 'Behind', x: 100, y: 800, width: 300, height: 100, fill: '#3366cc' } },
    { op: 'group', layers: ['Word', 'Behind'], name: 'Lettered' },
    { op: 'set', layer: 'Lettered', props: { clip: true } }
  ]
  for (const op of ops) f = (await applyDesignOp(f, op, services)).file ?? f
  const counts = { svg: 0, fragmentElements: 0, paints: 0 }
  const raw = designToSvg(f.design, f.design.artboards[0].id, { fonts: services.fonts, assets: {}, mode: 'export', counts })
  assert.ok(counts.paints >= 5, `${counts.paints} paintings`)
  assert.equal(cleanSvg(raw).painted, counts.paints)
  assert.equal(elementCount(raw), elements(raw))
})

test('raster mode, which PNG draws without cleaning, holds an svg layer only as a data URI image', async () => {
  const design = newDesign('logo')
  design.artboards[0].layers.push(svgLayerOf('mark', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle id="only-inside" r="4"/></svg>'))
  const svg = designToSvg(design, design.artboards[0].id, { fonts: await fontsOf(design), assets: {}, mode: 'raster' })
  assert.match(svg, /<image [^>]*xlink:href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\/>/)
  assert.doesNotMatch(svg, /only-inside|<circle/)
  assert.equal((svg.match(/<svg[\s>]/g) ?? []).length, 1, 'no inline svg but the root')
})

test('layers the drawing left out come back with the artboard they were on', async () => {
  const design = newDesign('logo')
  design.artboards[0].layers.push(svgLayerOf('bad', 'this is not svg'))
  const r = await exportDesign(path.join(folder(), 'Bad.gdesign'), { format: 'svg' }, await inMemory({ design, assets: {} }))
  assert.equal(r.leftOut.length, 1)
  assert.equal(r.leftOut[0].layer, 'bad')
  assert.equal(r.leftOut[0].artboard, design.artboards[0].name)
  assert.match(r.leftOut[0].reason, /could not be converted/)
})

test('look notes name text that overflows its box and layers past the edge or outside the artboard, by name and id', async () => {
  const file = await build(
    { design: newDesign('400x300'), assets: {} },
    { op: 'artboard', action: 'rename', name: 'Main' },
    { op: 'add', type: 'rect', props: { name: 'Fits', x: 0, y: 0, width: 400, height: 300 } },
    { op: 'add', type: 'text', props: { name: 'Title', x: 10, y: 10, width: 120, height: 20, mode: 'box', size: 16, text: 'This headline is far too long for the little box it sits in' } },
    { op: 'add', type: 'rect', props: { name: 'Badge', x: 350, y: 250, width: 100, height: 100 } },
    { op: 'add', type: 'rect', props: { name: 'Ghost', x: 500, y: 0, width: 50, height: 50 } },
    { op: 'add', type: 'rect', props: { name: 'Hidden', x: 600, y: 0, width: 50, height: 50, visible: false } }
  )
  const { designNotes } = await import('../src/renderer/src/design/notes')
  const id = (name: string) => file.design.artboards[0].layers.find(l => l.name === name)!.id
  const notes = designNotes(file.design, await fontsOf(file.design))
  assert.deepEqual(notes, [
    `Artboard Main: the text "This headline is far too long for the little..." in layer Title (${id('Title')}) doesn't fit its box and runs past it.`,
    `Artboard Main: layer Badge (${id('Badge')}) goes past the edge of the artboard.`,
    `Artboard Main: layer Ghost (${id('Ghost')}) is outside the artboard, so it doesn't show.`
  ])
  for (const note of notes) assert.match(note, /^[\x20-\x7e]+$/, 'ASCII only')
})

test('the Home card reads thumbnail.png from the zip, and none when the design says it is stale', async () => {
  const { readDesignThumbnail } = await import('../src/core/formats/design')
  const thumbnail = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const design = newDesign('logo')
  assert.deepEqual(await readDesignThumbnail(await designZipBytes({ design, assets: {}, thumbnail })), thumbnail)
  assert.equal(await readDesignThumbnail(await designZipBytes({ design: { ...design, thumbnailStale: true }, assets: {}, thumbnail })), null)
  assert.equal(await readDesignThumbnail(await designZipBytes({ design, assets: {} })), null)
  assert.equal(await readDesignThumbnail(new Uint8Array([1, 2, 3])), null, 'a file that is not a zip has none')
})

test('a partial save carries a thumbnail the editor just drew', async () => {
  const { DesignSaves } = await import('../src/renderer/src/design/saves')
  const design = newDesign('logo')
  const thumbnail = new Uint8Array([1, 2, 3])
  const saves = new DesignSaves({})
  const p = saves.partial({ design, assets: {}, thumbnail })
  assert.ok(p.kind === 'design' && p.partial)
  assert.deepEqual(p.file.thumbnail, thumbnail)
  const none = saves.partial({ design, assets: {} })
  assert.ok(none.kind === 'design' && !('thumbnail' in none.file), "without one the worker keeps the file's own")
})

test('a save draws a thumbnail when the file has none that shows the design, and a failed drawing still saves, marked stale', async () => {
  const { DesignSaves, DesignThumbs } = await import('../src/renderer/src/design/saves')
  const png = new Uint8Array([1, 2, 3])
  const drawn: Design[] = []
  const draw = async (f: DesignFile) => (drawn.push(f.design), png)
  const fail = async (): Promise<Uint8Array> => {
    throw new Error('no window')
  }
  // opened stale (saved without the app): the first save draws, sends it and drops the flag
  let f: DesignFile = { design: { ...newDesign('logo'), thumbnailStale: true }, assets: {}, thumbnail: new Uint8Array([9]) }
  const thumbs = new DesignThumbs(f)
  const saves = new DesignSaves({})
  const save = async (file: DesignFile, how: typeof draw | typeof fail | null) => {
    const { file: out, shows } = await thumbs.prepare(file, how)
    const p = thumbs.handOut(how ? saves.partial(out) : saves.full(out), shows)
    assert.ok(p.kind === 'design')
    return p
  }
  let p = await save(f, draw)
  assert.deepEqual([drawn.length, p.file.thumbnail, p.file.design.thumbnailStale], [1, png, undefined])
  assert.ok(!('thumbnailStale' in p.file.design))
  thumbs.saved(p)
  // saved again unchanged: nothing drawn, the file keeps its thumbnail
  p = await save(f, draw)
  assert.deepEqual([drawn.length, 'thumbnail' in p.file, p.file.design.thumbnailStale], [1, false, undefined])
  // changed, and the drawing fails: the save still comes out, marked stale, without a thumbnail
  f = { ...f, design: { ...f.design, id: 'changed' } }
  p = await save(f, fail)
  assert.deepEqual([p.file.design.thumbnailStale, 'thumbnail' in p.file], [true, false])
  thumbs.saved(p)
  // a copy for elsewhere never draws, and says it's stale until a save draws one
  p = await save(f, null)
  assert.deepEqual([drawn.length, p.file.design.thumbnailStale], [1, true])
  p = await save(f, draw)
  assert.deepEqual([drawn.length, p.file.thumbnail, p.file.design.thumbnailStale], [2, png, undefined])
  thumbs.saved(p)
  // now the copy carries it
  p = await save(f, null)
  assert.deepEqual([drawn.length, p.file.thumbnail, p.file.design.thumbnailStale], [2, png, undefined])
  // opened with a current thumbnail: an unchanged save draws nothing
  const opened: DesignFile = { design: newDesign('logo'), assets: {}, thumbnail: png }
  const unchanged = await new DesignThumbs(opened).prepare(opened, draw)
  assert.deepEqual([drawn.length, 'thumbnail' in unchanged.file, unchanged.file.design.thumbnailStale], [2, false, undefined])
  assert.equal(unchanged.shows, opened.design)
})

test('the thumbnail is 512 px on its long side', async () => {
  const { thumbnailSize } = await import('../src/renderer/src/design/raster')
  assert.deepEqual(thumbnailSize(1080, 1080), { width: 512, height: 512 })
  assert.deepEqual(thumbnailSize(1080, 1920), { width: 288, height: 512 })
  assert.deepEqual(thumbnailSize(1600, 900), { width: 512, height: 288 })
  assert.deepEqual(thumbnailSize(8192, 1), { width: 512, height: 1 })
})

test('a printed page may load only what a data URL page could: data, blob and web images, inline styles, data fonts', async () => {
  const { PRINT_POLICY, withPrintPolicy } = await import('../src/shared/convert')
  assert.equal(PRINT_POLICY, "default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline'; font-src data:")
  // images: embedded and from the web, never a local file (nothing else falls back to anything but 'none')
  const directive = (name: string) => PRINT_POLICY.split(';').map(d => d.trim().split(/\s+/)).find(d => d[0] === name)?.slice(1) ?? []
  assert.deepEqual(directive('img-src'), ['data:', 'blob:', 'http:', 'https:'])
  assert.ok(!PRINT_POLICY.includes('file:') && !PRINT_POLICY.includes('*') && !PRINT_POLICY.includes("'self'"))
  assert.deepEqual(directive('default-src'), ["'none'"])
  const page = withPrintPolicy('<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><img src="file:///C:/secret.png"></body></html>')
  assert.ok(page.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PRINT_POLICY}"><meta charset="utf-8">`))
  assert.ok(withPrintPolicy('<HTML><HEAD lang="en"><title>T</title></HEAD></HTML>').includes(`<HEAD lang="en"><meta http-equiv`))
  assert.ok(withPrintPolicy('<p>No head</p>').startsWith('<meta http-equiv="Content-Security-Policy"'))
})

test('print puts each artboard on its own page, drawn in raster mode and scaled to fit', async () => {
  const { designPrintHtml } = await import('../src/shared/design/print')
  const file = await build(
    { design: newDesign('logo'), assets: {} },
    { op: 'add', type: 'text', props: { name: 'Word', text: 'Hi', size: 96 } },
    { op: 'artboard', action: 'add', name: 'Wide', size: '1600x900' }
  )
  const html = designPrintHtml(file.design, { fonts: await fontsOf(file.design), assets: {} }, 'Card <1>')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<title>Card &lt;1&gt;<\/title>/)
  const pages = html.match(/<div class="page[^"]*">/g) ?? []
  assert.equal(pages.length, 2)
  assert.match(pages[1], /wide/, 'a wide artboard prints across the page')
  // raster mode: text as outlines, never live <text>
  assert.doesNotMatch(html, /<text[\s>]/)
  // fitted: 1000 x 1000 into 7.5 x 10 in (720 x 960 px), 1600 x 900 into 10 x 7.5 in (960 x 720 px)
  assert.match(html, /<svg [^>]*width="720" height="720" viewBox="0 0 1000 1000"/)
  assert.match(html, /<svg [^>]*width="960" height="540" viewBox="0 0 1600 900"/)
})
