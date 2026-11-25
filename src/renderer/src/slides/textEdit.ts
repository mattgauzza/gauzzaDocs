import type { DeckTheme, SlidePara, SlideRun } from '../../../shared/types'
import { cssFont, esc } from '../../../shared/slides/html'

/**
 * Text editing inside a slide element: the paragraphs become a contentEditable box (one <div> per paragraph, its
 * bullet, level and alignment kept as data attributes so Chromium copies them when Enter splits a paragraph), and the
 * DOM is read back into runs with computed styles, so whatever markup execCommand produces comes back right.
 */
const ZW = /​/g

export function editHtml(paras: SlidePara[], theme: DeckTheme) {
  const list = paras.length ? paras : [{ runs: [{ text: '' }] }]
  return list
    .map(p => {
      const size = p.runs[0]?.size || 18
      const attrs = `${p.bullet ? ` data-b="${p.bullet}"` : ''} data-l="${p.level || 0}"${p.align ? ` data-a="${p.align}"` : ''}`
      const runs = p.runs
        .filter(r => r.text)
        .map(r => {
          const css = [
            r.b ? 'font-weight:700' : 'font-weight:400',
            r.i ? 'font-style:italic' : '',
            r.u ? 'text-decoration:underline' : '',
            `color:${r.color || theme.text}`,
            r.size ? `font-size:${r.size}pt` : '',
            r.font ? `font-family:${esc(cssFont(r.font))}` : ''
          ].filter(Boolean)
          return `<span style="${css.join(';')}">${esc(r.text)}</span>`
        })
        .join('')
      const first = p.runs[0]
      const style = `font-size:${size}pt;color:${first?.color || theme.text};${first?.font ? `font-family:${esc(cssFont(first.font))};` : ''}${first?.b ? 'font-weight:700;' : ''}`
      return `<div${attrs} style="${style}">${runs || '<br>'}</div>`
    })
    .join('')
}

const hex = (c: string) => {
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return c.startsWith('#') ? c.toLowerCase() : undefined
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
}
const firstFamily = (f: string) => f.split(',')[0].trim().replace(/^["']|["']$/g, '')

function runOf(el: Element, text: string, defaults: { font: string }): SlideRun {
  const cs = getComputedStyle(el)
  const r: SlideRun = { text }
  if (Number(cs.fontWeight) >= 600) r.b = true
  if (cs.fontStyle === 'italic') r.i = true
  // Underline set on an ancestor shows on the text but is not inherited in computed style; walk up to the box.
  for (let e: Element | null = el; e && !e.hasAttribute('contenteditable'); e = e.parentElement) {
    if (getComputedStyle(e).textDecorationLine.includes('underline')) {
      r.u = true
      break
    }
  }
  const color = hex(cs.color)
  if (color) r.color = color
  r.size = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2
  const font = firstFamily(cs.fontFamily)
  if (font && font !== defaults.font) r.font = font
  return r
}

const same = (a: SlideRun, b: SlideRun) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && a.color === b.color && a.size === b.size && a.font === b.font

/** Reads the edit box back into paragraphs. `font` is the box's default font (runs in it carry no font of their own). */
export function parseEdit(root: HTMLElement, font: string): SlidePara[] {
  const paras: SlidePara[] = []
  const blockOf = (n: Node) => {
    let e: Node | null = n
    while (e && e.parentNode !== root) e = e.parentNode
    return e
  }
  let cur: { block: Node | null; para: SlidePara } | null = null
  const start = (block: Node | null, br = false) => {
    const el = block instanceof HTMLElement ? block : null
    const p: SlidePara = { runs: [] }
    const b = el?.dataset.b
    if (b === 'bullet' || b === 'number') p.bullet = b
    const l = Number(el?.dataset.l || 0)
    if (p.bullet || l) p.level = Math.max(0, Math.min(8, l))
    const a = el?.dataset.a || (el ? getComputedStyle(el).textAlign : '')
    if (a === 'center' || a === 'right') p.align = a
    else if (el?.dataset.a === 'left') p.align = 'left'
    if (br && cur) Object.assign(p, { bullet: cur.para.bullet, level: cur.para.level, align: cur.para.align })
    if (!p.bullet && !p.level) delete p.level
    cur = { block, para: p }
    paras.push(p)
    // An empty paragraph keeps its size and color in one empty run.
    if (el) (cur.para as SlidePara & { _el?: HTMLElement })._el = el
  }
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent || '').replace(ZW, '').replace(/\n/g, ' ')
      const block = blockOf(n)
      if (!cur || cur.block !== block) start(block)
      if (!text) return
      const r = runOf(n.parentElement!, text, { font })
      const last = cur!.para.runs[cur!.para.runs.length - 1]
      if (last && same(last, r)) last.text += r.text
      else cur!.para.runs.push(r)
      return
    }
    if (n.nodeName === 'BR') {
      const block = blockOf(n)
      if (!cur || cur.block !== block) start(block)
      // A trailing <br> only holds an empty line open; one in the middle splits the paragraph.
      if (n.nextSibling || (n.parentNode !== block && n.parentNode?.nextSibling)) start(block, true)
      return
    }
    if (n.parentNode === root && !(n instanceof HTMLElement && /^(DIV|P|LI|H\d)$/.test(n.nodeName))) {
      // Inline content straight in the box (typed after deleting everything): it is a paragraph of its own.
      if (!cur || cur.block !== n) start(n)
    } else if (n.parentNode === root) start(n)
    for (const c of [...n.childNodes]) walk(c)
  }
  for (const c of [...root.childNodes]) walk(c)
  for (const p of paras as (SlidePara & { _el?: HTMLElement })[]) {
    if (!p.runs.length) {
      const el = p._el && p._el.isConnected ? p._el : root
      p.runs = [{ ...runOf(el, '', { font }), text: '' }]
    }
    delete p._el
  }
  return paras.length ? paras : [{ runs: [{ ...runOf(root, '', { font }), text: '' }] }]
}

/** The paragraph <div>s the selection touches (or the caret's). */
export function selectedBlocks(root: HTMLElement): HTMLElement[] {
  const sel = getSelection()
  const blocks = [...root.children] as HTMLElement[]
  if (!sel || !sel.rangeCount) return blocks
  const r = sel.getRangeAt(0)
  if (!root.contains(r.commonAncestorContainer)) return blocks
  const hit = blocks.filter(b => r.intersectsNode(b))
  return hit.length ? hit : blocks
}

/** Font size (pt) on the selected text: execCommand only knows sizes 1-7, so mark with 7 and restyle the marks. */
export function setSelectionSize(root: HTMLElement, pt: number) {
  const sel = getSelection()
  if (!sel || sel.isCollapsed) {
    for (const b of selectedBlocks(root)) {
      b.style.fontSize = `${pt}pt`
      for (const e of b.querySelectorAll<HTMLElement>('[style*="font-size"]')) e.style.fontSize = `${pt}pt`
    }
    return
  }
  document.execCommand('styleWithCSS', false, 'true')
  document.execCommand('fontSize', false, '7')
  for (const e of root.querySelectorAll<HTMLElement>('font[size="7"]')) {
    e.removeAttribute('size')
    e.style.fontSize = `${pt}pt`
  }
  for (const e of root.querySelectorAll<HTMLElement>('[style*="xxx-large"], [style*="-webkit-xxx-large"]')) e.style.fontSize = `${pt}pt`
}

/** Style of the text at the caret, for the toolbar. */
export function caretStyle(root: HTMLElement, font: string) {
  const sel = getSelection()
  let n: Node | null = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null
  if (!n || !root.contains(n)) n = root.querySelector('span') || root
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement!
  const r = runOf(el, '', { font })
  const block = (() => {
    let e: Node | null = el
    while (e && e.parentNode !== root) e = e.parentNode
    return e instanceof HTMLElement ? e : null
  })()
  return {
    ...r,
    font: r.font || font,
    bullet: (block?.dataset.b as SlidePara['bullet']) || undefined,
    align: (block?.dataset.a as SlidePara['align']) || 'left'
  }
}
