import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTextOp } from '../src/shared/ops/text'

const T = 'one\ntwo\nthree'

test('read ranges and info', () => {
  assert.deepEqual(applyTextOp(T, { op: 'read', lines: '2-3' }).result, { content: 'two\nthree', from: 2, to: 3, lines: 3 })
  assert.deepEqual(applyTextOp(T, { op: 'info' }).result, { lines: 3, chars: 13 })
})

test('insert, replaceLines, deleteLines, append', () => {
  assert.equal(applyTextOp(T, { op: 'insert', line: 2, content: 'x' }).text, 'one\nx\ntwo\nthree')
  assert.equal(applyTextOp(T, { op: 'replaceLines', from: 1, to: 2, content: 'A' }).text, 'A\nthree')
  assert.equal(applyTextOp(T, { op: 'deleteLines', from: 3 }).text, 'one\ntwo')
  assert.equal(applyTextOp(T, { op: 'append', content: 'four' }).text, 'one\ntwo\nthree\nfour')
})

test('replace and find escape special characters', () => {
  const r = applyTextOp('a.b a.b axb', { op: 'replace', find: 'a.b', with: 'z', all: true })
  assert.equal(r.text, 'z z axb')
  assert.deepEqual((applyTextOp('f(x) f(y)', { op: 'find', query: 'f(' }).result as any).matches.length, 2)
})
