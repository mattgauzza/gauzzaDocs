import type { Box } from './geometry'
import {
  INKSCAPE_NS, MAX_RULE_DECLARATIONS, MAX_STYLE_STEPS, PRESENTATION, TOO_COMPLEX_STYLES, XLINK_NS, allElements, classesOf, cleanSvgRoot,
  cleanValue, escapedLength, serializeSvg, shortKey, simpleSelector
} from './svgClean'
import { len } from './svgPaint'
import { type Decl, cssBlocks, splitDeclarations } from './svgStyle'
import { num } from './text'

// Cleaned SVG fragments: simple <style> rules applied as attributes (for import, and so an inlined fragment can't
// restyle the document around it), and an svg layer's fragment inlined into an export with its ids prefixed per layer.

/**
 * A simple selector: an element, .class or #id, or up to 4 of them on the same element (rect.logo, .a.b). No
 * combinators, so a match only ever looks at the element itself.
 */
interface Selector { tag: string | null; ids: string[]; classes: string[]; spec: number }

function parseSelector(s: string): Selector | null {
  const t = s.trim()
  if (!simpleSelector(t)) return null
  const m = /^([A-Za-z][\w-]*)?(.*)$/.exec(t)!
  const parts = m[2].match(/[.#][\w-]+/g) ?? []
  const ids = parts.filter(p => p[0] === '#').map(p => p.slice(1))
  const classes = parts.filter(p => p[0] === '.').map(p => p.slice(1))
  return { tag: m[1] || null, ids, classes, spec: ids.length * 10000 + classes.length * 100 + (m[1] ? 1 : 0) }
}

/**
 * `font: italic bold 12px/1.2 Arial` as its longhands: at most four (size, family, and the last style and weight
 * word), however many words lead it, so a declaration costs the same to apply whatever its length.
 */
function expandFont(v: string): Decl[] {
  const m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{3})\s+)*)([\d.]+[a-z%]*)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(v)
  if (!m) return []
  const out: Decl[] = [{ prop: 'font-size', value: m[2], important: false }, { prop: 'font-family', value: m[3], important: false }]
  let style = ''
  let weight = ''
  for (const w of m[1].trim().split(/\s+/).filter(Boolean)) {
    if (/^(italic|oblique)$/i.test(w)) style = w
    else if (/^(bold|bolder|lighter|\d{3})$/i.test(w)) weight = w
  }
  if (style) out.push({ prop: 'font-style', value: style, important: false })
  if (weight) out.push({ prop: 'font-weight', value: weight, important: false })
  return out
}

/**
 * A font family list with the quotes taken off plain names ('Myriad Pro', a Japanese family name, Arial), or null when
 * a name holds anything but letters, digits, spaces, _ . and - in any script (so 'M+ 1p' can't lose its quotes).
 */
function plainFamilies(v: string): string | null {
  const names = v.split(',').map(p => p.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
  return names.every(n => /^[\p{L}\p{N}_ .-]+$/u.test(n)) ? names.join(', ') : null
}

/**
 * A declaration that can stand alone as an attribute or next to others in a style attribute: no quote, backslash,
 * semicolon or brace that could reach into a neighbor, and nothing cleanValue would change (so a url() is only ever
 * the canonical url(#id)). Null when it can't.
 */
function safeDecl(d: Decl): Decl | null {
  const value = d.prop === 'font-family' ? plainFamilies(d.value) : d.value
  if (!value || /['"\\;{}]/.test(value)) return null
  const v = cleanValue(value, true)
  return 'bad' in v || v.value !== value ? null : { ...d, value }
}

interface Rule { sel: Selector; decls: Decl[]; order: number }
export { MAX_STYLE_STEPS }

/**
 * Applies the simple <style> rules (element, .class, #id and chains of up to 4 of them on one element) as
 * attributes, then drops the style elements. Specificity orders the rules (id, then class, then element, later rules
 * winning ties); rules beat presentation attributes and the inline style attribute beats rules, as in a browser.
 * A rule with any other selector, or more than 64 declarations once each property is kept once, isn't applied
 * (cleanSvg has already dropped such rules with a note; `note` hears about any left). Every declaration is checked on
 * its own (safeDecl) before it's written, so two can never be stitched into a third.
 *
 * Rules are indexed by an id, class or element of their selector, so each element checks only the rules that could
 * match it, and a check looks at the element alone (at most 4 parts). Every candidate is charged 1 plus its declaration
 * count (what applying it would cost), all before any is checked, against MAX_STYLE_STEPS; past it, the SVG is refused.
 */
export function applyStyles(root: Element, note: (s: string) => void): void {
  const byId = new Map<string, Rule[]>()
  const byClass = new Map<string, Rule[]>()
  const byTag = new Map<string, Rule[]>()
  const add = (m: Map<string, Rule[]>, k: string, r: Rule) => {
    const list = m.get(k)
    if (list) list.push(r)
    else m.set(k, [r])
  }
  let order = 0
  const all = allElements(root)
  for (const st of all.filter(e => e.localName === 'style')) {
    for (const b of cssBlocks(st.textContent ?? '')) {
      if (b.kind === 'at') {
        note("a style rule gauzzaDocs doesn't support")
        continue
      }
      // one declaration per property, the later winning unless only the earlier is !important
      const one = new Map<string, Decl>()
      for (const d of splitDeclarations(b.body)) {
        if (!d.value) continue // an empty declaration is invalid, so it never replaces one before it
        const had = one.get(d.prop)
        if (had && had.important && !d.important) continue
        one.delete(d.prop)
        one.set(d.prop, d)
      }
      if (one.size > MAX_RULE_DECLARATIONS) {
        note("a style rule gauzzaDocs doesn't support")
        continue
      }
      const decls = [...one.values()]
      for (const s of b.selector.split(',')) {
        const sel = parseSelector(s)
        if (!sel) {
          note("a style rule gauzzaDocs doesn't support")
          continue
        }
        const rule = { sel, decls, order: order++ }
        if (sel.ids.length) add(byId, sel.ids[0], rule)
        else if (sel.classes.length) add(byClass, sel.classes[0], rule)
        else add(byTag, sel.tag!, rule)
      }
    }
    st.parentNode?.removeChild(st)
  }
  const indexed = byId.size + byClass.size + byTag.size > 0

  interface Facts { tag: string; id: string | null; classes: Set<string> }
  const facts = new Map<Element, Facts>()
  const factsOf = (el: Element): Facts => {
    let f = facts.get(el)
    if (!f) {
      f = { tag: el.localName, id: el.getAttribute('id'), classes: classesOf(el) }
      facts.set(el, f)
    }
    return f
  }
  // a rule's declarations apply to every element it matches: each is checked once, as what would be written
  const seenDecls = new Map<Decl, Decl[]>()
  const checked = (d: Decl): Decl[] => {
    let out = seenDecls.get(d)
    if (!out) {
      out = (d.prop === 'font' ? expandFont(d.value) : [d]).map(safeDecl).filter((x): x is Decl => x !== null)
      seenDecls.set(d, out)
    }
    return out
  }
  // Every candidate costs a check plus, if it matches, a pass over each of its declarations, and writing what they
  // write (a step per 16 characters of it, escaped as written; a declaration that won't be written, such as one with a
  // quote, writes nothing), so the budget also bounds the markup a sheet writes to about 8 MB. It's all counted first,
  // so a sheet that asks too much is refused before any work.
  if (indexed) {
    const costs = new Map<Rule[], number>()
    const cost = (list: Rule[] | undefined): number => {
      if (!list) return 0
      let c = costs.get(list)
      if (c === undefined) {
        c = 0
        for (const r of list) {
          let chars = 0
          for (const d of r.decls) for (const w of checked(d)) chars += w.prop.length + escapedLength(w.value)
          c += 1 + r.decls.length + Math.floor(chars / 16)
        }
        costs.set(list, c)
      }
      return c
    }
    let steps = 0
    for (const el of all) {
      if (!el.parentNode) continue
      const f = factsOf(el)
      steps += (f.id ? cost(byId.get(f.id)) : 0) + cost(byTag.get(f.tag))
      for (const c of f.classes) steps += cost(byClass.get(c))
      if (steps > MAX_STYLE_STEPS) throw new Error(TOO_COMPLEX_STYLES)
    }
  }
  const matches = (sel: Selector, f: Facts): boolean =>
    (!sel.tag || sel.tag === f.tag) && sel.ids.every(i => i === f.id) && sel.classes.every(x => f.classes.has(x))

  for (const el of all) {
    if (!el.parentNode) continue // a style element removed above
    const inline = splitDeclarations(el.getAttribute('style') ?? '')
    const candidates: Rule[] = []
    const take = (list: Rule[] | undefined) => {
      if (!list) return
      for (const r of list) candidates.push(r)
    }
    if (indexed) {
      const f = factsOf(el)
      if (f.id) take(byId.get(f.id))
      for (const c of f.classes) take(byClass.get(c))
      take(byTag.get(f.tag))
    }
    const f = factsOf(el)
    const hits = candidates.filter(r => matches(r.sel, f)).sort((a, b) => a.sel.spec - b.sel.spec || a.order - b.order)
    if (!hits.length && !inline.length) continue
    const final = new Map<string, string>()
    const put = (list: Decl[], important: boolean) => {
      for (const d of list) {
        if (d.important !== important) continue
        for (const safe of checked(d)) final.set(safe.prop, safe.value)
      }
    }
    for (const r of hits) put(r.decls, false)
    put(inline, false)
    for (const r of hits) put(r.decls, true)
    put(inline, true)
    const rest: string[] = []
    for (const [p, v] of final) {
      if (PRESENTATION.has(p)) el.setAttribute(p, v)
      else if (p === 'transform') el.setAttribute('transform', v.replace(/(px|deg)\b/g, ''))
      else rest.push(`${p}:${v}`)
    }
    if (rest.length) el.setAttribute('style', rest.join(';'))
    else el.removeAttribute('style')
  }
}

/** Free text that names things: never rewritten. */
const isFreeText = (a: Attr): boolean => {
  const name = a.localName ?? a.name
  return a.namespaceURI === INKSCAPE_NS || name === 'role' || /^(data|aria)-/.test(name)
}

/**
 * Prefixes every id and rewrites every reference to one: href and xlink:href "#id", and url(#id) in any attribute or
 * style. Cleaned input only holds the canonical forms; quotes, spaces and upper case are matched as well regardless.
 * Names (data-name, inkscape:label and the like) are left as they are.
 */
function prefixIds(root: Element, prefix: string): void {
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes)) {
      const name = a.localName ?? a.name
      if (isFreeText(a)) continue
      if (!a.namespaceURI && name === 'id') a.value = prefix + a.value
      else if (name === 'href' && (!a.namespaceURI || a.namespaceURI === XLINK_NS)) {
        const v = a.value.trim()
        if (v.startsWith('#')) a.value = '#' + prefix + v.slice(1)
      } else if (/url\(/i.test(a.value)) a.value = a.value.replace(/url\(\s*(['"]?)\s*#/gi, `url($1#${prefix}`)
    }
  }
}

/**
 * An svg layer's fragment inline, for export: cleaned again (it comes from a file), its style rules applied as
 * attributes, every id prefixed with `prefix`, as a nested <svg> filling `box` and stretched to it the way the layer's
 * image is drawn. An image paints only inside its box, so the root's own overflow, filter and transform are dropped,
 * from attributes, its style attribute and style rules alike (a nested svg clips its content by default, but a filter
 * or transform on it could paint outside). Empty when the fragment can't be read, asks too much (elements, painting
 * or style rules), or can't be written out (a RangeError for a string too long, say): it never throws, so an export
 * with such a layer still comes out, without it. With `cache`, each fragment is cleaned once (or found refused once)
 * however many times it's inlined, as instances of one component inline the same layer; `holder` is the layer that
 * holds the markup, which finds it again without reading the markup.
 */
export function inlineSvg(svg: string, box: Box, prefix: string, cache?: InlineCaches, holder?: object): string {
  try {
    let c = cache ? cachedInline(cache, svg, holder) : undefined
    if (c === null) return ''
    if (c === undefined) {
      c = converted(svg)
      if (cache) remember(cache, svg, holder, c)
    }
    return `<svg x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}"` + c.tail.split(c.mark).join(prefix)
  } catch {
    if (cache) remember(cache, svg, holder, null)
    return ''
  }
}

/**
 * Fragments converted for inlining in one drawing (null for one that can't be), found by the layer that holds the
 * markup, or else by the markup through its shortKey (checked against the markup), never with the markup itself as a
 * Map key: V8 hashes a string over 16,383 characters by its length alone, so same-length fragments would share one
 * bucket and every lookup would compare against each of them.
 */
export interface InlineCaches {
  byLayer: WeakMap<object, InlineCache | null>
  byKey: Map<string, { svg: string; c: InlineCache | null }>
}
export const inlineCaches = (): InlineCaches => ({ byLayer: new WeakMap(), byKey: new Map() })

/** What `cache` holds for `svg` (held by `holder`): its conversion, null when it can't be converted, else undefined. */
export function cachedInline(cache: InlineCaches, svg: string, holder?: object): InlineCache | null | undefined {
  if (holder) {
    const c = cache.byLayer.get(holder)
    if (c !== undefined) return c
  }
  const hit = cache.byKey.get(shortKey(svg))
  if (!hit || hit.svg !== svg) return undefined
  if (holder) cache.byLayer.set(holder, hit.c)
  return hit.c
}

function remember(cache: InlineCaches, svg: string, holder: object | undefined, c: InlineCache | null): void {
  if (holder) cache.byLayer.set(holder, c)
  const k = shortKey(svg)
  const hit = cache.byKey.get(k)
  if (!hit) cache.byKey.set(k, { svg, c })
  else if (hit.svg === svg) hit.c = c
}

/**
 * A fragment converted for inlining, ready for any box and prefix: its markup after the placement attributes, with
 * every id prefixed by `mark` (a private-use character the source doesn't hold, so it marks only those). `size` is
 * at least what one use writes.
 */
export interface InlineCache { tail: string; mark: string; size: number }
/** How the root begins before the box is put in. */
const HEAD = '<svg x="0" y="0" width="0" height="0"'

/**
 * A character the source doesn't hold, from the private use area, to stand for the prefix: the first one not among
 * those it holds, gathered in one pass over it.
 */
function markFor(svg: string): string {
  const used = new Set<number>()
  for (let i = 0; i < svg.length; i++) {
    const c = svg.charCodeAt(i)
    if (c >= 0xe000 && c <= 0xf8ff) used.add(c)
  }
  for (let c = 0xe000; c <= 0xf8ff; c++) if (!used.has(c)) return String.fromCharCode(c)
  throw new Error('This SVG uses every private use character.')
}

function converted(svg: string): InlineCache {
  const root = cleanSvgRoot(svg).root
  applyStyles(root, () => undefined)
  let viewBox = root.getAttribute('viewBox')
  if (!viewBox) {
    // as an image, a fragment without a viewBox is stretched from its own size
    const w = len(root.getAttribute('width'), 0)
    const h = len(root.getAttribute('height'), 0)
    if (w && h && w > 0 && h > 0) viewBox = `0 0 ${num(w, 3)} ${num(h, 3)}`
  }
  const mark = markFor(svg)
  prefixIds(root, mark)
  // the placement first (zeros here, the box at each use), then whatever else the root carries (inherited paint, its
  // prefixed id)
  const rest = Array.from(root.attributes)
    .filter(a => a.namespaceURI || !ROOT_DROPPED.has(a.localName ?? a.name))
    .map(a => ({ ns: a.namespaceURI, name: a.name, value: a.value }))
  for (const a of Array.from(root.attributes)) root.removeAttributeNode(a)
  for (const k of ['x', 'y', 'width', 'height']) root.setAttribute(k, '0')
  if (viewBox) root.setAttribute('viewBox', viewBox)
  root.setAttribute('preserveAspectRatio', 'none')
  for (const a of rest) {
    if (!a.ns && a.name === 'style') {
      const kept = splitDeclarations(a.value).filter(d => !ROOT_DROPPED.has(d.prop))
      if (kept.length) root.setAttribute('style', kept.map(d => `${d.prop}:${d.value}${d.important ? ' !important' : ''}`).join(';'))
    } else root.setAttributeNS(a.ns, a.name, a.value)
  }
  const out = serializeSvg(root, false)
  if (!out.startsWith(HEAD)) throw new Error('This SVG could not be inlined.')
  const tail = out.slice(HEAD.length)
  return { tail, mark, size: tail.length }
}
/** What a fragment's root loses inline: its own placement (the layer box replaces it), overflow, filter and transform. */
const ROOT_DROPPED = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'overflow', 'filter', 'transform'])
