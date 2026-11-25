import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { outline, searchDoc } from '../src/renderer/src/doc/live'

const schema = getSchema([StarterKit])
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'wor', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'ld' },
        { type: 'hardBreak' },
        { type: 'text', text: 'world again' }
      ]
    }
  ]
})

test('searchDoc maps matches across marks to document positions', () => {
  const hits = searchDoc(doc, 'world', { ignoreCase: true })
  assert.equal(hits.length, 2)
  for (const [a, b] of hits) assert.equal(doc.textBetween(a, b), 'world')
})

test('searchDoc regex and case', () => {
  assert.equal(searchDoc(doc, 'WORLD').length, 0)
  assert.equal(searchDoc(doc, 'w.rld', { regex: true }).length, 2)
  assert.deepEqual(searchDoc(doc, '(', { regex: true }), [])
})

test('outline lists headings with positions', () => {
  assert.deepEqual(outline(doc), [{ level: 1, text: 'Plan', pos: 0 }])
})
