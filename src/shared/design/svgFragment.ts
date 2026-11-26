import type { Box } from './geometry'
import { INKSCAPE_NS, PRESENTATION, XLINK_NS, allElements, cleanSvgRoot, cleanValue, serializeSvg } from './svgClean'
import { len } from './svgPaint'
import { type Decl, cssBlocks, splitDeclarations } from './svgStyle'
import { num } from './text'

// Cleaned SVG fragments: <style> rules applied as attributes (for import, and so an inlined fragment can't restyle the
// document around it), and an svg layer's fragment inlined into an export with its ids prefixed per layer.

/** One element, class and id part of a selector. */
interface Compound { tag: string | null; ids: string[]; classes: string[] }
/** Compounds joined by descendant spaces, the last one matching the element itself. */
interface Selector { parts: Compound[]; spec: number }

const COMPOUND = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/

function parseCompound(s: string): Compound | null {
  const m = COMPOUND.exec(s)
  if (!m || (!m[1] && !m[2])) return null
  const parts = m[2].match(/[.#][\w-]+/g) ?? []
  return {
    tag: m[1] && m[1] !== '*' ? m[1] : null,
    ids: parts.filter(p => p[0] === '#').map(p => p.slice(1)),
    classes: parts.filter(p => p[0] === '.').map(p => p.slice(1))
  }
}

function parseSelector(s: string): Selector | null {
  const parts: Compound[] = []
  for (const t of s.trim().split(/\s+/)) {
    const c = t ? parseCompound(t) : null
    if (!c) return null
    parts.push(c)
  }
  const spec = parts.reduce((a, c) => a + c.ids.length * 10000 + c.classes.length * 100 + (c.tag ? 1 : 0), 0)
  return parts.length ? { parts, spec } : null
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

const short = (v: string): string => (v.length > 60 ? v.slice(0, 57) + '...' : v)

/** A font family list with the quotes taken off plain names ('Myriad Pro', Arial), or null when that isn't safe. */
function plainFamilies(v: string): string | null {
  const names = v.split(',').map(p => p.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
  return names.every(n => /^[\w .-]+$/.test(n)) ? names.join(', ') : null
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

/** (xmldom has no firstElementChild.) */
function hasElementChild(el: Element): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return true
  return false
}

interface Rule { sel: Selector; decls: Decl[]; order: number }
/** Facts about an element that rule matching reads, worked out once per element. */
interface Facts { tag: string; id: string | null; classes: Set<string> }
/** Steps one style sheet may take to match its rules (candidates checked and ancestors walked). */
export const MAX_STYLE_STEPS = 2_000_000
/** Past this many entries, an element's set of ancestor ids, classes and tags isn't kept (matching walks instead). */
const MAX_ANCESTOR_TOKENS = 10_000

/**
 * Applies the <style> rules as attributes, then drops the style elements. Specificity orders the rules (id, then
 * class, then element, later rules winning ties); rules beat presentation attributes and the inline style attribute
 * beats rules, as in a browser. Element, class and id selectors apply, alone, compounded or joined by descendant
 * spaces; `note` hears about the rest. Every declaration is checked on its own (safeDecl) before it's written, so two
 * can never be stitched into a third.
 *
 * Rules are indexed by the id, class or element of their last part. Each element's id, classes and tag are read once,
 * and the ids, classes and tags of all its ancestors are gathered top down, so a descendant rule that can't match is
 * skipped without walking up. Candidates checked and ancestors walked count against MAX_STYLE_STEPS; past it, the
 * SVG is refused.
 */
export function applyStyles(root: Element, note: (s: string) => void): void {
  const byId = new Map<string, Rule[]>()
  const byClass = new Map<string, Rule[]>()
  const byTag = new Map<string, Rule[]>()
  const any: Rule[] = []
  const add = (m: Map<string, Rule[]>, k: string, r: Rule) => {
    const list = m.get(k)
    if (list) list.push(r)
    else m.set(k, [r])
  }
  let order = 0
  let descendant = false
  const all = allElements(root)
  for (const st of all.filter(e => e.localName === 'style')) {
    for (const b of cssBlocks(st.textContent ?? '')) {
      if (b.kind === 'at') {
        if (b.name === 'media') note(`Style rules inside @media were not applied (${short(b.prelude)})`)
        continue
      }
      const decls = splitDeclarations(b.body)
      for (const s of b.selector.split(',')) {
        const sel = parseSelector(s)
        if (!sel) {
          note(`A style rule the converter can't apply was skipped (${short(s.trim())})`)
          continue
        }
        if (sel.parts.length > 1) descendant = true
        const rule = { sel, decls, order: order++ }
        const last = sel.parts[sel.parts.length - 1]
        if (last.ids.length) add(byId, last.ids[0], rule)
        else if (last.classes.length) add(byClass, last.classes[0], rule)
        else if (last.tag) add(byTag, last.tag, rule)
        else if (sel.parts.length === 1 && any.length && any[any.length - 1].sel.parts.length === 1 && !any[any.length - 1].sel.spec) {
          // plain * rules match everything the same way: one rule holds them all, in order
          any[any.length - 1].decls = any[any.length - 1].decls.concat(decls)
        } else any.push(rule)
      }
    }
    st.parentNode?.removeChild(st)
  }
  const indexed = byId.size + byClass.size + byTag.size + any.length > 0

  const facts = new Map<Element, Facts>()
  const factsOf = (el: Element): Facts => {
    let f = facts.get(el)
    if (!f) {
      f = { tag: el.localName, id: el.getAttribute('id'), classes: new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) }
      facts.set(el, f)
    }
    return f
  }
  // the ids (#), classes (.) and tags (:) of every ancestor of each element, top down; null when too many to keep
  const above = new Map<Element, Set<string> | null>()
  const below = new Map<Element, Set<string> | null>() // above, plus the element's own
  if (indexed && descendant) {
    let copied = 0 // entries copied into new sets; past the cap, the rest walk instead
    for (const el of all) {
      const p = el.parentNode as Element | null
      const up = p && p.nodeType === 1 ? (below.get(p) ?? null) : new Set<string>()
      above.set(el, up)
      if (!hasElementChild(el)) continue // only children read an element's own set
      const f = factsOf(el)
      const own = [`:${f.tag}`, ...(f.id ? [`#${f.id}`] : []), ...[...f.classes].map(c => `.${c}`)]
      if (up === null || up.size + own.length > MAX_ANCESTOR_TOKENS || copied > MAX_STYLE_STEPS) below.set(el, null)
      else if (own.every(t => up.has(t))) below.set(el, up)
      else {
        const s = new Set(up)
        for (const t of own) s.add(t)
        copied += s.size
        below.set(el, s)
      }
    }
  }

  let steps = 0
  const step = (n = 1) => {
    steps += n
    if (steps > MAX_STYLE_STEPS) throw new Error("This SVG's style rules are too complex to apply.")
  }
  // every candidate check is a step: count them all first, so a sheet that asks too much is refused before any work
  if (indexed) {
    for (const el of all) {
      if (!el.parentNode) continue
      const f = factsOf(el)
      let n = (f.id ? (byId.get(f.id)?.length ?? 0) : 0) + (byTag.get(f.tag)?.length ?? 0) + any.length
      for (const c of f.classes) n += byClass.get(c)?.length ?? 0
      step(n)
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
  const matches = (c: Compound, f: Facts): boolean =>
    (!c.tag || c.tag === f.tag) && c.ids.every(i => i === f.id) && c.classes.every(x => f.classes.has(x))
  const matchesAll = (sel: Selector, el: Element): boolean => {
    if (!matches(sel.parts[sel.parts.length - 1], factsOf(el))) return false
    if (sel.parts.length === 1) return true
    const up = above.get(el)
    if (up) {
      // every part above must find its id, classes and tag somewhere among the ancestors
      for (let j = 0; j < sel.parts.length - 1; j++) {
        const c = sel.parts[j]
        if ((c.tag && !up.has(`:${c.tag}`)) || c.ids.some(i => !up.has(`#${i}`)) || c.classes.some(x => !up.has(`.${x}`))) return false
      }
    }
    let j = sel.parts.length - 2
    for (let n = el.parentNode; n && j >= 0; n = n.parentNode) {
      if (n.nodeType !== 1) continue
      step()
      if (matches(sel.parts[j], factsOf(n as Element))) j--
    }
    return j < 0
  }

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
      take(any)
    }
    const hits = candidates.filter(r => matchesAll(r.sel, el)).sort((a, b) => a.sel.spec - b.sel.spec || a.order - b.order)
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
 * image is drawn. An image paints only inside its box, so the root's own overflow and filter are dropped (a nested svg
 * clips its content by default, but a filter on it could paint outside). Empty when the fragment can't be read, or
 * its style rules are too complex to apply.
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
/** What a fragment's root loses inline: its own placement (the layer box replaces it), overflow and filter. */
const ROOT_DROPPED = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'overflow', 'filter'])
