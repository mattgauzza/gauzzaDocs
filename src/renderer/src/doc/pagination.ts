import { Extension } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

/**
 * Google Docs style pages while you type. The document stays one ProseMirror document (selection, undo and agent
 * ops are untouched); after each change one animation frame measures where the top-level blocks fall and puts a
 * widget before each block that would cross the bottom of a page. The widget fills the rest of that page, draws the
 * gap between sheets, and the next page's top margin, so the block starts at the top of the next page.
 *
 * Geometry (CSS px at 100%): Letter 816 x 1056, 1in (96px) margins -> 864px of text per page, 24px between pages.
 */
export const PAGE_H = 1056
export const MARGIN = 96
export const GAP = 24
export const CONTENT_H = PAGE_H - 2 * MARGIN
// Layout rounds sizes to 1/64 of a device pixel; at 125% display scaling or a zoomed page that is not 1/64 CSS px.
let unit = 64
const snap = (px: number) => Math.round(px * unit) / unit

export interface PageBreakAt {
  pos: number // document position the widget sits at (start of the block that begins the new page)
  fill: number // empty space left at the bottom of the previous page, above its margin
}
export interface PageInfo {
  pages: number
  breaks: number[] // positions where pages 2.. start
}

interface PState {
  deco: DecorationSet
  breaks: PageBreakAt[]
  pageless: boolean
}

export const paginationKey = new PluginKey<PState>('pagination')

function widget(fill: number, page: number) {
  const el = document.createElement('div')
  el.className = 'gd-page-gap'
  el.contentEditable = 'false'
  el.style.height = `${fill + MARGIN + GAP + MARGIN}px`
  el.innerHTML =
    `<div class="gd-page-fill" style="height:${fill + MARGIN}px"></div>` +
    `<div class="gd-page-sep" style="height:${GAP}px"></div>` +
    `<div class="gd-page-top" style="height:${MARGIN}px"><span>${page}</span></div>`
  return el
}

function decorate(doc: EditorState['doc'], breaks: PageBreakAt[]) {
  return DecorationSet.create(
    doc,
    breaks.map((b, i) =>
      // The key ties the DOM to (page, fill) so ProseMirror reuses widgets that did not change.
      Decoration.widget(b.pos, () => widget(b.fill, i + 2), { side: -1, ignoreSelection: true, key: `pg${i}-${Math.round(b.fill)}`, fill: b.fill })
    )
  )
}

const sameBreaks = (a: PageBreakAt[], b: PageBreakAt[]) =>
  a.length === b.length && a.every((x, i) => x.pos === b[i].pos && Math.abs(x.fill - b[i].fill) < 0.5)

/** Measures the laid-out document and works out where pages must break. */
function measure(view: EditorView, current: PState): PageBreakAt[] | null {
  const root = view.dom as HTMLElement
  if (!root.offsetParent || root.offsetHeight === 0) return null // hidden tab: measure again when shown
  // Widgets already in the flow push blocks down; subtract them to get each block's position in plain text flow.
  const widgetBefore: { pos: number; height: number }[] = current.breaks.map(b => ({ pos: b.pos, height: b.fill + MARGIN + GAP + MARGIN }))
  const blocks: { pos: number; top: number; bottom: number; manualBreak: boolean }[] = []
  const rootTop = root.getBoundingClientRect().top
  const scale = root.getBoundingClientRect().height / (root.offsetHeight || 1) || 1 // CSS zoom on the page
  unit = 64 * (window.devicePixelRatio || 1) * scale
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null
    if (!dom || dom.nodeType !== 1) return
    const r = dom.getBoundingClientRect()
    let shift = 0
    for (const w of widgetBefore) if (w.pos <= offset) shift += w.height
    const style = getComputedStyle(dom)
    const mt = parseFloat(style.marginTop) || 0
    const mb = parseFloat(style.marginBottom) || 0
    const top = (r.top - rootTop) / scale - shift
    blocks.push({ pos: offset, top: top - mt, bottom: top + r.height / scale + mb, manualBreak: node.type.name === 'pageBreak' })
  })

  const breaks: PageBreakAt[] = []
  let pageStart = 0 // in text-flow px
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const prev = blocks[i - 1]
    if (prev?.manualBreak || (b.bottom - pageStart > CONTENT_H + 0.5 && b.top > pageStart + 0.5)) {
      // Layout snaps heights to 1/64 px; round the fill the same way and carry the remainder into the next page,
      // so page edges stay on the 1080px grid however long the document gets.
      const exact = Math.max(0, pageStart + CONTENT_H - b.top)
      const fill = snap(exact)
      breaks.push({ pos: b.pos, fill })
      pageStart = b.top - (fill - exact)
    }
    // A block taller than a page (a long table) cannot be split here: it runs over, and the next page starts after it.
    while (b.bottom - pageStart > CONTENT_H + 0.5 && b.top <= pageStart + 0.5 && b.bottom - b.top > CONTENT_H) {
      pageStart += CONTENT_H
      if (pageStart >= b.bottom) break
    }
  }
  return breaks
}

export interface PaginationOptions {
  onPages: (info: PageInfo) => void
}

export const Pagination = Extension.create<PaginationOptions>({
  name: 'pagination',
  addOptions() {
    return { onPages: () => {} }
  },
  addProseMirrorPlugins() {
    const onPages = this.options.onPages
    let frame = 0
    let lastInfo = ''
    const report = (st: PState) => {
      const info: PageInfo = { pages: st.pageless ? 1 : st.breaks.length + 1, breaks: st.pageless ? [] : st.breaks.map(b => b.pos) }
      const key = JSON.stringify(info)
      if (key !== lastInfo) {
        lastInfo = key
        onPages(info)
      }
    }
    return [
      new Plugin<PState>({
        key: paginationKey,
        state: {
          init: () => ({ deco: DecorationSet.empty, breaks: [], pageless: false }),
          apply(tr: Transaction, value: PState): PState {
            const meta = tr.getMeta(paginationKey) as { breaks?: PageBreakAt[]; pageless?: boolean } | undefined
            if (meta?.pageless !== undefined) return { deco: DecorationSet.empty, breaks: [], pageless: meta.pageless }
            if (meta?.breaks) return { ...value, breaks: meta.breaks, deco: decorate(tr.doc, meta.breaks) }
            if (!tr.docChanged) return value
            // Keep widgets where they were (mapped) until the next measurement replaces them.
            const breaks = value.breaks.map(b => ({ ...b, pos: tr.mapping.map(b.pos, -1) }))
            return { ...value, breaks, deco: value.deco.map(tr.mapping, tr.doc) }
          }
        },
        props: { decorations: state => paginationKey.getState(state)?.deco },
        view: view => {
          const schedule = () => {
            if (frame) return
            frame = requestAnimationFrame(() => {
              frame = 0
              if ((view as any).isDestroyed) return
              const st = paginationKey.getState(view.state)!
              if (st.pageless) return report(st)
              const next = measure(view, st)
              if (next && !sameBreaks(next, st.breaks)) view.dispatch(view.state.tr.setMeta(paginationKey, { breaks: next }).setMeta('addToHistory', false))
              else report(st)
            })
          }
          // Re-measure when fonts or images finish loading, and when the tab becomes visible again.
          const onLoad = () => schedule()
          view.dom.addEventListener('load', onLoad, true)
          document.fonts?.ready.then(onLoad).catch(() => {})
          const ro = new ResizeObserver(onLoad)
          ro.observe(view.dom as HTMLElement)
          schedule()
          return {
            update: (v, prev) => {
              const st = paginationKey.getState(v.state)!
              if (v.state.doc !== prev.doc || paginationKey.getState(prev) !== st) schedule()
              if (paginationKey.getState(prev)?.breaks !== st.breaks) report(st)
            },
            destroy: () => {
              cancelAnimationFrame(frame)
              frame = 0
              view.dom.removeEventListener('load', onLoad, true)
              ro.disconnect()
            }
          }
        }
      })
    ]
  }
})

/** Page (1-based) that a document position falls on, given the break positions. */
export function pageAt(breaks: number[], pos: number) {
  let page = 1
  for (const b of breaks) if (pos >= b) page++
  return page
}

export const setPageless = (view: EditorView, pageless: boolean) =>
  view.dispatch(view.state.tr.setMeta(paginationKey, { pageless }).setMeta('addToHistory', false))
