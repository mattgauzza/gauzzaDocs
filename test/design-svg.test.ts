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
import { PRESENTATION, STYLE_ONLY, cleanSvg } from '../src/shared/design/svgClean'
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

test('style rules keep only simple selectors; url() in them must name an id here', () => {
  const { svg, removed } = cleanSvg(
    svgOf(
      '<style>g rect, .a.b, #x, rect.logo{fill:red} g > rect{fill:blue} rect[x]{fill:blue} rect:hover{fill:blue} *{fill:blue} ' +
        '.a.b.c.d.e{fill:blue} @media all{rect{fill:blue}} rect{fill:url(#nope)}</style><rect width="1" height="1"/>'
    )
  )
  assert.match(svg, /<style>\.a\.b, #x, rect\.logo\{fill:red\}<\/style>/)
  assert.ok(removed.includes("a style rule gauzzaDocs doesn't support (7 times)"), JSON.stringify(removed))
  assert.ok(removed.includes('a reference to a missing id (#nope)'), JSON.stringify(removed))
  // a descendant rule is dropped, not applied
  const { group, removed: dropped } = importSvg(svgOf('<style>g rect{fill:#00ff00}</style><g><rect width="1" height="1"/></g><rect width="1" height="1"/>'), 'D')
  const [g, plain] = kids(group)
  assert.deepEqual(kids(g)[0].fill, { type: 'color', color: '#000000' })
  assert.deepEqual(plain.fill, { type: 'color', color: '#000000' })
  assert.ok(dropped.includes("a style rule gauzzaDocs doesn't support"))
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
  // a mask's content is painted for every shape it masks (2,000,000 here), so the cleaner itself refuses this before any
  // layer is made
  assert.throws(() => importSvg(svgOf(`<defs>${mask}</defs>${shapes}`, 'width="5000" height="10"'), 'M'), {
    message: 'This SVG would take too long to draw (over 1,000,000 painted elements).'
  })
  // a filter is drawn once per shape, not painted as content, but each svg layer copies it: the import's budget refuses
  const filter = `<filter id="f">${'<feOffset dx="1"/>'.repeat(60)}</filter>`
  const filtered = Array.from({ length: 1000 }, (_, i) => `<rect x="${i}" width="1" height="1" filter="url(#f)"/>`).join('')
  const source = svgOf(`<defs>${filter}</defs>${filtered}`, 'width="5000" height="10"')
  assert.ok(cleanSvg(source).drawn < 50_000)
  assert.throws(() => importSvg(source, 'F'), { message: 'This SVG expands to too much (over 50,000 elements).' })
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
  // the mask's content is painted for each masked shape, so the cleaner refuses 900 of them before the import starts
  underASecond('refusing 900 masked shapes', () =>
    assert.throws(() => importSvg(masked(900), 'M'), { message: 'This SVG would take too long to draw (over 1,000,000 painted elements).' })
  )
  // filtered groups each using the fan-out: the source draws it once per group, but each svg layer also copies it
  // into its own definitions, uses and all, and those copies are what the import's budget refuses
  let fan3 = `<g id="L1">${'<rect width="1" height="1"/>'.repeat(12)}</g>`
  for (let i = 2; i <= 3; i++) fan3 += `<g id="L${i}">${fan(12, `L${i - 1}`)}</g>`
  const groups = (n: number) =>
    svgOf(
      `<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter>${fan3}</defs>` +
        Array.from({ length: n }, (_, i) => `<g filter="url(#f)"><rect x="${i}" width="1" height="1"/><use href="#L3"/></g>`).join(''),
      'width="100" height="100"'
    )
  assert.ok(cleanSvg(groups(20)).drawn < 50_000)
  assert.equal(kids(importSvg(groups(1), 'G').group)[0].type, 'svg')
  underASecond('refusing 20 filtered groups', () =>
    assert.throws(() => importSvg(groups(20), 'G'), { message: 'This SVG expands to too much (over 50,000 elements).' })
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
  // each value runs to the end of its rule (taking the closing brace with it), so it goes for its brace
  assert.ok(clean.removed.includes('a style value with braces (2 times)'), JSON.stringify(clean.removed))
  assert.ok(cleanSvg(svgOf(`<rect width="1" height="1" style="mix-blend-mode:';filter:url(https://evil.example/f.svg#f)"/>`)).removed.includes('a style value with a string that never ends'))
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
    const again = cleanSvg(out)
    if (first === second) assert.deepEqual(again.removed, [`a repeated id (#l-${first})`]) // the second l-z loses its id
    else assert.equal(again.svg, out)
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

// Fix round 3: simple style rules only, repeated ids, and the smaller ones

const BOX = { x: 0, y: 0, w: 10, h: 10 }
/** Import and export (inline) both finish in under a second, or are refused within it. */
function quickEither(label: string, svg: string): void {
  underASecond(`${label} import`, () => {
    try {
      importSvg(svg, 'X')
    } catch (e) {
      assert.match((e as Error).message, /^This SVG/)
    }
  })
  underASecond(`${label} export`, () => inlineSvg(svg, BOX, 's1-'))
}

test('the reviewer style inputs import and export in under a second each', () => {
  const E = 5000
  const K = 200_000
  quickEither('one compound repeating .a 200,000 times', svgOf(`<style>${'.a'.repeat(K)}{fill:red}</style>${'<rect class="a" width="1" height="1"/>'.repeat(E)}`, 'width="10" height="10"'))
  quickEither('one compound repeating #a 200,000 times', svgOf(`<style>${'#a'.repeat(K)}{fill:red}</style>${'<rect id="a" width="1" height="1"/>'.repeat(E)}`, 'width="10" height="10"'))
  quickEither('a descendant chain of 200,000 parts', svgOf(`<style>${'g '.repeat(K)}rect{fill:red}</style><g>${'<rect width="1" height="1"/>'.repeat(E)}</g>`, 'width="10" height="10"'))
  quickEither('.a repeated 100,000 times', svgOf(`<style>${'.a'.repeat(100_000)}{fill:red}</style>${'<rect class="a" width="1" height="1"/>'.repeat(E)}`, 'width="10" height="10"'))
  const decls = svgOf(`<style>rect{${'fill:red;'.repeat(50_000)}}</style>${'<rect width="1" height="1"/>'.repeat(10_000)}`, 'width="10" height="10"')
  quickEither('fill:red; 50,000 times over 10,000 rects', decls)
  assert.equal((cleanSvg(decls).svg.match(/fill:red/g) ?? []).length, 1, 'one declaration per property')
})

test('a rule with more than 64 declarations, once each property is kept once, is dropped', () => {
  const props = [...PRESENTATION, ...STYLE_ONLY]
  assert.ok(props.length >= 65)
  const rule = (n: number) => `rect{${props.slice(0, n).map(p => `${p}:inherit`).join(';')}}`
  assert.match(cleanSvg(svgOf(`<style>${rule(64)}</style>`)).svg, /<style>rect\{/)
  const over = cleanSvg(svgOf(`<style>${rule(65)}</style>`))
  assert.doesNotMatch(over.svg, /<style/)
  assert.ok(over.removed.includes("a style rule gauzzaDocs doesn't support"), JSON.stringify(over.removed))
})

test('a repeated id keeps only its first element, so a composed layer resolves a use the way the source did', () => {
  // pZ: the pattern's <g id="x"> repeats the id of a small rect; copied into each layer first, it would win there
  const N = 60
  const layer = `<g filter="url(#f)"><rect width="1" height="1" fill="url(#pat)"/>${'<use href="#x"/>'.repeat(80)}</g>`
  const src = svgOf(
    '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><rect id="x" width="1" height="1"/></defs>' +
      layer.repeat(N) +
      `<defs><pattern id="pat" width="1" height="1"><g id="x">${'<use href="#y"/>'.repeat(100)}</g></pattern>` +
      `<g id="y">${'<rect width="1" height="1"/>'.repeat(4)}</g></defs>`,
    'width="10" height="10"'
  )
  const clean = cleanSvg(src)
  assert.ok(clean.removed.includes('a repeated id (#x)'), JSON.stringify(clean.removed))
  assert.equal((clean.svg.match(/ id="x"/g) ?? []).length, 1)
  let drawn = 0
  try {
    const every = (l: Layer): Layer[] => [l, ...(l.type === 'group' ? l.children.flatMap(every) : [])]
    for (const l of every(importSvg(src, 'Z').group)) if (l.type === 'svg') drawn += browserElements(l.svg)
  } catch (e) {
    assert.equal((e as Error).message, 'This SVG expands to too much (over 50,000 elements).')
  }
  assert.ok(drawn <= 50_000, `the layers draw ${drawn} elements`)
})

test('a font family in any script keeps its letters; one with other characters is dropped', () => {
  const family = (css: string) => {
    const t = kids(importSvg(svgOf(`<style>${css}</style><text x="0" y="10">Hi</text>`), 'F').group)[0]
    return t.type === 'text' ? t.runs[0].font.family : ''
  }
  assert.equal(family("text{font-family:'\u30d2\u30e9\u30ae\u30ce\u89d2\u30b4 Pro', sans-serif}"), '\u30d2\u30e9\u30ae\u30ce\u89d2\u30b4 Pro')
  assert.equal(family("text{font-family:'M+ 1p', sans-serif}"), 'sans-serif', "a family that can't lose its quotes isn't applied")
})

test("an inlined fragment's root loses its transform too, however it was set", () => {
  const root = (attrs: string, body = '') => {
    const out = inlineSvg(svgOf(`${body}<rect width="10" height="10" fill="red"/>`, `viewBox="0 0 10 10" ${attrs}`), BOX, 's1-')
    return out.slice(0, out.indexOf('>') + 1)
  }
  for (const r of [
    root('transform="translate(500 0)"'),
    root('style="transform:translate(500px,0)"'),
    root('', '<style>svg{transform:scale(50);filter:url(#f)}</style><filter id="f"/>')
  ]) {
    assert.equal(r, '<svg x="0" y="0" width="10" height="10" viewBox="0 0 10 10" preserveAspectRatio="none">')
  }
})

test('a path drawn by 5,000 uses is parsed once: a 4.4 MB padded path imports in under a second', () => {
  const d = 'M0 0' + ' '.repeat(4_390_000) + 'L1 1'
  const src = svgOf(`<defs><path id="p" d="${d}"/></defs>${'<use href="#p"/>'.repeat(5000)}`, 'width="10" height="10"')
  underASecond('padded path', () => assert.equal(kids(importSvg(src, 'P').group).length, 5000))
})

test('url( with a gap, a comment, braces or no closing bracket is dropped with a plain note', () => {
  const removed = (attrs: string) => cleanSvg(svgOf(`<linearGradient id="g"/><rect width="1" height="1" ${attrs}/>`)).removed
  assert.deepEqual(removed('fill="url (#g)"'), ['a reference with a gap between url and its bracket'])
  assert.deepEqual(removed('fill="url/**/(#g)"'), ['a style value with a comment'])
  assert.deepEqual(removed('style="fill:red}"'), ['a style value with braces'])
  assert.deepEqual(removed('fill="url(#g"'), ["a reference that isn't closed (url(#g)"])
  assert.deepEqual(removed(`fill="url('#g"`), ["a reference that isn't closed ('#g)"])
  assert.deepEqual(removed('style="stroke:https://evil.example/x)"'), ['a style value with unbalanced brackets'])
  assert.deepEqual(removed('fill="rgb(1,2,3"'), ['a style value with unbalanced brackets'])
  assert.deepEqual(removed('style="mix-blend-mode:multiply !important !important"'), ['a style value with a stray !'])
  const empty = cleanSvg(svgOf('<rect id="r" width="1" height="1"/><use href="" xlink:href="#r"/>'))
  assert.deepEqual(empty.removed, ['an empty reference'])
  assert.match(empty.svg, /<use xlink:href="#r"\/>/)
})

// Fix round 4: declarations charged per match, even-odd conversion cached, repeated painting counted, valid overrides

const TOO_COMPLEX = "This SVG's style rules are too complex to apply."
const TOO_SLOW = 'This SVG would take too long to draw (over 1,000,000 painted elements).'

test('a style rule is charged its declarations on every element it matches, so the reviewer inputs are refused fast', () => {
  // 64 properties that keep a rect a native path on import (as the reviewer's pAD chose them)
  const skip = new Set(['font', 'transform', 'font-family', 'display', 'visibility', 'filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'clip', 'opacity', 'mix-blend-mode'])
  const props = [...PRESENTATION, ...STYLE_ONLY].filter(p => !skip.has(p)).slice(0, 64)
  assert.equal(props.length, 64)
  const body = props.map(p => `${p}:1`).join(';')
  const size = 'width="10" height="10"'
  const refused: [string, string][] = [
    ['pAD: 1,000 rules over 2,000 rects', svgOf(`<style>${`rect{${body}}`.repeat(1000)}</style>${'<rect/>'.repeat(2000)}`, size)],
    ['pAD: 200 rules over 10,000 rects', svgOf(`<style>${`rect{${body}}`.repeat(200)}</style>${'<rect/>'.repeat(10_000)}`, size)],
    ['pAC: rect, 200 times in one list, over 10,000 rects', svgOf(`<style>${Array(200).fill('rect').join(',')}{${body}}</style>${'<rect/>'.repeat(10_000)}`, size)],
    ['pAC: 40 rules over 49,000 rects', svgOf(`<style>${`rect{${body}}`.repeat(40)}</style>${'<rect/>'.repeat(49_000)}`, size)],
    ['pAC: one rule over 49,000 rects', svgOf(`<style>rect{${body}}</style>${'<rect/>'.repeat(49_000)}`, size)],
    ['one rule over 30,000 rects', svgOf(`<style>rect{${body}}</style>${'<rect/>'.repeat(30_000)}`, size)]
  ]
  for (const [label, svg] of refused) {
    underASecond(`${label}, import`, () => assert.throws(() => importSvg(svg, 'X'), { message: TOO_COMPLEX }))
    underASecond(`${label}, export`, () => assert.equal(inlineSvg(svg, BOX, 's1-'), ''))
  }
  // what fits the budget applies every declaration to every rect, in under a second each way (since round 5 a rule is
  // also charged a step per 16 characters it writes, so 4,000 rects fit where 7,000 did)
  const fits = svgOf(`<style>rect{${body}}</style>${'<rect width="1" height="1"/>'.repeat(4000)}`, size)
  let out = ''
  underASecond('one rule over 4,000 rects, import', () => assert.equal(kids(importSvg(fits, 'X').group).length, 4000))
  underASecond('one rule over 4,000 rects, export', () => (out = inlineSvg(fits, BOX, 's1-')))
  assert.equal(out.match(/<rect /g)?.length, 4000)
  for (const p of props.filter(p => PRESENTATION.has(p))) assert.equal(out.split(` ${p}="1"`).length - 1, 4000, p)
})

test('a font shorthand applies as at most four longhands, however many words lead it', () => {
  // before, each leading word became a declaration of its own, applied to every rect the rule matched. (Since round 5
  // a value is at most 2,000 characters, about 400 words, and the rule pays for its length; the four still hold.)
  const svg = svgOf(`<style>rect{font:${'bold '.repeat(390)}italic 12px Liberation Sans}</style>${'<rect width="1" height="1"/>'.repeat(3000)}`, 'width="10" height="10"')
  let out = ''
  quickEither('a font shorthand of 391 words over 3,000 rects', svg)
  underASecond('the same, exported', () => (out = inlineSvg(svg, BOX, 's1-')))
  assert.equal(out.split(' height="1" font-size="12px" font-family="Liberation Sans" font-style="italic" font-weight="bold"/>').length - 1, 3000)
  // a 100,000-word shorthand is now longer than any value may be, so it isn't applied at all
  const long = svgOf(`<style>rect{font:${'bold '.repeat(100_000)}italic 12px Liberation Sans}</style>${'<rect width="1" height="1"/>'.repeat(10_000)}`, 'width="10" height="10"')
  quickEither('a font shorthand of 100,000 words over 10,000 rects', long)
  assert.doesNotMatch(inlineSvg(long, BOX, 's1-'), /font/)
})

test('an even-odd outline is turned once per shape and baked once per place, however many uses or clips share it', () => {
  // a serpentine that never crosses itself, with every row spanning the same x range: the crossing check takes
  // every pair of its 1,988 edges, about 20 ms, each time it runs
  let d = 'M0 0'
  for (let i = 0; i < 994; i++) d += i % 2 ? `H0V${i + 1}` : `H1000V${i + 1}`
  const size = 'width="1000" height="2000"'
  const uses = svgOf(`<defs><path id="p" fill-rule="evenodd" d="${d}"/></defs>${'<use href="#p"/>'.repeat(1000)}`, size)
  underASecond('1,000 uses of one even-odd path', () => {
    const layers = kids(importSvg(uses, 'U').group)
    assert.equal(layers.length, 1000)
    assert.ok(layers.every(l => l.type === 'path'))
  })
  const clips = Array.from({ length: 1000 }, (_, i) => `<rect x="${i % 10}" width="1000" height="2000" clip-path="url(#c)"/>`).join('')
  for (const [label, clip] of [
    ['1,000 rects sharing one even-odd clip', `<clipPath id="c"><path clip-rule="evenodd" d="${d}"/></clipPath>`],
    ['the same, its path drawn by a use', `<path id="p" clip-rule="evenodd" d="${d}"/><clipPath id="c"><use href="#p"/></clipPath>`]
  ]) {
    underASecond(label, () => {
      const layers = kids(importSvg(svgOf(`<defs>${clip}</defs>${clips}`, size), 'C').group)
      assert.equal(layers.length, 1000)
      assert.ok(layers.every(l => l.type === 'group' && l.clip && l.children[0].type === 'path'))
    })
  }
  // what is kept is told apart by whether the fill was turned: one ring drawn even-odd and nonzero keeps both right
  const both = kids(importSvg(svgOf('<defs><path id="r" d="M0 0H10V10H0Z M2 2H8V8H2Z"/></defs><use href="#r" fill-rule="evenodd"/><use href="#r"/>'), 'R').group)
  const [evenOdd, nonZero] = both.map(l => (l.type === 'path' ? areas(l.d) : []))
  assert.ok(evenOdd[0] * evenOdd[1] < 0, `the hole turns the other way: ${evenOdd}`)
  assert.ok(nonZero[0] * nonZero[1] > 0, `nonzero keeps both the same way: ${nonZero}`)
})

test('markers, patterns, masks and clip paths count each time they are painted', () => {
  // every painting counts its content (Ruling 14: a budget of its own; `drawn` counts each element once)
  const painted = (body: string, attrs = 'width="10" height="10"') => cleanSvg(svgOf(body, attrs)).painted
  const rect = '<rect width="1" height="1"/>'
  const marker = `<marker id="m">${rect.repeat(2)}</marker>`
  // a marker at every vertex that carries it
  assert.equal(painted(`<defs>${marker}</defs><path d="M0 0L1 1L2 2" marker-mid="url(#m)"/>`), 3 * 2)
  assert.equal(painted(`<defs>${marker}</defs><path d="M0 0L1 1L2 2" marker="url(#m)"/>`), 5 * 2)
  assert.equal(painted(`<defs>${marker}</defs><polyline points="0 0 1 1 2 2 3 3" style="marker-start:url(#m);marker-end:url(#m)"/>`), 2 * 2)
  // a pattern for every element painted with it: set on each, inherited from a group, from a style rule (which also
  // matches the pattern's own rects, a loop that paints nothing), or taken back by a rule's inherit over an attribute
  const pattern = `<defs><pattern id="p" width="1" height="1">${rect.repeat(3)}</pattern></defs>`
  const filled = '<rect width="1" height="1" fill="url(#p)"/>'.repeat(100)
  assert.equal(painted(pattern + filled), 100 * 3)
  assert.equal(painted(`${pattern}<g fill="url(#p)">${rect.repeat(100)}</g>`), 100 * 3)
  assert.equal(painted(`<style>rect{fill:url(#p)}</style>${pattern}${rect.repeat(100)}`), 100 * 3)
  assert.equal(painted(`${pattern}<g fill="url(#p)"><style>.x{fill:inherit}</style>${'<rect class="x" width="1" height="1" fill="red"/>'.repeat(100)}</g>`), 100 * 3)
  // a marker inherited through a use, and one inside a pattern: painted at each vertex of each painting
  assert.equal(painted(`<defs>${marker}<path id="q" d="M0 0L1 1L2 2"/></defs>${'<use href="#q" marker-mid="url(#m)"/>'.repeat(10)}`), 10 * 3 * 2)
  const nested = `<defs><marker id="m">${rect.repeat(5)}</marker><pattern id="p"><path d="M0 0L1 1L2 2L3 3" marker-mid="url(#m)"/></pattern></defs>`
  assert.equal(painted(nested + filled), 100 * (1 + 4 * 5))
  // a pattern borrowing its template's content paints that content: two borrowers count it twice
  const template = `<defs><pattern id="t">${rect.repeat(30)}</pattern><pattern id="u" href="#t"/><pattern id="v" href="#t"/></defs>`
  assert.equal(painted(`${template}<rect width="1" height="1" fill="url(#u)"/><rect width="1" height="1" fill="url(#v)"/>`), 2 * 30)
  // a mask used once paints its content once, and the elements are still counted once each
  const once = cleanSvg(svgOf(`<defs><mask id="k">${rect.repeat(30_000)}</mask></defs><rect width="1" height="1" mask="url(#k)"/>`))
  assert.deepEqual([once.drawn, once.painted], [30_004, 30_000])
  assert.equal(painted(`<defs><linearGradient id="g"/></defs>${'<rect width="1" height="1" fill="url(#g)"/>'.repeat(100)}`), 0)
  // past 1,000,000 painted elements the SVG is refused, fast, and so is its import
  const clip = (n: number) => `<defs><clipPath id="c">${rect.repeat(n)}</clipPath></defs>`
  assert.equal(painted(clip(60) + '<rect width="1" height="1" clip-path="url(#c)"/>'.repeat(16_000)), 960_000)
  const big = `<defs><pattern id="t">${rect.repeat(100)}</pattern><pattern id="u" href="#t"/></defs>`
  const cases: [string, string][] = [
    ['20,000 rects sharing a clip of 60', clip(60) + '<rect width="1" height="1" clip-path="url(#c)"/>'.repeat(20_000)],
    ['20,000 rects painted with a borrowed pattern of 100', `${big}${'<rect width="1" height="1" fill="url(#u)"/>'.repeat(20_000)}`],
    // pAH: a 2.2 MB path of a million vertices carrying a marker of 10,000 rects
    ['a marker of 10,000 on a million vertices', `<defs><marker id="m">${rect.repeat(10_000)}</marker></defs><path d="M0 0${'h0'.repeat(1_000_000)}" stroke="black" marker-mid="url(#m)"/>`]
  ]
  for (const [label, body] of cases) {
    const svg = svgOf(body, 'width="10" height="10"')
    underASecond(`${label}, cleaned`, () => assert.throws(() => cleanSvg(svg), { message: TOO_SLOW }))
    underASecond(`${label}, imported`, () => assert.throws(() => importSvg(svg, 'X'), { message: TOO_SLOW }))
  }
})

test('a later declaration replaces an earlier one only when it is valid', () => {
  const styled = (s: string) => svgOf(`<linearGradient id="g"/><rect width="1" height="1" style="${s}"/>`)
  const style = (s: string) => /style="([^"]*)"/.exec(cleanSvg(styled(s)).svg)?.[1] ?? null
  assert.equal(style('fill:red;fill:'), 'fill:red') // pAH: was "fill:", which draws black
  assert.equal(style('fill:red;fill: !important'), 'fill:red')
  assert.equal(style('fill:red !important;fill:'), 'fill:red !important')
  // a reference is checked once the ids are known; until then what it would replace stays in front of it
  assert.equal(style('fill:red;fill:url(#gone)'), 'fill:red')
  assert.equal(style('fill:red;fill:url(#g)'), 'fill:url(#g)')
  assert.equal(style('fill:url(#g);fill:url(#gone);fill:url(#gone2)'), 'fill:url(#g)')
  assert.equal(style('fill:red;fill:url(#g);fill:blue'), 'fill:blue', 'a valid later one still wins')
  assert.equal(style('fill:url(#g);fill:'), 'fill:url(#g)')
  assert.equal(style('fill:'), null, 'an empty declaration on its own goes too')
  const rule = svgOf('<style>rect{fill:red;fill:}</style><rect width="1" height="1"/>')
  assert.match(cleanSvg(rule).svg, /<style>rect\{fill:red\}<\/style>/)
  const ruleRef = svgOf('<style>rect{fill:red;fill:url(#gone)}</style><rect width="1" height="1"/>')
  assert.match(cleanSvg(ruleRef).svg, /<style>rect\{fill:red\}<\/style>/)
  for (const svg of [rule, ruleRef, styled('fill:red;fill:'), styled('fill:red;fill:url(#gone)')]) {
    assert.deepEqual(kids(importSvg(svg, 'F').group).at(-1)?.fill, { type: 'color', color: '#ff0000' })
    const once = cleanSvg(svg).svg
    assert.equal(cleanSvg(once).svg, once, 'cleaning twice changes nothing')
  }
})

// Fix round 5 (Ruling 14): a paint budget of its own, short reference lists, template chains once, a symbol's own
// mask and clip, long values, and each element's style read once

const R = (n: number, s: string): string => s.repeat(n)
const RECT = '<rect width="1" height="1"/>'

test('repeated painting has a budget of its own: real files with markers, clips and patterns pass, bombs do not', () => {
  // the three real-world shapes the element limit used to refuse: each element counts once, each painting apart
  const legit: [string, string, number, number][] = [
    ['26,000 paths each clipped to one page', svgOf(`<defs><clipPath id="page"><path d="M0 0h100v100H0z"/></clipPath></defs>${R(26_000, '<path clip-path="url(#page)" d="M1 1h2"/>')}`, 'width="100" height="100"'), 26_004, 26_000],
    ['10 chart series of 2,000 vertices with a 3-element marker', svgOf(`<defs><marker id="dot"><circle r="2"/><circle r="1" fill="white"/><path d="M0 0h1"/></marker></defs>${R(10, `<polyline fill="none" stroke="black" marker-mid="url(#dot)" points="${Array.from({ length: 2000 }, (_, i) => `${i} ${i % 7}`).join(' ')}"/>`)}`, 'width="2000" height="10"'), 16, 60_000],
    ['5,000 map parcels with a 10-line hatch', svgOf(`<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse">${R(10, '<path d="M0 0l8 8" stroke="#ccc"/>')}</pattern></defs>${R(5000, '<path fill="url(#hatch)" d="M0 0h5v5z"/>')}`, 'width="100" height="100"'), 5013, 50_000]
  ]
  for (const [label, svg, drawn, painted] of legit) {
    underASecond(`${label}, cleaned`, () => {
      const c = cleanSvg(svg)
      assert.deepEqual([c.drawn, c.painted], [drawn, painted], label)
    })
    underASecond(`${label}, exported`, () => assert.ok(inlineSvg(svg, BOX, 's1-').length > 1000))
  }
  assert.deepEqual(kids(importSvg(legit[1][1], 'C').group).map(l => l.type), Array(10).fill('svg'))
  // bombs: pAH (in the test before), the reviewer's nested ones (qC), and a mask or clip on a used symbol (qD)
  const markers = (n: number) => `<defs><marker id="k${n}">${R(100, RECT)}</marker>${Array.from({ length: n }, (_, i) => `<marker id="k${i}"><path d="M0 0${R(99, 'h1')}" marker-mid="url(#k${i + 1})"/></marker>`).join('')}</defs><path d="M0 0${R(99, 'h1')}" marker-mid="url(#k0)"/>`
  const symbol = (kind: string) =>
    `<defs><${kind} id="m">${R(20_000, '<rect width="200" height="200" fill="white"/>')}</${kind}><symbol id="s" ${kind === 'mask' ? 'mask' : 'clip-path'}="url(#m)">${RECT}</symbol>` +
    `<filter id="f"><feGaussianBlur stdDeviation="0"/></filter></defs><g filter="url(#f)">${R(9000, '<use href="#s"/>')}</g>`
  const bombs: [string, string][] = [
    ['a marker in a marker, 100 x 100 x 100', markers(1)],
    ['a pattern in a pattern, 100 x 100 x 100', `<defs><pattern id="P2">${R(100, RECT)}</pattern><pattern id="P1">${R(100, '<rect width="1" height="1" fill="url(#P2)"/>')}</pattern></defs>${R(100, '<rect width="1" height="1" fill="url(#P1)"/>')}`],
    ['40 levels of masks each masked by both of the next', `<defs>${Array.from({ length: 40 }, (_, i) => `<mask id="a${i}" mask="url(#a${i + 1}) , url(#b${i + 1})"><rect/></mask><mask id="b${i}" mask="url(#a${i + 1}), url(#b${i + 1})"><rect/></mask>`).join('')}<mask id="a40"/><mask id="b40"/></defs><rect mask="url(#a0)"/>`],
    ['6 nested markers of 1,000 vertices', `<defs><marker id="k6"><rect/></marker>${Array.from({ length: 6 }, (_, i) => `<marker id="k${i}"><path d="M0 0${R(999, 'h1')}" marker-mid="url(#k${i + 1})"/></marker>`).join('')}</defs><path d="M0 0${R(999, 'h1')}" marker-mid="url(#k0)"/>`],
    ['qD: a mask of 20,000 on a symbol used 9,000 times', symbol('mask')],
    ['qD: the same with a clip path', symbol('clipPath')]
  ]
  for (const [label, body] of bombs) {
    const svg = svgOf(body, 'width="200" height="200"')
    underASecond(`${label}, cleaned`, () => assert.throws(() => cleanSvg(svg), { message: TOO_SLOW }))
    underASecond(`${label}, imported`, () => assert.throws(() => importSvg(svg, 'B'), { message: TOO_SLOW }))
  }
  // a loop of masks paints each once per chain and stops where it comes back
  const loop = cleanSvg(svgOf(`<defs><mask id="M1" mask="url(#M2)">${R(10, RECT)}</mask><mask id="M2" mask="url(#M1)">${R(10, RECT)}</mask></defs>${R(1000, '<rect width="1" height="1" mask="url(#M1)"/>')}`))
  assert.deepEqual([loop.drawn, loop.painted], [1024, 1000 * 20])
})

test('a value keeps at most 4 references, so reading them costs the same for every element', () => {
  const fill = (v: string) => cleanSvg(svgOf(`<defs>${['a', 'b', 'c', 'd', 'e', 'f'].map(i => `<pattern id="${i}"/>`).join('')}</defs><rect width="1" height="1" fill="${v}"/><rect width="1" height="1" style="mask:${v.replace(/ red$/, '')}"/>`))
  const five = fill('url(#a) url(#b) url(#c) url(#d) url(#e) red')
  assert.match(five.svg, /fill="url\(#a\) url\(#b\) url\(#c\) url\(#d\) red"/)
  assert.ok(five.removed.includes('a value with more than 4 references (the rest were dropped) (2 times)'), JSON.stringify(five.removed))
  assert.match(fill('url(#a),url(#b),url(#c),url(#d),url(#e),url(#f)').svg, /fill="url\(#a\),url\(#b\),url\(#c\),url\(#d\)"/)
  // what stood on either side of a dropped reference never joins into one name
  assert.match(fill('url(#a) url(#b) url(#c) url(#d) x url(#e)y').svg, /fill="url\(#a\) url\(#b\) url\(#c\) url\(#d\) x y"/)
  for (const svg of [five.svg, fill('url(#a) url(#b) url(#c) url(#d) x url(#e)y').svg]) assert.equal(cleanSvg(svg).svg, svg)
  // qA as the reviewer wrote it (10,000 references, now past 2,000 characters too) and at a length that fits
  const pats = (n: number) => Array.from({ length: n }, (_, i) => `<pattern id="p${i}"/>`).join('')
  const refs = (n: number) => Array.from({ length: n }, (_, i) => `url(#p${i})`).join(' ')
  const size = 'width="10" height="10"'
  for (const [label, svg] of [
    ['qA: one rule naming a pattern 10,000 times, 45,000 rects', svgOf(`<defs><pattern id="p"/></defs><style>rect{fill:${R(10_000, 'url(#p) ').trim()}}</style>${R(45_000, '<rect/>')}`, size)],
    ['qA: a group naming 10,000 patterns around 25,000 rects', svgOf(`<defs>${pats(10_000)}</defs><g fill="${refs(10_000)}">${R(25_000, '<rect/>')}</g>`, size)],
    ['qA: the same, each rect inheriting', svgOf(`<defs>${pats(10_000)}</defs><g fill="${refs(10_000)}">${R(25_000, '<rect fill="inherit"/>')}</g>`, size)]
  ]) {
    underASecond(`${label}, cleaned`, () => cleanSvg(svg))
    quickEither(label, svg)
  }
  const fits = svgOf(`<defs><pattern id="p"/></defs><style>rect{fill:${R(240, 'url(#p) ').trim()}}</style>${R(45_000, '<rect/>')}`, size)
  underASecond('a rule naming a pattern 240 times, 45,000 rects, cleaned', () => assert.match(cleanSvg(fits).svg, /rect\{fill:url\(#p\) url\(#p\) url\(#p\) url\(#p\)\}/))
  underASecond('the same, exported', () => inlineSvg(fits, BOX, 's1-'))
})

test("a pattern's chain of templates is followed once, however many patterns start on it", () => {
  // qI: 12,000 patterns each borrowing the next's content, and 12,000 rects each painted with a different link
  const N = 12_000
  const pats = Array.from({ length: N }, (_, i) => `<pattern id="P${i}" href="#P${i + 1}"/>`).join('') + `<pattern id="P${N}" width="1" height="1">${RECT}</pattern>`
  const svg = svgOf(`<defs>${pats}</defs>${Array.from({ length: N }, (_, i) => `<rect width="1" height="1" fill="url(#P${i})"/>`).join('')}`, 'width="10" height="10"')
  underASecond('qI', () => assert.equal(cleanSvg(svg).painted, N))
})

test("a symbol's own mask and clip path are painted for each use of it", () => {
  for (const kind of ['mask', 'clipPath']) {
    const attr = kind === 'mask' ? 'mask' : 'clip-path'
    const c = cleanSvg(svgOf(`<defs><${kind} id="m">${R(1000, RECT)}</${kind}><symbol id="s" ${attr}="url(#m)">${RECT}</symbol></defs>${R(100, '<use href="#s"/>')}`))
    assert.equal(c.painted, 100 * 1000, kind)
  }
})

test('values past 2,000 characters are dropped, and an export never fails on a layer it cannot inline', async () => {
  const one = (attrs: string) => cleanSvg(svgOf(`<rect width="1" height="1" ${attrs}/>`))
  const dashes = (n: number) => R(Math.ceil(n / 2), '1 ').slice(0, n)
  assert.match(one(`stroke-dasharray="${dashes(2000)}"`).svg, /stroke-dasharray="/)
  const long = one(`stroke-dasharray="${dashes(2001)}" style="stroke-dashoffset:${R(2001, '1')};stroke-width:2"`)
  assert.doesNotMatch(long.svg, /stroke-dash/)
  assert.match(long.svg, /style="stroke-width:2"/)
  assert.deepEqual(long.removed, ['a style value longer than 2,000 characters (stroke-dashoffset)', 'a value longer than 2,000 characters (stroke-dasharray)'])
  assert.equal(cleanSvg(long.svg).svg, long.svg)
  // path data and points are not capped
  const d = `M0 0${R(2000, 'h1')}`
  assert.ok(cleanSvg(svgOf(`<path d="${d}"/><polyline points="${R(1000, '1 1 ')}"/>`)).svg.includes(d))
  // qG: a long dash array a rule would copy onto every rect, and one just under the cap that the style budget refuses
  const sheet = (n: number, rects: number) => svgOf(`<style>rect{stroke-dasharray:${dashes(n)}}</style>${R(rects, '<rect/>')}`, 'width="10" height="10"')
  for (const rects of [5000, 30_000]) {
    let out = ''
    quickEither(`a 20,000-character dash array over ${rects} rects`, sheet(20_000, rects))
    underASecond(`a 20,000-character dash array over ${rects} rects, exported`, () => (out = inlineSvg(sheet(20_000, rects), BOX, 's1-')))
    assert.ok(out.length < 400_000, `${out.length} characters`)
  }
  underASecond('a 2,000-character dash array over 30,000 rects', () => assert.throws(() => importSvg(sheet(2000, 30_000), 'G'), { message: TOO_COMPLEX }))
  // an export with layers that can't be inlined (too much to paint, style rules too complex) still comes out, without them
  const d2 = newDesign('instagram')
  const layer = (id: string, svg: string): Layer => ({ ...base, id, name: id, type: 'svg', x: 0, y: 0, width: 10, height: 10, svg })
  const bomb = svgOf(`<defs><pattern id="P2">${R(100, RECT)}</pattern><pattern id="P1">${R(100, '<rect width="1" height="1" fill="url(#P2)"/>')}</pattern></defs>${R(100, '<rect width="1" height="1" fill="url(#P1)"/>')}`, 'viewBox="0 0 10 10"')
  d2.artboards[0].layers.push(layer('a1', bomb), layer('a2', sheet(2000, 30_000)), layer('a3', svgOf('<rect id="ok" width="5" height="5" fill="#123456"/>', 'viewBox="0 0 10 10"')))
  const out = designToSvg(d2, d2.artboards[0].id, { fonts: await fontsOf(d2), assets: {}, mode: 'export' })
  assert.match(out, /<rect id="s3-ok" width="5" height="5" fill="#123456"\/>/)
  assert.doesNotMatch(out, /s1-|s2-/)
})

test("a shape's own style is read once, however many uses draw it", () => {
  // qE, with values under the cap: a rect whose style attribute holds 20 long declarations (about 40 KB), drawn by
  // 4,000 uses; read per use, that was 160 MB of style
  const props = [...STYLE_ONLY].filter(p => p !== 'font' && p !== 'transform').slice(0, 20)
  assert.equal(props.length, 20)
  const style = props.map(p => `${p}:${R(1990, '1')}`).join(';')
  const svg = svgOf(`<defs><rect id="r" width="1" height="1" style="${style}"/></defs>${R(4000, '<use href="#r"/>')}`, 'width="10" height="10"')
  assert.ok(cleanSvg(svg).svg.includes(`${props[19]}:${R(1990, '1')}`), 'the declarations are kept')
  underASecond('4,000 uses of a rect with 40 KB of style', () => assert.equal(kids(importSvg(svg, 'E').group).length, 4000))
  // qE as the reviewer wrote it: one 400,000-character value, now dropped
  const qE = svgOf(`<defs><rect id="r" width="1" height="1" style="line-height:${R(400_000, '1')}"/></defs>${R(4000, '<use href="#r"/>')}`, 'width="10" height="10"')
  underASecond('qE', () => assert.equal(kids(importSvg(qE, 'E').group).length, 4000))
})
