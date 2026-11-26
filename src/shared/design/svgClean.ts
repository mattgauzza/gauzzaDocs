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
const isFreeText = (name: string): boolean =>
  name === 'role' || ((name[0] === 'd' || name[0] === 'a') && (/^data-[\w.-]+$/.test(name) || /^aria-[a-z]+$/.test(name)))

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
/** A value as a browser reads a URL scheme: control characters and whitespace removed, lowercased. For naming only. */
const normUrl = (v: string): string => v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
const short = (v: string): string => {
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

const NAME_START = 'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD'
/** `#` and an XML Name: the only form a reference inside the fragment may take. */
const FRAGMENT = new RegExp(`^#[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*$`)
/** XML white space, the only thing trimmed from a reference. */
const xmlTrim = (v: string): string => v.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
/** The canonical `#id` of a fragment reference, or null when it's anything else. */
const fragment = (v: string): string | null => {
  const t = xmlTrim(v)
  return FRAGMENT.test(t) ? t : null
}
/** Characters that don't show: controls, format characters, line and paragraph separators, unpaired surrogates. */
const HIDDEN = /[\u0000-\u001f\u007f-\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff\ud800-\udfff]/
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'g')
/** A value as it reads on screen: what HIDDEN matches taken out, then trimmed. */
export const visible = (v: string): string => v.replace(HIDDEN_ALL, '').trim()
/** How a reference that isn't a plain #name is named in `removed`. */
function badReference(value: string): string {
  const t = xmlTrim(value)
  if (HIDDEN.test(t) && visible(t).startsWith('#')) return `a reference with hidden characters (${short(visible(t))})`
  if (t.startsWith('#')) return `a reference to a name SVG doesn't allow (${short(t)})`
  return `a reference outside the file (${short(t)})`
}

/** The ids a canonical value refers to through url(#id). */
export function urlRefs(v: string): string[] {
  const out: string[] = []
  for (let i = v.indexOf('url(#'); i >= 0; i = v.indexOf('url(#', i + 5)) {
    const end = v.indexOf(')', i)
    out.push(v.slice(i + 5, end < 0 ? v.length : end))
  }
  return out
}

const CSS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const ATTR_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const KEYWORD = /javascript:|vbscript:|expression\(|behavior:|-moz-binding|@import/i
/** A CSS name character: a letter, digit, _ or -, or anything past ASCII. */
const nameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c >= 128

/**
 * A value in canonical form, or why it can't stay. One pass: strings are skipped, each function name must be on the
 * allowlist, and every url() must hold exactly `#` and an XML Name, written back as `url(#name)`. A CSS value (a style
 * declaration or presentation attribute) may hold no control characters at all, raw newlines included.
 */
export function cleanValue(raw: string, css: boolean): { value: string } | { bad: string } {
  if ((css ? CSS_CONTROL : ATTR_CONTROL).test(raw)) return { bad: 'a value with control characters' }
  if (raw.includes('\\')) return { bad: 'a style value with escapes' }
  if (raw.includes('<')) return { bad: 'a style value with markup' }
  const k = KEYWORD.exec(raw)
  if (k) return { bad: `a style value using ${k[0].toLowerCase().replace(/[:(]$/, '')}` }
  if (!/[('"]/.test(raw)) return { value: raw } // no function and no string: nothing more to check
  let out = ''
  let last = 0
  let start = -1 // where the identifier before the current position began
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '"' || ch === "'") {
      // a string that never closes would swallow whatever is joined after it, so it can't stay
      const end = raw.indexOf(ch, i + 1)
      if (end < 0) return { bad: 'a style value with a string that never ends' }
      i = end
      start = -1
      continue
    }
    if (nameChar(raw.charCodeAt(i))) {
      if (start < 0) start = i
      continue
    }
    if (ch !== '(') {
      start = -1
      continue
    }
    const name = start < 0 ? '' : raw.slice(start, i).toLowerCase()
    if (name !== 'url') {
      if (!FUNCTIONS.has(name)) return { bad: `a style function that could load something (${short(name)})` }
      start = -1
      continue
    }
    let j = i + 1
    while (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r') j++
    let arg: string
    if (raw[j] === '"' || raw[j] === "'") {
      const end = raw.indexOf(raw[j], j + 1)
      if (end < 0) return { bad: `a reference outside the file (${short(raw.slice(j + 1))})` }
      arg = raw.slice(j + 1, end)
      j = end + 1
    } else {
      const from = j
      while (j < raw.length && !/[)\t\n\r '"(]/.test(raw[j])) j++ // CSS white space only, so an NBSP stays in view
      arg = raw.slice(from, j)
    }
    while (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r') j++
    const ref = fragment(arg)
    if (raw[j] !== ')' || !ref) return { bad: badReference(arg) }
    out += raw.slice(last, start) + `url(${ref})`
    last = j + 1
    i = j
    start = -1
  }
  return { value: out + raw.slice(last) }
}

/**
 * A style attribute's declarations, keeping only allowed properties with safe values (in canonical form). With `ids`,
 * a declaration that refers to an id not among them goes too.
 */
export function cleanDeclarations(text: string, note: (s: string) => void, ids?: Map<string, Element>): string {
  const keep: string[] = []
  for (const d of splitDeclarations(text)) {
    if (d.prop.startsWith('--')) {
      note(`a CSS variable (${d.prop})`)
      continue
    }
    if (d.prop.startsWith('-')) continue // vendor properties such as -inkscape-font-specification
    if (!PRESENTATION.has(d.prop) && !STYLE_ONLY.has(d.prop)) {
      note(`a style property (${short(d.prop)})`)
      continue
    }
    const v = cleanValue(d.value, true)
    if ('bad' in v) {
      note(v.bad)
      continue
    }
    const missing = ids ? urlRefs(v.value).find(id => !ids.has(id)) : undefined
    if (missing !== undefined) {
      note(`a reference to a missing id (#${short(missing)})`)
      continue
    }
    keep.push(`${d.prop}:${v.value}${d.important ? ' !important' : ''}`)
  }
  return keep.join(';')
}

const SAFE_MEDIA = /^[\w\s(),:.-]*$/
const COMPOUND = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/
/** Selectors made only of element, class and id parts, joined by descendant spaces and commas. */
export function simpleSelector(sel: string): boolean {
  return sel.split(',').every(part => {
    const t = part.trim()
    return !!t && t.split(/\s+/).every(c => !!c && COMPOUND.test(c))
  })
}

/** A style sheet with only plain rules (and @media around them) whose declarations pass cleanDeclarations. */
export function cleanStylesheet(css: string, note: (s: string) => void, ids?: Map<string, Element>, depth = 0): string {
  const out: string[] = []
  for (const b of cssBlocks(css)) {
    if (b.kind === 'at') {
      if (b.name === 'import') note(`a CSS @import (${short(b.prelude)})`)
      else if (b.name === 'font-face') note('a font loaded from CSS (@font-face)')
      else if (b.name === 'media' && b.body !== null && depth < 4 && SAFE_MEDIA.test(b.prelude)) {
        const inner = cleanStylesheet(b.body, note, ids, depth + 1)
        if (inner) out.push(`@media ${b.prelude.trim().replace(/\s+/g, ' ')}{${inner}}`)
      } else note(`a CSS @${short(b.name) || '?'} rule`)
      continue
    }
    if (!simpleSelector(b.selector)) {
      note('a CSS rule with a selector other than element, class, id or descendant')
      continue
    }
    const decls = cleanDeclarations(b.body, note, ids)
    if (decls) out.push(`${b.selector.trim().replace(/\s+/g, ' ')}{${decls}}`)
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

/** Where the DOCTYPE starting at `at` ends (just past its `>`), skipping strings, comments and PIs in its subset. */
function doctypeEnd(s: string, at: number): { end: number; subset: string } {
  let quote = ''
  let open = -1
  for (let i = at + 9; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (open >= 0 && (s.startsWith('<!--', i) || s.startsWith('<?', i))) {
      const close = s.indexOf(s[i + 1] === '!' ? '-->' : '?>', i + 2)
      if (close < 0) break
      i = close + (s[i + 1] === '!' ? 2 : 1)
    } else if (ch === '[' && open < 0) open = i
    else if (ch === ']' && open >= 0) {
      let k = i + 1
      while (k < s.length && /\s/.test(s[k])) k++
      if (s[k] === '>') return { end: k + 1, subset: s.slice(open + 1, i) }
    } else if (ch === '>' && open < 0) return { end: i + 1, subset: '' }
  }
  throw new Error('This SVG could not be read: its DOCTYPE never ends.')
}

/**
 * Removes every DOCTYPE from the prolog (the part before the root element) before parsing, so no entity it declares
 * is ever expanded. Only the prolog is read, skipping its comments and processing instructions, so DOCTYPE text in a
 * comment or in CDATA is never mistaken for one. (xmldom refuses a DOCTYPE anywhere after the root starts.)
 */
function stripDoctype(s: string, notes: Notes): string {
  let out = ''
  let i = 0
  for (;;) {
    let j = i
    while (j < s.length && /[\s\uFEFF]/.test(s[j])) j++
    if (s.startsWith('<?', j) || s.startsWith('<!--', j)) {
      const close = s.indexOf(s[j + 1] === '?' ? '?>' : '-->', j + 2)
      if (close < 0) break
      const next = close + (s[j + 1] === '?' ? 2 : 3)
      out += s.slice(i, next)
      i = next
      continue
    }
    if (s.slice(j, j + 9).toUpperCase() !== '<!DOCTYPE') break
    const { end, subset } = doctypeEnd(s, j)
    if (/<!ENTITY/i.test(subset)) notes.add('a DOCTYPE that declares entities (they were not expanded)')
    else if (subset.trim()) notes.add('a DOCTYPE with declarations of its own (they were not used)')
    out += s.slice(i, j)
    i = end
  }
  return out + s.slice(i)
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
    // no locator: line and column bookkeeping costs time on large input and nothing here reads it
    doc = new DOMParser({ onError: () => undefined, locator: false }).parseFromString(src, 'image/svg+xml') as unknown as Document
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

function hrefAttrs(el: Element): Attr[] {
  const out: Attr[] = []
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]
    if (a.localName === 'href' && (a.namespaceURI === XLINK_NS || !a.namespaceURI)) out.push(a)
  }
  return out
}
const hrefAttr = (el: Element): Attr | null => hrefAttrs(el)[0] ?? null
/** The id a (cleaned, so canonical) href points at, without the #, or null when it isn't a fragment. */
export function hrefId(el: Element): string | null {
  const v = fragment(hrefAttr(el)?.value ?? '')
  return v ? v.slice(1) : null
}

function cleanAttributes(el: Element, notes: Notes): void {
  const tag = el.localName
  const attrs = el.attributes
  // backwards, so removing the current attribute never skips one
  for (let i = attrs.length - 1; i >= 0; i--) {
    const a = attrs[i]
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
      // only two forms stay, stored canonical: exactly "#name" (not on <image>), or an embedded picture on <image>
      const v = normUrl(a.value)
      const ref = fragment(a.value)
      const compact = a.value.replace(/[\s\u0000-\u001f]/g, '')
      if (ref && tag !== 'image') a.value = ref
      else if (ref) drop(`an image that is not an embedded picture (${short(ref)})`)
      else if (v.startsWith('#') || visible(a.value).startsWith('#')) drop(badReference(a.value))
      else if (tag === 'image' && IMAGE_TYPES.test(compact.toLowerCase())) {
        const bad = badImage(compact)
        if (bad) drop(bad)
        else a.value = compact
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
    const v = cleanValue(a.value, PRESENTATION.has(local))
    if ('bad' in v) drop(v.bad)
    else a.value = v.value
  }
  // One reference per element. A browser follows href over xlink:href while a checker might read either, so two
  // stay only as one xlink:href, and only when they say the same thing.
  const hrefs = hrefAttrs(el)
  if (hrefs.length > 1) {
    const values = new Set(hrefs.map(a => a.value))
    for (const a of hrefs) el.removeAttributeNode(a)
    if (values.size === 1) el.setAttributeNS(XLINK_NS, 'xlink:href', hrefs[0].value)
    else notes.add(`two different references on one element (${[...values].map(short).join(', ')})`)
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
      case 3: // white space between elements draws nothing outside text, so it goes
      case 4: // CDATA becomes plain text
        if (!TEXT_HOLDERS.has(parent.localName) && !/\S/.test((n as CharacterData).data)) parent.removeChild(n)
        else if (n.nodeType === 4) parent.replaceChild(parent.ownerDocument.createTextNode((n as CharacterData).data), n)
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

const TEXT_HOLDERS = new Set(['text', 'tspan', 'textPath', 'title', 'desc', 'style'])

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

/** id -> element, first one wins, over the tree under `root` (or a list of elements already gathered). */
export function idMap(root: Element | Element[]): Map<string, Element> {
  const ids = new Map<string, Element>()
  for (const el of Array.isArray(root) ? root : allElements(root)) {
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

/** For each element, how many elements it draws with every <use> in it expanded (a loop counts as Infinity). */
export function expandedSizes(root: Element, ids: Map<string, Element>): Map<Element, number> {
  const all = allElements(root)
  if (all.some(el => el.localName === 'use')) {
    const target = (el: Element): Element | null => (el.localName === 'use' ? (ids.get(hrefId(el) ?? '') ?? null) : null)
    return overGraph(all, target, (_el, kids, via) => 1 + kids.reduce((a, v) => a + v, 0) + (via ?? 0))
  }
  // no <use>: each size is just the element count of the subtree, added up children first
  const size = new Map<Element, number>()
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]
    size.set(el, (size.get(el) ?? 0) + 1)
    const p = el.parentNode as Element | null
    if (p && p.nodeType === 1) size.set(p, (size.get(p) ?? 0) + size.get(el)!)
  }
  return size
}

/** Drops the hrefs (outside <use>) that point at an id not in `ids`. */
function dropMissingHrefs(all: Element[], ids: Map<string, Element>, notes: Notes): void {
  for (const el of all) {
    if (el.localName === 'use' || el.localName === 'image') continue // uses are handled apart; images hold data only
    const attrs = el.attributes
    for (let i = attrs.length - 1; i >= 0; i--) {
      const a = attrs[i]
      if (a.localName !== 'href' || (a.namespaceURI && a.namespaceURI !== XLINK_NS)) continue
      const id = fragment(a.value)?.slice(1)
      if (id !== undefined && ids.has(id)) continue
      notes.add(`a reference to a missing id (#${short(id ?? a.value)})`)
      el.removeAttributeNode(a)
    }
  }
}

/** Drops <use> elements whose target is missing or is itself such a use; each chain is walked once. */
function dropDeadUses(uses: Element[], ids: Map<string, Element>, notes: Notes): boolean {
  const dead = new Map<Element, boolean>()
  for (const u of uses) {
    if (dead.has(u)) continue
    const path: Element[] = []
    const seen = new Set<Element>()
    let verdict = false
    for (let cur: Element = u; ; ) {
      if (dead.has(cur)) {
        verdict = dead.get(cur)!
        break
      }
      if (seen.has(cur)) break // a loop, which the depth check drops
      path.push(cur)
      seen.add(cur)
      const t = ids.get(hrefId(cur) ?? '')
      if (!t || t.localName !== 'use') {
        verdict = !t
        break
      }
      cur = t
    }
    for (const p of path) dead.set(p, verdict)
  }
  let any = false
  for (const [u, isDead] of dead) {
    if (!isDead) continue
    notes.add(`a reference to a missing id (#${short(hrefId(u) ?? '?')})`)
    u.parentNode?.removeChild(u)
    any = true
  }
  return any
}

/**
 * Every reference must name an id that exists in the fragment. Drops <use> elements whose target is missing (or is
 * such a use), then those whose chain of references is deeper than 8 (or loops), then any other href or url(#id) left
 * pointing nowhere; refuses the SVG when expanding every <use> would make more than 50,000 elements.
 */
function checkReferences(root: Element, notes: Notes): void {
  let all = allElements(root)
  let ids = idMap(all)
  const uses = all.filter(el => el.localName === 'use')
  if (uses.length) {
    if (dropDeadUses(uses, ids, notes)) {
      all = allElements(root)
      ids = idMap(all)
    }
    const target = (el: Element): Element | null => (el.localName === 'use' ? (ids.get(hrefId(el) ?? '') ?? null) : null)
    // the longest chain of uses starting anywhere inside each element
    const chain = overGraph(all, target, (_el, kids, via) => kids.reduce((a, v) => Math.max(a, v), via === null ? 0 : 1 + via))
    let pruned = false
    for (const el of all) {
      const t = target(el)
      if (!t) continue
      const depth = 1 + (chain.get(t) ?? Infinity)
      if (depth > MAX_USE_DEPTH) {
        notes.add(depth === Infinity ? 'a use that refers back to itself' : `a use nested deeper than ${MAX_USE_DEPTH} levels`)
        el.parentNode?.removeChild(el)
        pruned = true
      }
    }
    if (pruned) {
      all = allElements(root)
      ids = idMap(all)
    }
    const size = overGraph(all, target, (_el, kids, via) => 1 + kids.reduce((a, v) => a + v, 0) + (via ?? 0))
    if ((size.get(root) ?? Infinity) > MAX_SVG_ELEMENTS) throw new Error(TOO_MANY)
  }
  dropMissingHrefs(all, ids, notes)
  // url(#id) must name an id that is still here
  for (const el of all) {
    if (el.localName === 'style' && el.parentNode && (el.textContent ?? '').includes('url(#')) {
      const css = cleanStylesheet(el.textContent ?? '', s => notes.add(s), ids)
      while (el.firstChild) el.removeChild(el.firstChild)
      if (css) el.appendChild(el.ownerDocument.createTextNode(css))
      else el.parentNode.removeChild(el)
    }
    const attrs = el.attributes
    for (let i = attrs.length - 1; i >= 0; i--) {
      const a = attrs[i]
      if (a.namespaceURI || !a.value.includes('url(#')) continue
      if ((a.localName ?? a.name) === 'style') {
        const clean = cleanDeclarations(a.value, s => notes.add(s), ids)
        if (clean) a.value = clean
        else el.removeAttributeNode(a)
        continue
      }
      const gone = urlRefs(a.value).find(id => !ids.has(id))
      if (gone === undefined) continue
      notes.add(`a reference to a missing id (#${short(gone)})`)
      el.removeAttributeNode(a)
    }
  }
}

// The same escapes as the renderer's esc, so cleaning the renderer's output leaves it byte for byte the same. Tab, LF
// and CR become character references in attributes (where a parser would turn them into spaces) and tab and CR in
// text (CR would become LF), so every value reads back exactly as it was.
// NEL and LINE SEPARATOR are written as references too: xmldom reads them raw as line ends.
const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
  '\u0085': '&#133;', '\u2028': '&#8232;'
}
const escAttr = (s: string): string => cleanText(s).replace(/[&<>"'\t\n\r\u0085\u2028]/g, c => ESC[c])
const escText = (s: string): string => cleanText(s).replace(/[&<>"'\t\r\u0085\u2028]/g, c => ESC[c])
const PREFIX: Record<string, string> = { [XLINK_NS]: 'xlink:', [INKSCAPE_NS]: 'inkscape:', [XML_NS]: 'xml:' }

/** Clean SVG markup for an element. The root form declares the svg, xlink and inkscape namespaces. */
export function serializeSvg(el: Element, root = true): string {
  const out: string[] = []
  write(el, root, out)
  return out.join('')
}
function write(el: Element, root: boolean, out: string[]): void {
  out.push('<', el.localName)
  if (root) out.push(` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}"`)
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]
    const ns = a.namespaceURI
    const prefix = ns ? PREFIX[ns] : ''
    if (prefix === undefined || (root && (a.name === 'xmlns' || a.name.startsWith('xmlns:')))) continue
    out.push(' ', prefix, a.localName ?? a.name, '="', escAttr(a.value), '"')
  }
  if (!el.firstChild) {
    out.push('/>')
    return
  }
  const at = out.length
  out.push('>')
  for (let n: ChildNode | null = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) write(n as Element, false, out)
    else if (n.nodeType === 3 || n.nodeType === 4) {
      const text = escText((n as CharacterData).data)
      if (text) out.push(text)
    }
  }
  if (out.length === at + 1) out[at] = '/>' // nothing written inside
  else out.push('</', el.localName, '>')
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
