import type { Box } from './geometry'
import { PRESENTATION, XLINK_NS, allElements, cleanSvgRoot, serializeSvg } from './svgClean'
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

const classesOf = (el: Element): Set<string> => new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
const matches = (c: Compound, el: Element): boolean => {
  if (c.tag && c.tag !== el.localName) return false
  if (c.ids.length && !c.ids.every(i => i === el.getAttribute('id'))) return false
  if (!c.classes.length) return true
  const cls = classesOf(el)
  return c.classes.every(x => cls.has(x))
}
/** The last compound matches the element; the others match ancestors, nearest first. */
function matchesAll(sel: Selector, el: Element): boolean {
  if (!matches(sel.parts[sel.parts.length - 1], el)) return false
  let j = sel.parts.length - 2
  for (let n = el.parentNode; n && j >= 0; n = n.parentNode) {
    if (n.nodeType === 1 && matches(sel.parts[j], n as Element)) j--
  }
  return j < 0
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

interface Rule { sel: Selector; decls: Decl[]; order: number }
/** Rule checks one import may make; past this, the remaining elements get no style rules (and a note says so). */
const MAX_RULE_CHECKS = 2_000_000

/**
 * Applies the <style> rules as attributes, then drops the style elements. Specificity orders the rules (id, then
 * class, then element, later rules winning ties); rules beat presentation attributes and the inline style attribute
 * beats rules, as in a browser. Element, class and id selectors apply, alone, compounded or joined by descendant
 * spaces; `note` hears about the rest. Rules are indexed by the id, class or element of their last part, so each
 * element only checks the rules that could match it.
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
  for (const st of allElements(root).filter(e => e.localName === 'style')) {
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
  let work = 0
  let capped = false
  for (const el of allElements(root)) {
    const inline = splitDeclarations(el.getAttribute('style') ?? '')
    const candidates: Rule[] = []
    const take = (list: Rule[] | undefined) => {
      if (!list) return
      for (const r of list) candidates.push(r)
    }
    if (indexed && !capped) {
      const id = el.getAttribute('id')
      if (id) take(byId.get(id))
      for (const c of classesOf(el)) take(byClass.get(c))
      take(byTag.get(el.localName))
      take(any)
      work += candidates.length
      if (work > MAX_RULE_CHECKS) {
        capped = true
        note('Some style rules were not applied (the style sheet asks for too much matching)')
        candidates.length = 0
      }
    }
    const hits = candidates.filter(r => matchesAll(r.sel, el)).sort((a, b) => a.sel.spec - b.sel.spec || a.order - b.order)
    if (!hits.length && !inline.length) continue
    const final = new Map<string, string>()
    const put = (list: Decl[], important: boolean) => {
      for (const d of list) {
        if (d.important !== important) continue
        if (d.prop === 'font') for (const x of expandFont(d.value)) final.set(x.prop, x.value)
        else final.set(d.prop, d.value)
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

/**
 * Prefixes every id and rewrites every reference to one: href and xlink:href "#id", and url(#id) in any attribute or
 * style. Cleaned input only holds the canonical forms; quotes, spaces and upper case are matched as well regardless.
 */
function prefixIds(root: Element, prefix: string): void {
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes)) {
      const name = a.localName ?? a.name
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
 * image is drawn. An image clips to its box, so the root's own overflow is dropped (a nested svg clips by default).
 * Empty when the fragment can't be read.
 */
export function inlineSvg(svg: string, box: Box, prefix: string): string {
  let root: Element
  try {
    root = cleanSvgRoot(svg).root
  } catch {
    return ''
  }
  applyStyles(root, () => undefined)
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
    .filter(a => a.namespaceURI || !GEOMETRY.has(a.localName ?? a.name))
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
      const kept = splitDeclarations(a.value).filter(d => d.prop !== 'overflow')
      if (kept.length) root.setAttribute('style', kept.map(d => `${d.prop}:${d.value}${d.important ? ' !important' : ''}`).join(';'))
    } else root.setAttributeNS(a.ns, a.name, a.value)
  }
  return serializeSvg(root, false)
}
const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'overflow'])
