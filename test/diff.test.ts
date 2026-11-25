import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { sheetBytes } from '../src/core/formats/sheet'
import { compareVersions, versionText } from '../src/core/history/index'
import { lineDiff, type Hunk } from '../src/shared/diff'
import type { Workbook } from '../src/shared/types'

const enc = (s: string) => new TextEncoder().encode(s)
const paras = (n: number, edits: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `paragraph ${i + 1}`).join('\n') + '\n'
const groups = (h: Hunk[]) => h.filter((x, i) => x.kind !== 'same' && (i === 0 || h[i - 1].kind === 'same')).length

test('lineDiff returns no hunks when nothing changed', () => {
  assert.deepEqual(lineDiff('a\nb\n', 'a\nb\n'), [])
})

test('lineDiff reports adds and dels without trailing newlines', () => {
  const h = lineDiff('a\nb\nc\n', 'a\nB\nc\n')
  assert.deepEqual(h, [
    { kind: 'same', lines: ['a'] },
    { kind: 'del', lines: ['b'] },
    { kind: 'add', lines: ['B'] },
    { kind: 'same', lines: ['c'] },
  ])
})

test('an edit in paragraph 2 and paragraph 50 gives two separate hunks', () => {
  const h = lineDiff(paras(60), paras(60, { 2: 'changed two', 50: 'changed fifty' }))
  assert.equal(groups(h), 2)
  // a gap marker: two adjacent same hunks
  const gap = h.findIndex((x, i) => x.kind === 'same' && h[i + 1]?.kind === 'same')
  assert.ok(gap >= 0)
  for (const x of h) if (x.kind === 'same') assert.ok(x.lines.length <= 3)
  assert.equal(h[0].kind, 'same')
  assert.deepEqual(h[0].lines, ['paragraph 1'])
  assert.deepEqual(h.at(-1)!.lines, ['paragraph 51', 'paragraph 52', 'paragraph 53'])
})

test('changes close together keep the run between them as one same hunk', () => {
  const h = lineDiff(paras(20), paras(20, { 5: 'x', 11: 'y' })) // 5 lines between, <= 2 * 3
  assert.equal(h.filter((x, i) => x.kind === 'same' && h[i + 1]?.kind === 'same').length, 0)
  assert.equal(groups(h), 2)
})

test('context size is configurable', () => {
  const h = lineDiff(paras(20), paras(20, { 10: 'x' }), 1)
  assert.deepEqual(h.map(x => x.kind), ['same', 'del', 'add', 'same'])
  assert.equal(h[0].lines.length, 1)
})

test('a sheet change shows the old and new cell lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-diff-'))
  try {
    const f = path.join(dir, 'book.xlsx')
    const wb = (v: number): Workbook => ({ sheets: [{ name: 'Sheet1', cells: { A1: { v: 'Total' }, B7: { v }, C1: { v: 5, f: 'B7/2' } } }] })
    const a = await sheetBytes(f, wb(10))
    const b = await sheetBytes(f, wb(12))
    assert.match(await versionText(f, a), /^Sheet1!A1: Total$/m)
    const r = await compareVersions(f, a, b)
    assert.ok('hunks' in r)
    const del = r.hunks.filter(x => x.kind === 'del').flatMap(x => x.lines)
    const add = r.hunks.filter(x => x.kind === 'add').flatMap(x => x.lines)
    assert.ok(del.includes('Sheet1!B7: 10'), JSON.stringify(del))
    assert.ok(add.includes('Sheet1!B7: 12'), JSON.stringify(add))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('text is decoded as UTF-8 as is, and temp files are cleaned up', async () => {
    assert.equal(await versionText('notes.txt', enc('Hi\nthere\n')), 'Hi\nthere\n')
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`gd-compare-${process.pid}-`)), [])
})

test('a PDF is compared by its page text', async () => {
  const make = async (t: string) => {
    const d = await PDFDocument.create()
    const font = await d.embedFont(StandardFonts.Helvetica)
    d.addPage().drawText(t, { x: 50, y: 700, size: 12, font })
    return d.save()
  }
  const text = await versionText('x.pdf', await make('Hello world'))
  assert.match(text, /Hello world/)
})

test('a kind that cannot be read as text throws a short error', async () => {
  await assert.rejects(() => versionText('photo.png', enc('not really')), /cannot|compare|text/i)
})

test('a side over 8 MB returns tooLarge without doing any work', async () => {
  const big = new Uint8Array(9 * 1024 * 1024)
  assert.deepEqual(await compareVersions('big.md', big, enc('x')), { tooLarge: true })
  assert.deepEqual(await compareVersions('big.md', enc('x'), big), { tooLarge: true })
})
