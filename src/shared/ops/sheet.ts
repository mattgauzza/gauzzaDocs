import { type Range, addr, colIndex, norm, parseAddr, parseRange, rangeStr, usedSize } from '../sheet/address'
import { parseCsv, writeCsv } from '../sheet/csv'
import { formatValue, parseInput } from '../sheet/format'
import { type MergeMode, applyMerge, checkChart, checkRule, chartData, describeRule, expandToMerges, removeMerges, shiftExtras } from '../sheet/extras'
import { type RefTok, mapRefs, recalc } from '../sheet/formula'
import type { AgentOp, Cell, CellStyle, Sheet, Workbook } from '../types'
import { OpError, type OpHandler, need, num, str } from './types'

/** Copy of the workbook whose sheets and cells maps may be changed without touching the original. */
export function cloneWb(wb: Workbook): Workbook {
  return { sheets: wb.sheets.map(s => ({ ...s, cells: { ...s.cells }, colWidths: s.colWidths && { ...s.colWidths }, rowHeights: s.rowHeights && { ...s.rowHeights } })) }
}

/** Turns an agent/user supplied value into a cell, keeping the existing style. */
export function toCell(value: unknown, old?: Cell): Cell | undefined {
  const s = old?.s
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Cell & { formula?: string; value?: unknown; style?: CellStyle }
    const f = o.f ?? (o.formula ? String(o.formula).replace(/^=/, '') : undefined)
    const v = o.v !== undefined ? o.v : (o.value as Cell['v'])
    const style = o.s ?? o.style ?? s
    const c: Cell = {}
    if (f) c.f = f.replace(/^=/, '')
    else if (v !== undefined && v !== null && v !== '') c.v = v
    if (style && Object.keys(style).length) c.s = style
    return c.f || c.v !== undefined || c.s ? c : undefined
  }
  if (value === null || value === undefined || value === '') return s ? { s } : undefined
  if (typeof value === 'number' || typeof value === 'boolean') return s ? { v: value, s } : { v: value }
  const text = String(value)
  if (text.startsWith('=') && text.length > 1) return s ? { f: text.slice(1), s } : { f: text.slice(1) }
  const p = parseInput(text.startsWith("'") ? text : text)
  if (text.startsWith("'")) return s ? { v: text.slice(1), s } : { v: text.slice(1) }
  const style = p.fmt && !s?.fmt ? { ...s, fmt: p.fmt } : s
  if (p.v === null) return style ? { s: style } : undefined
  return style ? { v: p.v, s: style } : { v: p.v }
}

export function resolveSheet(wb: Workbook, sel: unknown, active = 0): number {
  if (sel === undefined || sel === null || sel === '') return Math.min(active, wb.sheets.length - 1)
  if (typeof sel === 'number' || /^\d+$/.test(String(sel))) {
    const i = Number(sel)
    if (!wb.sheets[i]) throw new OpError(`No sheet at index ${i} (there are ${wb.sheets.length})`)
    return i
  }
  const i = wb.sheets.findIndex(s => s.name.toLowerCase() === String(sel).toLowerCase())
  if (i < 0) throw new OpError(`No sheet named "${sel}". Sheets: ${wb.sheets.map(s => s.name).join(', ')}`)
  return i
}

export function usedRange(sheet: Sheet): Range | null {
  const { rows, cols } = usedSize(sheet.cells)
  return rows ? { r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 } : null
}

function rangeArg(op: AgentOp, sheet: Sheet, key = 'range', required = false): Range | null {
  const s = str(op, key)
  if (!s) {
    if (required) throw new OpError(`"${op.op}" needs ${key}, e.g. "A1:C10"`)
    return usedRange(sheet)
  }
  const u = usedSize(sheet.cells)
  const g = parseRange(s, { r: Math.max(u.rows - 1, 0), c: Math.max(u.cols - 1, 0) })
  if (!g) throw new OpError(`"${s}" is not a range. Use A1 or A1:C10`)
  return g
}

export const display = (c: Cell | undefined) => formatValue(c?.v, c?.s?.fmt)

export function grid(sheet: Sheet, g: Range, pick: (c: Cell | undefined) => unknown): unknown[][] {
  const out: unknown[][] = []
  for (let r = g.r1; r <= g.r2; r++) {
    const row: unknown[] = []
    for (let c = g.c1; c <= g.c2; c++) row.push(pick(sheet.cells[addr(r, c)]))
    out.push(row)
  }
  return out
}

/** Sheet's used area as CSV of displayed values. */
export function sheetToCsv(sheet: Sheet, delim = ','): string {
  const g = usedRange(sheet)
  return g ? writeCsv(grid(sheet, g, display) as string[][], delim) : ''
}

/** Replaces all cells of a sheet with a grid of raw values (strings parsed like typed input). */
export function setGrid(sheet: Sheet, rows: unknown[][], start = { r: 0, c: 0 }, parse = true) {
  rows.forEach((row, i) =>
    row.forEach((v, j) => {
      const a = addr(start.r + i, start.c + j)
      const cell = parse ? toCell(v, sheet.cells[a]) : v === '' || v == null ? undefined : { v: v as Cell['v'] }
      if (cell) sheet.cells[a] = cell
      else delete sheet.cells[a]
    })
  )
}

/** Fast CSV -> cells for big files: numbers recognized, everything else stays text. No style inference. */
export function csvToCells(text: string, delim?: string): Record<string, Cell> {
  const cells: Record<string, Cell> = {}
  const rows = parseCsv(text, delim)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      const s = row[c]
      if (s === '') continue
      const n = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) && !/^-?0\d/.test(s) ? Number(s) : NaN
      cells[addr(r, c)] = { v: Number.isNaN(n) ? s : n }
    }
  }
  return cells
}

// ---------- structural changes (rows/columns), with formula reference fix-ups ----------

type Axis = 'r' | 'c'
function shiftStructure(wb: Workbook, si: number, axis: Axis, at: number, count: number) {
  // count > 0 inserts `count` before index `at`; count < 0 deletes -count starting at `at`
  const sheet = wb.sheets[si]
  const moved: Record<string, Cell> = {}
  for (const a in sheet.cells) {
    const p = parseAddr(a)!
    const k = axis === 'r' ? p.r : p.c
    if (count < 0 && k >= at && k < at - count) continue
    const nk = k >= at ? k + count : k
    moved[axis === 'r' ? addr(nk, p.c) : addr(p.r, nk)] = sheet.cells[a]
  }
  sheet.cells = moved
  Object.assign(sheet, shiftExtras(sheet, axis, at, count)) // merges, rule ranges and charts move too
  const sizes = axis === 'r' ? 'rowHeights' : 'colWidths'
  if (sheet[sizes]) {
    const next: Record<number, number> = {}
    for (const [k, v] of Object.entries(sheet[sizes]!)) {
      const i = Number(k)
      if (count < 0 && i >= at && i < at - count) continue
      next[i >= at ? i + count : i] = v
    }
    sheet[sizes] = next
  }
  const fix = (e: RefTok['a']): RefTok['a'] | null => {
    const k = e[axis]
    if (k === undefined) return e
    if (count > 0) return k >= at ? { ...e, [axis]: k + count } : e
    if (k >= at && k < at - count) return null
    return k >= at - count ? { ...e, [axis]: k + count } : e
  }
  wb.sheets.forEach((s, i) => {
    for (const a in s.cells) {
      const c = s.cells[a]
      if (!c.f) continue
      const f = mapRefs(c.f, ref => {
        const target = ref.sheet === undefined ? i : wb.sheets.findIndex(x => x.name.toLowerCase() === ref.sheet!.toLowerCase())
        if (target !== si) return ref
        if (!ref.b) {
          const a2 = fix(ref.a)
          return a2 ? { ...ref, a: a2 } : null
        }
        // a range: shrink when an end is deleted
        let a1 = fix(ref.a), b1 = fix(ref.b)
        if (count < 0) {
          const k1 = ref.a[axis], k2 = ref.b[axis]
          if (k1 !== undefined && k2 !== undefined) {
            const lo = Math.min(k1, k2), hi = Math.max(k1, k2)
            const delEnd = at - count - 1
            if (lo >= at && hi <= delEnd) return null
            const nlo = lo >= at && lo <= delEnd ? at : lo > delEnd ? lo + count : lo
            const nhi = hi >= at && hi <= delEnd ? at - 1 : hi > delEnd ? hi + count : hi
            a1 = { ...ref.a, [axis]: nlo }
            b1 = { ...ref.b, [axis]: nhi }
          }
        }
        if (!a1 || !b1) return null
        return { ...ref, a: a1, b: b1 }
      })
      if (f !== c.f) s.cells[a] = { ...c, f }
    }
  })
}

const rowArg = (op: AgentOp, key = 'at') => {
  const v = op[key]
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new OpError(`${key} must be a 1-based row number`)
  return n - 1
}
const colArg = (op: AgentOp, key = 'at') => {
  const v = op[key]
  if (typeof v === 'string' && /^[A-Za-z]{1,3}$/.test(v)) return colIndex(v)
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new OpError(`${key} must be a column letter or 1-based number`)
  return n - 1
}

export interface SheetOpResult {
  result: unknown
  workbook?: Workbook
  /** For the editor: sheet and range the op changed, to highlight. */
  touched?: { sheet: number; range: Range }
  /** For the editor: sheet to show after the op. */
  activeSheet?: number
}

/**
 * Pure sheet ops (see src/shared/ops.md). Never mutates `wb`; returns a new workbook when anything changed,
 * already recalculated.
 */
export function applySheetOp(wb: Workbook, op: AgentOp, active = 0): SheetOpResult {
  const si = ['addSheet', 'sheets', 'info'].includes(op.op) ? active : resolveSheet(wb, op.sheet, active)
  const sheet = wb.sheets[si]
  // 'touched': only formulas downstream of the changed range are re-evaluated; 'none': values did not change
  const edit = (fn: (next: Workbook, s: Sheet) => Omit<SheetOpResult, 'workbook'>, mode: 'full' | 'touched' | 'none' = 'full'): SheetOpResult => {
    const next = cloneWb(wb)
    const r = fn(next, next.sheets[si])
    recalc(next, mode === 'none' ? [] : mode === 'touched' && r.touched ? [r.touched] : undefined)
    return { ...r, workbook: next }
  }
  switch (op.op) {
    case 'read': {
      const fmt = str(op, 'format', 'json')
      const g = rangeArg(op, sheet)
      if (!g) return { result: fmt === 'csv' ? { content: '' } : { range: null, values: [] } }
      if (fmt === 'csv' || fmt === 'tsv') return { result: { range: rangeStr(g), content: writeCsv(grid(sheet, g, display) as string[][], fmt === 'tsv' ? '\t' : ',') } }
      if (fmt === 'formulas') return { result: { range: rangeStr(g), values: grid(sheet, g, c => (c?.f ? '=' + c.f : c?.v ?? null)) } }
      if (fmt === 'display') return { result: { range: rangeStr(g), values: grid(sheet, g, display) } }
      return { result: { range: rangeStr(g), values: grid(sheet, g, c => c?.v ?? null) } }
    }
    case 'get': {
      const g = rangeArg(op, sheet)
      const cells: Record<string, Cell & { text: string }> = {}
      if (g) for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
        const a = addr(r, c), cell = sheet.cells[a]
        if (cell) cells[a] = { ...cell, text: display(cell) }
      }
      return { result: { sheet: sheet.name, range: g ? rangeStr(g) : null, cells } }
    }
    case 'set': {
      const map = need<Record<string, unknown>>(op, 'cells', 'object')
      const keys = Object.keys(map)
      if (!keys.length) throw new OpError('"set" needs at least one cell')
      const ps = keys.map(k => {
        const p = parseAddr(k)
        if (!p) throw new OpError(`"${k}" is not a cell address`)
        return p
      })
      return edit((_n, s) => {
        keys.forEach((k, i) => {
          const a = addr(ps[i].r, ps[i].c)
          const c = toCell(map[k], s.cells[a])
          if (c) s.cells[a] = c
          else delete s.cells[a]
        })
        const g = norm({ r1: Math.min(...ps.map(p => p.r)), c1: Math.min(...ps.map(p => p.c)), r2: Math.max(...ps.map(p => p.r)), c2: Math.max(...ps.map(p => p.c)) })
        return { result: { ok: true, sheet: s.name, updated: keys.length }, touched: { sheet: si, range: g } }
      }, 'touched')
    }
    case 'setRange': {
      const start = parseAddr(str(op, 'start', 'A1'))
      if (!start) throw new OpError('start must be a cell like A1')
      const values = op.values
      if (!Array.isArray(values) || !values.every(Array.isArray)) throw new OpError('"setRange" needs values: a 2D array (rows of cells)')
      return edit((_n, s) => {
        setGrid(s, values as unknown[][], start)
        const w = Math.max(1, ...(values as unknown[][]).map(r => r.length))
        const g = { r1: start.r, c1: start.c, r2: start.r + Math.max(values.length, 1) - 1, c2: start.c + w - 1 }
        return { result: { ok: true, sheet: s.name, range: rangeStr(g) }, touched: { sheet: si, range: g } }
      }, 'touched')
    }
    case 'append': {
      const values = op.values
      if (!Array.isArray(values) || !values.every(Array.isArray)) throw new OpError('"append" needs values: a 2D array (rows of cells)')
      return edit((_n, s) => {
        const start = { r: usedSize(s.cells).rows, c: 0 }
        setGrid(s, values as unknown[][], start)
        const w = Math.max(1, ...(values as unknown[][]).map(r => r.length))
        const g = { r1: start.r, c1: 0, r2: start.r + values.length - 1, c2: w - 1 }
        return { result: { ok: true, sheet: s.name, range: rangeStr(g) }, touched: { sheet: si, range: g } }
      }, 'touched')
    }
    case 'write': {
      const content = op.content
      const fmt = str(op, 'format', typeof content === 'string' ? 'csv' : 'json')
      return edit((_n, s) => {
        if (fmt === 'csv' || fmt === 'tsv') {
          if (typeof content !== 'string') throw new OpError('content must be CSV text')
          s.cells = {}
          setGrid(s, parseCsv(content, fmt === 'tsv' ? '\t' : undefined))
        } else {
          const data = typeof content === 'string' ? JSON.parse(content) : content
          s.cells = {}
          if (Array.isArray(data)) setGrid(s, data as unknown[][])
          else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data as object)) {
            const p = parseAddr(k)
            const c = p && toCell(v)
            if (p && c) s.cells[addr(p.r, p.c)] = c
          }
          else throw new OpError('JSON content must be a 2D array or a { "A1": value } map')
        }
        const g = usedRange(s) || { r1: 0, c1: 0, r2: 0, c2: 0 }
        return { result: { ok: true, sheet: s.name, range: rangeStr(g) }, touched: { sheet: si, range: g } }
      })
    }
    case 'clear': {
      const g = rangeArg(op, sheet, 'range', true)!
      const keepFormat = !!op.keepFormat
      return edit((_n, s) => {
        for (const a of Object.keys(s.cells)) {
          const p = parseAddr(a)!
          if (p.r < g.r1 || p.r > g.r2 || p.c < g.c1 || p.c > g.c2) continue
          const st = s.cells[a].s
          if (keepFormat && st) s.cells[a] = { s: st }
          else delete s.cells[a]
        }
        return { result: { ok: true, range: rangeStr(g) }, touched: { sheet: si, range: g } }
      }, 'touched')
    }
    case 'format': {
      const g = rangeArg(op, sheet, 'range', true)!
      const style = need<CellStyle>(op, 'style', 'object')
      const reset = !!op.reset
      if ((g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1) > 2_000_000) throw new OpError('range too large to format')
      return edit((_n, s) => {
        for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
          const a = addr(r, c), old = s.cells[a]
          const st: CellStyle = reset ? { ...style } : { ...old?.s, ...style }
          for (const k of Object.keys(st) as (keyof CellStyle)[]) if (st[k] === null || st[k] === undefined || (st[k] as unknown) === false) delete st[k]
          const next: Cell = { ...old }
          if (Object.keys(st).length) next.s = st
          else delete next.s
          if (next.v === undefined && !next.f && !next.s) delete s.cells[a]
          else s.cells[a] = next
        }
        return { result: { ok: true, range: rangeStr(g) }, touched: { sheet: si, range: g } }
      }, 'none')
    }
    case 'insertRows':
    case 'deleteRows':
    case 'insertCols':
    case 'deleteCols': {
      const rows = op.op.endsWith('Rows')
      const at = rows ? rowArg(op) : colArg(op)
      const count = Math.max(1, num(op, 'count', 1)!)
      const del = op.op.startsWith('delete')
      return edit(next => {
        shiftStructure(next, si, rows ? 'r' : 'c', at, del ? -count : count)
        return { result: { ok: true, sheet: sheet.name } }
      })
    }
    case 'merge':
    case 'unmerge': {
      const g = rangeArg(op, sheet, 'range', true)!
      if (op.op === 'unmerge') {
        return edit((_n, s) => {
          const n = removeMerges(s, expandToMerges(s, g))
          return { result: { ok: true, unmerged: n }, touched: { sheet: si, range: g } }
        }, 'none')
      }
      const mode = str(op, 'mode', 'all') as MergeMode
      if (!['all', 'horizontal', 'vertical'].includes(mode)) throw new OpError('mode must be all, horizontal or vertical')
      return edit((_n, s) => {
        const blocks = applyMerge(s, g, mode)
        if (!blocks.length) throw new OpError('Pick at least two cells to merge')
        return { result: { ok: true, merged: blocks.map(rangeStr), note: 'Only the top-left value of each block is kept.' }, touched: { sheet: si, range: g } }
      }, 'touched')
    }
    case 'merges':
      return { result: { sheet: sheet.name, merges: sheet.merges || [] } }
    case 'rules':
      return { result: { sheet: sheet.name, rules: (sheet.conditional || []).map((r, index) => ({ index, ...r, description: describeRule(r) })) } }
    case 'addRule': {
      let rule
      try {
        rule = checkRule({ ...(op.rule as object), range: (op.rule as { range?: string })?.range ?? op.range })
      } catch (e) {
        throw new OpError((e as Error).message)
      }
      return edit((_n, s) => {
        s.conditional = [...(s.conditional || []), rule]
        return { result: { ok: true, index: s.conditional.length - 1, description: describeRule(rule) }, touched: { sheet: si, range: parseRange(rule.range)! } }
      }, 'none')
    }
    case 'updateRule':
    case 'deleteRule': {
      const index = num(op, 'index')
      const list = sheet.conditional || []
      if (index === undefined || !list[index]) throw new OpError(`No rule at index ${index}. See "rules".`)
      let rule = list[index]
      if (op.op === 'updateRule') {
        try {
          rule = checkRule({ ...rule, ...(op.rule as object) })
        } catch (e) {
          throw new OpError((e as Error).message)
        }
      }
      return edit((_n, s) => {
        const next = [...list]
        if (op.op === 'deleteRule') next.splice(index, 1)
        else next[index] = rule
        s.conditional = next.length ? next : undefined
        return { result: { ok: true, rules: next.length } }
      }, 'none')
    }
    case 'charts':
      return {
        result: {
          sheet: sheet.name,
          charts: (sheet.charts || []).map(c => {
            const d = chartData(sheet, c)
            return { ...c, series: d.series.map(x => x.name), points: d.categories.length }
          })
        }
      }
    case 'addChart':
    case 'updateChart': {
      const list = sheet.charts || []
      let chart
      try {
        if (op.op === 'addChart') chart = checkChart(op, list)
        else {
          const old = list.find(c => c.id === str(op, 'id'))
          if (!old) throw new Error(`No chart "${str(op, 'id')}". See "charts".`)
          const { op: _o, sheet: _s, ...patch } = op
          chart = checkChart({ ...old, ...patch, id: old.id }, list)
        }
      } catch (e) {
        throw new OpError((e as Error).message)
      }
      const c = chart
      return edit((_n, s) => {
        s.charts = op.op === 'addChart' ? [...list, c] : list.map(x => (x.id === c.id ? c : x))
        return { result: { ok: true, id: c.id, chart: c }, touched: { sheet: si, range: parseRange(c.range)! } }
      }, 'none')
    }
    case 'deleteChart': {
      const id = need<string>(op, 'id')
      const list = sheet.charts || []
      if (!list.some(c => c.id === id)) throw new OpError(`No chart "${id}". See "charts".`)
      return edit((_n, s) => {
        const next = list.filter(c => c.id !== id)
        s.charts = next.length ? next : undefined
        return { result: { ok: true, deleted: id } }
      }, 'none')
    }
    case 'sheets':
      return { result: { sheets: wb.sheets.map(s => s.name) } }
    case 'addSheet': {
      let name = str(op, 'name')
      if (!name) for (let n = wb.sheets.length + 1; ; n++) if (!wb.sheets.some(s => s.name === `Sheet${n}`)) { name = `Sheet${n}`; break }
      if (wb.sheets.some(s => s.name.toLowerCase() === name.toLowerCase())) throw new OpError(`A sheet named "${name}" already exists`)
      const next = cloneWb(wb)
      next.sheets.push({ name, cells: {} })
      return { result: { ok: true, sheet: name, index: next.sheets.length - 1 }, workbook: next, activeSheet: next.sheets.length - 1 }
    }
    case 'renameSheet': {
      const name = need<string>(op, 'name').trim()
      if (!name || /[\\/?*[\]:]/.test(name)) throw new OpError('Sheet names cannot be empty or contain \\ / ? * [ ] :')
      if (wb.sheets.some((s, i) => i !== si && s.name.toLowerCase() === name.toLowerCase())) throw new OpError(`A sheet named "${name}" already exists`)
      const old = sheet.name
      return edit(next => {
        next.sheets[si].name = name
        // keep references to the sheet working
        next.sheets.forEach(s => {
          for (const a in s.cells) {
            const c = s.cells[a]
            if (!c.f || !c.f.includes('!')) continue
            const f = mapRefs(c.f, ref => (ref.sheet?.toLowerCase() === old.toLowerCase() ? { ...ref, sheet: name } : ref))
            if (f !== c.f) s.cells[a] = { ...c, f }
          }
        })
        return { result: { ok: true, sheet: name } }
      })
    }
    case 'deleteSheet': {
      if (wb.sheets.length < 2) throw new OpError('A workbook needs at least one sheet')
      return edit(next => {
        next.sheets.splice(si, 1)
        return { result: { ok: true, deleted: sheet.name }, activeSheet: Math.max(0, si - 1) }
      })
    }
    case 'info':
      return {
        result: {
          sheets: wb.sheets.map(s => {
            const u = usedSize(s.cells)
            return {
              name: s.name, rows: u.rows, cols: u.cols, used: u.rows ? rangeStr({ r1: 0, c1: 0, r2: u.rows - 1, c2: u.cols - 1 }) : null,
              formulas: Object.values(s.cells).filter(c => c.f).length,
              merges: s.merges?.length || 0, rules: s.conditional?.length || 0, charts: s.charts?.length || 0
            }
          })
        }
      }
    default:
      throw new OpError(
        `Unknown op "${op.op}" for spreadsheets. Try: read, get, set, setRange, append, write, clear, format, insertRows, deleteRows, insertCols, deleteCols, merge, unmerge, merges, rules, addRule, updateRule, deleteRule, charts, addChart, updateChart, deleteChart, sheets, addSheet, renameSheet, deleteSheet, info`
      )
  }
}

export const sheetOpHandler: OpHandler = (payload, op) => {
  if (payload.kind !== 'sheet') throw new OpError('not a spreadsheet')
  const r = applySheetOp(payload.workbook, op)
  return { result: r.result, payload: r.workbook ? { kind: 'sheet', workbook: r.workbook } : undefined }
}
