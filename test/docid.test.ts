import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOC_ID, docId } from '../src/shared/docId'

test('document IDs: short, stable, case and separator insensitive', () => {
  const a = docId('C:\\Users\\me\\Docs\\Plan.md')
  assert.match(a, DOC_ID)
  assert.equal(a.length, 'doc:'.length + 6)
  assert.equal(docId('c:/users/me/docs/plan.md'), a)
  assert.equal(docId('C:\\Users\\me\\Docs\\Plan.md\\'), a)
  assert.notEqual(docId('C:\\Users\\me\\Docs\\Plan2.md'), a)
  const many = new Set(Array.from({ length: 2000 }, (_, i) => docId(`C:/files/doc-${i}.md`)))
  assert.equal(many.size, 2000, 'no collisions across 2000 nearby paths')
})
