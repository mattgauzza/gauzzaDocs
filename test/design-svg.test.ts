import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { assetName } from '../src/core/formats/design'
import { fontsFor, type FontSource } from '../src/shared/design/fonts'
import { newDesign } from '../src/shared/design/model'
import { parsePath, pathBounds } from '../src/shared/design/path'
import { designToSvg } from '../src/shared/design/render'
import { sharedAssetName } from '../src/shared/design/sha256'
import { cleanSvg } from '../src/shared/design/svgClean'
import { inlineSvg } from '../src/shared/design/svgFragment'
import { importSvg, layerAsSvg } from '../src/shared/design/svgImport'
import { layoutText } from '../src/shared/design/text'
import type { Design, Layer, TextLayer } from '../src/shared/design/types'

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
const svgOf = (body: string, attrs = ''): string => `<svg ${NS}${attrs ? ' ' + attrs : ''}>${body}</svg>`
// a real 1x1 PNG
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG = new Uint8Array(Buffer.from(PNG64, 'base64'))
const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
const fontsOf = (d: Design): Promise<FontSource> => fontsFor(d, {}, async () => liberation, liberation)

const base = { visible: true, locked: false, opacity: 1, blend: 'normal' as const, rotation: 0, scaleX: 1, scaleY: 1 }
const parse = (svg: string): Document =>
  new DOMParser({ onError: (level, msg) => { throw new Error(`${level}: ${msg}`) } }).parseFromString(svg, 'image/svg+xml') as unknown as Document
const count = (svg: string): number => parse(svg).getElementsByTagName('*').length
const kids = (l: Layer): Layer[] => (l.type === 'group' ? l.children : [])
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`)
/** Signed area of each contour of a path, from its points (curves by their end points; enough for squares). */
function areas(d: string): number[] {
  const out: number[] = []
  let pts: [number, number][] = []
  const flush = () => {
    if (pts.length > 2) out.push(pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2)
    pts = []
  }
  for (const s of parsePath(d)) {
    if (s.c === 'M') flush()
    if (s.c !== 'Z') pts.push([s.v[s.v.length - 2], s.v[s.v.length - 1]])
  }
  flush()
  return out
}

// cleanSvg: what goes

const HOSTILE: [string, string, RegExp, RegExp][] = [
  ['a script', svgOf('<script>alert(1)</script><rect width="1" height="1"/>'), /<script|alert/, /script/],
  ['an onload attribute', svgOf('<rect width="1" height="1"/>', 'onload="alert(1)"'), /onload|alert/, /onload attribute/],
  ['a foreignObject', svgOf('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'), /foreignObject|<div/, /foreignObject/],
  ['a link to https://x', svgOf('<a href="https://x"><rect id="kept" width="1" height="1"/></a>'), /<a[\s>]|https:\/\/x/, /link to https:\/\/x/],
  ['an external image', svgOf('<image href="https://x/a.png" width="1" height="1"/>'), /<image|https:/, /external image \(https:\/\/x\/a\.png\)/],
  ['a file url in a style', svgOf('<rect width="1" height="1" style="fill:url(file:///c:/x)"/>'), /file:|url\(/, /outside the file \(file:\/\/\/c:\/x\)/],
  ['an href animation', svgOf('<a><animate attributeName="href" values="javascript:alert(1)"/></a><use href="#r"><animate attributeName="href" to="https://x"/></use><rect id="r" width="1" height="1"/>'), /<animate|javascript|https/, /animation \(animate\)/],
  ['a CSS @import', svgOf('<style>@import url(https://x); rect { fill: red }</style><rect width="1" height="1"/>'), /@import|https/, /@import \(url\(https:\/\/x\)\)/],
  ['a linked style sheet', '<?xml-stylesheet href="https://x/a.css"?>' + svgOf('<rect width="1" height="1"/>'), /stylesheet|https/, /linked style sheet/]
]
for (const [what, input, gone, named] of HOSTILE) {
  test(`cleanSvg removes ${what} and names it`, () => {
    const { svg, removed } = cleanSvg(input)
    assert.ok(!gone.test(svg), `still in the output: ${svg}`)
    assert.ok(removed.some(r => named.test(r)), `not named in ${JSON.stringify(removed)}`)
    parse(svg) // still well formed
  })
}

test('cleanSvg keeps what a link held and the CSS rules around an import', () => {
  assert.match(cleanSvg(HOSTILE[3][1]).svg, /<rect id="kept"/)
  assert.match(cleanSvg(HOSTILE[7][1]).svg, /<style>rect\{fill:red\}<\/style>/)
})

test('cleanSvg refuses over 5 MB', () => {
  const big = svgOf(' '.repeat(6 * 1024 * 1024))
  assert.throws(() => cleanSvg(big), { message: 'This SVG is too large (over 5 MB).' })
})

test('cleanSvg refuses over 50,000 elements', () => {
  assert.throws(() => cleanSvg(svgOf('<rect/>'.repeat(50_001))), { message: 'This SVG has too many elements (over 50,000).' })
})

test('cleanSvg refuses a use tree that would expand past 50,000 elements', () => {
  // each level holds ten uses of the level below: 10^6 rects once expanded, from 61 elements
  let body = '<rect id="l0" width="1" height="1"/>'
  for (let i = 1; i <= 6; i++) body += `<g id="l${i}">${Array.from({ length: 10 }, () => `<use href="#l${i - 1}"/>`).join('')}</g>`
  assert.throws(() => cleanSvg(svgOf(`<defs>${body}</defs><use href="#l6"/>`)), { message: 'This SVG has too many elements (over 50,000).' })
})

test('long values clean and import in linear time', () => {
  const start = Date.now()
  const d = 'M0 0' + ' l1 1 c1 2 3 4 5 6 a3 3 0 0 1 4 4'.repeat(60_000) // 2 MB of path data, no "("
  const long = svgOf(
    `<path d="${d}"/><rect width="${'1'.repeat(500_000)}x" height="1"/>` +
      `<rect transform="translate(1)${' '.repeat(500_000)}x" width="1" height="1"/>` +
      `<style>${'@x;'.repeat(100_000)}</style><rect style="fill:${'a'.repeat(200_000)} b(" width="1" height="1"/>`
  )
  const { group } = importSvg(long, 'L')
  assert.equal(kids(group)[0].type, 'path')
  assert.ok(Date.now() - start < 8000, `took ${Date.now() - start} ms`)
})

const CHAIN = (() => {
  let s = '<defs><rect id="u0" width="1" height="1"/></defs>'
  for (let i = 1; i <= 9; i++) s += `<use id="u${i}" href="#u${i - 1}" x="2"/>`
  return svgOf(s)
})()

test('a use chained 9 deep stops at 8', () => {
  const { svg, removed } = cleanSvg(CHAIN)
  assert.match(svg, /id="u8"/)
  assert.doesNotMatch(svg, /id="u9"/)
  assert.ok(removed.some(r => /deeper than 8/.test(r)), JSON.stringify(removed))
})

test('a use that refers to itself is dropped', () => {
  const { svg, removed } = cleanSvg(svgOf('<g id="a"><use href="#a"/></g>'))
  assert.doesNotMatch(svg, /<use/)
  assert.ok(removed.some(r => /refers back to itself/.test(r)))
})

test('a DOCTYPE entity bomb is rejected', () => {
  let ents = '<!ENTITY lol "lol">'
  for (let i = 2; i <= 9; i++) ents += `<!ENTITY lol${i} "${`&lol${i === 2 ? '' : i - 1};`.repeat(10)}">`
  const bomb = `<?xml version="1.0"?><!DOCTYPE svg [${ents}]>${svgOf('<text>&lol9;</text>')}`
  const { svg, removed } = cleanSvg(bomb)
  assert.ok(svg.length < 500, `expanded to ${svg.length} characters`)
  assert.doesNotMatch(svg, /lollol|DOCTYPE|ENTITY/)
  assert.ok(removed.some(r => /DOCTYPE that declares entities/.test(r)), JSON.stringify(removed))
})

test('an href to a missing id is dropped', () => {
  const { svg, removed } = cleanSvg(svgOf('<use xlink:href="#missing"/><linearGradient id="g" xlink:href="#gone"/><rect id="r"/><use xlink:href="#r"/>'))
  assert.doesNotMatch(svg, /#missing|#gone/)
  assert.match(svg, /<use xlink:href="#r"\/>/)
  assert.ok(removed.some(r => r === 'a reference to a missing id (#missing)'), JSON.stringify(removed))
})

test('an SVG inside an image is dropped, an embedded PNG stays', () => {
  const inner = Buffer.from(svgOf('<script>alert(1)</script>')).toString('base64')
  const { svg, removed } = cleanSvg(
    svgOf(`<image width="1" height="1" xlink:href="data:image/svg+xml;base64,${inner}"/><image width="1" height="1" xlink:href="data:image/png;base64,${PNG64}"/>`)
  )
  assert.doesNotMatch(svg, /svg\+xml/)
  assert.match(svg, /xlink:href="data:image\/png;base64,/)
  assert.ok(removed.includes('a nested SVG image'), JSON.stringify(removed))
})

test('control characters and case do not hide a scheme', () => {
  const { svg } = cleanSvg(svgOf('<use href=" JaVa&#9;ScRiPt:alert(1)"/><rect style="fill:URL( &quot;HTTPS://x&quot; )" width="1" height="1"/>'))
  assert.doesNotMatch(svg, /script|https/i)
})

test("the renderer's own export survives cleanSvg intact", async () => {
  const d = newDesign('instagram')
  const asset = assetName(PNG, 'png')
  const card: Layer = {
    ...base, id: 'card', name: 'Card', type: 'rect', x: 10, y: 10, width: 200, height: 100, blend: 'multiply',
    fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff80' }] },
    shadow: { x: 2, y: 3, blur: 6, color: '#00000080' }
  }
  const photo: Layer = { ...base, id: 'photo', name: 'Photo', type: 'image', x: 20, y: 20, width: 50, height: 50, asset, fit: 'cover', blur: 2 }
  const title: TextLayer = {
    ...base, id: 'title', name: 'Title & "quotes"', type: 'text', x: 10, y: 200, width: 400, height: 60, mode: 'box',
    align: 'left', valign: 'top', runs: [{ text: 'Hello <world>', font: { family: 'Liberation Sans', weight: 400, style: 'normal' }, size: 24 }]
  }
  const group: Layer = { ...base, id: 'grp', name: 'Group', type: 'group', x: 10, y: 10, width: 400, height: 250, children: [card, photo, title] }
  d.artboards[0].layers.push(group)
  const out = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: { [asset]: PNG }, mode: 'export' })
  const { svg, removed } = cleanSvg(out)
  assert.deepEqual(removed, [])
  assert.equal(svg, out, 'cleaning the export changes nothing, byte for byte')
  assert.equal(count(svg), count(out), 'every element stays')
  for (const want of [
    'inkscape:label="Card"', 'data-name="Card"', 'inkscape:groupmode="layer"', 'style="mix-blend-mode:multiply"',
    `xlink:href="data:image/png;base64,${PNG64}"`, 'filterUnits="userSpaceOnUse"', '<feGaussianBlur', 'filter="url(#f-card-1)"',
    'fill="url(#g-card-1)"', 'xml:space="preserve"', 'data-name="Title &amp; &quot;quotes&quot;"', 'Hello &lt;world&gt;'
  ]) assert.ok(svg.includes(want), `lost ${want}`)
  assert.equal(cleanSvg(svg).svg, svg, 'cleaning twice changes nothing')
})

/** An imported svg layer: a gradient rect with a filter, its gradient id "g" and filter id "f" the same every time. */
function blurredSvgLayer(color: string, dx = 0): Layer {
  const { group } = importSvg(
    svgOf(
      `<defs><linearGradient id="g"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#fff"/></linearGradient>` +
        '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><rect width="10" height="10" fill="url(#g)" filter="url(#f)"/>'
    ),
    'S'
  )
  const layer = kids(group)[0]
  assert.equal(layer.type, 'svg')
  return { ...layer, x: layer.x + dx }
}

test('an export inlines svg layers with ids prefixed per layer, and survives cleanSvg unchanged', async () => {
  // ids that start with a digit, as base36 layer ids often do: the prefix must still make valid references
  const a = { ...blurredSvgLayer('#ff0000'), id: '9a000001' }
  const b = { ...blurredSvgLayer('#0000ff', 50), id: '1b000002' }
  const styled: Layer = {
    ...base, id: 'styled', name: 'Styled', type: 'svg', x: 0, y: 100, width: 10, height: 10,
    svg: svgOf('<style>rect{fill:#00ff00}</style><rect width="10" height="10"/>', 'viewBox="0 0 10 10"')
  }
  const own: Layer = { ...base, id: 'own', name: 'Own', type: 'rect', x: 0, y: 200, width: 10, height: 10, fill: { type: 'color', color: '#123456' } }
  const d = newDesign('instagram')
  d.artboards[0].layers.push(a, b, styled, own)
  const fonts = await fontsOf(d)
  const out = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'export' })
  assert.doesNotMatch(out, /svg\+xml|<image/, 'no svg layer is drawn as an image')
  const doc = parse(out)
  // numbered by drawing order: the first svg layer's ids start s1-, the second's s2-
  for (const [n, l] of [a, b].entries()) {
    const p = `s${n + 1}-`
    for (const want of [`id="${p}g"`, `fill="url(#${p}g)"`, `id="${p}f"`, `filter="url(#${p}f)"`]) {
      assert.ok(out.includes(want), `missing ${want}`)
    }
    const wrapper = doc.getElementsByTagName('g')
    const holder = Array.from(wrapper).find(g => g.getAttribute('id') === `l-${l.id}`)!
    const nested = holder.getElementsByTagName('svg')[0]
    assert.deepEqual(['x', 'y', 'width', 'height', 'preserveAspectRatio'].map(k => nested.getAttribute(k)), [String(l.x), String(l.y), String(l.width), String(l.height), 'none'])
    assert.ok(nested.getAttribute('viewBox'), 'keeps the fragment viewBox')
  }
  const ids = Array.from(doc.getElementsByTagName('*')).map(e => e.getAttribute('id')).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length, `ids collide: ${ids.join(' ')}`)
  // a fragment's style rules become its own attributes and can't restyle the rest of the export
  assert.doesNotMatch(out, /<style/)
  assert.match(out, /<rect width="10" height="10" fill="#00ff00"\/>/)
  assert.match(out, /<rect x="0" y="200" width="10" height="10" fill="#123456"\/>/)
  const { svg, removed } = cleanSvg(out)
  assert.deepEqual(removed, [])
  assert.equal(svg, out)
  // the window still only ever sees svg layers as images
  const raster = designToSvg(d, d.artboards[0].id, { fonts, assets: {}, mode: 'raster' })
  assert.equal(raster.match(/xlink:href="data:image\/svg\+xml;base64,/g)?.length, 3)
  assert.ok(!raster.includes(`${a.id}-g`))
})

test('layerAsSvg of a group keeps the svg layers inside it', async () => {
  const inner = { ...blurredSvgLayer('#ff0000', 20), id: '7c000003' }
  const dot: Layer = { ...base, id: 'dot', name: 'Dot', type: 'ellipse', x: 0, y: 0, width: 5, height: 5, fill: { type: 'color', color: '#000000' } }
  const group: Layer = { ...base, id: 'grp', name: 'Group', type: 'group', x: 0, y: -1, width: 31, height: 12, children: [dot, inner] }
  const d = newDesign('instagram')
  d.artboards[0].layers.push(group)
  const svg = layerAsSvg(d, group, { fonts: await fontsOf(d), assets: {}, mode: 'raster' })
  assert.match(svg, /id="s1-g"/)
  assert.ok(svg.includes(`<svg x="19" y="-1" width="12" height="12" viewBox="-1 -1 12 12" preserveAspectRatio="none">`), svg)
  assert.doesNotMatch(svg, /svg\+xml/)
  assert.deepEqual(cleanSvg(svg).removed, [])
})

// importSvg

test('importSvg names children from id, inkscape:label or data-name, then Path 1, Path 2', () => {
  const logo = svgOf(
    '<path id="mark" d="M0 0H10V10H0Z"/><path inkscape:label="Word" d="M20 0H40V10H20Z"/><path data-name="Tag line" d="M0 20H5V25H0Z"/>' +
      '<path d="M0 30H1V31H0Z"/><path d="M0 40H1V41H0Z"/>',
    'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 100 100"'
  )
  const { group } = importSvg(logo, 'Logo')
  assert.equal(group.name, 'Logo')
  assert.deepEqual(kids(group).map(l => l.name), ['mark', 'Word', 'Tag line', 'Path 1', 'Path 2'])
  assert.ok(kids(group).every(l => l.type === 'path'))
  const ids = new Set([group.id, ...kids(group).map(l => l.id)])
  assert.equal(ids.size, 6, 'every layer has its own id')
})

test("a transformed path's bounds come out doubled and offset", () => {
  const { group } = importSvg(svgOf('<path d="M0 0L10 0L10 5Z" transform="translate(10 20) scale(2)"/>'), 'T')
  const p = kids(group)[0]
  assert.equal(p.type, 'path')
  assert.deepEqual([p.x, p.y, p.width, p.height], [10, 20, 20, 10])
  assert.equal(p.type === 'path' && p.d, 'M0 0L20 0L20 10Z', 'd is in the layer box coordinates')
  assert.deepEqual([group.x, group.y, group.width, group.height], [10, 20, 20, 10], 'the group box is the union')
})

test('the viewBox maps to px through width and height, otherwise 1:1', () => {
  const scaled = importSvg(svgOf('<rect x="10" y="10" width="10" height="10"/>', 'width="200" height="100" viewBox="0 0 100 50"'), 'S').group
  const r = kids(scaled)[0]
  assert.deepEqual([r.x, r.y, r.width, r.height], [20, 20, 20, 20])
  const plain = importSvg(svgOf('<rect x="10" y="10" width="10" height="10"/>', 'viewBox="0 0 100 50"'), 'P').group
  const q = kids(plain)[0]
  assert.deepEqual([q.x, q.y, q.width, q.height], [10, 10, 10, 10])
})

test('a linear gradient becomes a linear paint with two stops', () => {
  const { group } = importSvg(
    svgOf('<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)"/>'),
    'G'
  )
  const fill = kids(group)[0].fill
  assert.ok(fill && fill.type === 'linear', JSON.stringify(fill))
  assert.deepEqual(fill.stops, [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }])
  near(fill.angle ?? 0, 0)
})

test('a user-space gradient under a gradientTransform keeps its direction and its span', () => {
  // runs top to bottom over the middle half of the rect: the stops land at a quarter and three quarters
  const { group, kept } = importSvg(
    svgOf(
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="50" y2="0" gradientTransform="translate(0 25) rotate(90)">' +
        '<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff" stop-opacity="0.5"/></linearGradient></defs>' +
        '<rect width="20" height="100" fill="url(#g)"/>'
    ),
    'G'
  )
  const fill = kids(group)[0].fill
  assert.ok(fill && fill.type === 'linear')
  near(fill.angle ?? 0, 90)
  assert.deepEqual(fill.stops.map(s => s.offset), [0, 0.25, 0.75, 1])
  assert.deepEqual(fill.stops.map(s => s.color), ['#000000', '#000000', '#ffffff80', '#ffffff80'])
  assert.deepEqual(kept, [])
})

test('repeat and reflect gradients unroll into stops', () => {
  const stops = (spread: string) => {
    const { group } = importSvg(
      svgOf(`<defs><linearGradient id="g" x2="0.5" spreadMethod="${spread}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100" height="10" fill="url(#g)"/>`),
      'G'
    )
    const fill = kids(group)[0].fill
    return fill && fill.type === 'linear' ? fill.stops.map(s => `${s.offset} ${s.color}`) : []
  }
  assert.deepEqual(stops('repeat'), ['0 #000000', '0.5 #ffffff', '0.5 #000000', '1 #ffffff'])
  assert.deepEqual(stops('reflect'), ['0 #000000', '0.5 #ffffff', '1 #000000'])
  assert.deepEqual(stops('pad'), ['0 #000000', '0.5 #ffffff', '1 #ffffff'])
})

test('a radial gradient is exact when it stays a centered circle and noted in kept when it is not', () => {
  const radial = (w: number) =>
    importSvg(
      svgOf(`<defs><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><rect id="dot" width="${w}" height="100" fill="url(#r)"/>`),
      'R'
    )
  const square = radial(100)
  const fill = kids(square.group)[0].fill
  assert.ok(fill && fill.type === 'radial')
  assert.deepEqual(fill.stops, [{ offset: 0, color: '#ffffff' }, { offset: 0.707107, color: '#000000' }, { offset: 1, color: '#000000' }])
  assert.deepEqual(square.kept, [])
  assert.ok(radial(200).kept.some(k => /dot: its radial gradient is approximated \(stretched\)/.test(k)))
})

test("a filter's target stays as an svg layer listed in kept", () => {
  const { group, kept } = importSvg(
    svgOf('<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect id="glow" width="10" height="10" fill="red" filter="url(#f)"/><rect width="5" height="5"/>'),
    'F'
  )
  const [glow, plain] = kids(group)
  assert.equal(glow.type, 'svg')
  assert.equal(glow.name, 'glow')
  assert.equal(plain.type, 'path')
  assert.ok(kept.some(k => /glow/.test(k) && /filter/.test(k)), JSON.stringify(kept))
  if (glow.type !== 'svg') return
  assert.deepEqual(cleanSvg(glow.svg).removed, [])
  assert.match(glow.svg, /<filter id="f"/)
  // the filter region (10% around the box) is the layer box
  assert.deepEqual([glow.x, glow.y, glow.width, glow.height], [-1, -1, 12, 12])
})

test('style rules apply by specificity, inline style wins, and rules beat presentation attributes', () => {
  const { group } = importSvg(
    svgOf(
      '<style>.a{fill:#00ff00} #b{fill:#0000ff} rect{fill:#ff0000} .s{stroke:#111;stroke-width:3px}</style>' +
        '<rect class="a" width="1" height="1"/><rect id="b" class="a" width="1" height="1"/>' +
        '<rect class="a s" style="fill:#123456" width="1" height="1"/><rect fill="#abcdef" width="1" height="1"/>'
    ),
    'S'
  )
  assert.deepEqual(kids(group).map(l => l.fill), ['#00ff00', '#0000ff', '#123456', '#ff0000'].map(color => ({ type: 'color', color })))
  assert.deepEqual(kids(group)[2].stroke, { type: 'color', color: '#111111' })
  assert.equal(kids(group)[2].strokeWidth, 3)
})

test('a clipPath becomes a clipped group with the clip shape first', () => {
  const { group } = importSvg(
    svgOf('<defs><clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath></defs><g id="art" clip-path="url(#c)"><rect width="100" height="100" fill="#f00"/></g>', 'viewBox="0 0 100 100"'),
    'C'
  )
  const art = kids(group)[0]
  assert.equal(art.type, 'group')
  if (art.type !== 'group') return
  assert.equal(art.clip, true)
  assert.equal(art.name, 'art')
  const [clip, rect] = art.children
  assert.equal(clip.type, 'path')
  for (const [a, b] of [[clip.x, 10], [clip.y, 10], [clip.width, 80], [clip.height, 80]]) near(a, b, 1e-3)
  assert.equal(rect.type, 'path')
  assert.deepEqual(rect.fill, { type: 'color', color: '#ff0000' })
})

test('uses expand into layers, up to 8 deep', () => {
  const { group, removed } = importSvg(CHAIN, 'U')
  assert.deepEqual(kids(group).map(l => l.name), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'])
  assert.deepEqual(kids(group).map(l => l.x), [2, 4, 6, 8, 10, 12, 14, 16])
  assert.ok(removed.some(r => /deeper than 8/.test(r)))
})

test('an embedded image becomes an asset named by its hash', () => {
  const { group, assets } = importSvg(svgOf(`<image x="5" y="6" width="10" height="20" preserveAspectRatio="none" href="data:image/png;base64,${PNG64}"/>`), 'I')
  const img = kids(group)[0]
  const name = assetName(PNG, 'png')
  assert.equal(img.type, 'image')
  assert.ok(img.type === 'image' && img.asset === name && img.fit === 'fill')
  assert.deepEqual([img.x, img.y, img.width, img.height], [5, 6, 10, 20])
  assert.deepEqual(Object.keys(assets), [name])
  assert.deepEqual(assets[name], PNG)
})

test('asset names match assetName for every padding length', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 31 + len) & 0xff)
    assert.equal(sharedAssetName(bytes, 'png'), assetName(bytes, 'png'), `length ${len}`)
  }
})

test('simple text becomes a text layer on the same baseline; text on a path stays svg', async () => {
  const src = svgOf('<text id="Brand" x="10" y="50" font-family="Liberation Sans" font-size="20" fill="#333" text-anchor="middle"> Hello <tspan fill="red">there</tspan></text>')
  const d = newDesign('logo')
  const fonts = await fontsOf(d)
  const t = kids(importSvg(src, 'T', { fonts }).group)[0]
  assert.equal(t.type, 'text')
  if (t.type !== 'text') return
  assert.equal(t.name, 'Brand')
  assert.equal(t.mode, 'point')
  assert.equal(t.align, 'center')
  assert.deepEqual(t.runs.map(r => [r.text, r.size, r.font.family, r.color]), [
    ['Hello ', 20, 'Liberation Sans', { type: 'color', color: '#333333' }],
    ['there', 20, 'Liberation Sans', { type: 'color', color: '#ff0000' }]
  ])
  const line = layoutText(t, fonts).lines[0]
  near(line.y, 50, 1e-6)
  near(line.x + line.width / 2, 10, 1e-6)
  const { group, kept } = importSvg(svgOf('<defs><path id="p" d="M0 20L100 20"/></defs><text><textPath href="#p">Hi</textPath></text>'), 'P')
  assert.equal(kids(group)[0].type, 'svg')
  assert.ok(kept.some(k => /text/.test(k)))
})

test('arcs stay arcs under a uniform scale and become curves under a rotation', () => {
  const arc = (tf: string) => kids(importSvg(svgOf(`<path d="M0 0A5 5 0 0 1 10 0" transform="${tf}"/>`), 'A').group)[0]
  const scaled = arc('scale(2)')
  assert.ok(scaled.type === 'path' && /A/.test(scaled.d) && !/C/.test(scaled.d), JSON.stringify(scaled))
  near(scaled.height, 10, 1e-9)
  const turned = arc('rotate(30)')
  assert.ok(turned.type === 'path' && /C/.test(turned.d) && !/A/.test(turned.d))
})

test('every path command parses, absolute and relative, with exact bounds', () => {
  const b = (d: string) => pathBounds(parsePath(d))
  assert.deepEqual(b('m10 10 l5 0 h5 v5 z'), { x: 10, y: 10, w: 10, h: 5 })
  assert.deepEqual(b('M10 10 H20 V15 L10 15 Z'), { x: 10, y: 10, w: 10, h: 5 })
  assert.deepEqual(b('M0 0 C0 -10 10 -10 10 0'), { x: 0, y: -7.5, w: 10, h: 7.5 })
  assert.deepEqual(b('M0 0 C0 10 10 10 10 0 S20 -10 20 0'), { x: 0, y: -7.5, w: 20, h: 15 })
  assert.deepEqual(b('M0 0 Q5 10 10 0 T20 0'), { x: 0, y: -5, w: 20, h: 10 })
  assert.deepEqual(b('M0 0 c0 -10 10 -10 10 0 s10 10 10 0 q5 10 10 0 t10 0'), { x: 0, y: -7.5, w: 40, h: 15 })
  const arc = b('M0 0 A10 10 0 0 1 20 0')!
  for (const [a, e] of [[arc.x, 0], [arc.y, -10], [arc.w, 20], [arc.h, 10]]) near(a, e, 1e-9)
  const rel = b('M0 0 a10 10 0 1 0 20 0')!
  near(rel.y + rel.h, 10, 1e-9)
  assert.deepEqual(parsePath('M0 0L10 0 garbage L5 5'), parsePath('M0 0L10 0'), 'stops at the first error')
  assert.deepEqual(parsePath('M0 0 10 0 10 10').map(s => s.c), ['M', 'L', 'L'], 'pairs after a move are lines')
  assert.deepEqual(parsePath('M0 0L1 1ZL2 2').map(s => s.c), ['M', 'L', 'Z', 'M', 'L'], 'a subpath after Z starts at the last move')
  assert.deepEqual(parsePath('M0 0a1 1 0 00.5 .5').map(s => s.v), [[0, 0], [1, 1, 0, 0, 0, 0.5, 0.5]], 'flags need no separators')
})

test('an even-odd fill turns its holes around for the nonzero rule; crossing outlines stay svg', () => {
  const ring = kids(importSvg(svgOf('<path fill-rule="evenodd" d="M0 0H10V10H0Z M2 2H8V8H2Z"/>'), 'R').group)[0]
  assert.equal(ring.type, 'path')
  const [outer, inner] = ring.type === 'path' ? areas(ring.d) : []
  assert.ok(outer * inner < 0, `contours wind ${outer} and ${inner}`)
  const { group, kept } = importSvg(svgOf('<path id="bow" fill-rule="evenodd" d="M0 0L10 10L10 0L0 10Z"/>'), 'B')
  assert.equal(kids(group)[0].type, 'svg')
  assert.ok(kept.some(k => /bow/.test(k) && /even-odd/.test(k)))
})

test('importSvg cleans first and reports what it removed', () => {
  const { group, removed } = importSvg(svgOf('<script>x</script><rect width="1" height="1" onclick="x"/>'), 'R')
  assert.equal(kids(group).length, 1)
  assert.ok(removed.includes('a script') && removed.includes('an onclick attribute'), JSON.stringify(removed))
})

test('layerAsSvg gives one layer as clean SVG in its own coordinates', async () => {
  const d = newDesign('instagram')
  const rect: Layer = { ...base, id: 'r1', name: 'Box', type: 'rect', x: 100, y: 50, width: 40, height: 20, fill: { type: 'color', color: '#ff0000' } }
  const imported = importSvg(svgOf('<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><rect width="10" height="10" filter="url(#f)"/>'), 'F')
  const raw = kids(imported.group)[0]
  d.artboards[0].layers.push(rect, raw)
  const opts = { fonts: await fontsOf(d), assets: {}, mode: 'export' as const }
  const svg = layerAsSvg(d, rect, opts)
  const root = parse(svg).documentElement
  assert.equal(root.getAttribute('width'), '40')
  assert.equal(root.getAttribute('height'), '20')
  assert.equal(root.getAttribute('viewBox'), '0 0 40 20')
  assert.match(svg, /translate\(-100 -50\)/)
  assert.match(svg, /inkscape:label="Box"/)
  assert.deepEqual(cleanSvg(svg).removed, [])
  const own = layerAsSvg(d, raw, opts)
  assert.match(own, /<filter/)
  assert.equal(parse(own).documentElement.getAttribute('width'), String(raw.width))
})

test('an imported gradient path renders its gradient over its own box', async () => {
  const { group } = importSvg(
    svgOf('<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><path d="M100 0H150V10H100Z" fill="url(#g)"/>'),
    'G'
  )
  const d = newDesign('instagram')
  d.artboards[0].layers.push(group)
  const out = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' })
  const grad = parse(out).getElementsByTagName('linearGradient')[0]
  // the path is drawn translated to its box, so its gradient runs over 0..50 in the path's own space
  assert.deepEqual([grad.getAttribute('x1'), grad.getAttribute('x2')], ['0', '50'])
})

// Fix round 1: canonical references, idempotence, budgets and linear time

const bombOf = (pre: string): string => {
  let body = '<rect id="l0" width="1" height="1"/>'
  for (let i = 1; i <= 6; i++) body += `<g id="l${i}">${`<use href="${pre}#l${i - 1}"/>`.repeat(10)}</g>`
  return svgOf(`<defs>${body}</defs><use href="${pre}#l6"/>`)
}
const CONTROL = ['&#1;', '&#x7f;', '&#x85;']

for (const c of CONTROL) {
  test(`a control character (${c}) before # can't carry a reference past the checks`, () => {
    const bomb = cleanSvg(bombOf(c))
    assert.doesNotMatch(bomb.svg, /<use/)
    assert.ok(bomb.removed.some(r => /hidden characters/.test(r)), JSON.stringify(bomb.removed))
    assert.doesNotMatch(cleanSvg(svgOf(`<g id="a"><use href="${c}#a"/></g>`)).svg, /<use/)
    const refs = cleanSvg(
      svgOf(`<linearGradient id="g"/><rect id="r" width="1" height="1" fill="url(${c}#g)" style="stroke:url(${c}#g)"/><use xlink:href="${c}#r"/><image width="1" height="1" href="${c}#r"/>`)
    )
    assert.doesNotMatch(refs.svg, /url\(|<use|<image|[\u0001\u007f\u0085]/)
    assert.deepEqual(refs.removed, ['a value with control characters (2 times)', 'a reference with hidden characters (#r) (2 times)'])
  })
}

const IDEMPOTENT: string[] = [
  ...HOSTILE.map(h => h[1]),
  CHAIN,
  ...CONTROL.map(bombOf),
  svgOf('<text>a&#x85;b&#x2028;c&#13;d&#9;e</text><rect data-name="x&#10;y&#13;z&#9;w&#x85;" width="1" height="1"/>'),
  svgOf('<style>@media (min-width: 10px){g rect{fill:red}} g > rect{fill:blue}</style><g><rect width="1" height="1"/></g>'),
  svgOf(`<style>text{font-family:'a\nb'}</style><text font-family="Font (Pro)">x</text>`),
  '<!-- <!DOCTYPE decoy> --><!DOCTYPE svg [<!ENTITY y "EXPANDED">]>' + svgOf('<text>&y;</text>'),
  svgOf('<text><![CDATA[<!DOCTYPE x]]></text>'),
  svgOf(`<linearGradient id="g"/><rect width="1" height="1" fill="URL( '#g' )"/>`),
  svgOf('\n  <g>\n    <rect width="1" height="1"/>\n  </g>\n  <text xml:space="preserve">  a\tb  </text>\n')
]

test('cleaning twice gives the same SVG as cleaning once, for every hostile input', () => {
  for (const input of IDEMPOTENT) {
    const once = cleanSvg(input).svg
    assert.equal(cleanSvg(once).svg, once, input.slice(0, 120))
  }
})

test('an svg layer is already in the form cleanSvg writes, so cleaning it again changes nothing', () => {
  const every = (l: Layer): Layer[] => [l, ...(l.type === 'group' ? l.children.flatMap(every) : [])]
  const inputs = [
    svgOf(
      '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>' +
        `<g filter="url(#f)" font-family="A&#9;B" style="mix-blend-mode:screen"><rect width="5" height="5" fill="url(#g)"/><text>it's &amp; &#x85;</text></g>`
    ),
    svgOf(
      '<defs><mask id="m"><rect width="5" height="5" fill="#fff"/></mask><marker id="k"><path d="M0 0L1 1"/></marker></defs>' +
        '<rect width="5" height="5" mask="url(#m)"/><path d="M0 0L5 5" marker-end="url(#k)" stroke="red"/>'
    ),
    svgOf('<defs><path id="p" d="M0 20L100 20"/><pattern id="pt" width="2" height="2"><rect width="1" height="1"/></pattern></defs><text><textPath href="#p">Hi</textPath></text><rect width="5" height="5" fill="url(#pt)"/>'),
    // a reference to the element's own ancestor can't come along: the layer is cleaned again, and drops it
    svgOf('<defs><mask id="m"><rect width="5" height="5" fill="#fff"/></mask></defs><g id="outer"><rect width="5" height="5" mask="url(#m)" fill="url(#outer)"/></g>')
  ]
  let layers = 0
  for (const input of inputs) {
    for (const l of every(importSvg(input, 'T').group)) {
      if (l.type !== 'svg') continue
      layers++
      const again = cleanSvg(l.svg)
      assert.equal(again.svg, l.svg)
      assert.deepEqual(again.removed, [])
    }
  }
  assert.equal(layers, 6)
})

test('names with tabs, newlines and line separators round-trip through an export byte for byte', async () => {
  const name = 'a\tb\nc\rd\u0085e\u2028f'
  const d = newDesign('instagram')
  d.artboards[0].layers.push({ ...base, id: 'r1', name, type: 'rect', x: 0, y: 0, width: 5, height: 5, fill: { type: 'color', color: '#000000' } })
  const out = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' })
  const { svg, removed } = cleanSvg(out)
  assert.deepEqual(removed, [])
  assert.equal(svg, out)
  const g = parse(out).getElementsByTagName('g')[0]
  assert.equal(g.getAttribute('data-name'), name)
  assert.equal(g.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label'), name)
})

test('a font family with a space before a parenthesis is not taken for a function', () => {
  const { svg, removed } = cleanSvg(svgOf(`<text font-family="Font (Pro)" style="font-family:'Other', Font (Pro)">a</text>`))
  assert.match(svg, /font-family="Font \(Pro\)"/)
  assert.match(svg, /style="font-family:&apos;Other&apos;, Font \(Pro\)"/)
  assert.deepEqual(removed, [])
})

test('a DOCTYPE behind a decoy is still stripped, one with any subset is too, and DOCTYPE text in CDATA is text', () => {
  for (const decoy of ['<!-- <!DOCTYPE fake> -->', '<?foo <!DOCTYPE fake>?>']) {
    const { svg, removed } = cleanSvg(
      `${decoy}<!DOCTYPE svg [<!ENTITY y "EXPANDED"><!ENTITY x SYSTEM "file:///c:/windows/win.ini">]>` + svgOf('<text>&y;&x;</text>')
    )
    assert.doesNotMatch(svg, /EXPANDED|DOCTYPE|win\.ini/)
    assert.ok(removed.some(r => /DOCTYPE that declares entities/.test(r)), JSON.stringify(removed))
  }
  const cdata = cleanSvg(svgOf('<text><![CDATA[<!DOCTYPE x]]></text>'))
  assert.match(cdata.svg, /<text>&lt;!DOCTYPE x<\/text>/)
  assert.deepEqual(cdata.removed, [])
  const subset = cleanSvg('<!DOCTYPE svg [<!ELEMENT svg ANY>]>' + svgOf('<rect width="1" height="1"/>'))
  assert.ok(subset.removed.some(r => /DOCTYPE with declarations/.test(r)), JSON.stringify(subset.removed))
})

test('an image may only embed a picture, never point at an id', () => {
  const { svg, removed } = cleanSvg(svgOf('<rect id="r" width="1" height="1"/><image href="#r" width="1" height="1"/>'))
  assert.doesNotMatch(svg, /<image/)
  assert.ok(removed.some(r => /not an embedded picture \(#r\)/.test(r)), JSON.stringify(removed))
})

test('style rules keep element, class, id and descendant selectors only; url() in them must name an id here', () => {
  const { svg, removed } = cleanSvg(
    svgOf('<style>g rect, .a.b, #x{fill:red} g > rect{fill:blue} rect[x]{fill:blue} rect:hover{fill:blue} rect{fill:url(#nope)}</style><rect width="1" height="1"/>')
  )
  assert.match(svg, /<style>g rect, \.a\.b, #x\{fill:red\}<\/style>/)
  assert.ok(removed.some(r => /selector other than element, class, id or descendant \(3 times\)/.test(r)), JSON.stringify(removed))
  assert.ok(removed.includes('a reference to a missing id (#nope)'), JSON.stringify(removed))
  const { group } = importSvg(svgOf('<style>g rect{fill:#00ff00}</style><g><rect width="1" height="1"/></g><rect width="1" height="1"/>'), 'D')
  const [g, plain] = kids(group)
  assert.deepEqual(kids(g)[0].fill, { type: 'color', color: '#00ff00' })
  assert.deepEqual(plain.fill, { type: 'color', color: '#000000' })
})

test('an inlined fragment clips like the image it replaces and prefixes references however they were written', () => {
  const out = inlineSvg(
    svgOf(`<linearGradient id="g"/><rect x="-100" width="300" height="10" fill="URL( '#g' )" style="stroke:Url(#g)"/>`, 'viewBox="0 0 10 10" overflow="visible" style="overflow:visible;fill:red"'),
    { x: 0, y: 0, w: 10, h: 10 },
    's-k-'
  )
  // style declarations become attributes on the way in, so the root's fill stays and its overflow goes
  assert.doesNotMatch(out, /overflow/)
  assert.match(out, /^<svg [^>]* fill="red">/)
  assert.match(out, /fill="url\(#s-k-g\)" stroke="url\(#s-k-g\)"/)
})

test('an even-odd path past 2,000 edges stays svg, noted, without the crossing check', () => {
  let d = 'M0 0'
  for (let i = 0; i < 1100; i++) d += i % 2 ? `H0V${i + 1}` : `H1000V${i + 1}`
  const { group, kept } = importSvg(svgOf(`<path id="snake" fill-rule="evenodd" d="${d}"/>`), 'E')
  assert.equal(kids(group)[0].type, 'svg')
  assert.ok(kept.some(k => /snake: .*too detailed/.test(k)), JSON.stringify(kept))
})

test('a gradient never gives a paint more than 256 stops', () => {
  const stops = (n: number) => Array.from({ length: n }, (_, i) => `<stop offset="${(i / n).toFixed(6)}" stop-color="${i % 2 ? '#f00' : '#00f'}"/>`).join('')
  const many = importSvg(svgOf(`<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="100">${stops(10_000)}</linearGradient><rect id="bar" width="100" height="10" fill="url(#g)"/>`), 'S')
  const fill = kids(many.group)[0].fill
  assert.ok(fill && fill.type === 'linear' && fill.stops.length <= 256 && fill.stops.length > 200, JSON.stringify(fill).slice(0, 200))
  assert.ok(many.kept.some(k => /bar: its gradient is approximated/.test(k)), JSON.stringify(many.kept))
  const repeat = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="${(100 / 60).toFixed(6)}" spreadMethod="repeat">${stops(1000)}</linearGradient>`
  let r: ReturnType<typeof importSvg> | undefined
  underASecond('1,000 stops repeated 60 times over 50 rects', () => {
    r = importSvg(svgOf(repeat + '<rect width="100" height="10" fill="url(#g)"/>'.repeat(50)), 'R')
  })
  assert.ok(kids(r!.group).every(l => l.fill && l.fill.type === 'linear' && l.fill.stops.length <= 256))
})

test('svg layers that would copy too much are refused with a plain message', () => {
  const mask = `<mask id="m">${'<rect width="1" height="1" fill="#fff"/>'.repeat(2000)}</mask>`
  const shapes = Array.from({ length: 1000 }, (_, i) => `<rect x="${i}" width="1" height="1" mask="url(#m)"/>`).join('')
  assert.throws(() => importSvg(svgOf(`<defs>${mask}</defs>${shapes}`, 'width="5000" height="10"'), 'M'), {
    message: 'This SVG expands to too much (over 50,000 elements).'
  })
  const clip = `<clipPath id="c"><path d="M0 0${' L1 1'.repeat(40_000)}"/></clipPath><filter id="f"/>`
  const users = '<rect width="1" height="1" filter="url(#f)" clip-path="url(#c)"/>'.repeat(30)
  assert.throws(() => importSvg(svgOf(`<defs>${clip}</defs>${users}`), 'C'), { message: 'This SVG expands to too much (over 5 MB of SVG layers).' })
})

/**
 * Asserts that `fn` finishes in under a second. The runner runs test files in parallel, which inflates the usual
 * clocks: wall time counts waiting for other files, and the process's CPU time counts V8's parallel GC threads. So
 * this thread's own CPU time is what's checked (process.threadCpuUsage, Node 22.19 and later), or else the smaller of
 * wall and process CPU time.
 */
function underASecond(label: string, fn: () => unknown): void {
  const thread = (process as { threadCpuUsage?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage?.bind(process)
  const t0 = thread?.()
  const cpu = process.cpuUsage()
  const start = performance.now()
  fn()
  const wallMs = performance.now() - start
  const used = process.cpuUsage(cpu)
  const cpuMs = (used.user + used.system) / 1000
  const own = t0 && thread ? thread(t0) : null
  const threadMs = own ? (own.user + own.system) / 1000 : Math.min(cpuMs, wallMs)
  assert.ok(threadMs < 1000, `${label} took ${Math.round(threadMs)} ms of its thread's CPU (${Math.round(wallMs)} ms wall, ${Math.round(cpuMs)} ms process CPU)`)
}

test('pathological url( values clean in linear time', () => {
  underASecond('url(# x 40,000', () => cleanSvg(svgOf(`<rect width="1" height="1" fill="${'url(#'.repeat(40_000)}"/>`)))
})

test('10,000 style rules over 10,000 elements clean and import in under a second each', () => {
  const css = Array.from({ length: 10_000 }, (_, i) => `.c${i}{fill:#123456}`).join('')
  const els = Array.from({ length: 10_000 }, (_, i) => `<rect class="c${i}" width="1" height="1"/>`).join('')
  const svg = svgOf(`<style>${css}</style>${els}`)
  underASecond('clean', () => cleanSvg(svg))
  underASecond('import', () => importSvg(svg, 'X'))
})

test('a 48 KB serpentine even-odd path imports in under a second', () => {
  let d = 'M0 0'
  for (let i = 0; i < 5900; i++) d += i % 2 ? `H0V${i + 1}` : `H1000V${i + 1}`
  underASecond('serpentine', () => importSvg(svgOf(`<path fill-rule="evenodd" d="${d}"/>`), 'X'))
})

test('15,000 gradient-filled rects in a filtered group import in under a second', () => {
  const grads = Array.from({ length: 15_000 }, (_, i) => `<linearGradient id="g${i}"/>`).join('')
  const rects = Array.from({ length: 15_000 }, (_, i) => `<rect width="1" height="1" fill="url(#g${i})"/>`).join('')
  const svg = svgOf(`<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter>${grads}</defs><g filter="url(#f)">${rects}</g>`)
  underASecond('filtered group', () => {
    const { group } = importSvg(svg, 'X')
    assert.equal(kids(group)[0].type, 'svg')
  })
})

// Fix round 2: one href per element, budgets that follow <use>, composed markup always clean, linear style matching

/**
 * How many elements a browser draws: every <use> expanded, plain href followed over xlink:href (as Chromium does),
 * the first element with an id winning, a loop drawing nothing.
 */
function browserElements(svg: string): number {
  const root = parse(svg).documentElement
  const ids = new Map<string, Element>()
  const walk = (e: Element, f: (e: Element) => void) => {
    f(e)
    for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n as Element, f)
  }
  walk(root, e => {
    const id = e.getAttribute('id')
    if (id && !ids.has(id)) ids.set(id, e)
  })
  const memo = new Map<Element, number>()
  const active = new Set<Element>()
  const size = (e: Element): number => {
    if (memo.has(e)) return memo.get(e)!
    if (active.has(e)) return 0
    active.add(e)
    let n = 1
    for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) n += size(c as Element)
    if (e.localName === 'use') {
      const h = e.hasAttribute('href') ? e.getAttribute('href') : e.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      const t = h && h.startsWith('#') ? ids.get(h.slice(1)) : undefined
      if (t) n += size(t)
    }
    active.delete(e)
    memo.set(e, n)
    return n
  }
  return size(root)
}

/** pM: each use names a harmless target in xlink:href and the next level in href, which a browser follows. */
function doubleHref(levels = 6, fan = 10): string {
  let body = '<rect id="r" width="1" height="1"/><rect id="l0" width="1" height="1"/>'
  for (let i = 1; i <= levels; i++) body += `<g id="l${i}">${`<use xlink:href="#r" href="#l${i - 1}"/>`.repeat(fan)}</g>`
  return svgOf(`<defs>${body}</defs><use xlink:href="#r" href="#l${levels}"/>`)
}

test('an element keeps one href: two that disagree are both dropped, two that agree become one xlink:href', () => {
  const bomb = cleanSvg(doubleHref())
  assert.doesNotMatch(bomb.svg, /<use/)
  assert.ok(bomb.removed.some(r => /two different references on one element \(#r, #l0\)/.test(r)), JSON.stringify(bomb.removed))
  assert.ok(browserElements(bomb.svg) < 20)
  assert.equal(cleanSvg(bomb.svg).svg, bomb.svg)
  assert.doesNotMatch(cleanSvg(svgOf('<rect id="r" width="1" height="1"/><g id="a"><use xlink:href="#r" href="#a"/></g>')).svg, /<use/)
  const same = cleanSvg(svgOf('<rect id="r" width="1" height="1"/><use xlink:href="#r" href=" #r "/>'))
  assert.match(same.svg, /<use xlink:href="#r"\/>/)
  assert.deepEqual(same.removed, [])
  // through import (inside a filtered group, so kept as an svg layer) and through export inlining
  const filtered = svgOf(
    `<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter>${doubleHref().slice(doubleHref().indexOf('<defs>') + 6, doubleHref().indexOf('</defs>'))}</defs>` +
      '<g filter="url(#f)"><rect width="5" height="5"/><use xlink:href="#r" href="#l6"/></g>',
    'width="10" height="10"'
  )
  const layer = kids(importSvg(filtered, 'D').group)[0]
  assert.ok(layer.type === 'svg' && browserElements(layer.svg) < 20)
  assert.ok(browserElements(svgOf(inlineSvg(doubleHref(), { x: 0, y: 0, w: 10, h: 10 }, 's1-'))) < 20)
})

test("a <use> inside definitions an svg layer copies counts toward the import's 50,000 elements", () => {
  const fan = (n: number, id: string) => `<use href="#${id}"/>`.repeat(n)
  // a mask that draws 26,733 elements once its uses expand: one masked shape fits, 900 don't
  let mask = `<g id="L1">${'<rect width="1" height="1" fill="#fff"/>'.repeat(12)}</g>`
  for (let i = 2; i <= 4; i++) mask += `<g id="L${i}">${fan(12, `L${i - 1}`)}</g>`
  const masked = (n: number) =>
    svgOf(
      `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">${mask}</mask></defs>` +
        Array.from({ length: n }, (_, i) => `<rect x="${i % 100}" y="${Math.floor(i / 100)}" width="1" height="1" mask="url(#m)"/>`).join(''),
      'width="100" height="100"'
    )
  assert.equal(kids(importSvg(masked(1), 'M').group)[0].type, 'svg')
  underASecond('refusing 900 masked shapes', () =>
    assert.throws(() => importSvg(masked(900), 'M'), { message: 'This SVG expands to too much (over 50,000 elements).' })
  )
})

test('an import whose layers would come to more than 32 MB of JSON is refused', () => {
  // one 200-stop gradient shared by thousands of shapes: each shape carries its own copy of the paint
  const stops = Array.from({ length: 200 }, (_, i) => `<stop offset="${(i / 199).toFixed(4)}" stop-color="#${((i * 1237) % 0xffffff).toString(16).padStart(6, '0')}"/>`).join('')
  const rects = Array.from({ length: 8000 }, (_, i) => `<rect x="${i % 200}" y="${Math.floor(i / 200)}" width="1" height="1" fill="url(#g)"/>`).join('')
  // (no time bound: refusing at 32 MB means making 32 MB of layers first)
  assert.throws(() => importSvg(svgOf(`<linearGradient id="g">${stops}</linearGradient>${rects}`, 'width="200" height="300"'), 'J'), {
    message: 'This SVG is too large to convert.'
  })
})

/** pO: two values that are each an unterminated string, which joined would close each other and let a url through. */
const STITCH = svgOf(
  `<style>rect{isolation:'x}</style><style>rect{mix-blend-mode:';filter:url(https://evil.example/f.svg#f);mask-image:url(https://evil.example/m.png)}</style>` +
    '<rect width="10" height="10"/>',
  'viewBox="0 0 10 10"'
)

test('style values are checked one by one, so two can never be stitched into a third', async () => {
  const clean = cleanSvg(STITCH)
  assert.doesNotMatch(clean.svg, /evil|<style/)
  assert.ok(clean.removed.includes('a style value with a string that never ends (2 times)'), JSON.stringify(clean.removed))
  const d = newDesign('instagram')
  d.artboards[0].layers.push({ ...base, id: 'a1', name: 'L', type: 'svg', x: 0, y: 0, width: 10, height: 10, svg: STITCH })
  const out = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' })
  assert.doesNotMatch(out, /evil|filter|mask/)
  const again = cleanSvg(out)
  assert.deepEqual(again.removed, [])
  assert.equal(again.svg, out, 'the export survives cleanSvg byte for byte')
  // a rule's quoted font family is applied without its quotes; a value that can't stand alone is dropped
  const { group } = importSvg(svgOf(`<style>text{font-family:'Liberation Sans', sans-serif}</style><text x="0" y="10">Hi</text>`), 'F')
  const t = kids(group)[0]
  assert.ok(t.type === 'text' && t.runs[0].font.family === 'Liberation Sans', JSON.stringify(t))
})

test('composed svg layers are cleaned again and bring the definitions their inherited paint refers to', () => {
  const src = svgOf(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
      '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter><marker id="mk"><rect width="1" height="1"/></marker></defs>' +
      '<g fill="url(#g)" marker-start="url(#mk)"><path d="M0 0L10 0L10 10Z" filter="url(#f)"/></g>',
    'width="10" height="10"'
  )
  const layer = kids(kids(importSvg(src, 'R').group)[0])[0]
  assert.equal(layer.type, 'svg')
  if (layer.type !== 'svg') return
  assert.match(layer.svg, /<linearGradient id="g">/)
  assert.match(layer.svg, /<marker id="mk">/)
  assert.match(layer.svg, /fill="url\(#g\)" marker-start="url\(#mk\)"/)
  const again = cleanSvg(layer.svg)
  assert.equal(again.svg, layer.svg)
  assert.deepEqual(again.removed, [])
})

test('descendant rules over deep nesting and one element with 10,000 classes match in under a second', () => {
  const css = Array.from({ length: 250 }, (_, i) => `g.zz${i} rect{fill:red}`).join('')
  const classes = Array.from({ length: 20 }, (_, i) => `c${i}`).join(' ')
  const deep = svgOf(`<style>${css}</style>${`<g class="${classes}">`.repeat(250)}${'<rect width="1" height="1"/>'.repeat(1000)}${'</g>'.repeat(250)}`, 'width="10" height="10"')
  underASecond('pQ import', () => importSvg(deep, 'Q'))
  underASecond('pQ export', () => inlineSvg(cleanSvg(deep).svg, { x: 0, y: 0, w: 10, h: 10 }, 's1-'))
  const K = 10_000
  const wide = svgOf(
    `<style>${Array.from({ length: K }, (_, i) => `.c${i}{fill:red}`).join('')}</style><rect class="${Array.from({ length: K }, (_, i) => `c${i}`).join(' ')}" width="1" height="1"/>`,
    'width="10" height="10"'
  )
  underASecond('pT import', () => importSvg(wide, 'T'))
  underASecond('pT export', () => inlineSvg(cleanSvg(wide).svg, { x: 0, y: 0, w: 10, h: 10 }, 's1-'))
})

test('style matching past 2,000,000 steps is refused, fast', () => {
  // 1,000 rules that all match each of 3,000 rects: 3,000,000 matching steps
  const css = Array.from({ length: 1000 }, (_, i) => `rect{stroke-width:${i}}`).join('')
  const svg = svgOf(`<style>${css}</style>${'<rect width="1" height="1"/>'.repeat(3000)}`)
  underASecond('refusing', () => assert.throws(() => importSvg(svg, 'S'), { message: "This SVG's style rules are too complex to apply." }))
})

test('svg layers are numbered per render, so ids never collide between them', async () => {
  const fragment = (body: string) => svgOf(body, 'viewBox="0 0 10 10"')
  // layer "a" holds id "b-x" and layer "a-b" holds id "x": prefixed by layer id, both would be "s-a-b-x"
  const one = fragment('<defs><linearGradient id="b-x"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="5" height="5" fill="url(#b-x)"/>')
  const two = fragment('<defs><linearGradient id="x"><stop offset="0" stop-color="blue"/></linearGradient></defs><rect width="5" height="5" fill="url(#x)"/>')
  const svgLayer = (id: string, svg: string): Layer => ({ ...base, id, name: id, type: 'svg', x: 0, y: 0, width: 10, height: 10, svg })
  for (const [first, second] of [['a', 'a-b'], ['z', 'z']]) {
    const d = newDesign('instagram')
    d.artboards[0].layers.push(svgLayer(first, one), svgLayer(second, two))
    const out = designToSvg(d, d.artboards[0].id, { fonts: await fontsOf(d), assets: {}, mode: 'export' })
    // fragment ids (two layers sharing an id still repeat the renderer's own l-<id>, which layer ids being unique avoids)
    const ids = Array.from(out.matchAll(/ id="(s[^"]+)"/g), m => m[1])
    assert.deepEqual(ids, ['s1-b-x', 's2-x'])
    assert.match(out, /<linearGradient id="s1-b-x">[\s\S]*fill="url\(#s1-b-x\)"[\s\S]*<linearGradient id="s2-x">[\s\S]*fill="url\(#s2-x\)"/)
    assert.equal(cleanSvg(out).svg, out)
  }
})

test("an inlined fragment's root loses its filter, and names are never prefixed", () => {
  const out = inlineSvg(
    svgOf(
      '<defs><filter id="f"><feGaussianBlur stdDeviation="9"/></filter></defs><g id="x" data-name="url(#f)" inkscape:label="url(#f)" filter="url(#f)"><rect width="5" height="5"/></g>',
      'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 10 10" filter="url(#f)" style="filter:url(#f);fill:red"'
    ),
    { x: 0, y: 0, w: 10, h: 10 },
    's1-'
  )
  assert.match(out, /^<svg [^>]*fill="red">/)
  assert.doesNotMatch(out.slice(0, out.indexOf('>')), /filter/)
  assert.match(out, /<g id="s1-x" data-name="url\(#f\)" inkscape:label="url\(#f\)" filter="url\(#s1-f\)">/)
})

test('a reference to a name SVG does not allow is named plainly', () => {
  const { removed } = cleanSvg(svgOf('<rect id="9r" width="1" height="1"/><use href="#9r"/><linearGradient id="1g"/><rect width="1" height="1" fill="url(#1g)"/>'))
  assert.ok(removed.includes("a reference to a name SVG doesn't allow (#9r)"), JSON.stringify(removed))
  assert.ok(removed.includes("a reference to a name SVG doesn't allow (#1g)"), JSON.stringify(removed))
})
