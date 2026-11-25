import fs from 'node:fs'
import { extOf } from '../../shared/kinds'
import { csvToCells, sheetToCsv } from '../../shared/ops/sheet'
import { addr } from '../../shared/sheet/address'
import { type CfType, type ConditionalRule, type SheetChart, rng } from '../../shared/sheet/extras'
import { dateToSerial } from '../../shared/sheet/format'
import type { Cell, CellStyle, Sheet, Workbook } from '../../shared/types'

/**
 * Chart definitions live in a very-hidden sheet with this name, as JSON in A1 ({ "<sheet name>": SheetChart[] }).
 * exceljs cannot write real Excel charts, so Excel and Google Sheets do not show them, but they come back
 * whenever the file is opened here.
 */
export const CHARTS_SHEET = '_gdocs_charts'

/**
 * Spreadsheet files. .xlsx keeps values, formulas (with their last results), basic styles, column widths,
 * frozen panes and every sheet. .csv/.tsv hold the first sheet's displayed values.
 */
export async function loadSheet(file: string): Promise<{ kind: 'sheet'; workbook: Workbook }> {
  const ext = extOf(file)
  if (ext === 'csv' || ext === 'tsv') {
    const text = fs.readFileSync(file, 'utf8')
    return { kind: 'sheet', workbook: { sheets: [{ name: 'Sheet1', cells: csvToCells(text, ext === 'tsv' ? '\t' : undefined) }] } }
  }
  return { kind: 'sheet', workbook: await readXlsx(file) }
}

export async function saveSheet(file: string, workbook: Workbook): Promise<void> {
  const ext = extOf(file)
  if (ext === 'csv' || ext === 'tsv') {
    fs.writeFileSync(file, sheetToCsv(workbook.sheets[0] || { name: 'Sheet1', cells: {} }, ext === 'tsv' ? '\t' : ','))
    return
  }
  await writeXlsx(file, workbook)
}

const excel = async () => ((await import('exceljs')) as unknown as { default: typeof import('exceljs') }).default ?? (await import('exceljs'))

const argbToHex = (c?: { argb?: string }) => (c?.argb && /^[0-9a-f]{8}$/i.test(c.argb) ? '#' + c.argb.slice(2).toLowerCase() : undefined)
const hexToArgb = (h: string) => 'FF' + h.replace('#', '').toUpperCase().padStart(6, '0').slice(-6)

const FMT_IN: Record<string, string> = { 'm/d/yyyy': 'date', 'mm-dd-yy': 'date', 'yyyy-mm-dd': 'date', 'm/d/yyyy h:mm:ss': 'datetime', General: 'general' }
const FMT_OUT: Record<string, string> = { date: 'm/d/yyyy', datetime: 'm/d/yyyy h:mm:ss', general: 'General' }

async function readXlsx(file: string): Promise<Workbook> {
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const sheets: Sheet[] = []
  let charts: Record<string, SheetChart[]> = {}
  wb.eachSheet(ws => {
    if (ws.name === CHARTS_SHEET) {
      try {
        charts = JSON.parse(String(ws.getCell('A1').value || '{}'))
      } catch { /* not ours */ }
      return
    }
    const cells: Record<string, Cell> = {}
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        const out: Cell = {}
        const raw = cell.value as unknown
        let v: Cell['v']
        let isDate = false
        if (raw instanceof Date) { v = dateToSerial(raw); isDate = true }
        else if (raw && typeof raw === 'object') {
          const o = raw as { formula?: string; sharedFormula?: string; result?: unknown; richText?: { text: string }[]; text?: string; error?: string; hyperlink?: string }
          if (o.formula || o.sharedFormula) {
            out.f = (cell.formula || o.formula || '').replace(/^=/, '')
            const r = o.result as unknown
            v = r instanceof Date ? dateToSerial(r) : r && typeof r === 'object' ? ((r as { error?: string }).error ?? null) : (r as Cell['v'])
          } else if (o.richText) v = o.richText.map(t => t.text).join('')
          else if (o.error) v = o.error
          else if (o.text !== undefined) v = String(o.text)
        } else v = raw as Cell['v']
        if (v !== undefined && v !== null) out.v = v
        const s: CellStyle = {}
        const f = cell.font
        if (f?.bold) s.b = true
        if (f?.italic) s.i = true
        if (f?.underline) s.u = true
        if (f?.strike) s.s = true
        const fc = argbToHex(f?.color as { argb?: string })
        if (fc && fc !== '#000000') s.color = fc
        if (f?.size && f.size !== 11) s.size = f.size
        const fill = cell.fill as { type?: string; pattern?: string; fgColor?: { argb?: string } } | undefined
        if (fill?.type === 'pattern' && fill.pattern === 'solid') { const bg = argbToHex(fill.fgColor); if (bg) s.bg = bg }
        const al = cell.alignment
        if (al?.horizontal === 'left' || al?.horizontal === 'center' || al?.horizontal === 'right') s.align = al.horizontal
        if (al?.wrapText) s.wrap = true
        const nf = cell.numFmt
        if (nf && nf !== 'General') s.fmt = FMT_IN[nf] ?? nf
        else if (isDate) s.fmt = 'date'
        if (Object.keys(s).length) out.s = s
        if (out.v !== undefined || out.f || out.s) cells[addr(rn - 1, cn - 1)] = out
      })
    })
    const colWidths: Record<number, number> = {}
    ws.columns?.forEach((col, i) => { if (col?.width) colWidths[i] = Math.round(col.width * 7 + 5) })
    const sheet: Sheet = { name: ws.name, cells }
    if (Object.keys(colWidths).length) sheet.colWidths = colWidths
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined
    if (view?.state === 'frozen' && (view.xSplit || view.ySplit)) sheet.frozen = { rows: view.ySplit || 0, cols: view.xSplit || 0 }
    const merges = ((ws.model as { merges?: string[] }).merges || []).filter(m => rng(m))
    if (merges.length) sheet.merges = merges
    const rules = readRules(ws as unknown as { conditionalFormattings?: XCf[] })
    if (rules.length) sheet.conditional = rules
    sheets.push(sheet)
  })
  for (const sh of sheets) {
    const list = charts[sh.name]
    if (Array.isArray(list) && list.length) sh.charts = list.filter(c => c && rng(c.range))
  }
  return { sheets: sheets.length ? sheets : [{ name: 'Sheet1', cells: {} }] }
}

async function writeXlsx(file: string, workbook: Workbook) {
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'gauzzaDocs'
  for (const sheet of workbook.sheets) {
    const fr = sheet.frozen
    const ws = wb.addWorksheet(sheet.name, {
      views: fr && (fr.rows || fr.cols) ? [{ state: 'frozen', xSplit: fr.cols, ySplit: fr.rows }] : []
    })
    for (const [i, w] of Object.entries(sheet.colWidths || {})) ws.getColumn(Number(i) + 1).width = Math.max(1, (w - 5) / 7)
    for (const [a, c] of Object.entries(sheet.cells)) {
      const cell = ws.getCell(a)
      const isErr = typeof c.v === 'string' && /^#[A-Z/0!?]+[!?A]?$/.test(c.v) && !!c.f
      if (c.f) cell.value = { formula: c.f, result: isErr ? undefined : (c.v as never) } as never
      else if (c.v !== undefined && c.v !== null) cell.value = c.v as never
      const s = c.s
      if (!s) continue
      if (s.b || s.i || s.u || s.s || s.color || s.size)
        cell.font = { bold: s.b, italic: s.i, underline: s.u, strike: s.s, size: s.size, ...(s.color ? { color: { argb: hexToArgb(s.color) } } : {}) }
      if (s.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(s.bg) } }
      if (s.align || s.wrap) cell.alignment = { horizontal: s.align, wrapText: s.wrap }
      if (s.fmt && s.fmt !== 'general') cell.numFmt = FMT_OUT[s.fmt] ?? s.fmt
    }
    // After values: merging keeps the master (top-left) cell's value.
    for (const m of sheet.merges || []) if (rng(m)) ws.mergeCells(m)
    let priority = 1
    for (const rule of sheet.conditional || []) {
      const x = writeRule(rule, priority++)
      if (x) ws.addConditionalFormatting(x as never)
    }
  }
  const charts = Object.fromEntries(workbook.sheets.filter(s => s.charts?.length).map(s => [s.name, s.charts]))
  if (Object.keys(charts).length) {
    const hidden = wb.addWorksheet(CHARTS_SHEET, { state: 'veryHidden' })
    hidden.getCell('A1').value = JSON.stringify(charts)
  }
  await wb.xlsx.writeFile(file)
}

// ---------------- conditional formatting <-> Excel rules ----------------

interface XStyle {
  fill?: { type?: string; pattern?: string; bgColor?: { argb?: string }; fgColor?: { argb?: string } }
  font?: { color?: { argb?: string }; bold?: boolean; italic?: boolean; strike?: boolean }
}
interface XRule { type: string; operator?: string; formulae?: unknown[]; text?: string; style?: XStyle; priority?: number; cfvo?: { type: string }[]; color?: { argb?: string }[] }
interface XCf { ref: string; rules: XRule[] }

const OPS: Partial<Record<CfType, string>> = { gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', eq: 'equal', neq: 'notEqual', between: 'between' }
const OPS_IN = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k])) as Record<string, CfType>

/** A rule operand as an Excel formula: numbers bare, text quoted. */
const operand = (v: unknown) => (typeof v === 'number' ? String(v) : `"${String(v ?? '').replace(/"/g, '""')}"`)
const fromOperand = (f: unknown): string | number => {
  const t = String(f ?? '').trim()
  if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/""/g, '"')
  return t !== '' && !Number.isNaN(Number(t)) ? Number(t) : t
}

function writeRule(rule: ConditionalRule, priority: number): XCf | null {
  const g = rng(rule.range)
  if (!g) return null
  const tl = addr(g.r1, g.c1)
  const st = rule.style || {}
  const style: XStyle = {}
  if (st.bg) style.fill = { type: 'pattern', pattern: 'solid', bgColor: { argb: hexToArgb(st.bg) } }
  if (st.color || st.b || st.i || st.s)
    style.font = { ...(st.color ? { color: { argb: hexToArgb(st.color) } } : {}), ...(st.b ? { bold: true } : {}), ...(st.i ? { italic: true } : {}), ...(st.s ? { strike: true } : {}) }
  let x: XRule
  switch (rule.type) {
    case 'scale':
      x = { type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: hexToArgb(rule.scale?.min || '#ffffff') }, { argb: hexToArgb(rule.scale?.max || '#57bb8a') }] }
      break
    case 'contains':
    case 'notContains':
      x = { type: 'containsText', operator: rule.type === 'contains' ? 'containsText' : 'notContains', text: String(rule.value ?? ''), style }
      break
    case 'empty':
      x = { type: 'expression', formulae: [`LEN(TRIM(${tl}))=0`], style }
      break
    case 'notEmpty':
      x = { type: 'expression', formulae: [`LEN(TRIM(${tl}))>0`], style }
      break
    case 'formula':
      x = { type: 'expression', formulae: [String(rule.formula || '').replace(/^=/, '')], style }
      break
    default:
      x = { type: 'cellIs', operator: OPS[rule.type], formulae: rule.type === 'between' ? [operand(rule.value), operand(rule.value2)] : [operand(rule.value)], style }
  }
  return { ref: rule.range, rules: [{ ...x, priority }] }
}

function readStyle(s: XStyle | undefined): ConditionalRule['style'] {
  const out: NonNullable<ConditionalRule['style']> = {}
  const bg = argbToHex(s?.fill?.bgColor) || argbToHex(s?.fill?.fgColor)
  if (bg) out.bg = bg
  const fc = argbToHex(s?.font?.color)
  if (fc) out.color = fc
  if (s?.font?.bold) out.b = true
  if (s?.font?.italic) out.i = true
  if (s?.font?.strike) out.s = true
  return Object.keys(out).length ? out : undefined
}

const EMPTY_TEST = /^LEN\(TRIM\(\$?[A-Z]+\$?\d+\)\)([=>])0$/i

function readRules(ws: { conditionalFormattings?: XCf[] }): ConditionalRule[] {
  const out: ConditionalRule[] = []
  for (const cf of ws.conditionalFormattings || []) {
    const range = String(cf.ref || '').split(/\s+/)[0]
    if (!rng(range)) continue
    for (const x of [...(cf.rules || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
      const style = readStyle(x.style)
      const f0 = x.formulae?.[0]
      if (x.type === 'colorScale' && x.color?.length) {
        out.push({ range, type: 'scale', scale: { min: argbToHex(x.color[0]) || '#ffffff', max: argbToHex(x.color[x.color.length - 1]) || '#57bb8a' } })
      } else if (x.type === 'cellIs' && x.operator && OPS_IN[x.operator]) {
        const type = OPS_IN[x.operator]
        out.push({ range, type, value: fromOperand(f0), ...(type === 'between' ? { value2: fromOperand(x.formulae?.[1]) } : {}), ...(style ? { style } : {}) })
      } else if (x.type === 'containsText') {
        // exceljs drops the text attribute when reading; the generated SEARCH("text", A1) formula still has it.
        const m = String(f0 ?? '').match(/SEARCH\("((?:[^"]|"")*)"/i)
        const text = x.text ?? (m ? m[1].replace(/""/g, '"') : '')
        out.push({ range, type: x.operator === 'notContains' ? 'notContains' : 'contains', value: String(text), ...(style ? { style } : {}) })
      } else if (x.type === 'expression' && f0 !== undefined) {
        const f = String(f0).replace(/^=/, '')
        const m = f.match(EMPTY_TEST)
        if (m) out.push({ range, type: m[1] === '=' ? 'empty' : 'notEmpty', ...(style ? { style } : {}) })
        else out.push({ range, type: 'formula', formula: f, ...(style ? { style } : {}) })
      }
    }
  }
  return out
}
