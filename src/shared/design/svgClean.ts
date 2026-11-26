import { DOMParser } from '@xmldom/xmldom'
import { cssBlocks, splitDeclarations } from './svgStyle'
import { cleanText } from './text'

// The security boundary for SVG from outside. An allowlist: only known SVG elements and attributes survive, every
// reference must stay inside the fragment (or be an embedded PNG, JPEG, GIF or WebP on <image>), and each drop is named
// in plain words. Nothing that can run code, load from outside or read local files gets through, so the result can be
// stored, inlined into the editor, exported and shared.

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'
export const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
/** Editor metadata, dropped without a note. */
const QUIET_NS = new Set([
  INKSCAPE_NS,
  'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://creativecommons.org/ns#',
  'http://web.resource.org/cc/',
  'http://purl.org/dc/elements/1.1/'
])

export const MAX_SVG_BYTES = 5 * 1024 * 1024
export const MAX_SVG_ELEMENTS = 50_000
export const MAX_USE_DEPTH = 8
/** Deeper nesting than any real drawing; it keeps every walk well inside the call stack. */
export const MAX_NESTING = 256
export const MAX_IMAGE_PIXELS = 50_000_000

const TOO_LARGE = 'This SVG is too large (over 5 MB).'
const TOO_MANY = 'This SVG has too many elements (over 50,000).'

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'textPath', 'image', 'use', 'symbol', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
  'pattern', 'filter', 'style', 'marker', 'switch'
])
const FILTER_PRIMITIVES = new Set([
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence'
])
/** How a dropped element is named, when it's more than "a <name> element". */
const ELEMENT_NOTES: Record<string, string> = {
  script: 'a script',
  foreignObject: 'a foreignObject (HTML inside the SVG)',
  iframe: 'an iframe',
  object: 'an embedded object',
  embed: 'an embed',
  animate: 'an animation (animate)',
  animateColor: 'an animation (animateColor)',
  animateMotion: 'an animation (animateMotion)',
  animateTransform: 'an animation (animateTransform)',
  set: 'an animation (set)',
  discard: 'an animation (discard)',
  feImage: 'an feImage filter (it can load images)',
  link: 'a link to a style sheet',
  handler: 'a script handler',
  listener: 'an event listener'
}

/** Presentation attributes, which are also the CSS properties a style may set. Their values are checked for url(). */
export const PRESENTATION = new Set([
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering', 'direction', 'display', 'dominant-baseline', 'enable-background',
  'fill', 'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font-family', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'glyph-orientation-horizontal',
  'glyph-orientation-vertical', 'image-rendering', 'kerning', 'letter-spacing', 'lighting-color', 'marker',
  'marker-end', 'marker-mid', 'marker-start', 'mask', 'mask-type', 'opacity', 'overflow', 'paint-order',
  'pointer-events', 'shape-rendering', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'text-anchor',
  'text-decoration', 'text-rendering', 'transform-origin', 'unicode-bidi', 'vector-effect', 'visibility',
  'white-space', 'word-spacing', 'writing-mode'
])
/** CSS properties a style may set that have no presentation attribute. */
export const STYLE_ONLY = new Set([
  'mix-blend-mode', 'isolation', 'font', 'transform', 'transform-box', 'line-height', 'text-align', 'text-indent',
  'text-transform', 'text-orientation', 'font-variant-ligatures', 'font-variant-caps', 'font-variant-numeric',
  'font-variant-east-asian', 'font-feature-settings', 'font-kerning', 'font-variation-settings', 'inline-size',
  'shape-inside', 'shape-padding', 'solid-color', 'solid-opacity'
])
const ATTRIBUTES = new Set([
  'id', 'class', 'style', 'lang', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'fx', 'fy', 'fr', 'x1',
  'y1', 'x2', 'y2', 'd', 'points', 'pathLength', 'transform', 'viewBox', 'preserveAspectRatio', 'version',
  'baseProfile', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'side',
  'path', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerWidth', 'markerHeight',
  'markerUnits', 'refX', 'refY', 'orient', 'filterUnits', 'primitiveUnits', 'filterRes', 'in', 'in2', 'result',
  'stdDeviation', 'mode', 'type', 'values', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'operator',
  'k1', 'k2', 'k3', 'k4', 'order', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode',
  'kernelUnitLength', 'preserveAlpha', 'surfaceScale', 'diffuseConstant', 'specularConstant', 'specularExponent',
  'scale', 'xChannelSelector', 'yChannelSelector', 'radius', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles',
  'azimuth', 'elevation', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'limitingConeAngle', 'media',
  'systemLanguage', 'requiredFeatures', 'role'
])
/** Free text that is never read as a URL or style. */
const isFreeText = (name: string): boolean => /^data-[\w.-]+$/.test(name) || /^aria-[a-z]+$/.test(name) || name === 'role'

/** CSS functions a value may use. url() is checked separately and may only point at #id. */
const FUNCTIONS = new Set([
  '', 'url', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'calc', 'min',
  'max', 'clamp', 'matrix', 'matrix3d', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale',
  'scalex', 'scaley', 'scalez', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx',
  'skewy', 'perspective', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert',
  'opacity', 'saturate', 'sepia', 'inset', 'circle', 'ellipse', 'polygon', 'cubic-bezier', 'steps'
])
const IMAGE_TYPES = /^data:image\/(png|jpe?g|gif|webp)[;,]/

/** Removed things, in order, each once with a count. */
class Notes {
  private seen = new Map<string, number>()
  add(s: string): void {
    this.seen.set(s, (this.seen.get(s) ?? 0) + 1)
  }
  list(): string[] {
    return [...this.seen].map(([s, n]) => (n > 1 ? `${s} (${n} times)` : s))
  }
}

const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w
/** A value as a browser reads a URL scheme: control characters and whitespace removed, lowercased. */
export const normUrl = (v: string): string => v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
const short = (v: string): string => {
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

/** Why a style or attribute value isn't allowed, or null when it's fine. */
function badValue(raw: string): string | null {
  const v = normUrl(raw)
  if (v.includes('\\')) return 'a style value with escapes'
  if (v.includes('<')) return 'a style value with markup'
  for (const k of ['javascript:', 'vbscript:', 'expression(', 'behavior:', '-moz-binding', '@import']) {
    if (v.includes(k)) return `a style value using ${k.replace(/[:(]$/, '')}`
  }
  // each "(" and the name right before it; found by scanning back, so long values stay linear
  for (let i = v.indexOf('('); i >= 0; i = v.indexOf('(', i + 1)) {
    let j = i
    while (j > 0 && /[a-z0-9-]/.test(v[j - 1])) j--
    const name = v.slice(j, i)
    if (name === 'url') {
      const close = v.indexOf(')', i)
      const arg = v.slice(i + 1, close < 0 ? v.length : close).replace(/^['"]|['"]$/g, '')
      if (!arg.startsWith('#')) return `a reference outside the file (${short(arg)})`
    } else if (!FUNCTIONS.has(name)) return `a style function that could load something (${short(name)})`
  }
  return null
}

/** A style attribute's declarations, keeping only allowed properties with safe values. */
export function cleanDeclarations(text: string, note: (s: string) => void): string {
  const keep: string[] = []
  for (const d of splitDeclarations(text)) {
    if (d.prop.startsWith('--')) {
      note(`a CSS variable (${d.prop})`)
      continue
    }
    if (d.prop.startsWith('-')) continue // vendor properties such as -inkscape-font-specification
    if (!PRESENTATION.has(d.prop) && !STYLE_ONLY.has(d.prop)) {
      note(`a style property (${d.prop})`)
      continue
    }
    const bad = badValue(d.value)
    if (bad) {
      note(bad)
      continue
    }
    keep.push(`${d.prop}:${d.value}${d.important ? ' !important' : ''}`)
  }
  return keep.join(';')
}

const SAFE_SELECTOR = /^[\w\s.#*,>+~:()[\]="'|^$-]+$/
const SAFE_MEDIA = /^[\w\s(),:.-]*$/

/** A style sheet with only plain rules (and @media around them) whose declarations pass cleanDeclarations. */
export function cleanStylesheet(css: string, note: (s: string) => void, depth = 0): string {
  const out: string[] = []
  for (const b of cssBlocks(css)) {
    if (b.kind === 'at') {
      if (b.name === 'import') note(`a CSS @import (${short(b.prelude)})`)
      else if (b.name === 'font-face') note('a font loaded from CSS (@font-face)')
      else if (b.name === 'media' && b.body !== null && depth < 4 && SAFE_MEDIA.test(b.prelude)) {
        const inner = cleanStylesheet(b.body, note, depth + 1)
        if (inner) out.push(`@media ${b.prelude.trim()}{${inner}}`)
      } else note(`a CSS @${b.name || '?'} rule`)
      continue
    }
    if (!SAFE_SELECTOR.test(b.selector)) {
      note('a CSS rule with an unusual selector')
      continue
    }
    const decls = cleanDeclarations(b.body, note)
    if (decls) out.push(`${b.selector.replace(/\s+/g, ' ')}{${decls}}`)
  }
  return out.join('')
}

/** The bytes of a data: URI (base64 or percent-encoded), or null. */
export function dataUriBytes(uri: string): { mime: string; bytes: Uint8Array } | null {
  const s = uri.replace(/[\s\u0000-\u001f]/g, '')
  const comma = s.indexOf(',')
  if (!/^data:/i.test(s) || comma < 0) return null
  const meta = s.slice(5, comma).toLowerCase().split(';')
  const body = s.slice(comma + 1)
  try {
    if (meta.includes('base64')) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null
      const B = (globalThis as any).Buffer
      const bytes = B ? new Uint8Array(B.from(body, 'base64')) : Uint8Array.from(atob(body), c => c.charCodeAt(0))
      return { mime: meta[0], bytes }
    }
    const out: number[] = []
    for (let i = 0; i < body.length; i++) {
      const hex = body[i] === '%' ? /^[0-9a-f]{2}$/i.exec(body.slice(i + 1, i + 3)) : null
      if (hex) {
        out.push(parseInt(hex[0], 16))
        i += 2
      } else out.push(body.charCodeAt(i) & 0xff)
    }
    return { mime: meta[0], bytes: Uint8Array.from(out) }
  } catch {
    return null
  }
}

/** An image's type and size from its header, or null when it isn't a PNG, JPEG, GIF or WebP. */
export function imageInfo(b: Uint8Array): { type: 'png' | 'jpg' | 'gif' | 'webp'; width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1]
  const u16le = (i: number) => b[i] | (b[i + 1] << 8)
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return { type: 'png', width: u32(16), height: u32(20) }
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { type: 'gif', width: u16le(6), height: u16le(8) }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4)
    if (kind === 'VP8 ') return { type: 'webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (kind === 'VP8L') {
      return { type: 'webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) }
    }
    if (kind === 'VP8X') return { type: 'webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) {
        i++
        continue
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpg', width: u16(i + 7), height: u16(i + 5) }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) i += 2
      else i += 2 + u16(i + 2)
    }
  }
  return null
}

/** Why an embedded image can't stay, or null when it's a readable PNG, JPEG, GIF or WebP of at most 50 megapixels. */
function badImage(uri: string): string | null {
  const data = dataUriBytes(uri)
  const info = data && imageInfo(data.bytes)
  if (!info) return 'an image that is not a readable PNG, JPEG, GIF or WebP'
  if (info.width * info.height > MAX_IMAGE_PIXELS) return `an image over 50 megapixels (${info.width}x${info.height})`
  return null
}

/** Removes the DOCTYPE before parsing, so no entity it declares is ever expanded. */
function stripDoctype(s: string, notes: Notes): string {
  const at = s.search(/<!DOCTYPE/i)
  if (at < 0) return s
  let quote = ''
  let subset = false
  for (let i = at + 9; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (subset && s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end < 0) break
      i = end + 2
    } else if (ch === '[') subset = true
    else if (ch === ']') subset = false
    else if (ch === '>' && !subset) {
      if (/<!ENTITY/i.test(s.slice(at, i))) notes.add('a DOCTYPE that declares entities (they were not expanded)')
      return s.slice(0, at) + s.slice(i + 1)
    }
  }
  throw new Error('This SVG could not be read: its DOCTYPE never ends.')
}

/** Declares the xlink, inkscape and sodipodi prefixes on the root when they're used but not declared. */
function declarePrefixes(s: string): string {
  const add = [
    ['xlink', XLINK_NS],
    ['inkscape', INKSCAPE_NS],
    ['sodipodi', 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd']
  ]
    .filter(([p]) => new RegExp(`\\b${p}:`).test(s) && !new RegExp(`xmlns:${p}\\s*=`).test(s))
    .map(([p, ns]) => ` xmlns:${p}="${ns}"`)
    .join('')
  if (!add) return s
  const m = /<svg(?=[\s>/])/.exec(s)
  return m ? s.slice(0, m.index + 4) + add + s.slice(m.index + 4) : s
}

function utf8Length(s: string): number {
  if (s.length > MAX_SVG_BYTES) return s.length
  if (s.length * 3 <= MAX_SVG_BYTES) return s.length
  return new TextEncoder().encode(s).length
}

/** Parses SVG text. Fatal parse errors become "This SVG could not be read: ...". */
export function parseSvgText(src: string): Element {
  let doc: Document
  try {
    doc = new DOMParser({ onError: () => undefined }).parseFromString(src, 'image/svg+xml') as unknown as Document
  } catch (e) {
    throw new Error(`This SVG could not be read: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
  }
  const root = doc?.documentElement
  if (!root) throw new Error('This SVG could not be read: it has no root element.')
  return root
}

export const elementChildren = (el: Element): Element[] => {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element)
  return out
}

/** Counts elements and nesting without recursion, throwing over the limits. */
function checkSize(root: Element): void {
  let count = 0
  const stack: [Element, number][] = [[root, 1]]
  while (stack.length) {
    const [el, depth] = stack.pop()!
    if (++count > MAX_SVG_ELEMENTS) throw new Error(TOO_MANY)
    if (depth > MAX_NESTING) throw new Error(`This SVG is nested too deeply (over ${MAX_NESTING} levels).`)
    for (const c of elementChildren(el)) stack.push([c, depth + 1])
  }
}

const hrefAttrs = (el: Element): Attr[] =>
  Array.from(el.attributes).filter(a => a.localName === 'href' && (a.namespaceURI === XLINK_NS || !a.namespaceURI))
const hrefAttr = (el: Element): Attr | null => hrefAttrs(el)[0] ?? null
/** The id an href points at (without the #), or null when it isn't a fragment. */
export function hrefId(el: Element): string | null {
  const v = hrefAttr(el)?.value.trim() ?? ''
  return v.startsWith('#') ? v.slice(1) : null
}

function cleanAttributes(el: Element, notes: Notes): void {
  const tag = el.localName
  for (const a of Array.from(el.attributes)) {
    const ns = a.namespaceURI
    const local = a.localName ?? a.name
    const drop = (note?: string) => {
      el.removeAttributeNode(a)
      if (note) notes.add(note)
    }
    if (ns === XMLNS_NS || a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
      drop() // the serializer declares the namespaces it uses
      continue
    }
    if (!ns && /^on/i.test(local)) {
      drop(`${article(local)} attribute`)
      continue
    }
    if (local === 'href' && (ns === XLINK_NS || !ns)) {
      const v = normUrl(a.value)
      if (v.startsWith('#')) a.value = a.value.trim()
      else if (tag === 'image' && IMAGE_TYPES.test(v)) {
        const bad = badImage(a.value)
        if (bad) drop(bad)
        else a.value = a.value.replace(/[\s\u0000-\u001f]/g, '')
      } else if (tag === 'image' && v.startsWith('data:image/svg')) drop('a nested SVG image')
      else if (tag === 'image' && v.startsWith('data:')) drop(`an image of a type that isn't allowed (${short(a.value.split(',')[0])})`)
      else if (tag === 'image') drop(`an external image (${short(a.value)})`)
      else drop(`a reference outside the file (${short(a.value)})`)
      continue
    }
    if (ns === XML_NS) {
      if (local !== 'space' && local !== 'lang') drop(`an xml:${local} attribute`)
      continue
    }
    if (ns === INKSCAPE_NS && (local === 'label' || local === 'groupmode')) continue
    if (ns && QUIET_NS.has(ns)) {
      drop()
      continue
    }
    if (ns) {
      drop(`${article(a.name)} attribute`)
      continue
    }
    if (isFreeText(local)) continue
    if (local === 'style') {
      const clean = cleanDeclarations(a.value, s => notes.add(s))
      if (clean) a.value = clean
      else drop()
      continue
    }
    if (!ATTRIBUTES.has(local) && !PRESENTATION.has(local)) {
      drop(`${article(local)} attribute`)
      continue
    }
    const bad = badValue(a.value)
    if (bad) drop(bad)
  }
}

function cleanElement(el: Element, notes: Notes): void {
  cleanAttributes(el, notes)
  if (el.localName === 'style') {
    const css = cleanStylesheet(el.textContent ?? '', s => notes.add(s))
    while (el.firstChild) el.removeChild(el.firstChild)
    if (css) el.appendChild(el.ownerDocument.createTextNode(css))
    else el.parentNode?.removeChild(el)
    for (const a of Array.from(el.attributes)) if (a.name !== 'type' && a.name !== 'media') el.removeAttributeNode(a)
    return
  }
  if ((el.localName === 'image' || el.localName === 'use') && !hrefAttr(el)) {
    el.parentNode?.removeChild(el)
    return
  }
  cleanChildren(el, notes)
}

function cleanChildren(parent: Element, notes: Notes): void {
  for (let n = parent.firstChild; n; ) {
    const next = n.nextSibling
    switch (n.nodeType) {
      case 1: {
        const el = n as Element
        const ns = el.namespaceURI
        const tag = el.localName
        if (ns !== SVG_NS) {
          parent.removeChild(el)
          if (!(ns && QUIET_NS.has(ns))) notes.add(ELEMENT_NOTES[tag] ?? `an element from another format (${el.nodeName})`)
        } else if (tag === 'a') {
          const href = hrefAttr(el)?.value
          notes.add(href ? `a link to ${short(href)} (what it held was kept)` : 'a link (what it held was kept)')
          const first = el.firstChild
          while (el.firstChild) parent.insertBefore(el.firstChild, el)
          parent.removeChild(el)
          if (first) {
            n = first // clean the moved children where they now are
            continue
          }
        } else if (tag === 'metadata') parent.removeChild(el)
        else if (!ELEMENTS.has(tag) && !FILTER_PRIMITIVES.has(tag)) {
          parent.removeChild(el)
          notes.add(ELEMENT_NOTES[tag] ?? `${article(tag)} element`)
        } else cleanElement(el, notes)
        break
      }
      case 3:
        break
      case 4: // CDATA becomes plain text
        parent.replaceChild(parent.ownerDocument.createTextNode((n as CharacterData).data), n)
        break
      case 7:
        if ((n as ProcessingInstruction).target === 'xml-stylesheet') notes.add('a linked style sheet')
        parent.removeChild(n)
        break
      default: // comments, entity references and anything else
        parent.removeChild(n)
    }
    n = next
  }
}

/** Every element below and including root, in document order. */
export function allElements(root: Element): Element[] {
  const out: Element[] = []
  const stack = [root]
  while (stack.length) {
    const el = stack.pop()!
    out.push(el)
    const kids = elementChildren(el)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out
}

/** id -> element, first one wins. */
export function idMap(root: Element): Map<string, Element> {
  const ids = new Map<string, Element>()
  for (const el of allElements(root)) {
    const id = el.getAttribute('id')
    if (id && !ids.has(id)) ids.set(id, el)
  }
  return ids
}

/**
 * A value for every element over the graph of children and <use> targets, without recursion. `combine` gets the
 * values of the element's children, then (for a use) its target; a reference back into the walk (a cycle) is Infinity.
 */
function overGraph(
  elements: Element[], target: (el: Element) => Element | null, combine: (el: Element, kids: number[], via: number | null) => number
): Map<Element, number> {
  const value = new Map<Element, number>()
  const active = new Set<Element>()
  for (const start of elements) {
    if (value.has(start)) continue
    const stack: { el: Element; next: Element[]; i: number }[] = []
    const enter = (el: Element) => {
      active.add(el)
      const t = target(el)
      stack.push({ el, next: t ? [...elementChildren(el), t] : elementChildren(el), i: 0 })
    }
    enter(start)
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.i < top.next.length) {
        const n = top.next[top.i++]
        if (!value.has(n) && !active.has(n)) enter(n)
        continue
      }
      const t = target(top.el)
      const kids = elementChildren(top.el).map(c => value.get(c) ?? Infinity)
      const via = t ? (value.get(t) ?? Infinity) : null
      value.set(top.el, combine(top.el, kids, via))
      active.delete(top.el)
      stack.pop()
    }
  }
  return value
}

/**
 * Drops references to ids that don't exist, then <use> elements whose chain of references is deeper than 8 (or loops),
 * and refuses the SVG when expanding every <use> would make more than 50,000 elements.
 */
function checkReferences(root: Element, notes: Notes): void {
  let ids = idMap(root)
  for (const el of allElements(root)) {
    for (const a of hrefAttrs(el)) {
      const v = a.value.trim()
      if (!v.startsWith('#') || ids.has(v.slice(1))) continue
      notes.add(`a reference to a missing id (${short(v)})`)
      el.removeAttributeNode(a)
    }
    if ((el.localName === 'use' || el.localName === 'image') && !hrefAttr(el)) el.parentNode?.removeChild(el)
  }
  ids = idMap(root)
  const all = allElements(root)
  const target = (el: Element): Element | null => (el.localName === 'use' ? (ids.get(hrefId(el) ?? '') ?? null) : null)
  // the longest chain of uses starting anywhere inside each element
  const chain = overGraph(all, target, (_el, kids, via) => kids.reduce((a, v) => Math.max(a, v), via === null ? 0 : 1 + via))
  for (const el of all) {
    const t = target(el)
    if (!t) continue
    const depth = 1 + (chain.get(t) ?? Infinity)
    if (depth > MAX_USE_DEPTH) {
      notes.add(depth === Infinity ? 'a use that refers back to itself' : `a use nested deeper than ${MAX_USE_DEPTH} levels`)
      el.parentNode?.removeChild(el)
    }
  }
  ids = idMap(root)
  const left = allElements(root)
  const size = overGraph(left, target, (_el, kids, via) => 1 + kids.reduce((a, v) => a + v, 0) + (via ?? 0))
  if ((size.get(root) ?? Infinity) > MAX_SVG_ELEMENTS) throw new Error(TOO_MANY)
}

// the same escapes as the renderer's esc, so cleaning the renderer's output leaves it byte for byte the same
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const escXml = (s: string): string => cleanText(s).replace(/[&<>"']/g, c => ESC[c])
const PREFIX: Record<string, string> = { [XLINK_NS]: 'xlink:', [INKSCAPE_NS]: 'inkscape:', [XML_NS]: 'xml:' }

/** Clean SVG markup for an element. The root form declares the svg, xlink and inkscape namespaces. */
export function serializeSvg(el: Element, root = true): string {
  let attrs = root ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}"` : ''
  for (const a of Array.from(el.attributes)) {
    const ns = a.namespaceURI
    const prefix = ns ? PREFIX[ns] : ''
    if (prefix === undefined || (root && (a.name === 'xmlns' || a.name.startsWith('xmlns:')))) continue
    attrs += ` ${prefix}${a.localName ?? a.name}="${escXml(a.value)}"`
  }
  let body = ''
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) body += serializeSvg(n as Element, false)
    else if (n.nodeType === 3 || n.nodeType === 4) body += escXml((n as CharacterData).data)
  }
  return body ? `<${el.localName}${attrs}>${body}</${el.localName}>` : `<${el.localName}${attrs}/>`
}

/** Cleans SVG text into its root element (see cleanSvg). */
export function cleanSvgRoot(svg: string): { root: Element; removed: string[] } {
  if (typeof svg !== 'string') throw new Error('An SVG must be text.')
  if (utf8Length(svg) > MAX_SVG_BYTES) throw new Error(TOO_LARGE)
  const notes = new Notes()
  const root = parseSvgText(declarePrefixes(stripDoctype(svg, notes)))
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new Error(`This is not an SVG: its root element is <${root.nodeName}>.`)
  }
  checkSize(root)
  // only the root is written back, so anything before it goes; a linked style sheet there is worth naming
  for (let n = root.ownerDocument?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 7 && (n as ProcessingInstruction).target === 'xml-stylesheet') notes.add('a linked style sheet')
  }
  cleanAttributes(root, notes)
  cleanChildren(root, notes)
  checkReferences(root, notes)
  return { root, removed: notes.list() }
}

/**
 * SVG from outside, made safe to store, show and share: only allowlisted elements and attributes, references only to
 * the fragment's own ids or embedded images, and `removed` naming each thing that went. Throws over 5 MB or 50,000
 * elements.
 */
export function cleanSvg(svg: string): { svg: string; removed: string[] } {
  const { root, removed } = cleanSvgRoot(svg)
  return { svg: serializeSvg(root), removed }
}
