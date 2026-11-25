import { usedSize } from '../../../shared/sheet/address'
import type { Cell, Sheet, Workbook } from '../../../shared/types'

export const DEF_W = 100
export const DEF_H = 21
export const RH = 46 // row header width
export const CH = 24 // column header height

/** Offsets along one axis: pos[i] is where item i starts, pos[n] the total length. */
export interface Axis {
  n: number
  pos: Float64Array
  size(i: number): number
  /** Index of the item covering pixel `px` (clamped). */
  at(px: number): number
}

export function makeAxis(n: number, def: number, sizes?: Record<number, number>): Axis {
  const pos = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pos[i + 1] = pos[i] + (sizes?.[i] ?? def)
  return {
    n,
    pos,
    size: i => (i < n ? pos[i + 1] - pos[i] : sizes?.[i] ?? def),
    at: px => {
      let lo = 0, hi = n - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (pos[mid] <= px) lo = mid
        else hi = mid - 1
      }
      return Math.max(0, lo)
    }
  }
}

const usedCache = new WeakMap<Record<string, Cell>, { rows: number; cols: number }>()
/** usedSize, memoized per cells map (maps are replaced, never mutated, once the editor holds them). */
export function used(cells: Record<string, Cell>) {
  let u = usedCache.get(cells)
  if (!u) {
    u = usedSize(cells)
    usedCache.set(cells, u)
  }
  return u
}

const formulaCache = new WeakMap<Record<string, Cell>, boolean>()
export function hasFormulas(cells: Record<string, Cell>) {
  let h = formulaCache.get(cells)
  if (h === undefined) {
    h = false
    for (const k in cells) if (cells[k].f) { h = true; break }
    formulaCache.set(cells, h)
  }
  return h
}

export function dims(sheet: Sheet, minR = 0, minC = 0) {
  const u = used(sheet.cells)
  return { rows: Math.max(1000, u.rows + 100, minR + 50), cols: Math.max(26, u.cols + 5, minC + 5) }
}

/** Number format with one more/less decimal place. */
export function bumpDecimals(fmt: string | undefined, delta: number, value: unknown): string {
  let f = !fmt || fmt === 'general' ? '' : fmt
  if (!f) {
    const s = typeof value === 'number' ? String(value) : ''
    const d = s.includes('.') ? s.split('.')[1].length : 0
    f = d ? '0.' + '0'.repeat(d) : '0'
  }
  if (f === 'date' || f === 'datetime') return f
  const m = f.match(/^(.*?0)(\.0+)?(.*)$/)
  if (!m) return f
  const cur = m[2] ? m[2].length - 1 : 0
  const n = Math.max(0, Math.min(10, cur + delta))
  return m[1] + (n ? '.' + '0'.repeat(n) : '') + m[3]
}

export const REF_COLORS = ['#1a73e8', '#e8710a', '#9334e6', '#188038', '#d93025', '#12b5cb', '#f538a0']

/**
 * One undo step, stored compactly: sheets whose cells map is shared with the neighboring state are kept by
 * reference (free), changed ones as a diff against the state the step is applied to.
 */
export interface Snap {
  active: number
  sheets: { meta: Omit<Sheet, 'cells'>; cells: Record<string, Cell> | null; diff?: Record<string, Cell | null> }[]
}
/** Step that turns `next` back into `prev`. */
export function makeSnap(prev: Workbook, next: Workbook, active: number): Snap {
  return {
    active,
    sheets: prev.sheets.map((ps, i) => {
      const { cells, ...meta } = ps
      if (next.sheets.some(ns => ns.cells === cells) || !next.sheets[i]) return { meta, cells }
      const nc = next.sheets[i].cells
      const diff: Record<string, Cell | null> = {}
      for (const k in cells) if (nc[k] !== cells[k]) diff[k] = cells[k]
      for (const k in nc) if (!(k in cells)) diff[k] = null
      return { meta, cells: null, diff }
    })
  }
}
export function applySnap(s: Snap, cur: Workbook): Workbook {
  return {
    sheets: s.sheets.map((x, i) => {
      if (x.cells) return { ...x.meta, cells: x.cells }
      const cells = { ...cur.sheets[i].cells }
      for (const k in x.diff) {
        const v = x.diff[k]
        if (v) cells[k] = v
        else delete cells[k]
      }
      return { ...x.meta, cells }
    })
  }
}
