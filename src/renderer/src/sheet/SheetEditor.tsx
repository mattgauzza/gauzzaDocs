import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applySheetOp, display, sheetToCsv, toCell, usedRange } from '../../../shared/ops/sheet'
import { type Range, addr, colName, inRange, norm, parseAddr, parseRange, rangeStr } from '../../../shared/sheet/address'
import { parseCsv, writeCsv } from '../../../shared/sheet/csv'
import { formatValue } from '../../../shared/sheet/format'
import { FUNCTION_NAMES, formulaRefs, recalc, shiftFormula } from '../../../shared/sheet/formula'
import type { AgentOp, Cell, CellStyle, Sheet, Workbook } from '../../../shared/types'
import { type MergeMode, type SheetChart, chartData, chartSvg, conditionalStyle, expandToMerges, mergeAt, mergedStyle } from '../../../shared/sheet/extras'
import type { EditorHandle, EditorProps, MenuItem } from '../editor'
import { CfPanel, ChartBox, ChartPanel } from './Panels'
import { CH, DEF_H, DEF_W, REF_COLORS, RH, type Snap, applySnap, bumpDecimals, dims, hasFormulas, makeAxis, makeSnap, used } from './layout'
import './sheet.css'
import { SHEET_ZOOMS, stepZoom } from '../shell/zoom'

type Pos = { r: number; c: number }
interface EditState { r: number; c: number; text: string; mode: 'type' | 'edit'; bar?: boolean; orig: string }
interface CtxMenu { x: number; y: number; items: MenuItem[] }
interface Clip { text: string; sheet: number; range: Range; cells: (Cell | undefined)[][]; cut: boolean }

const P: Record<string, string> = {
  undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
  redo: 'M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z',
  bold: 'M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z',
  italic: 'M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z',
  strike: 'M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z',
  underline: 'M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z',
  color: 'M11 3 5.5 17h2.25l1.12-3h6.25l1.12 3h2.25L13 3h-2zm-1.38 9L12 5.67 14.38 12H9.62z',
  fill: 'M16.56 8.94 7.62 0 6.21 1.41l2.38 2.38-5.15 5.15c-.59.59-.59 1.54 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10 10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z',
  left: 'M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z',
  center: 'M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z',
  right: 'M3 21h18v-2H3v2zm6-4h12v-2H9v2zm-6-4h18v-2H3v2zm6-4h12V7H9v2zM3 3v2h18V3H3z',
  wrap: 'M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z',
  sigma: 'M18 4H6v2l6.5 6L6 18v2h12v-3h-7l5-5-5-5h7z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  freeze: 'M3 3h18v2H3zm0 4h2v14H3zm4 0h14v14H7zm2 2v10h10V9z',
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  down: 'M7 10l5 5 5-5z'
}
const EXTRA_ICONS = {
  merge: 'M3 5h2v14H3zm16 0h2v14h-2zM6 11h2.6L7 9.4 8.4 8l4 4-4 4L7 14.6 8.6 13H6zm12 2h-2.6l1.6 1.6-1.4 1.4-4-4 4-4 1.4 1.4-1.6 1.6H18z',
  chart: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
  palette: 'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z'
}
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d={d} /></svg>
)

const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#efefef', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'
]
const NUM_FORMATS: { label: string; fmt: string; sample: string }[] = [
  { label: 'Automatic', fmt: 'general', sample: '' },
  { label: 'Number', fmt: '#,##0.00', sample: '1,000.12' },
  { label: 'Percent', fmt: '0.00%', sample: '10.12%' },
  { label: 'Currency', fmt: '$#,##0.00', sample: '$1,000.12' },
  { label: 'Date', fmt: 'date', sample: '9/26/2008' },
  { label: 'Date time', fmt: 'datetime', sample: '9/26/2008 15:59:00' }
]
const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36]

/** What the cell shows in the editor / formula bar. */
function rawText(c: Cell | undefined): string {
  if (!c) return ''
  if (c.f) return '=' + c.f
  if (c.v == null) return ''
  if (typeof c.v === 'number') {
    const f = c.s?.fmt || ''
    if (f === 'date' || f === 'datetime') return display(c)
    if (f.includes('%')) return Number((c.v * 100).toPrecision(15)) + '%'
    return String(c.v)
  }
  if (typeof c.v === 'boolean') return c.v ? 'TRUE' : 'FALSE'
  return c.v
}

const isErr = (c: Cell | undefined) => !!c?.f && typeof c.v === 'string' && c.v.startsWith('#')
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const lumCache = new Map<string, boolean>()
/** Is a #rrggbb color light enough to need dark text? */
function lightBg(hex: string): boolean {
  let v = lumCache.get(hex)
  if (v === undefined) {
    const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)
    v = m ? 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) > 150 : true
    if (lumCache.size > 500) lumCache.clear()
    lumCache.set(hex, v)
  }
  return v
}

export default function SheetEditor(props: EditorProps) {
  const initial: Workbook =
    props.payload.kind === 'sheet' && props.payload.workbook.sheets.length ? props.payload.workbook : { sheets: [{ name: 'Sheet1', cells: {} }] }
  const wbRef = useRef<Workbook>(initial)
  const [, setVer] = useState(0)
  const bump = () => setVer(v => v + 1)
  const [active, setActiveState] = useState(0)
  const activeRef = useRef(0)
  const setActive = (i: number) => {
    activeRef.current = i
    setActiveState(i)
  }
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 })
  const [focus, setFocus] = useState<Pos>({ r: 0, c: 0 })
  const [edit, setEdit] = useState<EditState | null>(null)
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const [view, setView] = useState({ w: 900, h: 600 })
  const [zoom, setZoom] = useState(100) // Ctrl+scroll
  const [flash, setFlash] = useState<{ sheet: number; range: Range; key: number } | null>(null)
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const [find, setFind] = useState<{ q: string; rep: string; showRep: boolean; idx: number } | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [resize, setResize] = useState<{ c: number; w: number } | null>(null)
  const [fillTo, setFillTo] = useState<Range | null>(null)
  const [panel, setPanel] = useState<null | { kind: 'cf' } | { kind: 'chart'; id: string }>(null)
  const [chartSel, setChartSel] = useState<string | null>(null)
  const undo = useRef<Snap[]>([])
  const redo = useRef<Snap[]>([])
  const clip = useRef<Clip | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cellInput = useRef<HTMLInputElement>(null)
  const barInput = useRef<HTMLInputElement>(null)
  const nameBox = useRef<HTMLInputElement>(null)
  const refInsert = useRef<{ start: number; len: number; anchor: Pos } | null>(null)

  const wb = wbRef.current
  const si = Math.min(active, wb.sheets.length - 1)
  const sheet = wb.sheets[si]
  const cells = sheet.cells
  const rawSel = norm({ r1: anchor.r, c1: anchor.c, r2: focus.r, c2: focus.c })
  // a selection always covers whole merged blocks, like Sheets
  const sel = sheet.merges?.length ? expandToMerges(sheet, rawSel) : rawSel
  /** The cell a position stands for: the top-left of its merged block, if it is in one. */
  const origin = (p: Pos): Pos => {
    const m = sheet.merges?.length ? mergeAt(sheet, p.r, p.c) : null
    return m ? { r: m.r1, c: m.c1 } : p
  }
  const d = dims(sheet, Math.max(anchor.r, focus.r), Math.max(anchor.c, focus.c))
  const colWidths = useMemo(
    () => (resize ? { ...sheet.colWidths, [resize.c]: resize.w } : sheet.colWidths),
    [sheet.colWidths, resize]
  )
  const cols = useMemo(() => makeAxis(d.cols, DEF_W, colWidths), [d.cols, colWidths])
  const rows = useMemo(() => makeAxis(d.rows, DEF_H, sheet.rowHeights), [d.rows, sheet.rowHeights])
  const fr = Math.min(sheet.frozen?.rows || 0, d.rows - 1)
  const fc = Math.min(sheet.frozen?.cols || 0, d.cols - 1)
  const FH = rows.pos[fr]
  const FW = cols.pos[fc]

  // ---------------- model changes ----------------
  function setWb(next: Workbook, nextActive = activeRef.current) {
    undo.current.push(makeSnap(wbRef.current, next, activeRef.current))
    if (undo.current.length > 200) undo.current.shift()
    redo.current = []
    wbRef.current = next
    setActive(clampN(nextActive, 0, next.sheets.length - 1))
    bump()
    props.onChange()
  }
  /** Copy-on-write edit of the active sheet (plus any sheet whose formulas may change), then recalc. */
  /**
   * `changed`: ranges whose values changed, so only formulas downstream of them are re-evaluated;
   * 'none' when only formatting/layout changed; omitted to recalculate everything.
   */
  function editSheet(fn: (s: Sheet) => void, changed?: Range[] | 'none', idx = activeRef.current) {
    const cur = wbRef.current
    const next: Workbook = {
      sheets: cur.sheets.map((s, i) => (i === idx || (changed !== 'none' && hasFormulas(s.cells)) ? { ...s, cells: { ...s.cells } } : s))
    }
    fn(next.sheets[idx])
    if (changed !== 'none') recalc(next, changed?.map(range => ({ sheet: idx, range })))
    // sheets whose formulas produced no new results go back to sharing their old map
    next.sheets.forEach((s, i) => {
      const old = cur.sheets[i]
      if (i !== idx && old && s.cells !== old.cells && Object.keys(s.cells).every(k => s.cells[k] === old.cells[k])) next.sheets[i] = old
    })
    setWb(next)
  }
  function runOp(op: AgentOp) {
    const r = applySheetOp(wbRef.current, op, activeRef.current)
    if (r.workbook) setWb(r.workbook, r.activeSheet ?? activeRef.current)
    return r
  }
  function restore(from: Snap[], to: Snap[]) {
    const s = from.pop()
    if (!s) return
    const prev = applySnap(s, wbRef.current)
    to.push(makeSnap(wbRef.current, prev, activeRef.current))
    wbRef.current = prev
    setActive(clampN(s.active, 0, prev.sheets.length - 1))
    setEdit(null)
    bump()
    props.onChange()
  }

  // ---------------- selection / scrolling ----------------
  function ensureVisible(p: Pos) {
    const el = scrollRef.current
    if (!el) return
    const vw = el.clientWidth, vh = el.clientHeight
    if (p.r >= fr) {
      const top = rows.pos[p.r], bot = top + rows.size(p.r)
      if (top < el.scrollTop + FH) el.scrollTop = top - FH
      else if (bot > el.scrollTop + vh - CH) el.scrollTop = bot - (vh - CH)
    }
    if (p.c >= fc) {
      const left = cols.pos[p.c], right = left + cols.size(p.c)
      if (left < el.scrollLeft + FW) el.scrollLeft = left - FW
      else if (right > el.scrollLeft + vw - RH) el.scrollLeft = right - (vw - RH)
    }
  }
  /** One step from p, treating a merged block as a single cell. */
  function step(p: Pos, dr: number, dc: number): Pos {
    const m = sheet.merges?.length ? mergeAt(sheet, p.r, p.c) : null
    let r = p.r + dr, c = p.c + dc
    if (m) {
      if (dr > 0) r = m.r2 + 1
      if (dr < 0) r = m.r1 - 1
      if (dc > 0) c = m.c2 + 1
      if (dc < 0) c = m.c1 - 1
    }
    return origin({ r: Math.max(0, r), c: Math.max(0, c) })
  }
  function select(p: Pos, extend = false) {
    const q = { r: clampN(p.r, 0, 1048575), c: clampN(p.c, 0, 16383) }
    if (!extend) setAnchor(q)
    setFocus(q)
    requestAnimationFrame(() => ensureVisible(q))
  }
  const focusGrid = () => requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  const isEmpty = (r: number, c: number) => {
    const x = cells[addr(r, c)]
    return !x || (x.v == null && !x.f)
  }
  /** Ctrl+arrow: jump to the edge of the data block. */
  function jump(p: Pos, dr: number, dc: number): Pos {
    const u = used(cells)
    const maxR = Math.max(u.rows - 1, 0), maxC = Math.max(u.cols - 1, 0)
    let { r, c } = p
    const step = () => { r += dr; c += dc }
    const inside = () => r >= 0 && c >= 0 && r <= maxR && c <= maxC
    const nextEmpty = () => isEmpty(r + dr, c + dc)
    if (!isEmpty(r, c) && !nextEmpty()) {
      while (inside() && !nextEmpty() && r + dr >= 0 && c + dc >= 0) step()
    } else {
      step()
      while (inside() && isEmpty(r, c)) step()
      if (!inside()) return { r: dr ? (dr > 0 ? Math.max(maxR, p.r) : 0) : p.r, c: dc ? (dc > 0 ? Math.max(maxC, p.c) : 0) : p.c }
    }
    return { r: Math.max(0, r), c: Math.max(0, c) }
  }

  // ---------------- editing ----------------
  function startEdit(mode: 'type' | 'edit', text?: string, bar = false) {
    const at = origin(anchor)
    const c = cells[addr(at.r, at.c)]
    const orig = rawText(c)
    setEdit({ r: at.r, c: at.c, text: text ?? orig, mode, bar, orig })
    ensureVisible(at)
  }
  function commitEdit(move?: [number, number]) {
    const e = edit
    if (!e) return
    setEdit(null)
    refInsert.current = null
    if (e.text !== e.orig) {
      const a = addr(e.r, e.c)
      let text = e.text
      // close unbalanced parentheses like spreadsheets do
      if (text.startsWith('=')) {
        const open = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length
        if (open > 0) text += ')'.repeat(open)
      }
      editSheet(s => {
        const c = toCell(text, s.cells[a])
        if (c) s.cells[a] = c
        else delete s.cells[a]
      }, [{ r1: e.r, c1: e.c, r2: e.r, c2: e.c }])
    }
    if (move) select({ r: Math.max(0, e.r + move[0]), c: Math.max(0, e.c + move[1]) })
    focusGrid()
  }
  const cancelEdit = () => {
    setEdit(null)
    refInsert.current = null
    focusGrid()
  }
  const editingFormula = !!edit && edit.text.startsWith('=')
  /** While typing a formula, is the caret at a spot where a cell reference may go? */
  function canInsertRef(): boolean {
    if (!edit || !edit.text.startsWith('=')) return false
    const el = edit.bar ? barInput.current : cellInput.current
    const pos = el?.selectionStart ?? edit.text.length
    if (refInsert.current) return true
    const before = edit.text.slice(0, pos).trimEnd()
    return /[=(,+\-*/^&<>:;]$/.test(before)
  }
  function insertRef(g: Range) {
    if (!edit) return
    const el = edit.bar ? barInput.current : cellInput.current
    const ref = rangeStr(g)
    let start: number, len: number
    if (refInsert.current) ({ start, len } = refInsert.current)
    else {
      start = el?.selectionStart ?? edit.text.length
      len = 0
    }
    const text = edit.text.slice(0, start) + ref + edit.text.slice(start + len)
    refInsert.current = { start, len: ref.length, anchor: refInsert.current?.anchor ?? { r: g.r1, c: g.c1 } }
    setEdit({ ...edit, text, mode: 'edit' })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + ref.length, start + ref.length)
    })
  }

  // ---------------- styles ----------------
  const curPos = origin(anchor)
  const cur = cells[addr(curPos.r, curPos.c)]
  const curStyle: CellStyle = cur?.s || {}
  function forSel(fn: (a: string, s: Sheet) => void, g = sel) {
    const u = used(cells)
    // whole rows/columns: only touch the used part
    const r2 = Math.min(g.r2, Math.max(u.rows - 1, g.r1, d.rows - 1))
    const c2 = Math.min(g.c2, Math.max(u.cols - 1, g.c1, d.cols - 1))
    return (s: Sheet) => {
      for (let r = g.r1; r <= r2; r++) for (let c = g.c1; c <= c2; c++) fn(addr(r, c), s)
    }
  }
  function applyStyle(patch: Partial<Record<keyof CellStyle, unknown>>) {
    editSheet(forSel((a, s) => {
      const old = s.cells[a]
      const st: CellStyle = { ...old?.s, ...(patch as CellStyle) }
      for (const k of Object.keys(st) as (keyof CellStyle)[]) if (st[k] === undefined || st[k] === null || (st[k] as unknown) === false) delete st[k]
      const next: Cell = { ...old }
      if (Object.keys(st).length) next.s = st
      else delete next.s
      if (next.v === undefined && !next.f && !next.s) delete s.cells[a]
      else s.cells[a] = next
    }), 'none')
  }
  const toggle = (k: 'b' | 'i' | 'u' | 's') => applyStyle({ [k]: !curStyle[k] })
  function clearFormatting() {
    editSheet(forSel((a, s) => {
      const old = s.cells[a]
      if (!old?.s) return
      const { s: _drop, ...rest } = old
      if (rest.v === undefined && !rest.f) delete s.cells[a]
      else s.cells[a] = rest
    }), 'none')
  }
  function clearValues() {
    editSheet(forSel((a, s) => {
      const old = s.cells[a]
      if (!old) return
      if (old.s) s.cells[a] = { s: old.s }
      else delete s.cells[a]
    }), [sel])
  }
  function setFrozen(rowsN: number, colsN: number) {
    editSheet(s => { s.frozen = rowsN || colsN ? { rows: rowsN, cols: colsN } : undefined }, 'none')
  }
  function insertSum() {
    // Σ: sum the numbers above (or left of) the cursor, like Sheets' quick SUM
    const { r, c } = anchor
    let r0 = r - 1
    while (r0 >= 0 && typeof cells[addr(r0, c)]?.v === 'number') r0--
    if (sel.r2 > sel.r1 || sel.c2 > sel.c1) {
      const target = { r: sel.r2 + 1, c: sel.c1 }
      editSheet(s => { for (let cc = sel.c1; cc <= sel.c2; cc++) s.cells[addr(target.r, cc)] = { ...s.cells[addr(target.r, cc)], f: `SUM(${colName(cc)}${sel.r1 + 1}:${colName(cc)}${sel.r2 + 1})` } }, [{ r1: target.r, c1: sel.c1, r2: target.r, c2: sel.c2 }])
      select(target)
      return
    }
    const range = r0 < r - 1 ? `${colName(c)}${r0 + 2}:${colName(c)}${r}` : ''
    setEdit({ r, c, text: `=SUM(${range}`, mode: 'edit', orig: rawText(cur) })
  }

  // ---------------- merged cells, conditional formatting, charts ----------------
  const isMergedSel = !!(sheet.merges?.length && mergeAt(sheet, sel.r1, sel.c1) && (() => { const m = mergeAt(sheet, sel.r1, sel.c1)!; return m.r1 === sel.r1 && m.c1 === sel.c1 && m.r2 === sel.r2 && m.c2 === sel.c2 })())
  const selRange = () => rangeStr({ ...sel, r2: Math.min(sel.r2, d.rows - 1), c2: Math.min(sel.c2, d.cols - 1) })
  function merge(mode: MergeMode) {
    try {
      runOp({ op: 'merge', range: selRange(), mode })
    } catch { /* a single cell: nothing to merge */ }
    setAnchor({ r: sel.r1, c: sel.c1 })
  }
  const unmerge = () => runOp({ op: 'unmerge', range: selRange() })
  function mergeItems(): MenuItem[] {
    const multiR = sel.r2 > sel.r1, multiC = sel.c2 > sel.c1
    return [
      { label: 'Merge all', disabled: !(multiR || multiC), run: () => merge('all') },
      { label: 'Merge vertically', disabled: !multiR, run: () => merge('vertical') },
      { label: 'Merge horizontally', disabled: !multiC, run: () => merge('horizontal') },
      { label: 'Unmerge', disabled: !sheet.merges?.length, run: unmerge }
    ]
  }
  function insertChart() {
    const single = sel.r1 === sel.r2 && sel.c1 === sel.c2
    const g = single ? usedRange(sheet) : { ...sel, r2: Math.min(sel.r2, Math.max(used(cells).rows - 1, sel.r1)), c2: Math.min(sel.c2, Math.max(used(cells).cols - 1, sel.c1)) }
    if (!g) return
    const r = runOp({ op: 'addChart', range: rangeStr(g), type: 'column' })
    const id = (r.result as { id: string }).id
    setChartSel(id)
    setPanel({ kind: 'chart', id })
  }
  const updateChart = (id: string, patch: Partial<SheetChart>) => {
    try {
      runOp({ op: 'updateChart', id, ...patch })
    } catch (e) {
      console.warn(e)
    }
  }
  function deleteChart(id: string) {
    runOp({ op: 'deleteChart', id })
    setChartSel(null)
    setPanel(p => (p?.kind === 'chart' && p.id === id ? null : p))
    focusGrid()
  }
  /** Width/height of a block of columns/rows, also past the end of the laid-out grid. */
  const spanW = (a: number, b: number) => (b < cols.n ? cols.pos[b + 1] - cols.pos[a] : cols.pos[cols.n] - cols.pos[Math.min(a, cols.n)] + (b + 1 - Math.max(a, cols.n)) * DEF_W)
  const spanH = (a: number, b: number) => (b < rows.n ? rows.pos[b + 1] - rows.pos[a] : rows.pos[rows.n] - rows.pos[Math.min(a, rows.n)] + (b + 1 - Math.max(a, rows.n)) * DEF_H)

  // ---------------- structure ----------------
  const rowsSel = () => ({ at: sel.r1 + 1, count: sel.r2 - sel.r1 + 1 })
  const colsSel = () => ({ at: sel.c1 + 1, count: sel.c2 - sel.c1 + 1 })
  const insertRowsAbove = () => runOp({ op: 'insertRows', ...rowsSel() })
  const insertRowsBelow = () => runOp({ op: 'insertRows', at: sel.r2 + 2, count: rowsSel().count })
  const insertColsLeft = () => runOp({ op: 'insertCols', ...colsSel() })
  const insertColsRight = () => runOp({ op: 'insertCols', at: sel.c2 + 2, count: colsSel().count })
  const deleteRows = () => runOp({ op: 'deleteRows', ...rowsSel() })
  const deleteCols = () => runOp({ op: 'deleteCols', ...colsSel() })
  function addSheet() {
    const r = runOp({ op: 'addSheet' })
    setAnchor({ r: 0, c: 0 })
    setFocus({ r: 0, c: 0 })
    return r
  }
  function duplicateSheet(i: number) {
    const cur = wbRef.current
    let name = `Copy of ${cur.sheets[i].name}`
    for (let n = 2; cur.sheets.some(s => s.name === name); n++) name = `Copy of ${cur.sheets[i].name} ${n}`
    const sheets = [...cur.sheets]
    sheets.splice(i + 1, 0, { ...cur.sheets[i], name, cells: { ...cur.sheets[i].cells } })
    setWb({ sheets }, i + 1)
  }
  function moveSheet(i: number, to: number) {
    const cur = wbRef.current
    if (to < 0 || to >= cur.sheets.length) return
    const sheets = [...cur.sheets]
    const [s] = sheets.splice(i, 1)
    sheets.splice(to, 0, s)
    setWb({ sheets }, to)
  }
  function switchSheet(i: number) {
    if (edit) commitEdit()
    setActive(i)
    setAnchor({ r: 0, c: 0 })
    setFocus({ r: 0, c: 0 })
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
      scrollRef.current.scrollLeft = 0
    }
  }

  // ---------------- clipboard ----------------
  function selCells(g: Range) {
    const u = used(cells)
    const r2 = Math.min(g.r2, Math.max(u.rows - 1, g.r1)), c2 = Math.min(g.c2, Math.max(u.cols - 1, g.c1))
    const out: (Cell | undefined)[][] = []
    for (let r = g.r1; r <= r2; r++) {
      const row: (Cell | undefined)[] = []
      for (let c = g.c1; c <= c2; c++) row.push(cells[addr(r, c)])
      out.push(row)
    }
    return { out, range: { ...g, r2, c2 } }
  }
  function copy(e: ClipboardEvent | React.ClipboardEvent, cut = false) {
    const { out, range } = selCells(sel)
    const text = out.map(r => r.map(c => display(c)).join('\t')).join('\n')
    const esc = (s: string) => s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)
    const html = `<table>${out.map(r => `<tr>${r.map(c => `<td${c?.s?.b ? ' style="font-weight:bold"' : ''}>${esc(display(c))}</td>`).join('')}</tr>`).join('')}</table>`
    e.clipboardData?.setData('text/plain', text)
    e.clipboardData?.setData('text/html', html)
    e.preventDefault()
    clip.current = { text, sheet: activeRef.current, range, cells: out, cut }
  }
  function paste(text: string) {
    const c = clip.current
    const target = { r: sel.r1, c: sel.c1 }
    if (c && c.text === text.replace(/\r\n/g, '\n').replace(/\n$/, '')) {
      const h = c.cells.length, w = c.cells[0]?.length || 1
      const fill = h === 1 && w === 1 && (sel.r2 > sel.r1 || sel.c2 > sel.c1)
      const H = fill ? sel.r2 - sel.r1 + 1 : h, W = fill ? sel.c2 - sel.c1 + 1 : w
      editSheet(s => {
        if (c.cut && c.sheet === activeRef.current)
          for (let r = 0; r < h; r++) for (let k = 0; k < w; k++) delete s.cells[addr(c.range.r1 + r, c.range.c1 + k)]
        for (let r = 0; r < H; r++) for (let k = 0; k < W; k++) {
          const src = c.cells[r % h]?.[k % w]
          const a = addr(target.r + r, target.c + k)
          if (!src) { delete s.cells[a]; continue }
          const dr = target.r + r - (c.range.r1 + (r % h)), dc = target.c + k - (c.range.c1 + (k % w))
          s.cells[a] = src.f && !c.cut ? { ...src, f: shiftFormula(src.f, dr, dc) } : { ...src }
        }
      }, [{ r1: target.r, c1: target.c, r2: target.r + H - 1, c2: target.c + W - 1 }, ...(c.cut && c.sheet === activeRef.current ? [c.range] : [])])
      if (c.cut) clip.current = null
      setFocus({ r: target.r + H - 1, c: target.c + W - 1 })
      return
    }
    const grid = parseCsv(text.replace(/\r?\n$/, ''), '\t')
    if (!grid.length) return
    editSheet(s => {
      grid.forEach((row, i) => row.forEach((v, j) => {
        const a = addr(target.r + i, target.c + j)
        const cell = toCell(v, s.cells[a])
        if (cell) s.cells[a] = cell
        else delete s.cells[a]
      }))
    }, [{ r1: target.r, c1: target.c, r2: target.r + grid.length - 1, c2: target.c + Math.max(...grid.map(r => r.length)) - 1 }])
    setFocus({ r: target.r + grid.length - 1, c: target.c + Math.max(...grid.map(r => r.length)) - 1 })
  }

  // ---------------- fill ----------------
  function doFill(src: Range, dst: Range) {
    const h = src.r2 - src.r1 + 1, w = src.c2 - src.c1 + 1
    const vertical = dst.c1 === src.c1 && dst.c2 === src.c2
    editSheet(s => {
      // numeric series per column (vertical) or row (horizontal) when the source has 2+ numbers
      const series = (vals: (Cell | undefined)[]) => {
        if (vals.length < 2 || !vals.every(v => typeof v?.v === 'number' && !v.f)) return null
        const step = (vals[vals.length - 1]!.v as number) - (vals[vals.length - 2]!.v as number)
        return { last: vals[vals.length - 1]!.v as number, step }
      }
      if (vertical) {
        for (let c = src.c1; c <= src.c2; c++) {
          const col = Array.from({ length: h }, (_, i) => s.cells[addr(src.r1 + i, c)])
          const ser = series(col)
          for (let r = dst.r1; r <= dst.r2; r++) {
            if (r >= src.r1 && r <= src.r2) continue
            const a = addr(r, c)
            if (ser) { s.cells[a] = { ...col[0], v: ser.last + ser.step * (r - src.r2) }; continue }
            const k = ((r - src.r1) % h + h) % h
            const from = col[k]
            if (!from) delete s.cells[a]
            else s.cells[a] = from.f ? { ...from, f: shiftFormula(from.f, r - (src.r1 + k), 0) } : { ...from }
          }
        }
      } else {
        for (let r = src.r1; r <= src.r2; r++) {
          const row = Array.from({ length: w }, (_, i) => s.cells[addr(r, src.c1 + i)])
          const ser = series(row)
          for (let c = dst.c1; c <= dst.c2; c++) {
            if (c >= src.c1 && c <= src.c2) continue
            const a = addr(r, c)
            if (ser) { s.cells[a] = { ...row[0], v: ser.last + ser.step * (c - src.c2) }; continue }
            const k = ((c - src.c1) % w + w) % w
            const from = row[k]
            if (!from) delete s.cells[a]
            else s.cells[a] = from.f ? { ...from, f: shiftFormula(from.f, 0, c - (src.c1 + k)) } : { ...from }
          }
        }
      }
    }, [dst])
    setAnchor({ r: dst.r1, c: dst.c1 })
    setFocus({ r: dst.r2, c: dst.c2 })
  }

  // ---------------- find ----------------
  function findMatches(q: string): Pos[] {
    if (!q) return []
    const needle = q.toLowerCase()
    const out: Pos[] = []
    for (const a in cells) {
      const c = cells[a]
      if (display(c).toLowerCase().includes(needle) || c.f?.toLowerCase().includes(needle)) out.push(parseAddr(a)!)
    }
    return out.sort((x, y) => x.r - y.r || x.c - y.c)
  }
  const matches = useMemo(() => (find ? findMatches(find.q) : []), [find?.q, cells])
  function findNext(dir = 1) {
    if (!find || !matches.length) return
    const idx = (find.idx + dir + matches.length) % matches.length
    setFind({ ...find, idx })
    select(matches[idx])
  }
  function replaceAll() {
    if (!find?.q) return
    const re = new RegExp(find.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    editSheet(s => {
      for (const a in s.cells) {
        const c = s.cells[a]
        if (c.f || typeof c.v !== 'string' || !re.test(c.v)) continue
        re.lastIndex = 0
        const next = toCell(c.v.replace(re, find.rep), c)
        if (next) s.cells[a] = next
        else delete s.cells[a]
      }
    })
  }

  // ---------------- keyboard ----------------
  function onGridKey(e: React.KeyboardEvent) {
    if (edit || (e.target as HTMLElement) !== scrollRef.current) return
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key
    if (chartSel && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); deleteChart(chartSel); return }
    if (chartSel && k === 'Escape') { setChartSel(null); return }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (arrows[k]) {
      e.preventDefault()
      const [dr, dc] = arrows[k]
      const from = e.shiftKey ? focus : anchor
      const to = ctrl ? jump(from, dr, dc) : step(from, dr, dc)
      select(to, e.shiftKey)
      return
    }
    if (k === 'Tab' || k === 'Enter') {
      e.preventDefault()
      if (k === 'Enter' && !e.shiftKey && false) return
      const [dr, dc] = k === 'Tab' ? [0, e.shiftKey ? -1 : 1] : [e.shiftKey ? -1 : 1, 0]
      select(step(anchor, dr, dc))
      return
    }
    if (k === 'Home') {
      e.preventDefault()
      select(ctrl ? { r: 0, c: 0 } : { r: anchor.r, c: 0 }, e.shiftKey)
      return
    }
    if (k === 'End') {
      e.preventDefault()
      const u = used(cells)
      select(ctrl ? { r: Math.max(u.rows - 1, 0), c: Math.max(u.cols - 1, 0) } : { r: anchor.r, c: Math.max(u.cols - 1, 0) }, e.shiftKey)
      return
    }
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault()
      const n = Math.max(1, Math.floor((view.h - CH) / DEF_H) - 1) * (k === 'PageDown' ? 1 : -1)
      const from = e.shiftKey ? focus : anchor
      select({ r: Math.max(0, from.r + n), c: from.c }, e.shiftKey)
      if (scrollRef.current) scrollRef.current.scrollTop += n * DEF_H
      return
    }
    if (k === 'F2') { e.preventDefault(); startEdit('edit'); return }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); clearValues(); return }
    if (k === 'Escape') { setFillTo(null); clip.current = null; bump(); return }
    if (ctrl) {
      const lk = k.toLowerCase()
      if (lk === 'z' && !e.shiftKey) { e.preventDefault(); restore(undo.current, redo.current); return }
      if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); restore(redo.current, undo.current); return }
      if (lk === 'b') { e.preventDefault(); toggle('b'); return }
      if (lk === 'i') { e.preventDefault(); toggle('i'); return }
      if (lk === 'u') { e.preventDefault(); toggle('u'); return }
      if (lk === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setFocus({ r: d.rows - 1, c: d.cols - 1 }); return }
      if (lk === 'f' || lk === 'h') { e.preventDefault(); setFind({ q: find?.q || '', rep: find?.rep || '', showRep: lk === 'h', idx: -1 }); return }
      if (lk === 'd' && sel.r2 > sel.r1) { e.preventDefault(); doFill({ ...sel, r2: sel.r1 }, sel); return }
      if (lk === 'r' && sel.c2 > sel.c1) { e.preventDefault(); doFill({ ...sel, c2: sel.c1 }, sel); return }
      if (k === '5' && e.shiftKey) { e.preventDefault(); applyStyle({ s: !curStyle.s }); return }
      if (lk === 'e' && e.shiftKey) { e.preventDefault(); applyStyle({ align: 'center' }); return }
      if (lk === 'l' && e.shiftKey) { e.preventDefault(); applyStyle({ align: 'left' }); return }
      if (lk === 'r' && e.shiftKey) { e.preventDefault(); applyStyle({ align: 'right' }); return }
      return
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault()
      startEdit('type', k)
    }
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!edit) return
    const k = e.key
    const sugg = suggestions
    if (k === 'Tab' && sugg.length) {
      e.preventDefault()
      acceptSuggestion(sugg[0])
      return
    }
    if (k === 'Enter') { e.preventDefault(); commitEdit(e.altKey ? undefined : [e.shiftKey ? -1 : 1, 0]); return }
    if (k === 'Tab') { e.preventDefault(); commitEdit([0, e.shiftKey ? -1 : 1]); return }
    if (k === 'Escape') { e.preventDefault(); cancelEdit(); return }
    if (edit.mode === 'type' && !edit.bar && !edit.text.startsWith('=') && k.startsWith('Arrow')) {
      e.preventDefault()
      const m: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      commitEdit(m[k])
      return
    }
    refInsert.current = null
  }

  // function-name suggestions while typing a formula
  const suggestions = useMemo(() => {
    if (!edit?.text.startsWith('=')) return []
    const m = edit.text.match(/([A-Za-z][A-Za-z0-9.]*)$/)
    if (!m || m[1].length < 1) return []
    const pre = m[1].toUpperCase()
    if (/^[A-Z]{1,3}\d+$/.test(pre)) return []
    return FUNCTION_NAMES.filter(f => f.startsWith(pre) && f !== pre).slice(0, 8)
  }, [edit?.text])
  function acceptSuggestion(name: string) {
    if (!edit) return
    const text = edit.text.replace(/([A-Za-z][A-Za-z0-9.]*)$/, name + '(')
    setEdit({ ...edit, text, mode: 'edit' })
    requestAnimationFrame(() => {
      const el = edit.bar ? barInput.current : cellInput.current
      el?.focus()
      el?.setSelectionRange(text.length, text.length)
    })
  }

  // ---------------- mouse ----------------
  /** Follows a drag on the window; the listeners go away on mouseup or when the editor unmounts. */
  const dragCleanup = useRef<(() => void) | null>(null)
  function track(move: (e: MouseEvent) => void, onUp?: () => void) {
    dragCleanup.current?.()
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
      onUp?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    dragCleanup.current = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
    }
  }
  function cellFromEvent(e: { clientX: number; clientY: number }): Pos | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-r]') as HTMLElement | null
    return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null
  }
  function onMouseDown(e: React.MouseEvent) {
    if (e.button === 2) return
    if (chartSel) setChartSel(null)
    const t = e.target as HTMLElement
    if (t.closest('input, .sg-editor, .sg-sugg')) return
    if (t.dataset.fill !== undefined) {
      e.preventDefault()
      startFillDrag()
      return
    }
    const rz = t.closest('[data-resize]') as HTMLElement | null
    if (rz) {
      e.preventDefault()
      startResize(Number(rz.dataset.resize), e.clientX)
      return
    }
    const colH = t.closest('[data-col]') as HTMLElement | null
    const rowH = t.closest('[data-row]') as HTMLElement | null
    if (t.closest('[data-corner]')) {
      e.preventDefault()
      if (edit) commitEdit()
      setAnchor({ r: 0, c: 0 })
      setFocus({ r: d.rows - 1, c: d.cols - 1 })
      focusGrid()
      return
    }
    if (colH || rowH) {
      e.preventDefault()
      if (edit) commitEdit()
      const isCol = !!colH
      const idx = Number(isCol ? colH!.dataset.col : rowH!.dataset.row)
      const startIdx = e.shiftKey ? (isCol ? anchor.c : anchor.r) : idx
      const apply = (i: number) => {
        if (isCol) { setAnchor({ r: 0, c: Math.min(startIdx, i) }); setFocus({ r: d.rows - 1, c: Math.max(startIdx, i) }) }
        else { setAnchor({ r: Math.min(startIdx, i), c: 0 }); setFocus({ r: Math.max(startIdx, i), c: d.cols - 1 }) }
      }
      apply(idx)
      const move = (ev: MouseEvent) => {
        const h = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(isCol ? '[data-col]' : '[data-row]') as HTMLElement | null
        if (h) apply(Number(isCol ? h.dataset.col : h.dataset.row))
      }
      track(move)
      focusGrid()
      return
    }
    const p = cellFromEvent(e)
    if (!p) return
    e.preventDefault()
    if (edit && canInsertRef()) {
      const start = p
      insertRef({ r1: p.r, c1: p.c, r2: p.r, c2: p.c })
      const move = (ev: MouseEvent) => {
        const q = cellFromEvent(ev)
        if (q) insertRefRef.current(norm({ r1: start.r, c1: start.c, r2: q.r, c2: q.c }))
      }
      track(move)
      return
    }
    if (edit) commitEdit()
    if (e.shiftKey) setFocus(p)
    else { setAnchor(p); setFocus(p) }
    const move = (ev: MouseEvent) => {
      const q = cellFromEvent(ev)
      if (q) setFocus(q)
    }
    track(move)
    focusGrid()
  }
  const insertRefRef = useRef(insertRef)
  insertRefRef.current = insertRef

  function startResize(c: number, x0: number) {
    const cs = sel.c1 <= c && c <= sel.c2 && sel.r1 === 0 && sel.r2 >= d.rows - 1 ? [sel.c1, sel.c2] : [c, c]
    const w0 = cols.size(c)
    let w = w0
    const move = (ev: MouseEvent) => {
      w = Math.max(20, w0 + ev.clientX - x0)
      setResize({ c, w })
    }
    track(move, () => {
      setResize(null)
      if (w !== w0) editSheet(s => {
        s.colWidths = { ...s.colWidths }
        for (let i = cs[0]; i <= cs[1]; i++) s.colWidths[i] = Math.round(w)
      }, 'none')
    })
  }
  function autofit(c: number) {
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.font = '13px Arial'
    let w = 40
    const u = used(cells)
    for (let r = 0; r < Math.min(u.rows, 5000); r++) {
      const cell = cells[addr(r, c)]
      if (cell) w = Math.max(w, canvas.measureText(display(cell)).width * ((cell.s?.size || 10) / 10) + 14)
    }
    editSheet(s => { s.colWidths = { ...s.colWidths, [c]: Math.min(600, Math.ceil(w)) } }, 'none')
  }
  function startFillDrag() {
    const src = sel
    const move = (ev: MouseEvent) => {
      const q = cellFromEvent(ev)
      if (!q) return
      const down = q.r - src.r2, right = q.c - src.c2
      if (down <= 0 && right <= 0) setFillTo(null)
      else if (down >= right) setFillTo({ ...src, r2: Math.max(src.r2, q.r) })
      else setFillTo({ ...src, c2: Math.max(src.c2, q.c) })
    }
    track(move, () =>
      setFillTo(f => {
        if (f) fillRef.current(src, f)
        return null
      })
    )
  }
  const fillRef = useRef(doFill)
  fillRef.current = doFill

  function onContextMenu(e: React.MouseEvent) {
    const p = cellFromEvent(e)
    const colH = (e.target as HTMLElement).closest('[data-col]')
    const rowH = (e.target as HTMLElement).closest('[data-row]')
    if (!p && !colH && !rowH) return
    e.preventDefault()
    if (p && !inRange(sel, p.r, p.c)) { setAnchor(p); setFocus(p) }
    const nR = sel.r2 - sel.r1 + 1, nC = sel.c2 - sel.c1 + 1
    const rs = nR > 1 && nR < 1000 ? `${nR} rows` : 'row'
    const csl = nC > 1 && nC < 100 ? `${nC} columns` : 'column'
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Cut', shortcut: 'Ctrl+X', run: () => document.execCommand('cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', run: () => document.execCommand('copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', run: () => navigator.clipboard.readText().then(t => pasteRef.current(t)).catch(() => {}) },
        { label: '', sep: true },
        { label: `Insert ${rs} above`, run: insertRowsAbove },
        { label: `Insert ${rs} below`, run: insertRowsBelow },
        { label: `Insert ${csl} left`, run: insertColsLeft },
        { label: `Insert ${csl} right`, run: insertColsRight },
        { label: '', sep: true },
        { label: `Delete ${rs}`, run: deleteRows },
        { label: `Delete ${csl}`, run: deleteCols },
        { label: 'Clear contents', shortcut: 'Del', run: clearValues },
        { label: 'Clear formatting', run: clearFormatting },
        ...(colH ? [{ label: '', sep: true }, { label: 'Resize column to fit', run: () => autofit(Number((colH as HTMLElement).dataset.col)) }] : [])
      ]
    })
  }
  const pasteRef = useRef(paste)
  pasteRef.current = paste

  // ---------------- effects ----------------
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setView({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (edit && !edit.bar && edit.mode === 'type') {
      const el = cellInput.current
      el?.focus()
      el?.setSelectionRange(edit.text.length, edit.text.length)
    }
  }, [edit?.r, edit?.c, edit?.mode, edit?.bar])
  useEffect(() => {
    if (props.active && !edit) focusGrid()
  }, [props.active])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(t)
  }, [flash])

  // ---------------- handle for the shell ----------------
  const api = useRef<EditorHandle>(null!)
  api.current = {
    getPayload: () => ({ kind: 'sheet', workbook: wbRef.current }),
    agent: async op => {
      const r = applySheetOp(wbRef.current, op, activeRef.current)
      if (r.workbook) {
        setWb(r.workbook, r.activeSheet ?? r.touched?.sheet ?? activeRef.current)
        if (r.touched) {
          const t = r.touched
          setFlash({ sheet: t.sheet, range: t.range, key: Date.now() })
          setAnchor({ r: t.range.r1, c: t.range.c1 })
          setFocus({ r: t.range.r2, c: t.range.c2 })
          requestAnimationFrame(() => ensureVisibleRef.current({ r: t.range.r1, c: t.range.c1 }))
        }
      }
      return r.result
    },
    getPrintHtml: () => printHtml(wbRef.current, activeRef.current),
    getText: () => sheetToCsv(wbRef.current.sheets[activeRef.current]),
    setText: (text: string) => { runOp({ op: 'write', content: text, format: 'csv' }) },
    getSelection: () => {
      const { out } = selCells(sel)
      return writeCsv(out.map(r => r.map(c => display(c))))
    },
    replaceSelection: (text: string) => paste(text.split('\n').map(l => parseCsv(l, ',')[0]?.join('\t') ?? '').join('\n')),
    language: 'csv',
    command: (id: string) => {
      if (id === 'undo') restore(undo.current, redo.current)
      else if (id === 'redo') restore(redo.current, undo.current)
      else if (id === 'find' || id === 'replace') setFind({ q: find?.q || '', rep: '', showRep: id === 'replace', idx: -1 })
      else if (id === 'selectAll') { setAnchor({ r: 0, c: 0 }); setFocus({ r: d.rows - 1, c: d.cols - 1 }) }
      else if (id === 'copy' || id === 'cut') { focusGrid(); setTimeout(() => document.execCommand(id), 0) }
      else if (id === 'paste') navigator.clipboard.readText().then(t => pasteRef.current(t)).catch(() => {})
    },
    menus: () => ({
      Insert: [
        { label: 'Row above', run: insertRowsAbove },
        { label: 'Row below', run: insertRowsBelow },
        { label: 'Column left', run: insertColsLeft },
        { label: 'Column right', run: insertColsRight },
        { label: '', sep: true },
        { label: 'Sheet', shortcut: 'Shift+F11', run: addSheet },
        { label: 'Chart', run: insertChart },
        { label: 'Function', submenu: ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF', 'VLOOKUP', 'XLOOKUP'].map(f => ({ label: f, run: () => setEdit({ r: anchor.r, c: anchor.c, text: `=${f}(`, mode: 'edit', orig: rawText(cur) }) })) }
      ],
      Format: [
        { label: 'Number', submenu: NUM_FORMATS.map(n => ({ label: n.label + (n.sample ? `   ${n.sample}` : ''), checked: (curStyle.fmt || 'general') === n.fmt, run: () => applyStyle({ fmt: n.fmt === 'general' ? undefined : n.fmt }) })) },
        { label: '', sep: true },
        { label: 'Bold', shortcut: 'Ctrl+B', checked: !!curStyle.b, run: () => toggle('b') },
        { label: 'Italic', shortcut: 'Ctrl+I', checked: !!curStyle.i, run: () => toggle('i') },
        { label: 'Underline', shortcut: 'Ctrl+U', checked: !!curStyle.u, run: () => toggle('u') },
        { label: 'Strikethrough', shortcut: 'Alt+Shift+5', checked: !!curStyle.s, run: () => toggle('s') },
        { label: '', sep: true },
        { label: 'Align', submenu: (['left', 'center', 'right'] as const).map(a => ({ label: a[0].toUpperCase() + a.slice(1), checked: curStyle.align === a, run: () => applyStyle({ align: a }) })) },
        { label: 'Wrap text', checked: !!curStyle.wrap, run: () => applyStyle({ wrap: !curStyle.wrap }) },
        { label: 'Merge cells', submenu: mergeItems() },
        { label: '', sep: true },
        { label: 'Conditional formatting…', run: () => setPanel({ kind: 'cf' }) },
        { label: '', sep: true },
        { label: 'Clear formatting', shortcut: 'Ctrl+\\', run: clearFormatting }
      ],
      View: [
        { label: 'Freeze', submenu: freezeItems() }
      ]
    }),
    focus: () => focusGrid()
  }
  const ensureVisibleRef = useRef(ensureVisible)
  ensureVisibleRef.current = ensureVisible
  useEffect(() => {
    const handle: EditorHandle = {
      zoomBy: dir => setZoom(z => stepZoom(SHEET_ZOOMS, z, dir)),
      getPayload: () => api.current.getPayload(),
      agent: (op, who) => api.current.agent(op, who),
      getPrintHtml: () => api.current.getPrintHtml!(),
      getText: () => api.current.getText!(),
      setText: t => api.current.setText!(t),
      getSelection: () => api.current.getSelection!(),
      replaceSelection: t => api.current.replaceSelection!(t),
      language: 'csv',
      command: id => api.current.command!(id),
      menus: () => api.current.menus!(),
      focus: () => api.current.focus!()
    }
    props.setHandle(handle)
    return () => {
      props.setHandle(null)
      // drop everything this tab held so a closed or backgrounded tab frees its memory
      undo.current = []
      redo.current = []
      clip.current = null
      refInsert.current = null
      dragCleanup.current?.()
    }
  }, [])

  function freezeItems(): MenuItem[] {
    const f = sheet.frozen || { rows: 0, cols: 0 }
    return [
      { label: 'No rows', checked: !f.rows, run: () => setFrozen(0, f.cols) },
      { label: '1 row', checked: f.rows === 1, run: () => setFrozen(1, f.cols) },
      { label: '2 rows', checked: f.rows === 2, run: () => setFrozen(2, f.cols) },
      { label: `Up to row ${anchor.r + 1}`, run: () => setFrozen(anchor.r + 1, f.cols) },
      { label: '', sep: true },
      { label: 'No columns', checked: !f.cols, run: () => setFrozen(f.rows, 0) },
      { label: '1 column', checked: f.cols === 1, run: () => setFrozen(f.rows, 1) },
      { label: '2 columns', checked: f.cols === 2, run: () => setFrozen(f.rows, 2) },
      { label: `Up to column ${colName(anchor.c)}`, run: () => setFrozen(f.rows, anchor.c + 1) }
    ]
  }

  // ---------------- render ----------------
  const onScroll = () => {
    const el = scrollRef.current!
    setScroll({ x: el.scrollLeft, y: el.scrollTop })
  }
  const visC0 = Math.max(fc, cols.at(scroll.x + FW))
  const visC1 = Math.min(d.cols - 1, cols.at(scroll.x + view.w - RH) + 1)
  const visR0 = Math.max(fr, rows.at(scroll.y + FH))
  const visR1 = Math.min(d.rows - 1, rows.at(scroll.y + view.h - CH) + 1)
  const totalW = cols.pos[d.cols], totalH = rows.pos[d.rows]
  const flashOn = flash && flash.sheet === si ? flash.range : null
  const editRefs = editingFormula ? formulaRefs(edit!.text.slice(1)) : []
  const selIsMulti = sel.r2 > sel.r1 || sel.c2 > sel.c1

  const hasMerges = !!sheet.merges?.length
  const hasRules = !!sheet.conditional?.length
  function renderCell(r: number, c: number, x: number, y: number, m?: Range | null): ReactNode {
    const a = addr(r, c)
    const cell = cells[a]
    const s = hasRules ? mergedStyle(cell?.s, conditionalStyle(wb, si, r, c)) : cell?.s
    const w = m ? spanW(m.c1, m.c2) : cols.size(c), h = m ? spanH(m.r1, m.r2) : rows.size(r)
    const text = display(cell)
    const isNum = typeof cell?.v === 'number'
    const align = s?.align ?? (isNum ? 'right' : typeof cell?.v === 'boolean' || isErr(cell) ? 'center' : 'left')
    let width = w
    let ovf = false
    if (text && !m && !s?.wrap && align === 'left' && !isNum) {
      // text spills into empty neighbors, like Sheets (never into a merged block)
      for (let k = c + 1; k <= Math.min(c + 10, d.cols - 1) && isEmpty(r, k) && !cells[addr(r, k)]?.s?.bg && !(hasMerges && mergeAt(sheet, r, k)); k++) width += cols.size(k)
      ovf = width > w
    }
    const isCur = m ? inRange(m, anchor.r, anchor.c) : r === anchor.r && c === anchor.c
    const inSel = selIsMulti && inRange(sel, r, c)
    const style: CSSProperties = { left: x, top: y, width: ovf ? width : w, height: h }
    if (s) {
      if (s.b) style.fontWeight = 700
      if (s.i) style.fontStyle = 'italic'
      if (s.u || s.s) style.textDecoration = [s.u && 'underline', s.s && 'line-through'].filter(Boolean).join(' ')
      if (s.color) style.color = s.color
      if (s.bg) {
        style.background = s.bg
        // A fill without its own text color gets readable text (light fills stay readable in dark mode).
        if (!s.color) style.color = lightBg(s.bg) ? '#1f1f1f' : '#f1f3f4'
      }
      if (s.size) style.fontSize = Math.round((s.size * 4) / 3)
      if (s.wrap) style.whiteSpace = 'pre-wrap'
    }
    style.textAlign = align
    const isEditing = edit && edit.r === r && edit.c === c
    const isBR = (m ? inRange(m, sel.r2, sel.c2) : r === sel.r2 && c === sel.c2) && !edit
    const cls = 'sg-cell' + (m ? ' merged' : '') + (inSel ? ' sel' : '') + (isCur ? ' cur' : '') + (ovf ? ' ovf' : '') + (isErr(cell) ? ' err' : '') +
      (flashOn && inRange(flashOn, r, c) ? ' flash' : '') + (fillTo && inRange(fillTo, r, c) && !inRange(sel, r, c) ? ' fillpre' : '') +
      (isEditing ? ' editing' : '')
    return (
      <div key={a} className={cls} style={style} data-r={r} data-c={c} title={isErr(cell) ? `${cell!.v}` : undefined}>
        {!isEditing && <span className="sg-text" style={{ width: (ovf ? width : w) - 6 }}>{text}</span>}
        {isEditing && (
          <div className="sg-editor" style={{ minWidth: w, minHeight: h }}>
            <input
              ref={cellInput}
              value={edit!.text}
              spellCheck={false}
              onChange={e => { refInsert.current = null; setEdit({ ...edit!, text: e.target.value, bar: false }) }}
              onKeyDown={onInputKey}
              onFocus={() => edit!.bar && setEdit({ ...edit!, bar: false })}
              style={{ minWidth: w - 2, width: Math.max(w - 2, edit!.text.length * 8 + 16), fontWeight: s?.b ? 700 : undefined, fontStyle: s?.i ? 'italic' : undefined }}
            />
            {!edit!.bar && suggestions.length > 0 && (
              <div className="sg-sugg">
                {suggestions.map((f, i) => (
                  <button key={f} className={i === 0 ? 'on' : ''} onMouseDown={e => { e.preventDefault(); acceptSuggestion(f) }}>{f}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {isBR && <div className="sg-fill" data-fill="" />}
      </div>
    )
  }

  const colHeader = (c: number, x: number) => {
    const on = c >= sel.c1 && c <= sel.c2
    const full = sel.r1 === 0 && sel.r2 >= d.rows - 1
    return (
      <div key={'ch' + c} className={'sg-colh' + (on ? (full ? ' full' : ' on') : '')} style={{ left: x, width: cols.size(c) }} data-col={c}>
        {colName(c)}
        <div className="sg-resize" data-resize={c} onDoubleClick={() => autofit(c)} />
      </div>
    )
  }
  const rowHeader = (r: number, y: number) => {
    const on = r >= sel.r1 && r <= sel.r2
    const full = sel.c1 === 0 && sel.c2 >= d.cols - 1
    return (
      <div key={'rh' + r} className={'sg-rowh' + (on ? (full ? ' full' : ' on') : '')} style={{ top: y, height: rows.size(r) }} data-row={r}>
        {r + 1}
      </div>
    )
  }

  // the four regions
  const topCells: ReactNode[] = [], cornerCells: ReactNode[] = [], leftCells: ReactNode[] = [], bodyCells: ReactNode[] = []
  const colHs: ReactNode[] = [], frozenColHs: ReactNode[] = [], rowHs: ReactNode[] = []
  for (let c = visC0; c <= visC1; c++) colHs.push(colHeader(c, RH + cols.pos[c]))
  for (let c = 0; c < fc; c++) frozenColHs.push(colHeader(c, RH + cols.pos[c]))
  for (let r = visR0; r <= visR1; r++) rowHs.push(rowHeader(r, rows.pos[r] - FH))
  const frozenRowHs: ReactNode[] = []
  for (let r = 0; r < fr; r++) frozenRowHs.push(rowHeader(r, CH + rows.pos[r]))
  // A merged block is drawn once, from its top-left cell, even when that cell is scrolled out of view.
  const placed = new Set<string>()
  const place = (list: ReactNode[], region: string, r: number, c: number, yb: number) => {
    const m = hasMerges ? mergeAt(sheet, r, c) : null
    if (!m) return void list.push(renderCell(r, c, RH + cols.pos[c], yb + rows.pos[r]))
    const k = region + rangeStr(m)
    if (placed.has(k)) return
    placed.add(k)
    list.push(renderCell(m.r1, m.c1, RH + cols.pos[Math.min(m.c1, cols.n)], yb + rows.pos[Math.min(m.r1, rows.n)], m))
  }
  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < fc; c++) place(cornerCells, 'k', r, c, CH)
    for (let c = visC0; c <= visC1; c++) place(topCells, 't', r, c, CH)
  }
  for (let r = visR0; r <= visR1; r++) {
    for (let c = 0; c < fc; c++) place(leftCells, 'l', r, c, -FH)
    for (let c = visC0; c <= visC1; c++) place(bodyCells, 'b', r, c, -FH)
  }
  // the editor's cell must exist even when scrolled away, so typing never loses its input
  if (edit && !(edit.r >= visR0 && edit.r <= visR1 && edit.c >= visC0 && edit.c <= visC1) && edit.r >= fr && edit.c >= fc)
    bodyCells.push(renderCell(edit.r, edit.c, RH + cols.pos[edit.c], rows.pos[edit.r] - FH, hasMerges ? mergeAt(sheet, edit.r, edit.c) : null))
  // a box around the selection
  const selBox = (() => {
    if (sel.r2 < fr || sel.c2 < fc) return null
    const r1 = Math.max(sel.r1, fr), c1 = Math.max(sel.c1, fc)
    const r2 = Math.min(sel.r2, d.rows - 1), c2 = Math.min(sel.c2, d.cols - 1)
    return <div className="sg-selbox" style={{ left: RH + cols.pos[c1], top: rows.pos[r1] - FH, width: cols.pos[c2 + 1] - cols.pos[c1], height: rows.pos[r2 + 1] - rows.pos[r1] }} />
  })()
  const refBoxes = editRefs
    .filter(x => !x.sheet || x.sheet.toLowerCase() === sheet.name.toLowerCase())
    .map((x, i) => {
      const r1 = Math.max(fr, Math.min(x.r1, x.r2)), r2 = Math.min(d.rows - 1, Math.max(x.r1, x.r2))
      const c1 = Math.max(fc, Math.min(x.c1, x.c2)), c2 = Math.min(d.cols - 1, Math.max(x.c1, x.c2))
      if (r2 < r1 || c2 < c1) return null
      const color = REF_COLORS[i % REF_COLORS.length]
      return <div key={'ref' + i} className="sg-refbox" style={{ left: RH + cols.pos[c1], top: rows.pos[r1] - FH, width: cols.pos[c2 + 1] - cols.pos[c1], height: rows.pos[r2 + 1] - rows.pos[r1], borderColor: color, background: color + '18' }} />
    })

  // charts float over the body, anchored to a cell (+ pixel offset) so they move with rows and columns
  const chartBoxes = (sheet.charts || []).map(ch => {
    const p = parseAddr(ch.at) || { r: 0, c: 0 }
    const left = RH + (p.c < cols.n ? cols.pos[p.c] : cols.pos[cols.n] + (p.c - cols.n) * DEF_W) + (ch.dx || 0)
    const top = (p.r < rows.n ? rows.pos[p.r] : rows.pos[rows.n] + (p.r - rows.n) * DEF_H) - FH + (ch.dy || 0)
    return (
      <ChartBox
        key={ch.id}
        sheet={sheet}
        chart={ch}
        left={left}
        top={top}
        selected={chartSel === ch.id}
        onSelect={() => (setChartSel(ch.id), focusGrid())}
        onEdit={() => (setChartSel(ch.id), setPanel({ kind: 'chart', id: ch.id }))}
        onDelete={() => deleteChart(ch.id)}
        onMoved={(x, y) => {
          const c = cols.at(Math.max(0, x - RH)), r = rows.at(Math.max(0, y + FH))
          updateChart(ch.id, { at: addr(r, c), dx: Math.round(x - RH - cols.pos[c]), dy: Math.round(y + FH - rows.pos[r]) })
        }}
        onResized={(w, h) => updateChart(ch.id, { w, h })}
      />
    )
  })

  // status bar: sum / average / count of the selection
  const stats = useMemo(() => {
    if (!selIsMulti) return null
    const u = used(cells)
    let sum = 0, n = 0, cnt = 0
    const r2 = Math.min(sel.r2, u.rows - 1), c2 = Math.min(sel.c2, u.cols - 1)
    for (let r = sel.r1; r <= r2; r++) for (let c = sel.c1; c <= c2; c++) {
      const v = cells[addr(r, c)]?.v
      if (v == null || v === '') continue
      cnt++
      if (typeof v === 'number') { sum += v; n++ }
    }
    return { sum, avg: n ? sum / n : 0, n, cnt }
  }, [cells, sel.r1, sel.r2, sel.c1, sel.c2, selIsMulti])

  const barValue = edit ? edit.text : rawText(cur)
  const fmtLabel = (() => {
    const f = curStyle.fmt
    if (!f || f === 'general') return '123'
    if (f.includes('%')) return '%'
    if (f.includes('$')) return '$'
    if (f === 'date' || f === 'datetime') return 'Date'
    return '123'
  })()
  const openMenuAt = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4, items })
  }
  const palette = (onPick: (c: string | undefined) => void) => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4, items: [{ label: '__palette__', run: () => {} }], ...{ pick: onPick } } as CtxMenu)
  }

  return (
    <div className="sg-root">
      <div className="toolbar">
        <button className="tb" title="Undo (Ctrl+Z)" onClick={() => restore(undo.current, redo.current)} disabled={!undo.current.length}><Icon d={P.undo} /></button>
        <button className="tb" title="Redo (Ctrl+Y)" onClick={() => restore(redo.current, undo.current)} disabled={!redo.current.length}><Icon d={P.redo} /></button>
        <span className="tb-sep" />
        <button className="tb" title="Format as currency" onClick={() => applyStyle({ fmt: '$#,##0.00' })}>$</button>
        <button className="tb" title="Format as percent" onClick={() => applyStyle({ fmt: '0.00%' })}>%</button>
        <button className="tb" title="Decrease decimal places" onClick={() => applyStyle({ fmt: bumpDecimals(curStyle.fmt, -1, cur?.v) })}>.0<small>←</small></button>
        <button className="tb" title="Increase decimal places" onClick={() => applyStyle({ fmt: bumpDecimals(curStyle.fmt, 1, cur?.v) })}>.00<small>→</small></button>
        <button className="tb" title="More formats" onClick={e => openMenuAt(e, NUM_FORMATS.map(n => ({ label: n.label + (n.sample ? `   ${n.sample}` : ''), checked: (curStyle.fmt || 'general') === n.fmt, run: () => applyStyle({ fmt: n.fmt === 'general' ? undefined : n.fmt }) })))}>
          {fmtLabel}<Icon d={P.down} size={14} />
        </button>
        <span className="tb-sep" />
        <select className="tb-select" title="Font size" value={curStyle.size || 10} onChange={e => applyStyle({ size: Number(e.target.value) === 10 ? undefined : Number(e.target.value) })}>
          {[...new Set([...FONT_SIZES, curStyle.size || 10])].sort((a, b) => a - b).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="tb-sep" />
        <button className={'tb' + (curStyle.b ? ' on' : '')} title="Bold (Ctrl+B)" onClick={() => toggle('b')}><Icon d={P.bold} /></button>
        <button className={'tb' + (curStyle.i ? ' on' : '')} title="Italic (Ctrl+I)" onClick={() => toggle('i')}><Icon d={P.italic} /></button>
        <button className={'tb' + (curStyle.s ? ' on' : '')} title="Strikethrough (Alt+Shift+5)" onClick={() => toggle('s')}><Icon d={P.strike} /></button>
        <button className="tb sg-colorbtn" title="Text color" onClick={palette(c => applyStyle({ color: c }))}>
          <Icon d={P.color} /><span className="swatch" style={{ background: curStyle.color || 'var(--text)' }} />
        </button>
        <span className="tb-sep" />
        <button className="tb sg-colorbtn" title="Fill color" onClick={palette(c => applyStyle({ bg: c }))}>
          <Icon d={P.fill} /><span className="swatch" style={{ background: curStyle.bg || 'transparent', outline: curStyle.bg ? undefined : '1px solid var(--line)' }} />
        </button>
        <span className="tb-sep" />
        <button className={'tb' + (curStyle.align === 'left' ? ' on' : '')} title="Align left" onClick={() => applyStyle({ align: curStyle.align === 'left' ? undefined : 'left' })}><Icon d={P.left} /></button>
        <button className={'tb' + (curStyle.align === 'center' ? ' on' : '')} title="Align center" onClick={() => applyStyle({ align: curStyle.align === 'center' ? undefined : 'center' })}><Icon d={P.center} /></button>
        <button className={'tb' + (curStyle.align === 'right' ? ' on' : '')} title="Align right" onClick={() => applyStyle({ align: curStyle.align === 'right' ? undefined : 'right' })}><Icon d={P.right} /></button>
        <button className={'tb' + (curStyle.wrap ? ' on' : '')} title="Wrap text" onClick={() => applyStyle({ wrap: !curStyle.wrap })}><Icon d={P.wrap} /></button>
        <span className="tb-sep" />
        <button className={'tb' + (isMergedSel ? ' on' : '')} title={isMergedSel ? 'Unmerge' : 'Merge cells'} onClick={() => (isMergedSel ? unmerge() : merge('all'))}><Icon d={EXTRA_ICONS.merge} /></button>
        <button className="tb sg-narrow" title="Merge options" onClick={e => openMenuAt(e, mergeItems())}><Icon d={P.down} size={14} /></button>
        <button className={'tb' + (panel?.kind === 'cf' ? ' on' : '')} title="Conditional formatting" onClick={() => setPanel(panel?.kind === 'cf' ? null : { kind: 'cf' })}><Icon d={EXTRA_ICONS.palette} /></button>
        <span className="tb-sep" />
        <button className={'tb' + (sheet.frozen?.rows || sheet.frozen?.cols ? ' on' : '')} title="Freeze rows and columns" onClick={e => openMenuAt(e, freezeItems())}><Icon d={P.freeze} /><Icon d={P.down} size={14} /></button>
        <button className="tb" title="Sum (Σ)" onClick={insertSum}><Icon d={P.sigma} /></button>
        <button className="tb" title="Insert chart" onClick={insertChart}><Icon d={EXTRA_ICONS.chart} /></button>
      </div>

      <div className="sg-fbar">
        <input
          ref={nameBox}
          className="sg-name"
          defaultValue=""
          key={rangeStr(sel) + si}
          placeholder={selIsMulti ? rangeStr({ ...sel, r2: Math.min(sel.r2, d.rows - 1) }) : addr(anchor.r, anchor.c)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = e.currentTarget.value.trim()
              const g = parseRange(v)
              if (g) { setAnchor({ r: g.r1, c: g.c1 }); setFocus({ r: g.r2, c: g.c2 }); requestAnimationFrame(() => ensureVisible({ r: g.r1, c: g.c1 })) }
              e.currentTarget.value = ''
              focusGrid()
            } else if (e.key === 'Escape') { e.currentTarget.value = ''; focusGrid() }
          }}
          aria-label="Name box"
        />
        <span className="sg-fx">fx</span>
        <input
          ref={barInput}
          className="sg-formula"
          value={barValue}
          spellCheck={false}
          onFocus={() => { if (!edit) setEdit({ r: anchor.r, c: anchor.c, text: rawText(cur), mode: 'edit', bar: true, orig: rawText(cur) }); else setEdit({ ...edit, bar: true }) }}
          onChange={e => { refInsert.current = null; setEdit(ed => ({ ...(ed || { r: anchor.r, c: anchor.c, mode: 'edit', orig: rawText(cur) }), text: e.target.value, bar: true })) }}
          onKeyDown={onInputKey}
          aria-label="Formula"
        />
        {edit?.bar && suggestions.length > 0 && (
          <div className="sg-sugg bar">
            {suggestions.map((f, i) => <button key={f} className={i === 0 ? 'on' : ''} onMouseDown={e => { e.preventDefault(); acceptSuggestion(f) }}>{f}</button>)}
          </div>
        )}
      </div>

      <div className="sg-main">
      <div className="sg-wrap">
        <div
          ref={scrollRef}
          className={'sg-scroll' + (editingFormula ? ' pointing' : '')}
          style={zoom !== 100 ? { zoom: zoom / 100 } : undefined}
          tabIndex={0}
          onScroll={onScroll}
          onKeyDown={onGridKey}
          onMouseDown={onMouseDown}
          onDoubleClick={e => { if (cellFromEvent(e) && !edit) startEdit('edit') }}
          onContextMenu={onContextMenu}
          onCopy={e => { if (!edit) copy(e) }}
          onCut={e => {
            if (edit) return
            copy(e, true)
          }}
          onPaste={e => {
            if (edit) return
            e.preventDefault()
            paste(e.clipboardData.getData('text/plain'))
          }}
        >
          <div className="sg-band" style={{ width: RH + totalW, height: CH + FH }}>
            {colHs}
            {topCells}
            <div className="sg-corner" style={{ width: RH + FW, height: CH + FH }}>
              <div className="sg-cornerbox" data-corner="" style={{ width: RH, height: CH }} />
              {frozenColHs}
              {frozenRowHs}
              {cornerCells}
            </div>
          </div>
          <div className="sg-body" style={{ width: RH + totalW, height: totalH - FH }}>
            <div className="sg-left" style={{ width: RH + FW, height: totalH - FH }}>
              {rowHs}
              {leftCells}
            </div>
            {bodyCells}
            {selBox}
            {refBoxes}
            {chartBoxes}
          </div>
        </div>
        {fr > 0 && <div className="sg-freezeline h" style={{ top: CH + FH - 1 }} />}
        {fc > 0 && <div className="sg-freezeline v" style={{ left: RH + FW - 1 }} />}

        {find && (
          <div className="sg-find" onKeyDown={e => e.key === 'Escape' && (setFind(null), focusGrid())}>
            <input autoFocus placeholder="Find in sheet" value={find.q} onChange={e => setFind({ ...find, q: e.target.value, idx: -1 })}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1) } }} />
            <span className="muted">{find.q ? `${matches.length ? Math.max(find.idx + 1, 0) : 0} of ${matches.length}` : ''}</span>
            <button className="tb" title="Previous" onClick={() => findNext(-1)}>↑</button>
            <button className="tb" title="Next" onClick={() => findNext(1)}>↓</button>
            {find.showRep ? (
              <>
                <input placeholder="Replace with" value={find.rep} onChange={e => setFind({ ...find, rep: e.target.value })} />
                <button className="tb" onClick={replaceAll}>Replace all</button>
              </>
            ) : <button className="tb" onClick={() => setFind({ ...find, showRep: true })}>Replace</button>}
            <button className="tb" title="Close" onClick={() => { setFind(null); focusGrid() }}><Icon d={P.close} /></button>
          </div>
        )}
      </div>
      {panel?.kind === 'cf' && (
        <CfPanel
          key={si}
          rules={sheet.conditional || []}
          defaultRange={selRange()}
          onAdd={rule => runOp({ op: 'addRule', range: rule.range, rule })}
          onUpdate={(index, rule) => runOp({ op: 'updateRule', index, rule })}
          onDelete={index => runOp({ op: 'deleteRule', index })}
          onClose={() => (setPanel(null), focusGrid())}
        />
      )}
      {panel?.kind === 'chart' && (() => {
        const ch = sheet.charts?.find(x => x.id === panel.id)
        return ch ? (
          <ChartPanel chart={ch} onChange={patch => updateChart(ch.id, patch)} onDelete={() => deleteChart(ch.id)} onClose={() => (setPanel(null), focusGrid())} />
        ) : null
      })()}
      </div>

      <div className="sg-tabs">
        <button className="tb" title="Add sheet" onClick={addSheet}><Icon d={P.add} /></button>
        <button className="tb" title="All sheets" onClick={e => openMenuAt(e, wb.sheets.map((s, i) => ({ label: s.name, checked: i === si, run: () => switchSheet(i) })))}><Icon d={P.menu} /></button>
        <div className="sg-tablist">
          {wb.sheets.map((s, i) =>
            renaming === i ? (
              <input
                key={i}
                className="sg-tab renaming"
                autoFocus
                defaultValue={s.name}
                onBlur={e => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== s.name) { try { runOp({ op: 'renameSheet', sheet: i, name: v }) } catch (err) { alert((err as Error).message) } } }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }}
              />
            ) : (
              <button
                key={i}
                className={'sg-tab' + (i === si ? ' on' : '')}
                onClick={() => switchSheet(i)}
                onDoubleClick={() => setRenaming(i)}
                onContextMenu={e => {
                  e.preventDefault()
                  setMenu({
                    x: e.clientX, y: e.clientY - 8 - 32 * 5,
                    items: [
                      { label: 'Delete', disabled: wb.sheets.length < 2, run: () => runOp({ op: 'deleteSheet', sheet: i }) },
                      { label: 'Duplicate', run: () => duplicateSheet(i) },
                      { label: 'Rename', run: () => setRenaming(i) },
                      { label: 'Move left', disabled: i === 0, run: () => moveSheet(i, i - 1) },
                      { label: 'Move right', disabled: i === wb.sheets.length - 1, run: () => moveSheet(i, i + 1) }
                    ]
                  })
                }}
              >
                {s.name}
                {i === si && <Icon d={P.down} size={16} />}
              </button>
            )
          )}
        </div>
        <div className="grow" />
        {stats && (
          <div className="sg-stats" title={`Sum: ${stats.sum}\nAverage: ${stats.avg}\nCount: ${stats.cnt}`}>
            {stats.n > 0 ? `Sum: ${formatValue(stats.sum, curStyle.fmt)}   Avg: ${formatValue(stats.avg, curStyle.fmt)}   ` : ''}Count: {stats.cnt}
          </div>
        )}
      </div>

      {menu && <Menu menu={menu} onClose={() => { setMenu(null); focusGrid() }} />}
    </div>
  )
}

/** A popup menu, or a color palette when created by palette(). */
function Menu({ menu, onClose }: { menu: CtxMenu & { pick?: (c: string | undefined) => void }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<number | null>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useLayoutEffect(() => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(4, Math.min(menu.x, innerWidth - r.width - 8)), y: Math.max(4, Math.min(menu.y, innerHeight - r.height - 8)) })
    const down = (e: MouseEvent) => { if (!el.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const t = setTimeout(() => window.addEventListener('mousedown', down), 0)
    window.addEventListener('keydown', key)
    return () => { clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key) }
  }, [])
  if (menu.pick) {
    const pick = menu.pick
    return (
      <div ref={ref} className="sg-menu sg-palette" style={{ left: pos.x, top: pos.y }}>
        <button className="sg-reset" onClick={() => { pick(undefined); onClose() }}>Reset</button>
        <div className="sg-swatches">
          {PALETTE.map(c => <button key={c} title={c} style={{ background: c }} onClick={() => { pick(c); onClose() }} />)}
        </div>
        <label className="sg-custom">Custom <input type="color" onChange={e => { pick(e.target.value); onClose() }} /></label>
      </div>
    )
  }
  return (
    <div ref={ref} className="sg-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.items.map((it, i) =>
        it.sep ? <div key={i} className="sg-menusep" /> : (
          <div key={i} className="sg-menuitem-wrap" onMouseEnter={() => setSub(it.submenu ? i : null)}>
            <button
              className="sg-menuitem"
              disabled={it.disabled}
              onClick={() => { if (it.submenu) { setSub(i); return } it.run?.(); onClose() }}
            >
              <span className="sg-check">{it.checked ? '✓' : ''}</span>
              <span className="grow">{it.label}</span>
              {it.shortcut && <span className="muted">{it.shortcut}</span>}
              {it.submenu && <span className="muted">▸</span>}
            </button>
            {it.submenu && sub === i && (
              <div className="sg-menu sg-submenu">
                {it.submenu.map((s, j) => s.sep ? <div key={j} className="sg-menusep" /> : (
                  <button key={j} className="sg-menuitem" disabled={s.disabled} onClick={() => { s.run?.(); onClose() }}>
                    <span className="sg-check">{s.checked ? '✓' : ''}</span><span className="grow">{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}

/** The used range of a sheet as a printable HTML table, with merged cells, conditional formats and charts. */
function printHtml(wb: Workbook, si: number): string {
  const sheet = wb.sheets[si]
  const g = usedRange(sheet)
  const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  if (!g && !sheet.charts?.length) return `<p>${esc(sheet.name)} is empty.</p>`
  let html = `<style>table{border-collapse:collapse;font:10pt Arial,sans-serif}td{border:1px solid #ccc;padding:2px 6px;white-space:nowrap}.charts{margin-top:16px;color:#202124}.charts svg{display:block;margin:0 0 16px}</style>`
  if (g) {
    html += '<table><colgroup>'
    for (let c = g.c1; c <= g.c2; c++) html += `<col style="width:${sheet.colWidths?.[c] ?? DEF_W}px">`
    html += '</colgroup>'
    const hidden = new Set<string>()
    for (let r = g.r1; r <= g.r2; r++) {
      html += '<tr>'
      for (let c = g.c1; c <= g.c2; c++) {
        const a = addr(r, c)
        if (hidden.has(a)) continue
        const cell = sheet.cells[a]
        const m = sheet.merges?.length ? mergeAt(sheet, r, c) : null
        let span = ''
        if (m) {
          const r2 = Math.min(m.r2, g.r2), c2 = Math.min(m.c2, g.c2)
          for (let rr = r; rr <= r2; rr++) for (let cc = c; cc <= c2; cc++) if (rr !== r || cc !== c) hidden.add(addr(rr, cc))
          if (r2 > r) span += ` rowspan="${r2 - r + 1}"`
          if (c2 > c) span += ` colspan="${c2 - c + 1}"`
        }
        const s = sheet.conditional?.length ? mergedStyle(cell?.s, conditionalStyle(wb, si, r, c)) : cell?.s
        const css: string[] = []
        if (s?.b) css.push('font-weight:bold')
        if (s?.i) css.push('font-style:italic')
        if (s?.u) css.push('text-decoration:underline')
        if (s?.s) css.push('text-decoration:line-through')
        if (s?.color) css.push(`color:${s.color}`)
        if (s?.bg) css.push(`background:${s.bg}`)
        if (s?.size) css.push(`font-size:${s.size}pt`)
        if (s?.wrap) css.push('white-space:normal')
        css.push(`text-align:${s?.align ?? (typeof cell?.v === 'number' ? 'right' : 'left')}`)
        html += `<td${span} style="${css.join(';')}">${esc(display(cell))}</td>`
      }
      html += '</tr>'
    }
    html += '</table>'
  }
  if (sheet.charts?.length) html += `<div class="charts">${sheet.charts.map(ch => chartSvg(ch, chartData(sheet, ch))).join('')}</div>`
  return html
}
