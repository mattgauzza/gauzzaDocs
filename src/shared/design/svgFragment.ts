import type { Box } from './geometry'
import { PRESENTATION, XLINK_NS, allElements, cleanSvgRoot, serializeSvg } from './svgClean'
import { len } from './svgPaint'
import { type Decl, cssBlocks, splitDeclarations } from './svgStyle'
import { num } from './text'

// Cleaned SVG fragments: <style> rules applied as attributes (for import, and so an inlined fragment can't restyle the
// document around it), and an svg layer's fragment inlined into an export with its ids prefixed per layer.

interface Selector { tag: string | null; ids: string[]; classes: string[]; spec: number }

function parseSelector(s: string): Selector | null {
  const m = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(s.trim())
  if (!m || (!m[1] && !m[2])) return null
  const parts = m[2].match(/[.#][\w-]+/g) ?? []
  const ids = parts.filter(p => p[0] === '#').map(p => p.slice(1))
  const classes = parts.filter(p => p[0] === '.').map(p => p.slice(1))
  const tag = m[1] && m[1] !== '*' ? m[1] : null
  return { tag, ids, classes, spec: ids.length * 10000 + classes.length * 100 + (tag ? 1 : 0) }
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

/**
 * Applies the <style> rules as attributes, then drops the style elements. Specificity orders the rules (id, then
 * class, then element, later rules winning ties); rules beat presentation attributes and the inline style attribute
 * beats rules, as in a browser. Only element, class and id selectors (and compounds of them) apply; `note` hears about
 * the rest.
 */
export function applyStyles(root: Element, note: (s: string) => void): void {
  const rules: { sel: Selector; decls: Decl[]; order: number }[] = []
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
        if (sel) rules.push({ sel, decls, order: order++ })
        else note(`A style rule the converter can't apply was skipped (${short(s.trim())})`)
      }
    }
    st.parentNode?.removeChild(st)
  }
  for (const el of allElements(root)) {
    const cls = new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
    const id = el.getAttribute('id')
    const hits = rules
      .filter(r => (!r.sel.tag || r.sel.tag === el.localName) && r.sel.ids.every(i => i === id) && r.sel.classes.every(c => cls.has(c)))
      .sort((a, b) => a.sel.spec - b.sel.spec || a.order - b.order)
    const inline = splitDeclarations(el.getAttribute('style') ?? '')
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

/** Prefixes every id and rewrites every reference to one (href, xlink:href and url() in any attribute or style). */
function prefixIds(root: Element, prefix: string): void {
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes)) {
      const name = a.localName ?? a.name
      if (!a.namespaceURI && name === 'id') a.value = prefix + a.value
      else if (name === 'href' && (!a.namespaceURI || a.namespaceURI === XLINK_NS)) {
        const v = a.value.trim()
        if (v.startsWith('#')) a.value = '#' + prefix + v.slice(1)
      } else if (a.value.includes('url(')) a.value = a.value.replace(/url\(\s*(['"]?)#/g, `url($1#${prefix}`)
    }
  }
}

/**
 * An svg layer's fragment inline, for export: cleaned again (it comes from a file), its style rules applied as
 * attributes, every id prefixed with `prefix`, as a nested <svg> filling `box` and stretched to it the way the layer's
 * image is drawn. Empty when the fragment can't be read.
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
  for (const a of rest) root.setAttributeNS(a.ns, a.name, a.value)
  return serializeSvg(root, false)
}
const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio'])
