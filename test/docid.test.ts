import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolveDocId } from '../src/cli/docIds'
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

// Windows file names ignore case, whatever platform the test runs on.
const ignoreCase = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const dir = path.join(os.tmpdir(), 'gd-docid', 'Docs')
const real = path.join(dir, 'Plan.md')
const lower = real.toLowerCase()
const id = docId(real)

test('resolveDocId: one file written in two cases is one hit, not "more than one file"', () => {
  assert.equal(docId(lower), id)
  assert.equal(resolveDocId(id, [real, lower, real], () => [], ignoreCase), path.resolve(real))
  assert.equal(resolveDocId(id.toUpperCase(), [lower, real], () => [], ignoreCase), path.resolve(lower))
})

test('resolveDocId: history paths are only looked at when nothing else matches', () => {
  let looked = 0
  const history = () => (looked++, [lower])
  // Open and recent files match: the history's lowercased copy of the same path is never consulted.
  assert.equal(resolveDocId(id, [real, path.join(dir, 'Other.md')], history, ignoreCase), path.resolve(real))
  assert.equal(looked, 0)
  // Nothing else matches (the file is gone, say): history finds it.
  assert.equal(resolveDocId(id, [path.join(dir, 'Other.md')], history, ignoreCase), path.resolve(lower))
  assert.equal(looked, 1)
  // History listing the same file twice (an old lowercased index and a new one) is still one file.
  assert.equal(resolveDocId(id, [], () => [lower, real], ignoreCase), path.resolve(lower))
})

test('resolveDocId: two different files with one id, or none, are plain errors', () => {
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b) // a case-sensitive file system
  assert.throws(() => resolveDocId(id, [real, lower], () => [], same), /matches more than one file/)
  assert.throws(() => resolveDocId(id, [path.join(dir, 'Other.md')], () => [], ignoreCase), /isn't open in gauzzaDocs or in your recent files/)
})
