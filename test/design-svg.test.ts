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
  assert.equal(count(svg), count(out), 'every element stays')
  for (const want of [
    'inkscape:label="Card"', 'data-name="Card"', 'inkscape:groupmode="layer"', 'style="mix-blend-mode:multiply"',
    `xlink:href="data:image/png;base64,${PNG64}"`, 'filterUnits="userSpaceOnUse"', '<feGaussianBlur', 'filter="url(#f-card-1)"',
    'fill="url(#g-card-1)"', 'xml:space="preserve"', 'data-name="Title &amp; &quot;quotes&quot;"', 'Hello &lt;world&gt;'
  ]) assert.ok(svg.includes(want), `lost ${want}`)
  assert.equal(cleanSvg(svg).svg, svg, 'cleaning twice changes nothing')
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
