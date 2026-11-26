// CSS for SVG: comments, declarations, top-level rules and colors. Used by svgClean (to keep only safe styles) and
// svgImport (to apply style rules and read paints).

export interface Decl { prop: string; value: string; important: boolean }

/** Index of the quote that closes the string opening at `i`, or the end. Backslash escapes are skipped. */
function stringEnd(s: string, i: number): number {
  const q = s[i]
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === q) return j
  }
  return s.length
}

/** CSS without its comments; strings are left as they are. */
export function stripCssComments(css: string): string {
  let out = ''
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i)
      out += css.slice(i, end + 1)
      i = end
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 1
      out += ' '
    } else out += ch
  }
  return out
}

/** Splits on `sep` where it isn't inside a string or parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' || ch === "'") i = stringEnd(s, i)
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === sep && !depth) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/** `fill: red; stroke: blue !important` as declarations, property names lowercased. */
export function splitDeclarations(text: string): Decl[] {
  const out: Decl[] = []
  for (const part of splitTop(stripCssComments(text), ';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const prop = part.slice(0, at).trim().toLowerCase()
    let value = part.slice(at + 1).trim()
    const imp = /!\s*important\s*$/i.exec(value)
    if (imp) value = value.slice(0, imp.index).trim()
    if (prop) out.push({ prop, value, important: !!imp })
  }
  return out
}

export type CssBlock =
  | { kind: 'rule'; selector: string; body: string }
  | { kind: 'at'; name: string; prelude: string; body: string | null }

/** Where the block opening at `i` (a `{`) closes, or the end. */
function blockEnd(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const ch = s[j]
    if (ch === '"' || ch === "'") j = stringEnd(s, j)
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return j
  }
  return s.length
}

/** The first of `chars` at `i` or later that isn't inside a string, or -1. */
function findTop(s: string, i: number, chars: string): number {
  for (let j = i; j < s.length; j++) {
    const ch = s[j]
    if (ch === '"' || ch === "'") j = stringEnd(s, j)
    else if (chars.includes(ch)) return j
  }
  return -1
}

const AT_NAME = /@([\w-]*)/y

/** A style sheet's top-level rules and at-rules (comments already removed by the caller or not). */
export function cssBlocks(css: string): CssBlock[] {
  const s = stripCssComments(css)
  const out: CssBlock[] = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++
    if (i >= s.length) break
    if (s[i] === '@') {
      AT_NAME.lastIndex = i
      const name = (AT_NAME.exec(s)?.[1] ?? '').toLowerCase()
      const start = i + 1 + name.length
      const j = findTop(s, start, ';{')
      if (j < 0) {
        out.push({ kind: 'at', name, prelude: s.slice(start).trim(), body: null })
        break
      }
      if (s[j] === ';') {
        out.push({ kind: 'at', name, prelude: s.slice(start, j).trim(), body: null })
        i = j + 1
      } else {
        const end = blockEnd(s, j)
        out.push({ kind: 'at', name, prelude: s.slice(start, j).trim(), body: s.slice(j + 1, end) })
        i = end + 1
      }
      continue
    }
    const j = findTop(s, i, '{')
    if (j < 0) break
    const end = blockEnd(s, j)
    out.push({ kind: 'rule', selector: s.slice(i, j).trim(), body: s.slice(j + 1, end) })
    i = end + 1
  }
  return out
}

/** Red, green and blue 0..255 and alpha 0..1. */
export type RGBA = [number, number, number, number]

const NAMED: Record<string, string> = Object.fromEntries(
  (
    'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 ' +
    'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 ' +
    'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff ' +
    'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
    'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
    'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f ' +
    'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
    'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
    'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 ' +
    'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
    'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
    'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 ' +
    'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
    'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 ' +
    'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 ' +
    'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
    'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 ' +
    'oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa ' +
    'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f ' +
    'pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f ' +
    'royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee ' +
    'sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
    'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 ' +
    'violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'
  )
    .split(' ')
    .map(p => p.split(':') as [string, string])
)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** A channel: a number, or a percentage of `full`. */
function channel(s: string, full: number): number | null {
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(s.trim())
  if (!m) return null
  const v = parseFloat(m[1])
  return m[2] ? (v / 100) * full : v
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** A CSS color: a name, transparent, #rgb(a), #rrggbb(aa), rgb()/rgba() or hsl()/hsla(). Null for anything else. */
export function parseColor(value: string): RGBA | null {
  const s = value.trim().toLowerCase()
  if (s === 'transparent') return [0, 0, 0, 0]
  const named = Object.prototype.hasOwnProperty.call(NAMED, s) ? NAMED[s] : null
  const hex = named ?? (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1] ?? null)
  if (hex) {
    const h = hex.length <= 4 ? hex.replace(/./g, c => c + c) : hex
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s)
  if (!fn) return null
  const body = fn[2].trim()
  const parts = body.includes(',') ? body.split(',').map(p => p.trim()) : body.replace('/', ' / ').split(/\s+/).filter(p => p && p !== '/')
  if (parts.length !== 3 && parts.length !== 4) return null
  const alpha = parts.length === 4 ? channel(parts[3], 1) : 1
  if (alpha === null) return null
  if (fn[1].startsWith('rgb')) {
    const c = parts.slice(0, 3).map(p => channel(p, 255))
    if (c.some(v => v === null)) return null
    return [clamp(c[0]!, 0, 255), clamp(c[1]!, 0, 255), clamp(c[2]!, 0, 255), clamp(alpha, 0, 1)]
  }
  const h = parseFloat(parts[0].replace(/deg$/, ''))
  const sat = channel(parts[1], 1)
  const light = channel(parts[2], 1)
  if (!Number.isFinite(h) || sat === null || light === null) return null
  const [r, g, b] = hsl(((h % 360) + 360) % 360, clamp(sat, 0, 1), clamp(light, 0, 1))
  return [r, g, b, clamp(alpha, 0, 1)]
}

const hex2 = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')

/** #rrggbb, or #rrggbbaa when it isn't opaque. */
export function hexColor(c: RGBA): string {
  const a = clamp(c[3], 0, 1)
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + (a < 1 ? hex2(a * 255) : '')
}
