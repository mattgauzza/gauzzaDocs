import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CHARTS_SHEET, loadSheet, saveSheet } from '../src/core/formats/sheet'
import { applySheetOp } from '../src/shared/ops/sheet'
import { chartData, chartSvg, conditionalStyle, mergeAt } from '../src/shared/sheet/extras'
import type { Workbook } from '../src/shared/types'

const base = (): Workbook =>
  applySheetOp({ sheets: [{ name: 'Sheet1', cells: {} }] }, {
    op: 'setRange', start: 'A1',
    values: [['Month', 'Sales', 'Costs'], ['Jan', 100, 80], ['Feb', 150, 90], ['Mar', 50, 70], ['Apr', '', 60]]
  }).workbook!
const run = (w: Workbook, op: Record<string, unknown>) => {
  const r = applySheetOp(w, { op: '', ...op } as never)
  return { w: r.workbook ?? w, result: r.result as Record<string, any> }
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-sx-')), 'book.xlsx')

test('merges: ops, top-left value kept, lookups, horizontal mode, unmerge', () => {
  let { w } = run(base(), { op: 'merge', range: 'A1:C1' })
  assert.deepEqual(w.sheets[0].merges, ['A1:C1'])
  assert.equal(w.sheets[0].cells.A1.v, 'Month')
  assert.equal(w.sheets[0].cells.B1, undefined, 'non-top-left values are dropped')
  assert.deepEqual(mergeAt(w.sheets[0], 0, 2), { r1: 0, c1: 0, r2: 0, c2: 2 })
  assert.equal(mergeAt(w.sheets[0], 1, 1), null)
  ;({ w } = run(w, { op: 'merge', range: 'A2:B3', mode: 'horizontal' }))
  assert.deepEqual(w.sheets[0].merges, ['A1:C1', 'A2:B2', 'A3:B3'])
  ;({ w } = run(w, { op: 'unmerge', range: 'B3' }))
  assert.deepEqual(w.sheets[0].merges, ['A1:C1', 'A2:B2'])
  assert.throws(() => run(w, { op: 'merge', range: 'D5' }), /at least two/)
})

test('merges, rules and charts follow inserted and deleted rows/columns', () => {
  let { w } = run(base(), { op: 'merge', range: 'B2:C3' })
  ;({ w } = run(w, { op: 'addRule', range: 'B2:B5', rule: { type: 'gt', value: 90, style: { bg: '#ff0000' } } }))
  ;({ w } = run(w, { op: 'addChart', range: 'A1:C5', type: 'column', at: 'E2' }))
  ;({ w } = run(w, { op: 'insertRows', at: 1, count: 2 }))
  let s = w.sheets[0]
  assert.deepEqual(s.merges, ['B4:C5'])
  assert.equal(s.conditional![0].range, 'B4:B7')
  assert.equal(s.charts![0].range, 'A3:C7')
  assert.equal(s.charts![0].at, 'E4')
  ;({ w } = run(w, { op: 'insertCols', at: 'C' })) // inside the merge: it grows
  assert.deepEqual(w.sheets[0].merges, ['B4:D5'])
  ;({ w } = run(w, { op: 'deleteCols', at: 'B', count: 3 })) // the whole merge goes
  s = w.sheets[0]
  assert.equal(s.merges?.length || 0, 0)
  assert.equal(s.conditional?.length || 0, 0, 'rule range fully deleted')
  assert.equal(s.charts![0].range, 'A3:A7', 'chart range shrinks (C was inserted, so B:D were the old B:C)')
})

test('conditional formatting: conditions, first match wins, custom formula, color scale, rule ops', () => {
  let { w } = run(base(), { op: 'addRule', range: 'B2:B5', rule: { type: 'gt', value: 120, style: { bg: '#ff0000', b: true } } })
  ;({ w } = run(w, { op: 'addRule', range: 'B2:B5', rule: { type: 'between', value: 60, value2: 200, style: { color: '#00ff00' } } }))
  ;({ w } = run(w, { op: 'addRule', range: 'B2:B5', rule: { type: 'empty', style: { bg: '#cccccc' } } }))
  assert.deepEqual(conditionalStyle(w, 0, 2, 1), { bg: '#ff0000', b: true }) // Feb 150: first rule wins
  assert.deepEqual(conditionalStyle(w, 0, 1, 1), { color: '#00ff00' }) // Jan 100: between
  assert.equal(conditionalStyle(w, 0, 3, 1), null) // Mar 50: none
  assert.deepEqual(conditionalStyle(w, 0, 4, 1), { bg: '#cccccc' }) // Apr empty
  // custom formula, written for the top-left cell and shifted per row
  ;({ w } = run(w, { op: 'addRule', range: 'A2:A5', rule: { type: 'formula', formula: '=C2>B2', style: { bg: '#ffff00' } } }))
  assert.equal(conditionalStyle(w, 0, 1, 0), null) // 80 > 100? no
  assert.deepEqual(conditionalStyle(w, 0, 3, 0), { bg: '#ffff00' }) // 70 > 50
  // text contains
  ;({ w } = run(w, { op: 'addRule', range: 'A1:A5', rule: { type: 'contains', value: 'fe', style: { s: true } } }))
  assert.deepEqual(conditionalStyle(w, 0, 2, 0), { s: true })
  // color scale
  ;({ w } = run(w, { op: 'addRule', range: 'C2:C5', rule: { type: 'scale', scale: { min: '#ffffff', max: '#000000' } } }))
  assert.equal(conditionalStyle(w, 0, 2, 2)!.bg, '#000000') // 90 = max
  assert.equal(conditionalStyle(w, 0, 4, 2)!.bg, '#ffffff') // 60 = min
  const listed = run(w, { op: 'rules' }).result.rules
  assert.equal(listed.length, 6)
  assert.match(listed[1].description, /between 60 and 200/)
  ;({ w } = run(w, { op: 'deleteRule', index: 0 }))
  assert.deepEqual(conditionalStyle(w, 0, 2, 1), { color: '#00ff00' })
  assert.throws(() => run(w, { op: 'addRule', range: 'B2:B5', rule: { type: 'gt' } }), /needs value/)
  assert.throws(() => run(w, { op: 'addRule', range: 'nope', rule: { type: 'empty' } }), /not a range/)
})

test('charts: ops, data with headers and labels, svg', () => {
  let { w, result } = run(base(), { op: 'addChart', range: 'A1:C5', type: 'column', title: 'Sales vs costs' })
  assert.equal(result.id, 'chart1')
  const c = w.sheets[0].charts![0]
  assert.equal(c.at, 'E1')
  const d = chartData(w.sheets[0], c)
  assert.deepEqual(d.categories, ['Jan', 'Feb', 'Mar', 'Apr'])
  assert.deepEqual(d.series.map(s => s.name), ['Sales', 'Costs'])
  assert.deepEqual(d.series[0].values, [100, 150, 50, null])
  for (const type of ['bar', 'column', 'line', 'pie', 'scatter'] as const) {
    const svg = chartSvg({ ...c, type }, chartData(w.sheets[0], { ...c, type }))
    assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), type)
    assert.ok(/<(rect|path|polyline|circle)\b/.test(svg), `${type} draws something`)
  }
  ;({ w } = run(w, { op: 'updateChart', id: 'chart1', type: 'pie', w: 300 }))
  assert.equal(w.sheets[0].charts![0].type, 'pie')
  assert.equal(w.sheets[0].charts![0].w, 300)
  assert.equal(run(w, { op: 'charts' }).result.charts[0].points, 4)
  ;({ w } = run(w, { op: 'deleteChart', id: 'chart1' }))
  assert.equal(w.sheets[0].charts, undefined)
  assert.throws(() => run(w, { op: 'addChart', range: 'A1:C5', type: 'donut' }), /chart type/)
})

test('xlsx round trip: merges, conditional rules, chart definitions (hidden sheet)', async () => {
  let { w } = run(base(), { op: 'merge', range: 'A1:C1' })
  const rules = [
    { type: 'gt', value: 120, style: { bg: '#ff0000', b: true } },
    { type: 'between', value: 60, value2: 200, style: { color: '#00aa00' } },
    { type: 'contains', value: 'Fe', style: { bg: '#ffff00' } },
    { type: 'empty', style: { bg: '#cccccc' } },
    { type: 'formula', formula: 'C2>B2', style: { i: true } },
    { type: 'eq', value: 'Jan', style: { bg: '#123456' } }
  ]
  for (const rule of rules) ({ w } = run(w, { op: 'addRule', range: 'B2:B5', rule }))
  ;({ w } = run(w, { op: 'addRule', range: 'C2:C5', rule: { type: 'scale', scale: { min: '#ffffff', max: '#57bb8a' } } }))
  ;({ w } = run(w, { op: 'addChart', range: 'A1:C5', type: 'line', title: 'Trend', at: 'F3', w: 420, h: 260 }))
  const file = tmp()
  await saveSheet(file, w)
  const back = (await loadSheet(file)).workbook
  assert.equal(back.sheets.length, 1, 'the charts sheet stays hidden from the sheet list')
  const s = back.sheets[0]
  assert.deepEqual(s.merges, ['A1:C1'])
  assert.equal(s.cells.A1.v, 'Month')
  assert.deepEqual(s.conditional, w.sheets[0].conditional)
  assert.deepEqual(s.charts, w.sheets[0].charts)

  // Excel sees a very hidden sheet holding the JSON, and nothing else changes.
  const ExcelJS = (await import('exceljs')).default
  const x = new ExcelJS.Workbook()
  await x.xlsx.readFile(file)
  assert.equal(x.getWorksheet(CHARTS_SHEET)!.state, 'veryHidden')
  // Saving again keeps everything (and does not duplicate the hidden sheet).
  await saveSheet(file, back)
  const again = (await loadSheet(file)).workbook
  assert.deepEqual(again.sheets[0].charts, w.sheets[0].charts)
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('print-free: rules evaluate only what is asked (no per-cell state kept)', () => {
  const { w } = run(base(), { op: 'addRule', range: 'A1:Z100000', rule: { type: 'notEmpty', style: { bg: '#eeeeee' } } })
  const t = performance.now()
  for (let r = 0; r < 60; r++) for (let c = 0; c < 20; c++) conditionalStyle(w, 0, r, c)
  assert.ok(performance.now() - t < 200, 'a screenful of cells is cheap')
})
