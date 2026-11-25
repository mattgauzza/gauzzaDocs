import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { describeOp, describeOps } from '../src/shared/history/describe'

test('describeOp puts known ops in plain past-tense words', () => {
  assert.equal(describeOp('replace'), 'Replaced text')
  assert.equal(describeOp('append'), 'Added text at the end')
  assert.equal(describeOp('insert'), 'Inserted text')
  assert.equal(describeOp('write'), 'Rewrote the file')
  assert.equal(describeOp('set'), 'Changed cells')
  assert.equal(describeOp('format'), 'Formatted')
  assert.equal(describeOp('deletePages'), 'Deleted pages')
  assert.equal(describeOp('rotate'), 'Rotated pages')
})

test('describeOp picks the meaning for the kind and the count', () => {
  assert.equal(describeOp('merge', 'sheet'), 'Merged cells')
  assert.equal(describeOp('merge', 'pdf'), 'Added pages from other PDFs')
  assert.equal(describeOp('append', 'sheet'), 'Added rows at the end')
  assert.equal(describeOp('append', 'slides'), 'Added slides at the end')
  assert.equal(describeOp('addSlide', 'slides'), 'Added a slide')
  assert.equal(describeOp('addSlide', 'slides', 3), 'Added slides')
})

test('describeOp falls back to plain words for an op it does not know', () => {
  assert.equal(describeOp('frobnicateWidgets'), 'Frobnicate widgets')
  assert.equal(describeOp('sheet.set'), 'Sheet set')
})

test('describeOps joins once each, in order, without an Oxford comma', () => {
  assert.equal(describeOps([]), '')
  assert.equal(describeOps(['replace']), 'Replaced text')
  assert.equal(describeOps(['replace', 'replace']), 'Replaced text')
  assert.equal(describeOps(['replace', 'append']), 'Replaced text and added text at the end')
  assert.equal(describeOps(['set', 'format', 'set', 'addChart'], 'sheet'), 'Changed cells, formatted and added a chart')
  assert.equal(describeOps(['set', 'setRange'], 'sheet'), 'Changed cells') // two ops, one phrase
  assert.equal(describeOps(['write', 'append', 'insert', 'replace', 'format', 'rotate']), 'Rewrote the file, added text at the end, inserted text, replaced text and 2 more')
})

test('every op that changes a file has its own phrase, never the fallback', () => {
  // Op names from the op modules (src/shared/ops/*.ts and src/core/ops/pdf.ts), minus the ones that only read.
  const reads = new Set(['read', 'get', 'find', 'outline', 'info', 'sheets', 'charts', 'rules', 'merges', 'formFields', 'textLines', 'slide', 'save'])
  const names = new Set<string>()
  for (const f of ['src/shared/ops/doc.ts', 'src/shared/ops/sheet.ts', 'src/shared/ops/slides.ts', 'src/shared/ops/text.ts', 'src/shared/ops/pdf.ts', 'src/core/ops/pdf.ts'])
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/case '([a-zA-Z]+)'/g)) names.add(m[1])
  assert.ok(names.size > 20, 'found the op names')
  const plain = (op: string) => op.charAt(0).toUpperCase() + op.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()
  for (const op of names) if (!reads.has(op)) assert.notEqual(describeOp(op), plain(op), `${op} has a phrase`)
})
