import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadSheet, saveSheet } from '../src/core/formats/sheet'
import { applySheetOp } from '../src/shared/ops/sheet'
import { parseCsv, writeCsv } from '../src/shared/sheet/csv'
import { formatNumber, parseInput } from '../src/shared/sheet/format'
import { recalc, shiftFormula } from '../src/shared/sheet/formula'
import type { Workbook } from '../src/shared/types'

const wb = (cells: Record<string, unknown>, extra: Workbook['sheets'] = []): Workbook => {
  const r = applySheetOp({ sheets: [{ name: 'Sheet1', cells: {} }, ...extra] }, { op: 'set', cells: { Z99: null, ...cells } })
  return r.workbook!
}
const v = (w: Workbook, a: string, s = 0) => w.sheets[s].cells[a]?.v

test('arithmetic and precedence', () => {
  const w = wb({ A1: 2, A2: 3, B1: '=A1+A2*2', B2: '=(A1+A2)*2', B3: '=-A1^2', B4: '=2^3^2', B5: '=10%', B6: '="a"&A1&TRUE', B7: '=1/0', B8: '=A1>A2', B9: '=1+"x"' })
  assert.equal(v(w, 'B1'), 8)
  assert.equal(v(w, 'B2'), 10)
  assert.equal(v(w, 'B3'), 4)
  assert.equal(v(w, 'B4'), 64)
  assert.equal(v(w, 'B5'), 0.1)
  assert.equal(v(w, 'B6'), 'a2TRUE')
  assert.equal(v(w, 'B7'), '#DIV/0!')
  assert.equal(v(w, 'B8'), false)
  assert.equal(v(w, 'B9'), '#VALUE!')
})

test('functions', () => {
  const w = wb({
    A1: 1, A2: 2, A3: 3, A4: 'x', B1: 'apple', B2: 'banana', B3: 'cherry',
    C1: '=SUM(A1:A4)', C2: '=AVERAGE(A1:A3)', C3: '=COUNT(A1:A4)', C4: '=COUNTA(A1:A4)', C5: '=COUNTIF(A1:A3,">1")',
    C6: '=SUMIF(A1:A3,">=2")', C7: '=IF(A1>0,"pos","neg")', C8: '=IFERROR(1/0,"oops")', C9: '=VLOOKUP(2,A1:B3,2,FALSE)',
    C10: '=INDEX(B1:B3,3)', C11: '=MATCH("banana",B1:B3,0)', C12: '=XLOOKUP("cherry",B1:B3,A1:A3)', C13: '=ROUND(2.345,2)',
    C14: '=TEXTJOIN("-",TRUE,B1:B3)', C15: '=UPPER(LEFT(B2,3))', C16: '=SUBSTITUTE("a-b-c","-","+")', C17: '=MEDIAN(A1:A3,10)',
    C18: '=YEAR(DATE(2026,11,24))', C19: '=TEXT(0.256,"0.0%")', C20: '=MOD(-3,5)', C21: '=FOO(1)', C22: '=AND(TRUE,A1=1)',
    C23: '=TEXT(DATE(2026,1,5),"yyyy-mm-dd")', C24: '=AVERAGEIF(B1:B3,"b*",A1:A3)', C25: '=MAX(A1:A3)*PRODUCT(A1:A3)', C26: '=MID("hello",2,3)&LEN("abc")'
  })
  const exp: Record<string, unknown> = {
    C1: 6, C2: 2, C3: 3, C4: 4, C5: 2, C6: 5, C7: 'pos', C8: 'oops', C9: 'banana', C10: 'cherry', C11: 2, C12: 3, C13: 2.35,
    C14: 'apple-banana-cherry', C15: 'BAN', C16: 'a+b+c', C17: 2.5, C18: 2026, C19: '25.6%', C20: 2, C21: '#NAME?', C22: true,
    C23: '2026-01-05', C24: 2, C25: 18, C26: 'ell3'
  }
  for (const [k, e] of Object.entries(exp)) assert.equal(v(w, k), e, k)
})

test('cross-sheet, cycles, dependency order', () => {
  const w = wb({ A1: "='My Data'!A1*2", A2: '=Data2!B2+1', B1: '=B2', B2: '=B1', C1: '=C2+1', C2: '=C3+1', C3: 5 }, [
    { name: 'My Data', cells: { A1: { v: 21 } } },
    { name: 'Data2', cells: { B2: { v: 1 } } }
  ])
  assert.equal(v(w, 'A1'), 42)
  assert.equal(v(w, 'A2'), 2)
  assert.equal(v(w, 'B1'), '#CIRC!')
  assert.equal(v(w, 'C1'), 7)
})

test('formula shift and structural edits', () => {
  assert.equal(shiftFormula('A1+$B$2+B$3+Sheet2!C4', 1, 1), 'B2+$B$2+C$3+Sheet2!D5')
  let w = wb({ A1: 1, A2: 2, A3: 3, B1: '=SUM(A1:A3)', B2: '=A3' })
  w = applySheetOp(w, { op: 'insertRows', at: 2, count: 2 }).workbook!
  assert.equal(w.sheets[0].cells.B1.f, 'SUM(A1:A5)')
  assert.equal(w.sheets[0].cells.B4.f, 'A5')
  assert.equal(v(w, 'B1'), 6)
  w = applySheetOp(w, { op: 'deleteRows', at: 5 }).workbook!
  assert.equal(w.sheets[0].cells.B4.f, '#REF!')
  assert.equal(w.sheets[0].cells.B1.f, 'SUM(A1:A4)')
  w = applySheetOp(w, { op: 'insertCols', at: 'A' }).workbook!
  assert.equal(w.sheets[0].cells.C1.f, 'SUM(B1:B4)')
})

test('ops: read/get/setRange/append/format/clear/sheets', () => {
  let w = wb({})
  w = applySheetOp(w, { op: 'setRange', start: 'A1', values: [['Name', 'Qty'], ['a', '3'], ['b', '$4.50'], ['Total', '=SUM(B2:B3)']] }).workbook!
  assert.equal(v(w, 'B4'), 7.5)
  assert.equal(w.sheets[0].cells.B3.s?.fmt, '$#,##0.00')
  w = applySheetOp(w, { op: 'append', values: [['c', 1]] }).workbook!
  assert.equal(v(w, 'A5'), 'c')
  const r = applySheetOp(w, { op: 'read', format: 'csv' }).result as { content: string }
  assert.match(r.content, /Total,7.5/)
  w = applySheetOp(w, { op: 'format', range: 'A1:B1', style: { b: true, bg: '#ffff00' } }).workbook!
  assert.equal(w.sheets[0].cells.A1.s?.b, true)
  w = applySheetOp(w, { op: 'clear', range: 'A5:B5' }).workbook!
  assert.equal(w.sheets[0].cells.A5, undefined)
  w = applySheetOp(w, { op: 'addSheet', name: 'Two' }).workbook!
  w = applySheetOp(w, { op: 'set', sheet: 'Two', cells: { A1: '=Sheet1!B4*2' } }).workbook!
  assert.equal(v(w, 'A1', 1), 15)
  w = applySheetOp(w, { op: 'renameSheet', sheet: 'Sheet1', name: 'Main Data' }).workbook!
  assert.equal(w.sheets[1].cells.A1.f, "'Main Data'!B4*2")
  assert.equal(v(w, 'A1', 1), 15)
  assert.throws(() => applySheetOp(w, { op: 'nope' }), /Unknown op/)
})

test('csv and formats', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\n1,2\r\n'), [['a', 'b,c', 'd"e'], ['1', '2']])
  assert.equal(writeCsv([['a', 'b,c', 'x"y']]), 'a,"b,c","x""y"\n')
  assert.equal(formatNumber(1234.5, '$#,##0.00'), '$1,234.50')
  assert.equal(formatNumber(0.125, '0.00%'), '12.50%')
  assert.equal(formatNumber(-1234, '#,##0'), '-1,234')
  assert.equal(formatNumber(46350, 'date'), '11/24/2026')
  assert.deepEqual(parseInput('12%'), { v: 0.12, fmt: '0%' })
  assert.equal(parseInput('2026-11-24').v, 46350)
})

test('xlsx round trip and big csv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-sheet-'))
  const file = path.join(dir, 'r.xlsx')
  const w: Workbook = {
    sheets: [
      { name: 'Data', cells: { A1: { v: 'Item', s: { b: true, bg: '#ffeeaa' } }, A2: { v: 2 }, A3: { v: 3, s: { fmt: '$#,##0.00', align: 'right' } }, A4: { f: 'SUM(A2:A3)' } }, colWidths: { 0: 145 }, frozen: { rows: 1, cols: 0 } },
      { name: 'Other', cells: { B2: { f: 'Data!A4*2' } } }
    ]
  }
  recalc(w)
  await saveSheet(file, w)
  const back = (await loadSheet(file)).workbook
  assert.equal(back.sheets.length, 2)
  assert.equal(back.sheets[0].cells.A4.f, 'SUM(A2:A3)')
  assert.equal(back.sheets[0].cells.A4.v, 5)
  assert.equal(back.sheets[1].cells.B2.v, 10)
  assert.equal(back.sheets[0].cells.A1.s?.b, true)
  assert.equal(back.sheets[0].cells.A1.s?.bg, '#ffeeaa')
  assert.equal(back.sheets[0].cells.A3.s?.fmt, '$#,##0.00')
  assert.equal(back.sheets[0].colWidths?.[0], 145)
  assert.deepEqual(back.sheets[0].frozen, { rows: 1, cols: 0 })
  const csv = path.join(dir, 'r.csv')
  await saveSheet(csv, back)
  assert.equal(fs.readFileSync(csv, 'utf8'), 'Item\n2\n$3.00\n5\n')
  const big = path.join(dir, 'big.csv')
  fs.writeFileSync(big, Array.from({ length: 50000 }, (_, i) => `${i},name ${i},${i * 1.5},"q, ${i}"`).join('\n'))
  const t = Date.now()
  const loaded = (await loadSheet(big)).workbook
  const ms = Date.now() - t
  assert.equal(loaded.sheets[0].cells.D50000.v, 'q, 49999')
  assert.ok(ms < 3000, `50k-row CSV took ${ms}ms`)
  const t2 = Date.now()
  const w2 = applySheetOp(loaded, { op: 'set', cells: { E1: '=SUM(C:C)' } }).workbook!
  assert.equal(w2.sheets[0].cells.E1.v, ((49999 * 50000) / 2) * 1.5)
  console.log(`big csv load ${ms}ms, edit+recalc ${Date.now() - t2}ms`)
})

test('recalc only re-evaluates downstream formulas', async () => {
  const { recalc: rc } = await import('../src/shared/sheet/formula')
  let w = wb({ A1: 1, B1: '=RAND()', C1: '=A1*2', D1: '=C1+1' })
  const rand = v(w, 'B1')
  w = applySheetOp(w, { op: 'set', cells: { A1: 5 } }).workbook!
  assert.equal(v(w, 'C1'), 10)
  assert.equal(v(w, 'D1'), 11)
  assert.equal(v(w, 'B1'), rand, 'unrelated formula was not re-evaluated')
  // a long chain still updates end to end
  const cells: Record<string, unknown> = { A1: 1 }
  for (let r = 2; r <= 3000; r++) cells[`A${r}`] = `=A${r - 1}+1`
  w = wb(cells)
  assert.equal(v(w, 'A3000'), 3000)
  const t = Date.now()
  w = applySheetOp(w, { op: 'set', cells: { A1: 10 } }).workbook!
  assert.equal(v(w, 'A3000'), 3009)
  assert.ok(Date.now() - t < 1000)
  // whole-column readers are found
  w = wb({ A1: 1, A2: 2, B1: '=SUM(A:A)' })
  w = applySheetOp(w, { op: 'set', cells: { A7: 10 } }).workbook!
  assert.equal(v(w, 'B1'), 13)
  void rc
})

test('undo steps store diffs and restore exactly', async () => {
  const { makeSnap, applySnap } = await import('../src/renderer/src/sheet/layout')
  const a = wb({ A1: 1, B1: '=A1+1' }, [{ name: 'Other', cells: { A1: { v: 'x' } } }])
  const b = applySheetOp(a, { op: 'set', cells: { A1: 2, C3: 'new' } }).workbook!
  const snap = makeSnap(a, b, 0)
  assert.ok(snap.sheets[0].diff && Object.keys(snap.sheets[0].diff).length <= 3, 'only changed cells stored')
  const back = applySnap(snap, b)
  assert.deepEqual(back.sheets[0].cells, a.sheets[0].cells)
  assert.deepEqual(back.sheets[1].cells, a.sheets[1].cells)
})
