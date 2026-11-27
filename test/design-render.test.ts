import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { fontsFor, type FontSource } from '../src/shared/design/fonts'
import { newDesign, walk } from '../src/shared/design/model'
import { connectorPath, designToSvg, layerToSvg } from '../src/shared/design/render'
import { cleanText, layoutText, num, textReport } from '../src/shared/design/text'
import type { Component, Design, FontRef, Layer, TextLayer, TextRun } from '../src/shared/design/types'

const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
const LIB: FontRef = { family: 'Liberation Sans', weight: 400, style: 'normal' }
const FOX = 'The quick brown fox jumps over the lazy dog'

const base = { visible: true, locked: false, opacity: 1, blend: 'normal' as const, rotation: 0, scaleX: 1, scaleY: 1 }
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const rect = (id: string, name: string, extra: Partial<Layer> = {}): Layer =>
  ({ ...base, ...box(10, 10, 100, 50), id, name, type: 'rect', fill: { type: 'color', color: '#ff0000' }, ...extra }) as Layer
const text = (id: string, runs: TextRun[] | string, extra: Partial<TextLayer> = {}): TextLayer => ({
  ...base, ...box(0, 0, 300, 400), id, name: 'Text ' + id, type: 'text', mode: 'box', align: 'left', valign: 'top',
  runs: typeof runs === 'string' ? [{ text: runs, font: LIB, size: 32 }] : runs, ...extra
})

function designOf(...layers: Layer[]): Design {
  const d = newDesign('instagram')
  d.artboards[0].layers.push(...layers)
  return d
}
/** Liberation Sans for every font the design names, or nothing (every font missing) with `missing`. */
const fontsOf = (d: Design, missing = false): Promise<FontSource> =>
  fontsFor(d, {}, async () => (missing ? null : liberation), liberation)

function parse(svg: string): Document {
  return new DOMParser({ onError: (level, msg) => { throw new Error(`${level}: ${msg}`) } })
    .parseFromString(svg, 'image/svg+xml') as unknown as Document
}
const lineText = (l: { spans: { text: string }[] }) => l.spans.map(s => s.text).join('')
const byId = (doc: Document, id: string): Element | null => {
  const all = doc.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) if (all[i].getAttribute('id') === id) return all[i]
  return null
}
const children = (el: Element, tag: string): Element[] => {
  const out: Element[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i] as Element
    if (n.nodeType === 1 && n.tagName === tag) out.push(n)
  }
  return out
}

test('box text wraps at the box width on spaces', async () => {
  const layer = text('t1', FOX)
  const layout = layoutText(layer, await fontsOf(designOf(layer)))
  // Liberation Sans at 32 px: The 55.14, quick 74.70, brown 87.16, fox 42.69, jumps 85.36, over 62.25, the 44.48,
  // lazy 56.91, dog 53.39, space 8.89. "The quick brown fox" is 286.36 and "jumps over the lazy" is 275.67.
  assert.deepEqual(layout.lines.map(lineText), ['The quick brown fox', 'jumps over the lazy', 'dog'])
  assert.equal(layout.lines.length, 3)
  assert.ok(Math.abs(layout.lines[0].width - 286.36) < 0.05, `line 1 is ${layout.lines[0].width}`)
  assert.ok(Math.abs(layout.height - 3 * 32 * 1.2) < 1e-6)
  // first baseline at top plus the ascent (1854 / 2048 of 32 px)
  assert.ok(Math.abs(layout.lines[0].y - (32 * 1854) / 2048) < 1e-6)
  assert.ok(Math.abs(layout.lines[1].y - layout.lines[0].y - 38.4) < 1e-6)
  assert.equal(layout.overflow, false)
})

test('point text never wraps', async () => {
  const layer = text('t1', FOX, { mode: 'point', width: 50 })
  const layout = layoutText(layer, await fontsOf(designOf(layer)))
  assert.equal(layout.lines.length, 1)
  assert.equal(lineText(layout.lines[0]), FOX)
  assert.equal(layout.overflow, false)
})

test('a box too short for its text overflows', async () => {
  const layer = text('t1', FOX, { height: 40 })
  const fonts = await fontsOf(designOf(layer))
  assert.equal(layoutText(layer, fonts).overflow, true)
  assert.deepEqual(textReport(layer, fonts), { missingFont: false, overflow: true })
})

test('a word wider than the box breaks by letter', async () => {
  const layer = text('t1', 'Supercalifragilistic', { width: 100 })
  const layout = layoutText(layer, await fontsOf(designOf(layer)))
  assert.ok(layout.lines.length > 1)
  assert.equal(layout.lines.map(lineText).join(''), 'Supercalifragilistic')
  for (const l of layout.lines) assert.ok(l.width <= 100 + 1e-6)
})

test('alignment, justify, newlines and mixed runs', async () => {
  const center = text('c', 'Hi', { align: 'center' })
  const fonts = await fontsOf(designOf(center))
  const c = layoutText(center, fonts).lines[0]
  assert.ok(Math.abs(c.x - (300 - c.width) / 2) < 1e-6)
  const justified = layoutText(text('j', FOX, { align: 'justify' }), fonts)
  assert.ok(Math.abs(justified.lines[0].width - 300) < 1e-6)
  assert.ok(Math.abs(justified.lines[1].width - 300) < 1e-6)
  assert.ok(justified.lines[2].width < 100, 'the last line is not stretched')
  assert.equal(layoutText(text('n', 'a\nb'), fonts).lines.length, 2)
  const mixed = layoutText(text('m', [{ text: 'Big ', font: LIB, size: 40 }, { text: 'small', font: LIB, size: 10 }]), fonts)
  assert.equal(mixed.lines.length, 1)
  assert.deepEqual(mixed.lines[0].spans.map(s => s.run), [0, 1])
  assert.ok(Math.abs(mixed.height - 48) < 1e-6, 'line height is 1.2 times the largest run')
  assert.equal(layoutText(text('o', FOX), fonts, 'Hello').lines.map(lineText).join('|'), 'Hello')
})

const logoName = '<Logo & "Mark">'
function sampleDesign(): Design {
  const d = designOf(
    rect('r1', logoName),
    {
      ...base, ...box(0, 0, 400, 400), id: 'g1', name: 'Group', type: 'group',
      children: [rect('r2', 'Inner', { fill: { type: 'style', ref: 'Brand' } }), text('t1', FOX, { y: 100 })]
    } as Layer
  )
  d.styles.colors.push({ name: 'Brand', color: '#123abc' })
  return d
}

test('designToSvg output parses and names every layer', async () => {
  const d = sampleDesign()
  const fonts = await fontsOf(d)
  for (const mode of ['raster', 'export'] as const) {
    const svg = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode })
    const doc = parse(svg)
    const root = doc.documentElement
    assert.equal(root.getAttribute('width'), '1080')
    assert.equal(root.getAttribute('viewBox'), '0 0 1080 1080')
    walk(d.artboards[0].layers, l => {
      const g = byId(doc, `l-${l.id}`)
      assert.ok(g, `layer ${l.id} has a group`)
      assert.equal(g!.getAttribute('inkscape:label'), l.name)
      assert.equal(g!.getAttribute('data-name'), l.name)
    })
    assert.equal(byId(doc, 'l-r1')!.getAttribute('inkscape:groupmode'), 'layer')
    assert.equal(byId(doc, 'l-r2')!.getAttribute('inkscape:groupmode'), null)
    assert.ok(svg.includes('data-name="&lt;Logo &amp; &quot;Mark&quot;&gt;"'))
    assert.ok(!svg.includes(logoName))
    assert.ok(svg.includes('fill="#123abc"'), 'the style paint resolves to its color')
  }
})

test('text is outlines in raster mode and one tspan per line in export mode', async () => {
  const d = sampleDesign()
  const fonts = await fontsOf(d)
  const raster = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' }))
  assert.equal(raster.getElementsByTagName('text').length, 0)
  assert.ok(byId(raster, 'l-t1')!.getElementsByTagName('path').length >= 3)
  const exported = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' }))
  const texts = byId(exported, 'l-t1')!.getElementsByTagName('text')
  assert.equal(texts.length, 1)
  const lines = children(texts[0], 'tspan')
  assert.deepEqual(lines.map(l => l.textContent), ['The quick brown fox', 'jumps over the lazy', 'dog'])
  assert.equal(lines[0].getAttribute('font-family'), 'Liberation Sans')
  assert.ok(Number(lines[1].getAttribute('y')) > Number(lines[0].getAttribute('y')))
  const outlined = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export', outlines: true }))
  assert.equal(outlined.getElementsByTagName('text').length, 0)
})

test('the same input renders byte for byte the same, with ids from the layer id', async () => {
  const d = designOf(
    rect('r1', 'Grad', {
      fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff80' }] },
      shadow: { x: 2, y: 2, blur: 4, color: '#00000080' }
    })
  )
  const fonts = await fontsOf(d)
  const a = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.equal(a, designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' }))
  const doc = parse(a)
  assert.equal(byId(doc, 'g-r1-1')!.tagName, 'linearGradient')
  assert.equal(byId(doc, 'f-r1-1')!.tagName, 'filter')
  assert.ok(a.includes('fill="url(#g-r1-1)"'))
  assert.ok(!/#[0-9a-f]{8}"/i.test(a), 'eight digit colors become a color plus an opacity')
})

test('hidden layers are skipped in raster mode and display none in export mode', async () => {
  const d = designOf(rect('r1', 'Hidden', { visible: false }))
  const fonts = await fontsOf(d)
  assert.ok(!designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' }).includes('l-r1'))
  const exported = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' }))
  assert.equal(byId(exported, 'l-r1')!.getAttribute('display'), 'none')
})

test('a layer outside its timing window is hidden at that time', async () => {
  const d = designOf(rect('r1', 'Later', { timing: { start: 2, end: 4 } }))
  const fonts = await fontsOf(d)
  const at = (seconds: number) => designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster', seconds })
  assert.ok(!at(1).includes('l-r1'))
  assert.ok(at(3).includes('l-r1'))
  assert.ok(!at(4).includes('l-r1'))
})

test('a clipping group clips the rest to its first child, which keeps its group but is not drawn', async () => {
  const d = designOf({
    ...base, ...box(0, 0, 200, 200), id: 'g1', name: 'Masked', type: 'group', clip: true,
    children: [{ ...rect('m1', 'Mask'), type: 'ellipse' } as Layer, rect('r1', 'Photo')]
  } as Layer)
  const doc = parse(designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'raster' }))
  const clip = byId(doc, 'c-g1-1')!
  assert.equal(clip.tagName, 'clipPath')
  assert.equal(clip.getElementsByTagName('ellipse').length, 1)
  const mask = byId(doc, 'l-m1')!
  assert.equal(mask.getAttribute('inkscape:label'), 'Mask')
  assert.equal(mask.getAttribute('data-name'), 'Mask')
  assert.equal(clip.parentNode, mask, 'the mask layer holds its clip path, which never draws')
  assert.equal(children(mask, 'ellipse').length, 0)
  assert.equal((byId(doc, 'l-r1')!.parentNode as Element).getAttribute('clip-path'), 'url(#c-g1-1)')
})

test('opacity, blend, rotation and scale go on the layer group', async () => {
  const d = designOf(rect('r1', 'R', { opacity: 0.5, blend: 'multiply', rotation: 45, scaleX: 2 }))
  const one = layerToSvg(d, d.artboards[0].layers[0], { fonts: await fontsOf(d), assets: {}, mode: 'export' })
  const g = byId(parse(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">${one}</svg>`), 'l-r1')!
  assert.equal(g.getAttribute('opacity'), '0.5')
  assert.equal(g.getAttribute('style'), 'mix-blend-mode:multiply')
  assert.match(g.getAttribute('transform')!, /^rotate\(45 60 35\) translate\(60 35\) scale\(2 1\) translate\(-60 -35\)$/)
})

test('an instance draws its component with overrides by inner layer id', async () => {
  const comp: Component = {
    id: 'c1', name: 'Button',
    root: {
      ...base, ...box(0, 0, 200, 60), id: 'root', name: 'Button', type: 'group',
      children: [rect('bg', 'Bg', { ...box(0, 0, 200, 60) }), text('label', 'Label', { ...box(0, 0, 200, 60), mode: 'point' })]
    } as Layer & { type: 'group' }
  }
  const inst = { ...base, ...box(100, 100, 400, 120), id: 'i1', name: 'Buy', type: 'instance', component: 'c1', overrides: { label: { text: 'Hello' }, bg: { fill: { type: 'color', color: '#00ff00' } } } } as Layer
  const d = designOf(inst, { ...inst, id: 'i2', component: 'nope' } as Layer)
  d.components.push(comp)
  const fonts = await fontsOf(d)
  const svg = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  const doc = parse(svg)
  assert.ok(svg.includes('>Hello<'))
  assert.ok(!svg.includes('Label<'))
  assert.ok(svg.includes('fill="#00ff00"'))
  assert.ok(svg.includes('translate(100 100) scale(2 2)'))
  assert.equal(byId(doc, 'l-i2')!.childNodes.length, 0, 'an unknown component draws nothing')
  assert.ok(byId(doc, 'l-i1-label'), 'inner layers get ids scoped by the instance')
})

test('a component that contains an instance of itself stops instead of recursing', async () => {
  const comp: Component = {
    id: 'loop', name: 'Loop',
    root: {
      ...base, ...box(0, 0, 100, 100), id: 'lr', name: 'Loop', type: 'group',
      children: [rect('lbox', 'Box'), { ...base, ...box(0, 0, 50, 50), id: 'li', name: 'Again', type: 'instance', component: 'loop', overrides: {} } as Layer]
    } as Layer & { type: 'group' }
  }
  const d = designOf({ ...base, ...box(0, 0, 100, 100), id: 'i1', name: 'Loop', type: 'instance', component: 'loop', overrides: {} } as Layer)
  d.components.push(comp)
  const svg = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'raster' })
  parse(svg)
  assert.equal(svg.split('<rect').length - 1, 2, 'the background and the box once')
})

test('an svg layer is an image in raster mode and its cleaned fragment inline in export mode', async () => {
  const inner = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle id="c" cx="5" cy="5" r="5" onclick="x()"/></svg>'
  const d = designOf({ ...base, ...box(0, 0, 50, 50), id: 's1', name: 'Kept', type: 'svg', svg: inner } as Layer)
  const fonts = await fontsOf(d)
  const raster = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' })
  const img = parse(raster).getElementsByTagName('image')[0]
  assert.ok(img)
  assert.ok(img.getAttribute('xlink:href')!.startsWith('data:image/svg+xml;base64,'))
  assert.ok(!raster.includes('<circle'))
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(img.getAttribute('xlink:href')!.split(',')[1]), c => c.charCodeAt(0))), inner)
  const exported = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.ok(!exported.includes('<image'))
  assert.ok(exported.includes('<svg x="0" y="0" width="50" height="50" viewBox="0 0 10 10" preserveAspectRatio="none"><circle id="s1-c" cx="5" cy="5" r="5"/></svg>'))
  assert.ok(!exported.includes('onclick'), 'the fragment is cleaned again on the way out')
})

test('images embed their asset and a missing asset draws nothing', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const d = designOf(
    { ...base, ...box(0, 0, 50, 50), id: 'p1', name: 'Photo', type: 'image', asset: 'assets/abc.png', fit: 'cover' } as Layer,
    { ...base, ...box(0, 0, 50, 50), id: 'p2', name: 'Gone', type: 'image', asset: 'assets/def.jpg' } as Layer
  )
  const svg = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: { 'assets/abc.png': png }, mode: 'raster' })
  const imgs = parse(svg).getElementsByTagName('image')
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].getAttribute('xlink:href'), 'data:image/png;base64,iVBORwECAw==')
  assert.equal(imgs[0].getAttribute('preserveAspectRatio'), 'xMidYMid slice')
})

test('a missing font renders through the fallback and reports missingFont', async () => {
  const layer = text('t1', FOX, { runs: [{ text: FOX, font: { family: 'No Such Font', weight: 400, style: 'normal' }, size: 32 }] })
  const d = designOf(layer)
  const fonts = await fontsOf(d, true)
  assert.deepEqual(textReport(layer, fonts), { missingFont: true, overflow: false })
  assert.equal(layoutText(layer, fonts).lines.length, 3)
  const raster = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' }))
  assert.ok(byId(raster, 'l-t1')!.getElementsByTagName('path').length >= 3)
  const exported = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.ok(exported.includes('font-family="No Such Font"'), 'export names the family it asked for')
})

test('stored glyphs draw when the font is missing', async () => {
  const layer = text('t1', 'Hi', { x: 5, y: 7, glyphs: 'M0 0L10 0L10 10Z' })
  const d = designOf(layer)
  const missing = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d, true), assets: {}, mode: 'raster' })
  assert.ok(missing.includes('d="M0 0L10 0L10 10Z" transform="translate(5 7)"'))
  const present = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'raster' })
  assert.ok(!present.includes('M0 0L10 0L10 10Z'))
})

test('text and names drop characters XML cannot hold', async () => {
  const layer = text('t1', 'a\u0001b & <c>', { name: 'x\u0007y' })
  const d = designOf(layer)
  const svg = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' })
  parse(svg)
  assert.ok(svg.includes('data-name="xy"'))
  assert.ok(svg.includes('ab &amp; &lt;c&gt;'))
  const smile = String.fromCodePoint(0x1f600)
  const odd = 'a' + String.fromCharCode(0xd800) + 'b' + String.fromCharCode(0xdc00) + String.fromCharCode(0xfffe) + smile + '\t\n'
  assert.equal(cleanText(odd), 'ab' + smile + '\t\n')
})

test('connectors route between boxes and draw markers and a label', async () => {
  const a = rect('a', 'A', box(0, 0, 100, 100))
  const b = rect('b', 'B', box(300, 200, 100, 100))
  const conn = (id: string, extra: object): Layer =>
    ({ ...base, ...box(0, 0, 0, 0), id, name: id, type: 'connector', from: { layer: 'a' }, to: { layer: 'b' }, route: 'straight', arrow: 'end', ...extra }) as Layer
  const straight = conn('s', { label: 'sends' })
  const elbow = conn('o', { route: 'orthogonal', arrow: 'both' })
  const fixed = conn('p', { points: [[1, 2], [3, 4]] })
  const dangling = conn('d', { to: { layer: 'gone' } })
  const d = designOf(a, b, straight, elbow, fixed, dangling)
  const board = d.artboards[0]
  const s = connectorPath(d, board, straight)
  assert.equal(s.length, 2)
  // center (50,50) to (350,250): leaves A through its right side and enters B through its left side
  assert.deepEqual(s.map(p => p.map(v => Math.round(v * 100) / 100)), [[100, 83.33], [300, 216.67]])
  assert.deepEqual(connectorPath(d, board, elbow), [[100, 50], [200, 50], [200, 250], [300, 250]])
  assert.deepEqual(connectorPath(d, board, fixed), [[1, 2], [3, 4]])
  assert.deepEqual(connectorPath(d, board, dangling), [], 'a connector whose end layer is missing has no route')
  const fonts = await fontsOf(d)
  const svg = designToSvg(d, board.id, { fonts, assets: {}, mode: 'export' })
  const doc = parse(svg)
  assert.equal(byId(doc, 'm-s-1')!.tagName, 'marker')
  assert.ok(byId(doc, 'm-o-2'), 'a start marker for arrow both')
  assert.equal(byId(doc, 'l-s')!.getElementsByTagName('polyline')[0].getAttribute('marker-end'), 'url(#m-s-1)')
  const label = byId(doc, 'l-s')!.getElementsByTagName('text')[0]
  assert.equal(label.textContent, 'sends')
  assert.equal(label.getElementsByTagName('tspan')[0].getAttribute('font-size'), '14')
  assert.equal(byId(doc, 'l-s')!.getElementsByTagName('rect')[0].getAttribute('fill'), '#ffffff')
  assert.equal(byId(doc, 'l-d')!.childNodes.length, 0, 'and draws nothing')
})

test("stored glyphs paint a gradient over their own box, not shifted by the box's position", async () => {
  const fill = { type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
  const layer = text('t1', [{ text: 'Hi', font: LIB, size: 32, color: fill }], { ...box(100, 50, 40, 20), glyphs: 'M0 0L10 0L10 10Z' })
  const d = designOf(layer)
  const doc = parse(designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d, true), assets: {}, mode: 'export' }))
  const grad = doc.getElementsByTagName('linearGradient')[0]
  // the path is translated to (100, 50), so the gradient runs 0..40 in its own space
  assert.deepEqual(['x1', 'y1', 'x2', 'y2'].map(a => grad.getAttribute(a)), ['0', '10', '40', '10'])
})

test('a filter region covers the glyphs and their shadow, past the box', async () => {
  const shadow = { x: 0, y: 12, blur: 24, color: '#00000080' }
  const probe = text('p1', [{ text: 'Hi', font: LIB, size: 40 }], { ...box(0, 0, 600, 400), shadow })
  const point = text('p2', [{ text: 'Hello', font: LIB, size: 40 }], { ...box(100, 100, 10, 10), mode: 'point', shadow })
  const d = designOf(probe, point)
  const fonts = await fontsOf(d)
  const doc = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' }))
  const reach = 3 * 12 // three deviations of a 24 px blur radius
  for (const layer of [probe, point]) {
    const f = byId(doc, `f-${layer.id}-1`)!
    assert.equal(f.getAttribute('filterUnits'), 'userSpaceOnUse')
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(a => Number(f.getAttribute(a)))
    const line = layoutText(layer, fonts).lines[0]
    const inkTop = line.y - (40 * 1854) / 2048
    const inkBottom = line.y + (40 * 434) / 2048
    assert.ok(x <= line.x - reach && x + w >= line.x + line.width + reach, `${layer.id} covers the line and its blur`)
    assert.ok(y <= inkTop, `${layer.id} covers the glyph tops`)
    assert.ok(y + h >= inkBottom + 12 + reach, `${layer.id} covers the shadow below the glyphs`)
  }
})

test('a fill override on a text layer replaces every run color', async () => {
  const comp: Component = {
    id: 'c1', name: 'Tag',
    root: {
      ...base, ...box(0, 0, 200, 60), id: 'root', name: 'Tag', type: 'group',
      children: [text('label', [
        { text: 'Red ', font: LIB, size: 20, color: { type: 'color', color: '#ff0000' } },
        { text: 'Blue', font: LIB, size: 20, color: { type: 'color', color: '#0000ff' } }
      ], box(0, 0, 200, 60))]
    } as Layer & { type: 'group' }
  }
  const d = designOf({ ...base, ...box(0, 0, 200, 60), id: 'i1', name: 'Tag', type: 'instance', component: 'c1', overrides: { label: { fill: { type: 'color', color: '#00ff00' } } } } as Layer)
  d.components.push(comp)
  const fonts = await fontsOf(d)
  for (const mode of ['raster', 'export'] as const) {
    const svg = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode })
    assert.ok(svg.includes('fill="#00ff00"'), mode)
    assert.ok(!svg.includes('#ff0000') && !svg.includes('#0000ff'), `${mode}: no run keeps its own color`)
  }
})

test('valign middle and bottom place the block in the box, and right align ends lines at the box edge', async () => {
  const fonts = await fontsOf(designOf(text('x', FOX)))
  const ascent = (32 * 1854) / 2048
  const height = 3 * 32 * 1.2
  const middle = layoutText(text('m', FOX, { valign: 'middle' }), fonts)
  assert.ok(Math.abs(middle.lines[0].y - ((400 - height) / 2 + ascent)) < 1e-6)
  const bottom = layoutText(text('b', FOX, { valign: 'bottom' }), fonts)
  assert.ok(Math.abs(bottom.lines[0].y - (400 - height + ascent)) < 1e-6)
  assert.ok(Math.abs(bottom.lines[2].y - (400 - 38.4 + ascent)) < 1e-6)
  const right = layoutText(text('r', FOX, { align: 'right', x: 10 }), fonts)
  for (const l of right.lines) assert.ok(Math.abs(l.x + l.width - 310) < 1e-6)
  const last = right.lines[0].spans[right.lines[0].spans.length - 1]
  assert.ok(Math.abs(last.x + last.width - 310) < 1e-6)
})

test('a rotated and scaled instance turns about its box and maps the component into it', async () => {
  const comp: Component = {
    id: 'c1', name: 'Box',
    root: { ...base, ...box(10, 20, 100, 60), id: 'root', name: 'Box', type: 'group', children: [rect('in', 'In', box(10, 20, 100, 60))] } as Layer & { type: 'group' }
  }
  const d = designOf({ ...base, ...box(100, 100, 400, 120), rotation: 90, scaleX: 2, id: 'i1', name: 'Turned', type: 'instance', component: 'c1', overrides: {} } as Layer)
  d.components.push(comp)
  const doc = parse(designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'raster' }))
  const g = byId(doc, 'l-i1')!
  assert.equal(g.getAttribute('transform'), 'rotate(90 300 160) translate(300 160) scale(2 1) translate(-300 -160)')
  assert.equal(children(g, 'g')[0].getAttribute('transform'), 'translate(100 100) scale(4 2) translate(-10 -20)')
  assert.ok(byId(doc, 'l-i1-in'))
})

test('hostile path data, font families, colors and blends stay inside their attributes', async () => {
  const evil = '"/><script>alert(1)</script><x a="'
  const d = designOf(
    { ...rect('p1', 'P'), type: 'path', d: evil } as Layer,
    rect('r1', 'R', { fill: { type: 'color', color: '#fff" onload="alert(1)' }, blend: 'multiply;x:url(y)' as any }),
    text('t1', [{ text: 'Hi', font: { family: 'Evil" onload="alert(1)', weight: 400, style: 'normal' }, size: 20 }])
  )
  const fonts = await fontsOf(d)
  for (const mode of ['raster', 'export'] as const) {
    const doc = parse(designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode }))
    assert.equal(doc.getElementsByTagName('script').length, 0)
    const all = doc.getElementsByTagName('*')
    for (let i = 0; i < all.length; i++) assert.equal(all[i].getAttribute('onload'), null, `${mode}: no onload`)
    assert.equal(byId(doc, 'l-p1')!.getElementsByTagName('path')[0].getAttribute('d'), evil)
    assert.equal(byId(doc, 'l-r1')!.getElementsByTagName('rect')[0].getAttribute('fill'), '#000000')
    assert.equal(byId(doc, 'l-r1')!.getAttribute('style'), null)
    if (mode === 'export') {
      const span = byId(doc, 'l-t1')!.getElementsByTagName('tspan')[0]
      assert.equal(span.getAttribute('font-family'), `'Evil" onload="alert(1)'`)
    }
  }
})

test('letter breaks keep graphemes, leading spaces wrap, negative boxes flip, sizes clamp', async () => {
  const fonts = await fontsOf(designOf(text('x', FOX)))
  const accented = 'e' + String.fromCharCode(0x301)
  const g = layoutText(text('g', accented + accented, { width: 1 }), fonts)
  assert.deepEqual(g.lines.map(lineText), [accented, accented])
  const lead = layoutText(text('s', ' '.repeat(10) + 'quick', { width: 100 }), fonts)
  assert.deepEqual(lead.lines.map(lineText), ['', 'quick'])
  const flipped = layoutText(text('n', FOX, { x: 300, width: -300, y: 400, height: -400 }), fonts)
  assert.deepEqual(flipped.lines.map(lineText), ['The quick brown fox', 'jumps over the lazy', 'dog'])
  assert.equal(flipped.lines[0].x, 0)
  assert.ok(Math.abs(flipped.lines[0].y - (32 * 1854) / 2048) < 1e-6)
  assert.equal(num(1e308), '1e+308')
  assert.equal(num(-1e308, 4), '-1e+308')
  assert.equal(num(Infinity), '0')
  const tiny = text('z', [{ text: 'Hi', font: LIB, size: -5 }])
  const d = designOf(tiny)
  assert.ok(designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' }).includes('font-size="0"'))
})

/** A design with a picture, a gradient, a shadow, a clip group and an arrowed connector: every kind of id a drawing makes. */
function idHeavy(): { d: Design; assets: Record<string, Uint8Array> } {
  const png = new Uint8Array(fs.readFileSync('resources/icon.png'))
  const asset = 'assets/' + 'b'.repeat(64) + '.png'
  const grad = { type: 'linear' as const, angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }
  const d = designOf(
    rect('r1', 'Grad', { fill: grad, shadow: { x: 2, y: 2, blur: 4, color: '#00000080' } }),
    { ...base, ...box(200, 10, 80, 80), id: 'img', name: 'Pic', type: 'image', asset, fit: 'cover' } as Layer,
    { ...base, ...box(10, 200, 100, 100), id: 'g1', name: 'Clip', type: 'group', clip: true, children: [rect('m1', 'Mask'), rect('k1', 'Kid', { fill: grad })] } as Layer,
    { ...base, ...box(0, 0, 0, 0), id: 'c1', name: 'Link', type: 'connector', from: { layer: 'r1' }, to: { layer: 'img' }, route: 'straight', arrow: 'both', stroke: { type: 'color', color: '#333333' } } as Layer
  )
  return { d, assets: { [asset]: png } }
}

test('two drawings with different id prefixes share no ids, and every url(#...) points inside its own drawing', async () => {
  const { d, assets } = idHeavy()
  const fonts = await fontsOf(d)
  const draw = (idPrefix?: string) => designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'raster', idPrefix })
  const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
  const refs = (svg: string) => [...svg.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1])
  const a = draw('e1-')
  const b = draw('e2-')
  assert.ok(refs(a).length >= 5, 'gradients, filter, clip and markers are pointed to')
  for (const [svg, other] of [[a, b], [b, a]]) {
    const own = new Set(ids(svg))
    for (const r of refs(svg)) assert.ok(own.has(r), `${r} is in its own drawing`)
    const theirs = new Set(ids(other))
    for (const id of own) assert.ok(!theirs.has(id), `${id} is not in the other drawing`)
  }
  assert.ok(ids(a).every(id => id.startsWith('e1-')))
  // without a prefix the drawing is what it always was (exports and look stay the same for the same design)
  assert.equal(draw(), draw(''))
  assert.ok(ids(draw()).some(id => id.startsWith('l-')))
  parse(a)
})

test('a picture is encoded once however many times its design is drawn, and the editor can draw it from a URL of its own', async () => {
  const { imageEncodes } = await import('../src/shared/design/render')
  const { d, assets } = idHeavy()
  const fonts = await fontsOf(d)
  const before = imageEncodes.calls
  const first = designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'raster' })
  const second = designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'raster' })
  designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'export' })
  assert.equal(imageEncodes.calls - before, 1, 'one asset, encoded once')
  assert.equal(first, second)
  assert.ok(first.includes('xlink:href="data:image/png;base64,'))
  const asked: string[] = []
  const hooked = designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'raster', imageUrl: (_b, mime) => (asked.push(mime), 'blob:gd/1') })
  assert.deepEqual(asked, ['image/png'])
  assert.ok(hooked.includes('xlink:href="blob:gd/1"'))
  assert.equal(imageEncodes.calls - before, 1)
  // exports always carry the picture itself
  assert.ok(designToSvg(d, d.artboards[0].id, { fonts, assets, mode: 'export', imageUrl: () => 'blob:no' }).includes('data:image/png;base64,'))
})
