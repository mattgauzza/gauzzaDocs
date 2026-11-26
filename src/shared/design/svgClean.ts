import { DOMParser } from '@xmldom/xmldom'
import { numbers, pathVertices } from './path'
import { type Decl, cssBlocks, splitDeclarations } from './svgStyle'
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

/**
 * Steps one style sheet may take to apply its rules (each candidate rule costing 1 plus its declarations when applied
 * as attributes, or 1 when only its references are read); past this, the SVG is refused. A rule's declarations each
 * become an attribute, so this also bounds what a sheet can write: about 500,000 attributes, some 8 MB of markup.
 * (Ten steps for each of 50,000 elements: a class rule and an element rule of four declarations apiece fit.)
 */
export const MAX_STYLE_STEPS = 500_000
export const TOO_COMPLEX_STYLES = "This SVG's style rules are too complex to apply."
/**
 * Paint operations an SVG may ask for: each painting of a marker, pattern, mask or clip path counts its content, a
 * budget of its own beside the 50,000 elements (which count each element once).
 */
export const MAX_PAINTS = 1_000_000
export const TOO_SLOW = 'This SVG would take too long to draw (over 1,000,000 painted elements).'
/** Longest value a style declaration or presentation attribute may hold (path data and points aren't either). */
export const MAX_VALUE_LENGTH = 2000
/** Most url() references one value may hold; past these they're dropped. */
export const MAX_VALUE_REFS = 4

/** Why an SVG over 5 MB is refused: reading drops an svg layer for it, so the ops and saving refuse one in these words. */
export const SVG_TOO_LARGE = 'This SVG is too large (over 5 MB).'

/**
 * What one cleaning takes on before it refuses: elements (each once, and again with every <use> expanded), painted
 * elements and the steps of the walk over chains of paintings, UTF-8 bytes and nesting. CLEAN_LIMITS (the default)
 * is for SVG from outside; exportLimits raises them for a drawing of our own.
 */
export interface CleanLimits { elements: number; painted: number; paintSteps: number; bytes: number; depth: number }

const thousands = (n: number): string => n.toLocaleString('en-US')
const tooMany = (lim: CleanLimits): string => `This SVG has too many elements (over ${thousands(lim.elements)}).`
const tooSlow = (lim: CleanLimits): string => `This SVG would take too long to draw (over ${thousands(lim.painted)} painted elements).`
const tooLarge = (lim: CleanLimits): string => `This SVG is too large (over ${thousands(Math.round(lim.bytes / 1048576))} MB).`

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

/**
 * Presentation attributes, which are also the CSS properties a style may set. Their values are checked for url().
 * Not `marker`: browsers ignore it as an attribute, and as a style it is written out as its three longhands.
 */
export const PRESENTATION = new Set([
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering', 'direction', 'display', 'dominant-baseline', 'enable-background',
  'fill', 'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font-family', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'glyph-orientation-horizontal',
  'glyph-orientation-vertical', 'image-rendering', 'kerning', 'letter-spacing', 'lighting-color', 'marker-end',
  'marker-mid', 'marker-start', 'mask', 'mask-type', 'opacity', 'overflow', 'paint-order',
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
  if (!t) return 'an empty reference'
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
 * declaration or presentation attribute) may hold no control characters at all, raw newlines included. Past the fourth
 * url() a value's references are dropped, each with the separator before it, and `note` says so (no real value names
 * more: a paint and its fallback, or a short mask or filter list).
 */
export function cleanValue(raw: string, css: boolean): { value: string; note?: string } | { bad: string } {
  if ((css ? CSS_CONTROL : ATTR_CONTROL).test(raw)) return { bad: 'a value with control characters' }
  if (raw.includes('\\')) return { bad: 'a style value with escapes' }
  if (raw.includes('<')) return { bad: 'a style value with markup' }
  if (css && /[{}]/.test(raw)) return { bad: 'a style value with braces' }
  if (css && raw.includes('/*')) return { bad: 'a style value with a comment' }
  if (/url[ \t\n\r\f]+\(/i.test(raw)) return { bad: 'a reference with a gap between url and its bracket' }
  const k = KEYWORD.exec(raw)
  if (k) return { bad: `a style value using ${k[0].toLowerCase().replace(/[:(]$/, '')}` }
  if (css && raw.includes('!')) return { bad: 'a style value with a stray !' }
  if (!/[('"]/.test(raw)) {
    // no function and no string: nothing more to check, once a lone closing bracket is ruled out
    return raw.includes(')') ? { bad: 'a style value with unbalanced brackets' } : { value: raw }
  }
  let depth = 0 // brackets open around the current position (url() closes its own)
  let out = ''
  let last = 0
  let start = -1 // where the identifier before the current position began
  let refs = 0
  // A reference was dropped since `out` last grew. What follows it gets a space wherever it would otherwise run into
  // the name before (a dropped url between "red" and "x" can't leave "redx", nor "red(" a function). A name is what
  // the scan below reads as one, so a letter past ASCII joins like any other (é and rgb( can't make érgb().
  let gap = false
  const add = (text: string) => {
    if (gap && text && (text[0] === '(' || nameChar(text.charCodeAt(0))) && out && nameChar(out.charCodeAt(out.length - 1))) out += ' '
    if (text) gap = false
    out += text
  }
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
    if (ch === ')') {
      if (--depth < 0) return { bad: 'a style value with unbalanced brackets' }
      start = -1
      continue
    }
    if (ch !== '(') {
      start = -1
      continue
    }
    const name = start < 0 ? '' : raw.slice(start, i).toLowerCase()
    if (name !== 'url') {
      if (!FUNCTIONS.has(name)) return { bad: `a style function that could load something (${short(name)})` }
      depth++
      start = -1
      continue
    }
    let j = i + 1
    while (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r') j++
    let arg: string
    if (raw[j] === '"' || raw[j] === "'") {
      const end = raw.indexOf(raw[j], j + 1)
      if (end < 0) return { bad: `a reference that isn't closed (${short(raw.slice(j))})` }
      arg = raw.slice(j + 1, end)
      j = end + 1
    } else {
      const from = j
      while (j < raw.length && !/[)\t\n\r '"(]/.test(raw[j])) j++ // CSS white space only, so an NBSP stays in view
      arg = raw.slice(from, j)
    }
    while (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r') j++
    const ref = fragment(arg)
    if (j >= raw.length) return { bad: `a reference that isn't closed (${short(raw.slice(i - 3))})` }
    if (raw[j] !== ')' || !ref) return { bad: badReference(arg) }
    if (++refs > MAX_VALUE_REFS) {
      // the reference goes with the separator before it
      add(raw.slice(last, start).replace(/[\s,]+$/, ''))
      gap = true
    } else add(raw.slice(last, start) + `url(${ref})`)
    last = j + 1
    i = j
    start = -1
  }
  if (depth) return { bad: 'a style value with unbalanced brackets' }
  add(raw.slice(last))
  return refs > MAX_VALUE_REFS ? { value: out, note: `a value with more than ${MAX_VALUE_REFS} references (the rest were dropped)` } : { value: out }
}

/**
 * A style attribute's (or rule's) declarations, keeping only allowed properties with safe values (in canonical form),
 * one per property: a later one replaces an earlier one unless only the earlier is !important, as in CSS. Only a valid
 * declaration (not empty, and passing every check here) can replace one; a browser skips an invalid one, so the earlier
 * stays. With `ids`, a declaration that refers to an id not among them goes too. Without them, such a reference can't
 * be checked yet, so the declarations it would replace stay in front of it until a pass with the ids settles which
 * one is left (cleanSvg makes that pass on every value holding a url(#id)).
 */
export function cleanDeclarations(text: string, note: (s: string) => void, ids?: Map<string, Element>): string {
  return keptDeclarations(text, note, ids).list.join(';')
}

const MARKER_LONGHANDS = ['marker-start', 'marker-mid', 'marker-end']

/**
 * cleanDeclarations as a list, and how many properties it sets (one, unless a reference is still to be checked). The
 * `marker` shorthand is checked once and written as its three longhands, in its place (so later ones still win).
 */
function keptDeclarations(text: string, note: (s: string) => void, ids?: Map<string, Element>): { list: string[]; props: number } {
  // per property: the declaration that wins, after any it would replace that stay until its reference is checked
  const keep = new Map<string, { text: string; important: boolean }[]>()
  for (const d of splitDeclarations(text)) {
    if (d.prop.startsWith('--')) {
      note(`a CSS variable (${short(d.prop)})`)
      continue
    }
    if (d.prop.startsWith('-')) continue // vendor properties such as -inkscape-font-specification
    if (d.prop !== 'marker' && !PRESENTATION.has(d.prop) && !STYLE_ONLY.has(d.prop)) {
      note(`a style property (${short(d.prop)})`)
      continue
    }
    if (!d.value) continue // empty: invalid, so it neither stays nor replaces an earlier one
    if (d.value.length > MAX_VALUE_LENGTH) {
      note(`a style value longer than 2,000 characters (${short(d.prop)})`)
      continue
    }
    const v = cleanValue(d.value, true)
    if ('bad' in v) {
      note(v.bad)
      continue
    }
    if (v.note) note(v.note)
    const missing = ids ? urlRefs(v.value).find(id => !ids.has(id)) : undefined
    if (missing !== undefined) {
      note(`a reference to a missing id (#${short(missing)})`)
      continue
    }
    for (const prop of d.prop === 'marker' ? MARKER_LONGHANDS : [d.prop]) {
      const had = keep.get(prop)
      if (had && had[had.length - 1].important && !d.important) continue
      const entry = { text: `${prop}:${v.value}${d.important ? ' !important' : ''}`, important: d.important }
      const list = had && !ids && v.value.includes('url(#') ? had : []
      list.push(entry)
      keep.delete(prop) // the later one takes the later place
      keep.set(prop, list)
    }
  }
  const list: string[] = []
  for (const entries of keep.values()) for (const e of entries) list.push(e.text)
  return { list, props: keep.size }
}

/** Most declarations a style rule may hold (one per property). */
export const MAX_RULE_DECLARATIONS = 64
/** Most simple parts (element, .class, #id) one selector may chain. */
export const MAX_SELECTOR_PARTS = 4
/**
 * An element, then .class and #id parts, each name a CSS identifier as a browser reads one: no leading digit, and no
 * hyphen followed by a digit (.1a and .-1 are not selectors at all, so cleanStylesheet drops a list holding one whole,
 * as a browser drops the rule).
 */
const SIMPLE = /^([A-Za-z][\w-]*)?((?:[.#](?:--|-?[A-Za-z_])[\w-]*)*)$/
/** An element's classes, split on ASCII white space only, as a browser splits them (a no-break space is part of a name). */
export const classesOf = (el: Element): Set<string> => new Set((el.getAttribute('class') ?? '').split(/[ \t\n\f\r]+/).filter(Boolean))
/**
 * Whether one selector (one part of a comma list) is a simple one gauzzaDocs supports: an element, .class or #id, or
 * a chain of them on the same element (rect.logo, .a.b) up to 4 parts. No combinators, no *, no pseudo-classes.
 */
export function simpleSelector(sel: string): boolean {
  const m = SIMPLE.exec(sel.trim())
  if (!m || (!m[1] && !m[2])) return false
  const parts = (m[1] ? 1 : 0) + (m[2].match(/[.#]/g)?.length ?? 0)
  return parts <= MAX_SELECTOR_PARTS
}

const UNSUPPORTED = "a style rule gauzzaDocs doesn't support"

/**
 * A style sheet with only simple rules: each selector in a list a simple one (others are dropped from the list), at
 * most 64 declarations once each property is kept once, and every declaration passing cleanDeclarations. At-rules
 * go: @import and @font-face named as such, any other as a rule gauzzaDocs doesn't support.
 */
export function cleanStylesheet(css: string, note: (s: string) => void, ids?: Map<string, Element>): string {
  const out: string[] = []
  for (const b of cssBlocks(css)) {
    if (b.kind === 'at') {
      if (b.name === 'import') note(`a CSS @import (${short(b.prelude)})`)
      else if (b.name === 'font-face') note('a font loaded from CSS (@font-face)')
      else note(UNSUPPORTED)
      continue
    }
    const selectors = b.selector.split(',').map(s => s.trim())
    // a class or id that isn't an identifier makes the whole list invalid: a browser drops the rule, so it goes
    if (selectors.some(s => /[.#]-?\d/.test(s))) {
      note(UNSUPPORTED)
      continue
    }
    const simple = selectors.filter(simpleSelector)
    for (let i = simple.length; i < selectors.length; i++) note(UNSUPPORTED)
    if (!simple.length) continue
    const decls = keptDeclarations(b.body, note, ids)
    if (decls.props > MAX_RULE_DECLARATIONS) {
      note(UNSUPPORTED)
      continue
    }
    if (decls.list.length) out.push(`${simple.join(', ')}{${decls.list.join(';')}}`)
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

/**
 * An SVG's size as a byte limit (5 MB unless given) measures it: UTF-8 bytes. Any string longer than the limit in
 * characters is over it, and one a third as long is under it, without counting.
 */
export function utf8Length(s: string, limit = MAX_SVG_BYTES): number {
  if (s.length > limit) return s.length
  if (s.length * 3 <= limit) return s.length
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
function checkSize(root: Element, lim: CleanLimits): void {
  let count = 0
  const stack: [Element, number][] = [[root, 1]]
  while (stack.length) {
    const [el, depth] = stack.pop()!
    if (++count > lim.elements) throw new Error(tooMany(lim))
    if (depth > lim.depth) throw new Error(`This SVG is nested too deeply (over ${lim.depth} levels).`)
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
      else drop(badReference(a.value))
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
    if (local === 'marker') {
      drop('a marker attribute (browsers ignore it)') // only marker-start, marker-mid and marker-end are attributes
      continue
    }
    if (!ATTRIBUTES.has(local) && !PRESENTATION.has(local)) {
      drop(`${article(local)} attribute`)
      continue
    }
    if (PRESENTATION.has(local) && a.value.length > MAX_VALUE_LENGTH) {
      drop(`a value longer than 2,000 characters (${local})`)
      continue
    }
    const v = cleanValue(a.value, PRESENTATION.has(local))
    if ('bad' in v) drop(v.bad)
    else {
      a.value = v.value
      if (v.note) notes.add(v.note)
    }
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
  if (el.localName === 'style') {
    // A browser applies a style sheet only for its media and of type text/css; rather than judge which, any other goes.
    const type = el.getAttribute('type')
    if (el.hasAttribute('media') || (type !== null && !/^[ \t\n\r]*(text\/css)?[ \t\n\r]*$/i.test(type))) {
      notes.add('a style sheet for some media only, or not of type text/css')
      el.parentNode?.removeChild(el)
      return
    }
    const css = cleanStylesheet(el.textContent ?? '', s => notes.add(s))
    while (el.firstChild) el.removeChild(el.firstChild)
    if (css) el.appendChild(el.ownerDocument.createTextNode(css))
    else el.parentNode?.removeChild(el)
    for (const a of Array.from(el.attributes)) el.removeAttributeNode(a)
    return
  }
  cleanAttributes(el, notes)
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

// Repeated painting. A browser paints a marker's content at every vertex that carries it, a pattern's content for every
// element filled or stroked with it, and a mask's or clip path's content for every element that uses it. That has a
// budget of its own (MAX_PAINTS), so a small file can't ask for millions of painted elements this way either.

/** Properties whose url(#id) paints the content of the element it names again, and the kind that element must be. */
const REPAINTS = new Map([
  ['marker-start', 'marker'], ['marker-mid', 'marker'], ['marker-end', 'marker'], ['fill', 'pattern'], ['stroke', 'pattern'],
  ['mask', 'mask'], ['clip-path', 'clipPath']
])
const REPAINT_PROPS = [...REPAINTS.keys()]
const REPAINT_KINDS = new Set(REPAINTS.values())
const MARKER_PROPS = ['marker-start', 'marker-mid', 'marker-end']
/** Of those, the ones an element inherits from its parent. */
const INHERITED_REPAINTS = new Set([...MARKER_PROPS, 'fill', 'stroke'])
/** Values that can take a property from the parent. */
const FROM_PARENT = new Set(['inherit', 'unset', 'revert', 'revert-layer'])
/** Elements drawn only through a reference, never where they stand. */
const DEFINITIONS = new Set([
  'defs', 'symbol', 'marker', 'pattern', 'mask', 'clipPath', 'linearGradient', 'radialGradient', 'filter', 'style', 'title', 'desc'
])
const MARKABLE = new Set(['path', 'line', 'polyline', 'polygon'])
const PAINTED = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath'])

/**
 * For each of REPAINT_PROPS, the definitions an element may paint through it: every one any of its sources names (at
 * most MAX_VALUE_REFS from each), and its parent's when it may take the parent's.
 */
type Paints = Readonly<Record<string, readonly Element[]>>
const NONE: readonly Element[] = []
const NO_PAINTS: Paints = Object.fromEntries(REPAINT_PROPS.map(p => [p, NONE]))
/**
 * Most steps the walk over chains of paintings may take before the SVG is refused as too slow: each definition opened
 * costs 1 plus the length of the list of what it paints in turn (which the walk goes through), and each such list
 * made costs its length.
 */
const MAX_PAINT_STEPS = 100_000

/** A style rule's selector as the cleaner keeps it (an element, .class or #id, or a chain of them), with its declarations. */
interface SheetRule { tag: string | null; ids: string[]; classes: string[]; decls: Decl[] }

/** Whether a declaration of a style rule can add a definition an element paints: it names one, or takes the parent's. */
const repaintDecl = (d: Decl): boolean =>
  (REPAINTS.has(d.prop) || d.prop === 'marker') && (d.value.includes('url(#') || FROM_PARENT.has(d.value.trim().toLowerCase()))

/**
 * How many elements the SVG's markers, patterns, masks and clip paths paint: the content of each, every time it's
 * painted. The count is conservative and never models the cascade, since any difference from a browser's (a value it
 * drops when parsing, a rule it never applies, an attribute it ignores) would hide a painting. Which definitions an
 * element paints is every definition any of its sources names (its presentation attributes, each kept style rule that
 * matches it and its style attribute, up to MAX_VALUE_REFS from each). A property that inherits (fill, stroke and the
 * markers) always adds the parent's too, whatever the element sets itself; a mask or clip path adds the parent's when
 * a source takes it (inherit, unset, revert, revert-layer). Inheritance runs through a <use> as well. A definition painted inside its own painting paints nothing there (no
 * browser paints that). What one painting of a definition comes to is remembered unless a loop back past it cut it
 * short, and the walk over such loops is charged its work against MAX_PAINT_STEPS. Reading which definitions each
 * element paints is charged too, against MAX_PAINTS (every one read is at least one painting). Throws as soon as the
 * count passes MAX_PAINTS. (`sizes` is expandedSizes: what a definition holds counts as it stands, uses expanded.)
 * `lim` raises MAX_PAINTS, MAX_PAINT_STEPS and the element limit for a drawing of our own (exportLimits).
 */
function paintedCount(root: Element, ids: Map<string, Element>, sizes: Map<Element, number>, lim: CleanLimits): number {
  const all = allElements(root)
  // style rules that can name a definition or take one from the parent, indexed by an id, class or element of their
  // selector
  const rules = new Map<string, SheetRule[]>()
  for (const st of all) {
    if (st.localName !== 'style') continue
    for (const b of cssBlocks(st.textContent ?? '')) {
      if (b.kind !== 'rule') continue
      const decls = splitDeclarations(b.body).filter(repaintDecl)
      if (!decls.length) continue
      for (const s of b.selector.split(',')) {
        const m = SIMPLE.exec(s.trim())
        if (!m || (!m[1] && !m[2])) continue
        const parts = m[2].match(/[.#][\w-]+/g) ?? []
        const rule: SheetRule = {
          tag: m[1] || null, ids: parts.filter(p => p[0] === '#').map(p => p.slice(1)), classes: parts.filter(p => p[0] === '.').map(p => p.slice(1)), decls
        }
        const key = rule.ids.length ? `#${rule.ids[0]}` : rule.classes.length ? `.${rule.classes[0]}` : rule.tag!
        const list = rules.get(key)
        if (list) list.push(rule)
        else rules.set(key, [rule])
      }
    }
  }
  let steps = 0
  // what reading which definitions elements paint has cost: each one read is at least one painting
  let read = 0
  const charge = (n: number) => {
    if ((read += n) > lim.painted) throw new Error(tooSlow(lim))
  }

  // What an element sets itself, by property, over all its sources: the definitions they name, and whether any takes
  // the parent's. A value that does neither adds nothing (and, being only the element's own, takes nothing away).
  interface Own { refs: readonly Element[]; parent: boolean }
  const owns = new Map<Element, Map<string, Own> | null>()
  const ownOf = (el: Element) => {
    if (owns.has(el)) return owns.get(el)!
    const found = new Map<string, { refs: Set<Element>; parent: boolean }>()
    const put = (prop: string, value: string) => {
      const props = prop === 'marker' ? MARKER_PROPS : REPAINTS.has(prop) ? [prop] : null
      if (!props) return
      const parent = FROM_PARENT.has(value.trim().toLowerCase())
      const named = parent ? [] : urlRefs(value).slice(0, MAX_VALUE_REFS)
      if (!parent && !named.length) return
      for (const p of props) {
        let o = found.get(p)
        if (!o) found.set(p, (o = { refs: new Set(), parent: false }))
        for (const id of named) {
          const t = ids.get(id)
          if (t && t.localName === REPAINTS.get(p)) o.refs.add(t)
        }
        o.parent ||= parent
      }
    }
    const attrs = el.attributes
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]
      if (a.namespaceURI) continue
      const name = a.localName ?? a.name
      if (name === 'style') for (const d of splitDeclarations(a.value)) put(d.prop, d.value)
      else put(name, a.value)
    }
    if (rules.size) {
      const id = el.getAttribute('id')
      const classes = classesOf(el)
      const check = (list: SheetRule[] | undefined) => {
        if (!list) return
        for (const r of list) {
          steps += 1 + r.decls.length
          if (steps > MAX_STYLE_STEPS) throw new Error(TOO_COMPLEX_STYLES)
          if ((r.tag && r.tag !== el.localName) || !r.ids.every(i => i === id) || !r.classes.every(c => classes.has(c))) continue
          for (const d of r.decls) put(d.prop, d.value)
        }
      }
      if (id) check(rules.get(`#${id}`))
      for (const c of classes) check(rules.get(`.${c}`))
      check(rules.get(el.localName))
    }
    let own: Map<string, Own> | null = null
    for (const [p, o] of found) {
      own ??= new Map()
      own.set(p, { refs: o.refs.size ? [...o.refs] : NONE, parent: o.parent })
    }
    owns.set(el, own)
    return own
  }

  /** An element's paints, given its parent's: its own, and the parent's wherever it can inherit them. */
  const paintsOf = (el: Element, parent: Paints): Paints => {
    const own = ownOf(el)
    if (!own && parent.mask === NONE && parent['clip-path'] === NONE) return parent
    const out: Record<string, readonly Element[]> = {}
    for (const p of REPAINT_PROPS) {
      const o = own?.get(p)
      const inherits = INHERITED_REPAINTS.has(p)
      if (!o) {
        out[p] = inherits ? parent[p] : NONE
        continue
      }
      const up = inherits || o.parent ? parent[p] : NONE
      if (!up.length) out[p] = o.refs
      else if (!o.refs.length) out[p] = up
      else {
        const both = new Set([...o.refs, ...up])
        charge(both.size)
        out[p] = [...both]
      }
    }
    return out
  }
  /** An element's paints where it stands in the document, which is what a definition's content inherits. */
  const placed = new Map<Element, Paints>()
  const paintsInPlace = (el: Element): Paints => {
    let p = placed.get(el)
    if (!p) {
      const up = el.parentNode
      p = paintsOf(el, up && up.nodeType === 1 ? paintsInPlace(up as Element) : NO_PAINTS)
      placed.set(el, p)
    }
    return p
  }

  const vertices = new Map<Element, number>()
  const verticesOf = (el: Element): number => {
    let n = vertices.get(el)
    if (n === undefined) {
      if (el.localName === 'path') n = pathVertices(el.getAttribute('d'))
      else if (el.localName === 'line') n = 2
      else n = Math.floor(numbers(el.getAttribute('points') ?? '').length / 2) + (el.localName === 'polygon' ? 1 : 0)
      vertices.set(el, n)
    }
    return n
  }
  const tallyPaints = (el: Element, p: Paints, tally: Map<Element, number>) => {
    const add = (defs: readonly Element[], times: number) => {
      if (!defs.length) return
      charge(defs.length)
      for (const d of defs) tally.set(d, (tally.get(d) ?? 0) + times)
    }
    add(p.mask, 1)
    add(p['clip-path'], 1)
    const tag = el.localName
    if (PAINTED.has(tag)) {
      add(p.fill, 1)
      add(p.stroke, 1)
    }
    if (MARKABLE.has(tag) && (p['marker-start'].length || p['marker-mid'].length || p['marker-end'].length)) {
      const n = verticesOf(el)
      if (n) {
        add(p['marker-start'], 1)
        add(p['marker-mid'], n) // every vertex: the ends as well, which only adds two
        add(p['marker-end'], 1)
      }
    }
  }

  // Every element walked is one `sizes` already counted (the page once, and each holder's content once, since that is
  // remembered), so this never passes the element limit; it only guards the walk.
  let work = 0
  const overElements = (n: number) => {
    if (n > lim.elements) throw new Error(tooMany(lim))
  }
  /** Draws `items` once: how many elements that takes, and how many times each definition gets painted. */
  const draw = (items: [Element, Paints][]): { count: number; tally: Map<Element, number> } => {
    let count = 0
    const tally = new Map<Element, number>()
    const stack = items.slice()
    while (stack.length) {
      const [el, parent] = stack.pop()!
      if (DEFINITIONS.has(el.localName)) {
        count += sizes.get(el) ?? 1 // as it stands: itself and what it holds, uses expanded, painted nowhere here
        continue
      }
      count++
      overElements(++work)
      const p = paintsOf(el, parent)
      tallyPaints(el, p, tally)
      for (const c of elementChildren(el)) stack.push([c, p])
      if (el.localName !== 'use') continue
      const t = ids.get(hrefId(el) ?? '')
      if (!t) continue
      if (t.localName !== 'symbol') stack.push([t, p])
      else {
        // a symbol's own mask and clip path apply to each instance (Chromium copies its attributes onto it)
        count++
        const sp = paintsOf(t, p)
        tallyPaints(t, sp, tally)
        for (const c of elementChildren(t)) stack.push([c, sp])
      }
    }
    return { count, tally }
  }
  /**
   * The element whose children one painting of a definition draws: itself, or for a pattern without any, its template
   * (null when the chain of templates ends nowhere or loops). Remembered for every pattern on the chain walked, so
   * each link is followed once however many definitions start on it.
   */
  const holders = new Map<Element, Element | null>()
  const hasChildren = (el: Element): boolean => {
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return true
    return false
  }
  const holderOf = (def: Element): Element | null => {
    const chain: Element[] = []
    const seen = new Set<Element>()
    let holder: Element | null = def
    while (holder) {
      if (holders.has(holder)) {
        holder = holders.get(holder)!
        break
      }
      if (holder.localName !== 'pattern' || hasChildren(holder)) break
      chain.push(holder)
      seen.add(holder)
      const t = ids.get(hrefId(holder) ?? '')
      holder = t && t.localName === 'pattern' && !seen.has(t) ? t : null
    }
    for (const p of chain) holders.set(p, holder)
    if (!chain.length) holders.set(def, holder)
    return holder
  }
  /**
   * What one painting of a holder's children draws (at least 1, the painting itself) and what they paint in turn: the
   * same wherever it's painted, since content inherits from where its definition stands. Drawn once per holder.
   */
  const contents = new Map<Element, { count: number; next: [Element, number][] }>()
  const contentOf = (holder: Element) => {
    let c = contents.get(holder)
    if (!c) {
      const p = paintsInPlace(holder)
      const { count, tally } = draw(elementChildren(holder).map(k => [k, p]))
      c = { count: Math.max(count, 1), next: [...tally] }
      contents.set(holder, c)
    }
    return c
  }
  let walked = 0
  const chargeWalk = (n: number) => {
    if ((walked += n) > lim.paintSteps) throw new Error(tooSlow(lim))
  }
  /**
   * What painting `def` once paints in turn: its content's definitions, and its own mask or clip path (a clipped clip).
   * Made once per definition; a list joined from both is charged its length.
   */
  const nexts = new Map<Element, [Element, number][]>()
  const nextOf = (def: Element, holder: Element | null): [Element, number][] => {
    let next = nexts.get(def)
    if (!next) {
      const own = paintsInPlace(def)
      next = holder ? contentOf(holder).next : []
      if (own.mask !== NONE || own['clip-path'] !== NONE) {
        next = [...next, ...[...own.mask, ...own['clip-path']].map((x): [Element, number] => [x, 1])]
        chargeWalk(next.length)
      }
      nexts.set(def, next)
    }
    return next
  }

  const overPainted = (n: number) => {
    if (n > lim.painted) throw new Error(tooSlow(lim))
  }
  /**
   * Everything one painting of `top` paints: its content, and every painting that content asks for in turn, walked
   * (not recursed). A definition met again inside its own painting paints nothing there. A definition's total is
   * remembered once worked out, unless that walk was cut by meeting a definition painted further out (its total then
   * depends on where it was reached); a loop back to itself doesn't stop it being remembered. Only paths through such
   * loops are walked more than once. Opening a definition costs 1 plus the length of what it paints in turn, since the
   * walk goes through all of it, and at most MAX_PAINT_STEPS steps are taken in all.
   */
  const totals = new Map<Element, number>()
  const totalOf = (top: Element): number => {
    interface Frame { def: Element; total: number; next: [Element, number][]; i: number; times: number; low: number }
    const frames: Frame[] = []
    const depth = new Map<Element, number>()
    const open = (def: Element, times: number) => {
      const holder = holderOf(def)
      const next = nextOf(def, holder)
      chargeWalk(1 + next.length)
      depth.set(def, frames.length)
      frames.push({ def, total: holder ? contentOf(holder).count : 1, next, i: 0, times, low: frames.length })
    }
    open(top, 1)
    for (;;) {
      const f = frames[frames.length - 1]
      overPainted(f.total) // every total is painted at least once, so this alone is already too much
      if (f.i < f.next.length) {
        const [def, k] = f.next[f.i++]
        const at = depth.get(def)
        if (at !== undefined) f.low = Math.min(f.low, at) // painted inside its own painting: nothing
        else if (totals.has(def)) f.total += k * totals.get(def)!
        else open(def, k)
        continue
      }
      frames.pop()
      depth.delete(f.def)
      if (f.low >= frames.length) totals.set(f.def, f.total) // no cut reached past it
      if (!frames.length) return f.total
      const up = frames[frames.length - 1]
      up.total += f.times * f.total
      up.low = Math.min(up.low, f.low)
    }
  }

  const page = draw([[root, NO_PAINTS]])
  let painted = 0
  for (const [def, times] of page.tally) {
    painted += times * (totals.get(def) ?? totalOf(def))
    overPainted(painted)
  }
  return painted
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
 * pointing nowhere; refuses the SVG when it would draw more than 50,000 elements with every <use> expanded, or paint
 * more than 1,000,000 through its markers, patterns, masks and clip paths (or the limits `lim` raises them to).
 * Returns both counts.
 */
function checkReferences(root: Element, notes: Notes, lim: CleanLimits): { drawn: number; painted: number } {
  let all = allElements(root)
  // one element per id: the first keeps it (as a browser resolves it), later ones lose theirs
  const seenIds = new Set<string>()
  for (const el of all) {
    const id = el.getAttribute('id')
    if (!id) continue
    if (seenIds.has(id)) {
      el.removeAttribute('id')
      notes.add(`a repeated id (#${short(id)})`)
    } else seenIds.add(id)
  }
  let ids = idMap(all)
  let drawn = all.length
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
    drawn = size.get(root) ?? Infinity
    if (drawn > lim.elements) throw new Error(tooMany(lim))
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
  // markers, patterns, masks and clip paths paint their content again wherever they're used: counted, against their
  // own budget, once the references that stay are known
  const painted = all.some(el => REPAINT_KINDS.has(el.localName)) ? paintedCount(root, ids, expandedSizes(root, ids), lim) : 0
  return { drawn, painted }
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
/** What escaping adds for each character code up to LINE SEPARATOR (the highest ESC escapes). */
const ESC_EXTRA = new Uint8Array(0x2029)
for (const [c, e] of Object.entries(ESC)) ESC_EXTRA[c.charCodeAt(0)] = e.length - 1
/** Any character ESC escapes (made from its keys, none of which means anything inside [ ]). */
const ESCAPES = new RegExp(`[${Object.keys(ESC).join('')}]`)
/** How many characters a value takes once escaped as an attribute (& is 5, a quote 6), so a charge counts what's written. */
export function escapedLength(s: string): number {
  // most long values (path data) hold nothing to escape: one native scan says so
  if (!ESCAPES.test(s)) return s.length
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x2028) n += ESC_EXTRA[c]
  }
  return n
}

/**
 * A key a Map can find a long string by. V8 hashes a string over 16,383 characters by its length alone, so long
 * strings of one length used as keys would all share one bucket, and every lookup would compare against all of them.
 * A string up to 1,024 characters is its own key; a longer one is keyed by its length and two 32-bit hashes of it.
 * Two different strings can share a key (a long one with another, or with a short one that reads like its key), so
 * whatever is found by one must be checked against the string itself.
 */
export function shortKey(s: string): string {
  if (s.length <= 1024) return s
  let a = 0x811c9dc5
  let b = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
    b ^= b >>> 15
  }
  return `#${s.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`
}
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

/**
 * Cleans SVG text into its root element (see cleanSvg), with how many elements it draws (every element once, every
 * <use> expanded) and how many its markers, patterns, masks and clip paths paint (their content, each time it's
 * painted). `lim` is what it takes on before refusing (CLEAN_LIMITS unless given).
 */
export function cleanSvgRoot(svg: string, lim: CleanLimits = CLEAN_LIMITS): { root: Element; removed: string[]; drawn: number; painted: number } {
  if (typeof svg !== 'string') throw new Error('An SVG must be text.')
  if (utf8Length(svg, lim.bytes) > lim.bytes) throw new Error(tooLarge(lim))
  const notes = new Notes()
  const root = parseSvgText(declarePrefixes(stripDoctype(svg, notes)))
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new Error(`This is not an SVG: its root element is <${root.nodeName}>.`)
  }
  checkSize(root, lim)
  // only the root is written back, so anything before it goes; a linked style sheet there is worth naming
  for (let n = root.ownerDocument?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 7 && (n as ProcessingInstruction).target === 'xml-stylesheet') notes.add('a linked style sheet')
  }
  cleanAttributes(root, notes)
  cleanChildren(root, notes)
  const { drawn, painted } = checkReferences(root, notes, lim)
  return { root, removed: notes.list(), drawn, painted }
}

/**
 * SVG from outside, made safe to store, show and share: only allowlisted elements and attributes, references only to
 * the fragment's own ids or embedded images, and `removed` naming each thing that went. Throws over 5 MB, 50,000
 * elements or 1,000,000 painted elements (or the limits `lim` gives).
 */
export function cleanSvg(svg: string, lim: CleanLimits = CLEAN_LIMITS): { svg: string; removed: string[]; drawn: number; painted: number } {
  const { root, removed, drawn, painted } = cleanSvgRoot(svg, lim)
  return { svg: serializeSvg(root), removed, drawn, painted }
}

/** What SVG from outside may take on: 50,000 elements, 1,000,000 painted, 5 MB and 256 levels. */
export const CLEAN_LIMITS: CleanLimits = {
  elements: MAX_SVG_ELEMENTS, painted: MAX_PAINTS, paintSteps: MAX_PAINT_STEPS, bytes: MAX_SVG_BYTES, depth: MAX_NESTING
}

/**
 * Elements a drawing may hold for each layer it draws: the most an ordinary layer writes, measured in export mode, with
 * room to spare. A text of four runs wrapped over several lines, one run a gradient, with a shadow, writes 26; a shape
 * with a gradient fill and stroke, a dash, a shadow and a blur, 17; a connector with a label, arrows at both ends and a
 * gradient, 14; a diagram, 2.5 a layer.
 */
export const ELEMENTS_PER_LAYER = 64

/**
 * The limits for cleaning a drawing of our own (an export, or svg --get) that draws `drawn.layers` layers and inlines
 * `drawn.svg` svg layers. Each svg layer was held to CLEAN_LIMITS when it came in and is cleaned again on every read,
 * so the drawing may hold that much again for each one, and ELEMENTS_PER_LAYER for each layer drawn, on top of the
 * outside limits. Painted elements and paint steps grow in the same proportion, so the ceiling stays real. Bytes are
 * bounded by the renderer itself (its 128 MB of characters, at most 3 UTF-8 bytes each), since embedded images alone
 * pass 5 MB, and nesting gets room for the groups and instances a fragment sits in.
 */
export function exportLimits(drawn: { svg: number; layers: number }): CleanLimits {
  const whole = (n: number): number => Math.max(0, Math.floor(n) || 0)
  const elements = MAX_SVG_ELEMENTS * (1 + whole(drawn.svg)) + ELEMENTS_PER_LAYER * whole(drawn.layers)
  const grow = elements / MAX_SVG_ELEMENTS
  return {
    elements, painted: Math.ceil(MAX_PAINTS * grow), paintSteps: Math.ceil(MAX_PAINT_STEPS * grow), bytes: 3 * 128 * 1024 * 1024,
    depth: 2 * MAX_NESTING
  }
}
