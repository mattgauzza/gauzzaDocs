import type { Cell, CellStyle, Sheet, Workbook } from '../types'
import { type Range, addr, colName, parseAddr, parseRange, rangeStr, usedSize } from './address'
import { type EvalCtx, FErr, type V, evaluate, shiftFormula } from './formula'
import { formatValue } from './format'

/**
 * Sheet extras beyond plain cells: merged cells, conditional formatting rules and charts.
 * Pure and isomorphic: the editor, the ops agents run, xlsx IO and printing all use these.
 * Everything here treats the arrays on a Sheet as immutable (functions return new arrays), so undo
 * snapshots that keep a sheet's settings by reference stay correct.
 */

// ---------------- types ----------------

export type CfType = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'contains' | 'notContains' | 'empty' | 'notEmpty' | 'formula' | 'scale'

export interface CfStyle {
  bg?: string
  color?: string
  b?: boolean
  i?: boolean
  s?: boolean
}

export interface ConditionalRule {
  range: string // A1 range the rule covers
  type: CfType
  value?: string | number // operand (gt/lt/eq/contains/...), lower bound for between
  value2?: string | number // upper bound for between
  formula?: string // custom formula without "=", written for the range's top-left cell
  style?: CfStyle
  scale?: { min: string; max: string } // two-color scale, lowest value -> highest value
}

export type ChartType = 'bar' | 'column' | 'line' | 'pie' | 'scatter'

export interface SheetChart {
  id: string
  type: ChartType
  range: string // data, e.g. A1:C10
  title?: string
  at: string // top-left cell the chart floats over
  dx?: number // pixel offset inside that cell
  dy?: number
  w: number // px
  h: number
  headers?: boolean // first row holds series names (default: guessed)
  labels?: boolean // first column holds category labels (default: guessed)
}

export const CF_LABELS: Record<CfType, string> = {
  gt: 'Greater than', gte: 'Greater than or equal to', lt: 'Less than', lte: 'Less than or equal to',
  eq: 'Is equal to', neq: 'Is not equal to', between: 'Is between', contains: 'Text contains',
  notContains: 'Text does not contain', empty: 'Is empty', notEmpty: 'Is not empty', formula: 'Custom formula is', scale: 'Color scale'
}
export const CF_TYPES = Object.keys(CF_LABELS) as CfType[]

/** Chart colors: Google's palette, readable on light and dark backgrounds. */
export const CHART_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01', '#46bdc6', '#ab47bc', '#7baaf7', '#f07b72', '#fcd04f']

// ---------------- range helpers ----------------

const rangeCache = new Map<string, Range | null>()
export function rng(s: string): Range | null {
  let g = rangeCache.get(s)
  if (g === undefined) {
    g = parseRange(s)
    if (rangeCache.size > 5000) rangeCache.clear()
    rangeCache.set(s, g)
  }
  return g
}
const overlaps = (a: Range, b: Range) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2

/**
 * Range after inserting (count > 0, before index `at`) or deleting (count < 0, from `at`) rows (axis 'r') or columns.
 * An insert inside a range grows it; a delete shrinks it; null when the whole range is deleted.
 */
export function shiftRange(g: Range, axis: 'r' | 'c', at: number, count: number): Range | null {
  const lo = axis === 'r' ? g.r1 : g.c1
  const hi = axis === 'r' ? g.r2 : g.c2
  let nlo = lo, nhi = hi
  if (count > 0) {
    if (lo >= at) nlo = lo + count
    if (hi >= at) nhi = hi + count
  } else {
    const n = -count, delEnd = at + n - 1
    if (lo >= at && hi <= delEnd) return null
    nlo = lo < at ? lo : lo <= delEnd ? at : lo - n
    nhi = hi < at ? hi : hi <= delEnd ? at - 1 : hi - n
  }
  return axis === 'r' ? { ...g, r1: nlo, r2: nhi } : { ...g, c1: nlo, c2: nhi }
}
function shiftCell(a: string, axis: 'r' | 'c', at: number, count: number): string {
  const p = parseAddr(a)
  if (!p) return a
  const k = axis === 'r' ? p.r : p.c
  let nk = k
  if (count > 0) nk = k >= at ? k + count : k
  else nk = k < at ? k : k < at - count ? at : k + count
  nk = Math.max(0, nk)
  return axis === 'r' ? addr(nk, p.c) : addr(p.r, nk)
}

/** Moves merges, rule ranges and charts along with an insert/delete of rows or columns. Returns the changed fields. */
export function shiftExtras(sheet: Sheet, axis: 'r' | 'c', at: number, count: number): Pick<Sheet, 'merges' | 'conditional' | 'charts'> {
  const out: Pick<Sheet, 'merges' | 'conditional' | 'charts'> = {}
  if (sheet.merges?.length) {
    out.merges = sheet.merges.flatMap(m => {
      const g = rng(m)
      const n = g && shiftRange(g, axis, at, count)
      return n && (n.r2 > n.r1 || n.c2 > n.c1) ? [rangeStr(n)] : []
    })
  }
  if (sheet.conditional?.length) {
    out.conditional = sheet.conditional.flatMap(rule => {
      const g = rng(rule.range)
      const n = g && shiftRange(g, axis, at, count)
      return n ? [{ ...rule, range: rangeStr(n) }] : []
    })
  }
  if (sheet.charts?.length) {
    out.charts = sheet.charts.flatMap(ch => {
      const g = rng(ch.range)
      const n = g && shiftRange(g, axis, at, count)
      return n ? [{ ...ch, range: rangeStr(n), at: shiftCell(ch.at, axis, at, count) }] : []
    })
  }
  return out
}

// ---------------- merges ----------------

const mergeCache = new WeakMap<string[], Range[]>()
export function mergeList(sheet: Sheet): Range[] {
  const m = sheet.merges
  if (!m?.length) return []
  let list = mergeCache.get(m)
  if (!list) {
    list = m.map(rng).filter((g): g is Range => !!g)
    mergeCache.set(m, list)
  }
  return list
}
/** The merged block covering (r, c), if any. */
export function mergeAt(sheet: Sheet, r: number, c: number): Range | null {
  for (const g of mergeList(sheet)) if (r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2) return g
  return null
}
/** Grows a selection until it fully contains every merged block it touches. */
export function expandToMerges(sheet: Sheet, g: Range): Range {
  const list = mergeList(sheet)
  if (!list.length) return g
  let out = { ...g }
  for (let changed = true; changed; ) {
    changed = false
    for (const m of list) {
      if (!overlaps(m, out)) continue
      const n = { r1: Math.min(out.r1, m.r1), c1: Math.min(out.c1, m.c1), r2: Math.max(out.r2, m.r2), c2: Math.max(out.c2, m.c2) }
      if (n.r1 !== out.r1 || n.c1 !== out.c1 || n.r2 !== out.r2 || n.c2 !== out.c2) (out = n), (changed = true)
    }
  }
  return out
}

export type MergeMode = 'all' | 'horizontal' | 'vertical'
/** Blocks a merge of `g` produces: one block, one per row, or one per column. */
export function mergeBlocks(g: Range, mode: MergeMode = 'all'): Range[] {
  if (mode === 'horizontal') return g.c2 > g.c1 ? Array.from({ length: g.r2 - g.r1 + 1 }, (_, i) => ({ r1: g.r1 + i, r2: g.r1 + i, c1: g.c1, c2: g.c2 })) : []
  if (mode === 'vertical') return g.r2 > g.r1 ? Array.from({ length: g.c2 - g.c1 + 1 }, (_, i) => ({ r1: g.r1, r2: g.r2, c1: g.c1 + i, c2: g.c1 + i })) : []
  return g.r2 > g.r1 || g.c2 > g.c1 ? [g] : []
}
/**
 * Merges `g` on a sheet (mutates the given sheet object's cells map and merges field, which the caller has copied):
 * existing merges it overlaps are replaced; each block keeps only its top-left cell's value, like Sheets.
 */
export function applyMerge(sheet: Sheet, g: Range, mode: MergeMode = 'all'): Range[] {
  const blocks = mergeBlocks(g, mode)
  const keep = mergeList(sheet).filter(m => !overlaps(m, g))
  for (const b of blocks)
    for (let r = b.r1; r <= b.r2; r++)
      for (let c = b.c1; c <= b.c2; c++) {
        if (r === b.r1 && c === b.c1) continue
        const a = addr(r, c)
        if (sheet.cells[a]) delete sheet.cells[a]
      }
  const next = [...keep, ...blocks].map(rangeStr)
  sheet.merges = next.length ? next : undefined
  return blocks
}
export function removeMerges(sheet: Sheet, g: Range): number {
  const list = mergeList(sheet)
  const keep = list.filter(m => !overlaps(m, g))
  sheet.merges = keep.length ? keep.map(rangeStr) : undefined
  return list.length - keep.length
}

// ---------------- conditional formatting ----------------

const cellValue = (c: Cell | undefined): V => {
  const v = c?.v
  if (v === undefined) return null
  if (typeof v === 'string' && c?.f && /^#[A-Z/0!?]+[!?A]?$/.test(v)) return new FErr(v)
  return v
}

/** Read-only evaluation context over stored values (rules never recalculate the workbook). */
const ctxCache = new WeakMap<Sheet[], EvalCtx[]>()
function ctxFor(wb: Workbook, si: number): EvalCtx {
  let list = ctxCache.get(wb.sheets)
  if (!list) {
    const byName = new Map(wb.sheets.map((s, i) => [s.name.toLowerCase(), i]))
    const sizes: ({ rows: number; cols: number } | undefined)[] = []
    list = wb.sheets.map((_, sheet) => ({
      sheet,
      cell: (s: number, r: number, c: number) => cellValue(wb.sheets[s]?.cells[addr(r, c)]),
      sheetIndex: (name: string | undefined) => (name === undefined ? sheet : byName.get(name.toLowerCase()) ?? -1),
      size: (s: number) => (sizes[s] ??= wb.sheets[s] ? usedSize(wb.sheets[s].cells) : { rows: 0, cols: 0 })
    }))
    ctxCache.set(wb.sheets, list)
  }
  return list[si]
}

const isNum = (x: unknown) => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)))
function compare(v: V, operand: unknown): number | null {
  if (v === null || v instanceof FErr) return null
  if (isNum(v) && isNum(operand)) return Number(v) - Number(operand)
  const a = String(v).toLowerCase(), b = String(operand ?? '').toLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

/** Min and max of the numbers in a range, cached per cells map (recomputed only when the sheet changes). */
const scaleCache = new WeakMap<Record<string, Cell>, Map<string, { min: number; max: number }>>()
function minMax(sheet: Sheet, g: Range) {
  let m = scaleCache.get(sheet.cells)
  if (!m) scaleCache.set(sheet.cells, (m = new Map()))
  const key = rangeStr(g)
  let mm = m.get(key)
  if (!mm) {
    let min = Infinity, max = -Infinity
    const u = usedSize(sheet.cells)
    const r2 = Math.min(g.r2, u.rows - 1), c2 = Math.min(g.c2, u.cols - 1)
    for (let r = g.r1; r <= r2; r++)
      for (let c = g.c1; c <= c2; c++) {
        const v = sheet.cells[addr(r, c)]?.v
        if (typeof v === 'number') (min = Math.min(min, v)), (max = Math.max(max, v))
      }
    mm = { min, max }
    m.set(key, mm)
  }
  return mm
}

const hex = (h: string) => {
  const s = h.replace('#', '')
  const n = parseInt(s.length === 3 ? s.replace(/./g, x => x + x) : s.padEnd(6, '0').slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export function mix(a: string, b: string, t: number): string {
  const x = hex(a), y = hex(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('')
}

/** Does a rule apply to the cell at (r, c)? */
export function ruleMatches(wb: Workbook, si: number, rule: ConditionalRule, g: Range, r: number, c: number): boolean {
  const sheet = wb.sheets[si]
  const v = cellValue(sheet.cells[addr(r, c)])
  const empty = v === null || v === ''
  switch (rule.type) {
    case 'empty': return empty
    case 'notEmpty': return !empty
    case 'contains': return !empty && String(v).toLowerCase().includes(String(rule.value ?? '').toLowerCase())
    case 'notContains': return !String(v ?? '').toLowerCase().includes(String(rule.value ?? '').toLowerCase())
    case 'formula': {
      const f = (rule.formula || String(rule.value ?? '')).replace(/^=/, '')
      if (!f) return false
      const res = evaluate(r === g.r1 && c === g.c1 ? f : shiftFormula(f, r - g.r1, c - g.c1), ctxFor(wb, si))
      return res === true || (typeof res === 'number' && res !== 0)
    }
    case 'scale': return typeof v === 'number'
    case 'between': {
      if (empty) return false
      const lo = compare(v, rule.value), hi = compare(v, rule.value2)
      return lo !== null && hi !== null && lo >= 0 && hi <= 0
    }
    default: {
      if (empty && rule.type !== 'neq') return false
      const d = compare(v, rule.value)
      if (d === null) return rule.type === 'neq'
      return rule.type === 'gt' ? d > 0 : rule.type === 'gte' ? d >= 0 : rule.type === 'lt' ? d < 0 : rule.type === 'lte' ? d <= 0 : rule.type === 'eq' ? d === 0 : d !== 0
    }
  }
}

/**
 * The style conditional rules give the cell at (r, c), or null. Rules are checked in order and the first that
 * matches wins, like Google Sheets. Called only for cells on screen; nothing is stored per cell.
 */
export function conditionalStyle(wb: Workbook, si: number, r: number, c: number): CfStyle | null {
  const sheet = wb.sheets[si]
  const rules = sheet?.conditional
  if (!rules?.length) return null
  for (const rule of rules) {
    const g = rng(rule.range)
    if (!g || r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) continue
    if (!ruleMatches(wb, si, rule, g, r, c)) continue
    if (rule.type === 'scale') {
      const v = sheet.cells[addr(r, c)]?.v as number
      const { min, max } = minMax(sheet, g)
      const t = max > min ? (v - min) / (max - min) : 1
      return { bg: mix(rule.scale?.min || '#ffffff', rule.scale?.max || '#57bb8a', t) }
    }
    return rule.style || { bg: '#b7e1cd' }
  }
  return null
}

export function describeRule(rule: ConditionalRule): string {
  const v = rule.value ?? ''
  switch (rule.type) {
    case 'between': return `${CF_LABELS.between} ${v} and ${rule.value2 ?? ''}`
    case 'empty': case 'notEmpty': return CF_LABELS[rule.type]
    case 'formula': return `${CF_LABELS.formula} =${(rule.formula || String(v)).replace(/^=/, '')}`
    case 'scale': return `Color scale ${rule.scale?.min || '#ffffff'} → ${rule.scale?.max || '#57bb8a'}`
    default: return `${CF_LABELS[rule.type]} ${v}`
  }
}

/** Validates and normalizes a rule from an agent or the panel. Throws with a helpful message. */
export function checkRule(raw: unknown): ConditionalRule {
  const o = (raw || {}) as Record<string, unknown>
  const type = String(o.type || '') as CfType
  if (!CF_TYPES.includes(type)) throw new Error(`rule type must be one of: ${CF_TYPES.join(', ')}`)
  const range = String(o.range || '')
  if (!rng(range)) throw new Error(`rule range "${range}" is not a range like B2:B20`)
  const rule: ConditionalRule = { range: rangeStr(rng(range)!), type }
  const val = (x: unknown) => (x === undefined || x === null || x === '' ? undefined : isNum(x) ? Number(x) : String(x))
  if (o.value !== undefined) rule.value = val(o.value)
  if (o.value2 !== undefined) rule.value2 = val(o.value2)
  if (type === 'formula') {
    const f = String(o.formula ?? o.value ?? '').replace(/^=/, '')
    if (!f) throw new Error('a custom formula rule needs formula, e.g. "B2>100"')
    rule.formula = f
    delete rule.value
  }
  if (['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains', 'notContains'].includes(type) && rule.value === undefined) throw new Error(`"${type}" needs value`)
  if (type === 'between' && (rule.value === undefined || rule.value2 === undefined)) throw new Error('"between" needs value and value2')
  if (type === 'scale') {
    const s = (o.scale || {}) as { min?: string; max?: string }
    rule.scale = { min: String(s.min || o.min || '#ffffff'), max: String(s.max || o.max || '#57bb8a') }
  } else {
    const st = (o.style || {}) as CfStyle & { bold?: boolean }
    const style: CfStyle = {}
    if (st.bg) style.bg = String(st.bg)
    if (st.color) style.color = String(st.color)
    if (st.b || st.bold) style.b = true
    if (st.i) style.i = true
    if (st.s) style.s = true
    rule.style = Object.keys(style).length ? style : { bg: '#b7e1cd' }
  }
  return rule
}

// ---------------- charts ----------------

export interface ChartData {
  categories: string[]
  series: { name: string; values: (number | null)[] }[]
  xs?: (number | null)[] // scatter: x values (first column)
}

const textOf = (c: Cell | undefined) => (c?.v === undefined || c?.v === null ? '' : formatValue(c.v, c.s?.fmt))
const numOf = (c: Cell | undefined) => (typeof c?.v === 'number' ? c.v : isNum(c?.v) ? Number(c!.v) : null)

/** Pulls a chart's numbers out of its range. Headers/labels are guessed from the data unless set. */
export function chartData(sheet: Sheet, chart: SheetChart): ChartData {
  const g = rng(chart.range)
  if (!g) return { categories: [], series: [] }
  const u = usedSize(sheet.cells)
  const r2 = Math.min(g.r2, Math.max(g.r1, u.rows - 1)), c2 = Math.min(g.c2, Math.max(g.c1, u.cols - 1))
  const at = (r: number, c: number) => sheet.cells[addr(r, c)]
  const firstRowText = (() => {
    for (let c = g.c1; c <= c2; c++) if (numOf(at(g.r1, c)) === null && textOf(at(g.r1, c))) return true
    return false
  })()
  const firstColText = (() => {
    for (let r = g.r1 + 1; r <= r2; r++) if (numOf(at(r, g.c1)) === null && textOf(at(r, g.c1))) return true
    return false
  })()
  const headers = chart.headers ?? firstRowText
  // First column is labels when it holds text, or when the header row leaves its first cell blank (a corner).
  const labels = chart.labels ?? (chart.type === 'scatter' ? false : firstColText || (c2 > g.c1 && firstRowText && !textOf(at(g.r1, g.c1))))
  const rs = headers ? g.r1 + 1 : g.r1
  const cs = labels || chart.type === 'scatter' ? g.c1 + 1 : g.c1
  const rowsN = Math.max(0, Math.min(r2 - rs + 1, 2000))
  const categories = Array.from({ length: rowsN }, (_, i) => (labels ? textOf(at(rs + i, g.c1)) : String(i + 1)))
  const series: ChartData['series'] = []
  for (let c = cs; c <= c2 && series.length < 12; c++)
    series.push({ name: headers ? textOf(at(g.r1, c)) || colName(c) : `Series ${series.length + 1}`, values: Array.from({ length: rowsN }, (_, i) => numOf(at(rs + i, c))) })
  const data: ChartData = { categories, series }
  if (chart.type === 'scatter') data.xs = Array.from({ length: rowsN }, (_, i) => numOf(at(rs + i, g.c1)))
  return data
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (lo === hi) (lo = lo > 0 ? 0 : lo - 1), (hi = hi > 0 ? hi : hi + 1)
  const span = hi - lo
  const step0 = span / n
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= step0) || mag * 10
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step)
  return out
}
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
const short = (n: number) => {
  const a = Math.abs(n)
  return a >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : a >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : a >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : String(+n.toFixed(2))
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * The chart as an SVG string. Text and axes use currentColor, so the chart follows the page's text color
 * (dark mode in the app, black when printed).
 */
export function chartSvg(chart: SheetChart, data: ChartData, w = chart.w, h = chart.h): string {
  const title = chart.title ? `<text x="${w / 2}" y="22" text-anchor="middle" font-size="15" font-weight="600" fill="currentColor">${esc(chart.title)}</text>` : ''
  const top = chart.title ? 36 : 14
  const series = data.series.filter(s => s.values.some(v => v !== null))
  const wrap = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Arial, Helvetica, sans-serif" style="color: inherit">${title}${body}</svg>`
  if (!series.length) return wrap(`<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="13" fill="currentColor" opacity=".6">No numbers in ${esc(chart.range)}</text>`)
  const legend = (y: number) => {
    if (series.length < 2 && chart.type !== 'pie') return ''
    const items = chart.type === 'pie' ? data.categories.map((name, i) => ({ name, color: CHART_COLORS[i % CHART_COLORS.length] })) : series.map((s, i) => ({ name: s.name, color: CHART_COLORS[i % CHART_COLORS.length] }))
    let x = 12
    return items.slice(0, 12).map(it => {
      const label = clip(it.name || '', 18)
      const part = `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${it.color}"/><text x="${x + 14}" y="${y}" font-size="11" fill="currentColor">${esc(label)}</text>`
      x += 26 + label.length * 6.2
      return x > w ? '' : part
    }).join('')
  }

  if (chart.type === 'pie') {
    const vals = series[0].values.map(v => Math.max(0, v ?? 0))
    const total = vals.reduce((a, b) => a + b, 0) || 1
    const cx = w / 2, cy = top + (h - top - 26) / 2, rad = Math.max(10, Math.min(w, h - top - 26) / 2 - 8)
    let a0 = -Math.PI / 2
    const slices = vals.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const p = (a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`
      const d = vals.length === 1 || v === total ? `M${cx - rad},${cy}a${rad},${rad} 0 1,0 ${rad * 2},0a${rad},${rad} 0 1,0 ${-rad * 2},0` : `M${cx},${cy}L${p(a0)}A${rad},${rad} 0 ${large},1 ${p(a1)}Z`
      const mid = (a0 + a1) / 2
      const pct = v / total
      const label = pct > 0.06 ? `<text x="${(cx + rad * 0.65 * Math.cos(mid)).toFixed(1)}" y="${(cy + rad * 0.65 * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#fff">${Math.round(pct * 100)}%</text>` : ''
      a0 = a1
      return `<path d="${d}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" stroke="#fff" stroke-width="1"><title>${esc(data.categories[i] || '')}: ${v}</title></path>${label}`
    }).join('')
    return wrap(slices + legend(h - 8))
  }

  // axes charts
  const horizontal = chart.type === 'bar'
  const all = chart.type === 'scatter' ? series.flatMap(s => s.values) : series.flatMap(s => s.values)
  const nums = all.filter((v): v is number => v !== null)
  let lo = Math.min(0, ...nums), hi = Math.max(0, ...nums)
  if (chart.type === 'line' || chart.type === 'scatter') (lo = Math.min(...nums)), (hi = Math.max(...nums))
  const ticks = niceTicks(lo, hi)
  lo = ticks[0]
  hi = ticks[ticks.length - 1]
  const legendH = series.length > 1 ? 20 : 0
  const left = horizontal ? Math.min(120, 14 + Math.max(...data.categories.map(c => clip(c, 16).length)) * 6.2) : 14 + Math.max(...ticks.map(t => short(t).length)) * 6.5
  const bottom = 26 + legendH
  const pw = Math.max(10, w - left - 16), ph = Math.max(10, h - top - bottom)
  const val = (v: number) => (v - lo) / (hi - lo || 1)
  let out = ''
  // grid + value axis
  for (const t of ticks) {
    const k = val(t)
    if (horizontal) {
      const x = left + k * pw
      out += `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + ph}" stroke="currentColor" stroke-opacity=".15"/><text x="${x}" y="${top + ph + 15}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${short(t)}</text>`
    } else {
      const y = top + ph - k * ph
      out += `<line x1="${left}" x2="${left + pw}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity=".15"/><text x="${left - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="currentColor" opacity=".7">${short(t)}</text>`
    }
  }
  const n = data.categories.length || 1
  if (chart.type === 'scatter') {
    const xs = (data.xs || []).filter((v): v is number => v !== null)
    const xt = niceTicks(Math.min(...xs), Math.max(...xs))
    const xv = (v: number) => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw
    for (const t of xt) out += `<text x="${xv(t)}" y="${top + ph + 15}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${short(t)}</text>`
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = data.xs?.[i]
        if (v === null || x === null || x === undefined) return
        out += `<circle cx="${xv(x).toFixed(1)}" cy="${(top + ph - val(v) * ph).toFixed(1)}" r="3.5" fill="${CHART_COLORS[si % CHART_COLORS.length]}"><title>${x}, ${v}</title></circle>`
      })
    })
  } else if (chart.type === 'line') {
    const step = pw / Math.max(1, n - 1)
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => (v === null ? null : `${(left + (n === 1 ? pw / 2 : i * step)).toFixed(1)},${(top + ph - val(v) * ph).toFixed(1)}`))
      const color = CHART_COLORS[si % CHART_COLORS.length]
      const segs = pts.join(' ').split(/\s*null\s*/).filter(Boolean)
      out += segs.map(seg => `<polyline points="${seg}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`).join('')
      if (n <= 40) out += pts.map(p => (p ? `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="${color}"/>` : '')).join('')
    })
    const every = Math.ceil(n / Math.max(1, Math.floor(pw / 60)))
    data.categories.forEach((c, i) => {
      if (i % every) return
      out += `<text x="${(left + (n === 1 ? pw / 2 : i * step)).toFixed(1)}" y="${top + ph + 15}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${esc(clip(c, 12))}</text>`
    })
  } else {
    // bar (horizontal) / column (vertical), grouped
    const band = (horizontal ? ph : pw) / n
    const inner = band * 0.75
    const bw = inner / series.length
    const zero = val(Math.max(lo, Math.min(0, hi)))
    series.forEach((s, si) => {
      const color = CHART_COLORS[si % CHART_COLORS.length]
      s.values.forEach((v, i) => {
        if (v === null) return
        const k = val(v)
        const a = Math.min(k, zero), b = Math.max(k, zero)
        const off = i * band + (band - inner) / 2 + si * bw
        const tip = `<title>${esc(data.categories[i] || '')} · ${esc(s.name)}: ${v}</title>`
        out += horizontal
          ? `<rect x="${(left + a * pw).toFixed(1)}" y="${(top + off).toFixed(1)}" width="${Math.max(0.5, (b - a) * pw).toFixed(1)}" height="${Math.max(1, bw - 1).toFixed(1)}" fill="${color}">${tip}</rect>`
          : `<rect x="${(left + off).toFixed(1)}" y="${(top + ph - b * ph).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0.5, (b - a) * ph).toFixed(1)}" fill="${color}">${tip}</rect>`
      })
    })
    const every = Math.ceil(n / Math.max(1, Math.floor((horizontal ? ph / 16 : pw / 60))))
    data.categories.forEach((c, i) => {
      if (i % every) return
      out += horizontal
        ? `<text x="${left - 6}" y="${(top + i * band + band / 2 + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" opacity=".7">${esc(clip(c, 16))}</text>`
        : `<text x="${(left + i * band + band / 2).toFixed(1)}" y="${top + ph + 15}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${esc(clip(c, 12))}</text>`
    })
  }
  out += horizontal
    ? `<line x1="${left}" x2="${left}" y1="${top}" y2="${top + ph}" stroke="currentColor" stroke-opacity=".4"/>`
    : `<line x1="${left}" x2="${left + pw}" y1="${top + ph}" y2="${top + ph}" stroke="currentColor" stroke-opacity=".4"/>`
  return wrap(out + legend(h - 8))
}

export const CHART_TYPES: { type: ChartType; label: string }[] = [
  { type: 'column', label: 'Column' },
  { type: 'bar', label: 'Bar' },
  { type: 'line', label: 'Line' },
  { type: 'pie', label: 'Pie' },
  { type: 'scatter', label: 'Scatter' }
]

export function checkChart(raw: unknown, existing: SheetChart[] = []): SheetChart {
  const o = (raw || {}) as Record<string, unknown>
  const g = rng(String(o.range || ''))
  if (!g) throw new Error(`chart range "${o.range ?? ''}" is not a range like A1:C10`)
  const type = String(o.type || 'column') as ChartType
  if (!CHART_TYPES.some(t => t.type === type)) throw new Error(`chart type must be one of: ${CHART_TYPES.map(t => t.type).join(', ')}`)
  let id = String(o.id || '')
  if (!id) for (let n = existing.length + 1; ; n++) if (!existing.some(c => c.id === `chart${n}`)) { id = `chart${n}`; break }
  const at = o.at && parseAddr(String(o.at)) ? String(o.at).toUpperCase().replace(/\$/g, '') : addr(g.r1, g.c2 + 2)
  const chart: SheetChart = { id, type, range: rangeStr(g), at, w: Math.max(160, Number(o.w) || 480), h: Math.max(120, Number(o.h) || 300) }
  if (o.title) chart.title = String(o.title)
  if (typeof o.headers === 'boolean') chart.headers = o.headers
  if (typeof o.labels === 'boolean') chart.labels = o.labels
  if (Number(o.dx)) chart.dx = Number(o.dx)
  if (Number(o.dy)) chart.dy = Number(o.dy)
  return chart
}

/** CSS-ish style for a cell after conditional formatting (for print). */
export function mergedStyle(base: CellStyle | undefined, cf: CfStyle | null): CellStyle | undefined {
  if (!cf) return base
  return { ...base, ...(cf.bg ? { bg: cf.bg } : {}), ...(cf.color ? { color: cf.color } : {}), ...(cf.b ? { b: true } : {}), ...(cf.i ? { i: true } : {}), ...(cf.s ? { s: true } : {}) }
}
