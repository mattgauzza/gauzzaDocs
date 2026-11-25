import type { PdfEdit } from '../types'
import { textWidth } from './wrap'
import { baseFontName } from './fontNames'

/**
 * Lines of text on a PDF page, with their boxes, for editing text that is already in the PDF. Isomorphic: works with
 * the pdf.js page proxy in the window (browser build) and in Node (legacy build).
 *
 * Coordinates are display points from the page's top-left (after its rotation), like every PdfEdit. Only horizontal
 * text is returned; rotated or vertical runs can't be edited in place.
 */
export type FontFamily = 'sans' | 'serif' | 'mono'

export interface PdfLine {
  id: string // "<page>:<index>", stable for the same file
  page: number
  x: number
  y: number // top
  w: number
  h: number
  base: number // baseline (display y)
  size: number // font size in points
  text: string
  font: FontFamily
  bold: boolean
  italic: boolean
  fontName?: string // the PDF's own font name, subset prefix dropped
}

interface PdfJsItem { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }
interface PdfJsStyle { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean }
export interface PdfJsPageLike {
  getViewport(o: { scale: number }): { transform: number[]; width: number; height: number }
  getTextContent(): Promise<{ items: unknown[]; styles?: Record<string, PdfJsStyle> }>
  getOperatorList?(): Promise<unknown>
  commonObjs?: { has(id: string): boolean; get(id: string): unknown }
}

type M = number[]
export const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
]
const r2 = (n: number) => Math.round(n * 100) / 100

/** Best guess at a standard font for a PDF font, from its real name and what pdf.js knows about it. */
export function guessFont(info: { name?: string; family?: string; bold?: boolean; italic?: boolean; mono?: boolean; serif?: boolean }) {
  const name = (info.name || '').replace(/^[A-Z]{6}\+/, '') // drop the subset prefix "ABCDEF+"
  const fam = (info.family || '').toLowerCase()
  const bold = !!info.bold || /bold|black|heavy|semibold|demi|extrabold|-bd\b|,bd\b/i.test(name)
  const italic = !!info.italic || /italic|oblique|-it\b|,it\b|slant/i.test(name)
  let font: FontFamily = 'sans'
  if (info.mono || /courier|mono|consol|menlo|inconsolata|code|typewriter/i.test(name) || fam === 'monospace') font = 'mono'
  else if (/sans|arial|helvet|verdana|calibri|segoe|roboto|inter|open ?sans|lato|tahoma|trebuchet|futura|gill/i.test(name)) font = 'sans'
  else if (info.serif || /times|serif|georgia|garamond|roman|cambria|book|minion|palatino|baskerville|caslon|century|didot|bodoni|charter/i.test(name) || fam === 'serif')
    font = 'serif'
  return { font, bold, italic }
}

/** What the window/Node pdf.js knows about a loaded font (name, bold, italic...), if it has been loaded. */
function fontInfo(page: PdfJsPageLike, id: string | undefined) {
  if (!id || !page.commonObjs) return {}
  try {
    if (!page.commonObjs.has(id)) return {}
    const f = page.commonObjs.get(id) as { name?: string; fallbackName?: string; bold?: boolean; italic?: boolean; black?: boolean; isMonospace?: boolean; isSerifFont?: boolean }
    return { name: f?.name || f?.fallbackName, bold: f?.bold || f?.black, italic: f?.italic, mono: f?.isMonospace, serif: f?.isSerifFont }
  } catch {
    return {}
  }
}

export async function pageLines(page: PdfJsPageLike, pageNo: number, opts: { loadFonts?: boolean } = {}): Promise<PdfLine[]> {
  if (opts.loadFonts && page.getOperatorList) {
    try {
      await page.getOperatorList() // makes the real font names available in commonObjs
    } catch { /* fonts stay unknown; the family from styles still helps */ }
  }
  const vp = page.getViewport({ scale: 1 })
  const { items, styles = {} } = await page.getTextContent()
  type Run = { s: string; x: number; base: number; w: number; size: number; top: number; bottom: number; fontName?: string }
  const runs: Run[] = []
  for (const raw of items as PdfJsItem[]) {
    if (typeof raw.str !== 'string' || !raw.transform || !raw.str.length) continue
    const t = mul(vp.transform, raw.transform)
    const size = Math.hypot(t[2], t[3])
    if (!size || Math.abs(Math.atan2(t[1], t[0])) > 0.02) continue // rotated or vertical text: not editable in place
    const st = styles[raw.fontName || ''] || {}
    if (st.vertical) continue
    const ascent = typeof st.ascent === 'number' && st.ascent > 0 ? st.ascent : 0.8
    const descent = typeof st.descent === 'number' && st.descent < 0 ? st.descent : -0.2
    const base = t[5]
    runs.push({ s: raw.str, x: t[4], base, w: (raw.width || 0) * Math.hypot(vp.transform[0], vp.transform[1]), size, top: base - ascent * size, bottom: base - descent * size, fontName: raw.fontName })
  }
  runs.sort((a, b) => a.base - b.base || a.x - b.x)

  type Line = { runs: Run[]; base: number; size: number; right: number }
  const lines: Line[] = []
  for (const r of runs) {
    // Whitespace runs carry nothing visible, and pdf.js stretches one across a gap between columns on the same
    // baseline, which would join them into one line. Word spacing comes back from the gaps below.
    if (!r.s.trim()) continue
    const line = lines.find(l =>
      Math.abs(l.base - r.base) <= Math.min(l.size, r.size) * 0.35 &&
      Math.abs(l.size - r.size) <= Math.max(l.size, r.size) * 0.4 &&
      r.x >= l.runs[0].x - r.size &&
      r.x - l.right <= Math.max(r.size * 1.6, 8) // a wide gap starts a new segment (columns, tab stops)
    )
    if (line) {
      line.runs.push(r)
      line.right = Math.max(line.right, r.x + r.w)
    } else lines.push({ runs: [r], base: r.base, size: r.size, right: r.x + r.w })
  }

  const out = lines
    .map(l => {
      l.runs.sort((a, b) => a.x - b.x)
      let text = ''
      let end = -Infinity
      for (const r of l.runs) {
        if (text && r.x - end > r.size * 0.15 && !text.endsWith(' ') && !r.s.startsWith(' ')) text += ' '
        text += r.s
        end = r.x + r.w
      }
      const x = Math.min(...l.runs.map(r => r.x))
      const top = Math.min(...l.runs.map(r => r.top))
      const bottom = Math.max(...l.runs.map(r => r.bottom))
      const first = l.runs.find(r => r.s.trim()) || l.runs[0]
      const info = fontInfo(page, first.fontName)
      const g = guessFont({ ...info, family: styles[first.fontName || '']?.fontFamily })
      return {
        page: pageNo,
        x: r2(x),
        y: r2(top),
        w: r2(Math.max(...l.runs.map(r => r.x + r.w)) - x),
        h: r2(bottom - top),
        base: r2(l.base),
        size: r2(Math.max(...l.runs.map(r => r.size))),
        text: text.trimEnd(),
        ...g,
        ...(baseFontName(info.name) ? { fontName: baseFontName(info.name) } : {})
      }
    })
    .filter(l => l.text.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x)
  return out.map((l, i) => ({ id: `${pageNo}:${i}`, ...l }))
}

/** A replaceText edit for a line. Colors default to black on white when they can't be sampled (Node, CLI). */
export function lineEdit(line: PdfLine, text: string, colors: { color?: string; bg?: string } = {}): Extract<PdfEdit, { type: 'replaceText' }> {
  return {
    type: 'replaceText',
    page: line.page,
    x: line.x,
    y: line.y,
    w: line.w,
    h: line.h,
    base: line.base,
    text,
    size: line.size,
    font: line.font,
    bold: line.bold,
    italic: line.italic,
    ...(line.fontName ? { fontName: line.fontName } : {}),
    color: colors.color || '#000000',
    bg: colors.bg || '#ffffff'
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const LIST_START = /^([•◦▪‣●○■□*–-]|\d+[.)])\s/

/**
 * Groups a page's lines into paragraphs: lines in a column at the same size and font, with steady spacing between
 * baselines. A list item, a change of size or a short line that ends a sentence starts a new one.
 */
export function paragraphsOf(lines: PdfLine[]): PdfLine[][] {
  const paras: PdfLine[][] = []
  for (const l of [...lines].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const home = paras.find(p => {
      const q = p[p.length - 1]
      if (q.page !== l.page || q.font !== l.font || Math.abs(q.size - l.size) > Math.max(0.6, q.size * 0.08)) return false
      const gap = l.base - q.base
      if (gap < q.size * 0.9 || gap > q.size * 1.9) return false
      if (p.length > 1 && Math.abs(gap - (p[1].base - p[0].base)) > q.size * 0.3) return false
      const left = p.length > 1 ? Math.min(...p.slice(1).map(x => x.x)) : q.x
      // Same left edge, or a first line indented by up to a few characters.
      if (Math.abs(l.x - left) > q.size * 0.75 && !(p.length === 1 && l.x < q.x && q.x - l.x < q.size * 3)) return false
      if (LIST_START.test(l.text.trim())) return false
      const widest = Math.max(...p.map(x => x.x + x.w)) - Math.min(...p.map(x => x.x))
      if (q.x + q.w - Math.min(...p.map(x => x.x)) < widest * 0.6 && /[.!?:"”']$/.test(q.text.trim())) return false
      return true
    })
    if (home) home.push(l)
    else paras.push([l])
  }
  return paras
}

export interface ReplacePlan {
  line: PdfLine
  text: string
  count: number
  para?: PdfLine[] // the whole paragraph is rewritten (and rewrapped) with text
}

/**
 * Plans a find-and-replace on existing PDF text. A match inside one line changes that line, as long as the new words
 * still fit the paragraph's width. A match that runs across lines, or new words that no longer fit, rewrite the whole
 * paragraph, wrapped to its old width and spacing.
 */
export function planReplace(lines: PdfLine[], find: string, withText: string, opts: { all?: boolean } = {}): ReplacePlan[] {
  if (!find) throw new Error('replaceText needs "find"')
  const re = new RegExp(escapeRe(find), opts.all ? 'g' : '')
  const paras = paragraphsOf(lines)
  const paraOf = new Map<PdfLine, PdfLine[]>()
  for (const p of paras) for (const l of p) paraOf.set(l, p)
  const out: ReplacePlan[] = []
  const done = new Set<PdfLine[]>()
  const right = (p: PdfLine[]) => Math.max(...p.map(l => l.x + l.w))

  for (const line of lines) {
    if (!line.text.includes(find)) continue
    const count = opts.all ? line.text.split(find).length - 1 : 1
    const text = line.text.replace(re, () => withText)
    const para = paraOf.get(line)
    if (para && para.length > 1 && textWidth(text, line, line.size) > right(para) - line.x + 1) {
      // Too long for its line now: rewrite the paragraph so the words flow onto the next lines.
      if (!done.has(para)) {
        done.add(para)
        out.push({ line: para[0], para, count, text: norm(para.map(l => (l === line ? text : l.text)).join(' ')) })
      }
    } else out.push({ line, text, count })
    if (!opts.all) return out
  }
  const f = norm(find)
  const re2 = new RegExp(escapeRe(f), opts.all ? 'g' : '')
  for (const para of paras) {
    if (para.length < 2 || done.has(para) || out.some(o => para.includes(o.line))) continue
    const joined = norm(para.map(l => l.text).join(' '))
    if (!joined.includes(f)) continue
    out.push({ line: para[0], para, count: opts.all ? joined.split(f).length - 1 : 1, text: joined.replace(re2, () => withText) })
    if (!opts.all) return out
  }
  if (!out.length) {
    if (norm(lines.map(l => l.text).join(' ')).includes(f))
      throw new Error(`"${find}" runs across lines that aren't one paragraph (a heading and the text under it, or two columns). Replace each part separately (gdocs pdf lines shows them).`)
    throw new Error(`"${find}" was not found${lines.length ? ` on page ${lines[0].page}` : ''}`)
  }
  return out
}

/** Edits that rewrite a paragraph: the first line carries the new words, wrapped; the other lines are emptied. */
export function paraEdits(para: PdfLine[], text: string, colors: { color?: string; bg?: string } = {}): Extract<PdfEdit, { type: 'replaceText' }>[] {
  const [first, ...rest] = para
  const gaps = rest.map((l, i) => l.base - para[i].base).sort((a, b) => a - b)
  return [
    {
      ...lineEdit(first, text, colors),
      wrapRight: r2(Math.max(...para.map(l => l.x + l.w)) + 0.5),
      hang: rest.length ? r2(Math.min(...rest.map(l => l.x))) : first.x,
      lineHeight: r2(gaps.length ? gaps[Math.floor(gaps.length / 2)] : first.size * 1.2),
      maxLines: para.length + 1
    },
    ...rest.map(l => lineEdit(l, '', colors))
  ]
}

/**
 * Applies a plan to a list of edits: lines edited before are updated in place (matched by position, keeping where
 * they were moved to), new ones are added. colorsOf samples a line's text and background color where it can.
 */
export function applyPlan(edits: PdfEdit[], plan: ReplacePlan[], colorsOf: (l: PdfLine) => { color?: string; bg?: string } = () => ({})): PdfEdit[] {
  const out = [...edits]
  for (const p of plan) {
    const made = p.para ? paraEdits(p.para, p.text, colorsOf(p.para[0])) : [lineEdit(p.line, p.text, colorsOf(p.line))]
    for (const e of made) {
      const i = out.findIndex(x => x.type === 'replaceText' && x.page === e.page && Math.abs(x.x - e.x) < 0.5 && Math.abs(x.y - e.y) < 0.5)
      if (i < 0) out.push(e)
      else {
        const { wrapRight, hang, lineHeight, maxLines } = e
        out[i] = { ...(out[i] as typeof e), text: e.text, ...(wrapRight != null ? { wrapRight, hang, lineHeight, maxLines } : {}) }
      }
    }
  }
  return out
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Rebuilds a document from PDF lines in reading order: paragraphs from line gaps, headings from relative font size,
 * simple bullet and numbered lists. Layout (columns, tables, images) is not reproduced.
 */
export function linesToHtml(pages: PdfLine[][]): string {
  const all = pages.flat()
  if (!all.length) return '<p></p>'
  // Body size: the size covering the most characters.
  const weight = new Map<number, number>()
  for (const l of all) weight.set(Math.round(l.size), (weight.get(Math.round(l.size)) || 0) + l.text.length)
  const body = [...weight].sort((a, b) => b[1] - a[1])[0][0] || 11

  const blocks: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => {
    if (para.length) blocks.push(`<p>${esc(para.join(' ').replace(/\s+/g, ' ').trim())}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map(i => `<li><p>${esc(i)}</p></li>`).join('')}</${list.tag}>`)
    list = null
  }
  const BULLET = /^[•◦▪‣●○■□\-*–]\s+/
  const NUMBER = /^\d{1,3}[.)]\s+/

  for (const lines of pages) {
    // How wide a full line usually is in a line's column (lines starting at the same x, same size): a line that stops
    // well short of that ends its paragraph ("Thanks again," above a name), even without a gap.
    const usual = new Map<PdfLine, number>()
    for (const l of lines) {
      const ws = lines.filter(o => Math.abs(o.x - l.x) < 2 && Math.abs(o.size - l.size) < 1).map(o => o.w).sort((a, b) => a - b)
      usual.set(l, ws.length >= 3 ? ws[Math.floor(ws.length * 0.75)] : 0)
    }
    let prev: PdfLine | null = null
    for (const l of lines) {
      const text = l.text.trim()
      const heading = l.size >= body * 1.6 ? 'h1' : l.size >= body * 1.25 ? 'h2' : null
      const gap = prev ? l.y - (prev.y + prev.h) : Infinity
      const newBlock =
        !prev ||
        gap > Math.max(l.size, prev.size) * 0.6 ||
        Math.abs(l.size - prev.size) > body * 0.15 ||
        Math.abs(l.x - prev.x) > Math.max(l.size, prev.size) * 2 || // jumped to another column
        (prev.w < (usual.get(prev) || 0) * 0.6 && !/-$/.test(prev.text))
      if (heading) {
        flushPara()
        flushList()
        // Consecutive heading lines of the same size are one heading that wrapped.
        const last = blocks[blocks.length - 1]
        if (prev && !newBlock && last?.startsWith(`<${heading}>`)) blocks[blocks.length - 1] = last.replace(`</${heading}>`, ` ${esc(text)}</${heading}>`)
        else blocks.push(`<${heading}>${esc(text)}</${heading}>`)
      } else if (BULLET.test(text) || NUMBER.test(text)) {
        flushPara()
        const tag = BULLET.test(text) ? 'ul' : 'ol'
        if (list && list.tag !== tag) flushList()
        list ??= { tag, items: [] }
        list.items.push(text.replace(BULLET, '').replace(NUMBER, ''))
      } else if (list && !newBlock && prev && l.x > prev.x + 2) {
        list.items[list.items.length - 1] += ` ${text}` // a wrapped list item
      } else {
        if (newBlock) {
          flushPara()
          flushList()
        }
        const last = para[para.length - 1]
        if (last && /[a-z]-$/.test(last) && /^[a-z]/.test(text)) para[para.length - 1] = last.slice(0, -1) + text // re-join a hyphenated wrap
        else para.push(text)
      }
      prev = l
    }
    flushPara()
    flushList()
  }
  return blocks.join('\n') || '<p></p>'
}
