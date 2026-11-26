import type { Box } from './geometry'
import { INKSCAPE_NS, MAX_RULE_DECLARATIONS, PRESENTATION, XLINK_NS, allElements, cleanSvgRoot, cleanValue, serializeSvg, simpleSelector } from './svgClean'
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

/** `font: italic bold 12px/1.2 Arial` as its longhands. */
function expandFont(v: string): Decl[] {
  const m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{3})\s+)*)([\d.]+[a-z%]*)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(v)
  if (!m) return []
  const out: Decl[] = [{ prop: 'font-size', value: m[2], important: false }, { prop: 'font-family', value: m[3], important: false }]
  for (const w of m[1].trim().split(/\s+/).filter(Boolean)) {
    if (/^(italic|oblique)$/i.test(w)) out.push({ prop: 'font-style', value: w, important: false })
    else if (/^(bold|bolder|lighter|\d{3})$/i.test(w)) out.push({ prop: 'font-weight', value: w, important: false })
  }
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
/** Candidate checks one style sheet may take to apply its rules; past this, the SVG is refused. */
export const MAX_STYLE_STEPS = 2_000_000

/**
 * Applies the simple <style> rules (element, .class, #id and chains of up to 4 of them on one element) as
 * attributes, then drops the style elements. Specificity orders the rules (id, then class, then element, later rules
 * winning ties); rules beat presentation attributes and the inline style attribute beats rules, as in a browser.
 * A rule with any other selector, or more than 64 declarations once each property is kept once, isn't applied
 * (cleanSvg has already dropped such rules with a note; `note` hears about any left). Every declaration is checked on
 * its own (safeDecl) before it's written, so two can never be stitched into a third.
 *
 * Rules are indexed by an id, class or element of their selector, so each element checks only the rules that could
 * match it, and a check looks at the element alone (at most 4 parts). All candidate checks are counted before any
 * is made, against MAX_STYLE_STEPS; past it, the SVG is refused.
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
      f = { tag: el.localName, id: el.getAttribute('id'), classes: new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) }
      facts.set(el, f)
    }
    return f
  }
  // every candidate check is a step: count them all first, so a sheet that asks too much is refused before any work
  if (indexed) {
    let steps = 0
    for (const el of all) {
      if (!el.parentNode) continue
      const f = factsOf(el)
      steps += (f.id ? (byId.get(f.id)?.length ?? 0) : 0) + (byTag.get(f.tag)?.length ?? 0)
      for (const c of f.classes) steps += byClass.get(c)?.length ?? 0
      if (steps > MAX_STYLE_STEPS) throw new Error("This SVG's style rules are too complex to apply.")
    }
  }
  // a rule's declarations apply to every element it matches: each is checked once
  const seenDecls = new Map<Decl, Decl[]>()
  const checked = (d: Decl): Decl[] => {
    let out = seenDecls.get(d)
    if (!out) {
      out = (d.prop === 'font' ? expandFont(d.value) : [d]).map(safeDecl).filter((x): x is Decl => x !== null)
      seenDecls.set(d, out)
    }
    return out
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
 * or transform on it could paint outside). Empty when the fragment can't be read, or its style rules are too complex
 * to apply.
 */
export function inlineSvg(svg: string, box: Box, prefix: string): string {
  let root: Element
  try {
    root = cleanSvgRoot(svg).root
    applyStyles(root, () => undefined)
  } catch {
    return ''
  }
  let viewBox = root.getAttribute('viewBox')
  if (!viewBox) {
    // as an image, a fragment without a viewBox is stretched from its own size
    const w = len(root.getAttribute('width'), 0)
    const h = len(root.getAttribute('height'), 0)
    if (w && h && w > 0 && h > 0) viewBox = `0 0 ${num(w, 3)} ${num(h, 3)}`
  }
  prefixIds(root, prefix)
  // the placement first, then whatever else the fragment's root carries (inherited paint, its prefixed id)
  const rest = Array.from(root.attributes)
    .filter(a => a.namespaceURI || !ROOT_DROPPED.has(a.localName ?? a.name))
    .map(a => ({ ns: a.namespaceURI, name: a.name, value: a.value }))
  for (const a of Array.from(root.attributes)) root.removeAttributeNode(a)
  root.setAttribute('x', num(box.x))
  root.setAttribute('y', num(box.y))
  root.setAttribute('width', num(box.w))
  root.setAttribute('height', num(box.h))
  if (viewBox) root.setAttribute('viewBox', viewBox)
  root.setAttribute('preserveAspectRatio', 'none')
  for (const a of rest) {
    if (!a.ns && a.name === 'style') {
      const kept = splitDeclarations(a.value).filter(d => !ROOT_DROPPED.has(d.prop))
      if (kept.length) root.setAttribute('style', kept.map(d => `${d.prop}:${d.value}${d.important ? ' !important' : ''}`).join(';'))
    } else root.setAttributeNS(a.ns, a.name, a.value)
  }
  return serializeSvg(root, false)
}
/** What a fragment's root loses inline: its own placement (the layer box replaces it), overflow, filter and transform. */
const ROOT_DROPPED = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'overflow', 'filter', 'transform'])
