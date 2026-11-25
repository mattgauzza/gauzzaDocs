import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadFile, saveFile } from '../src/core/files'
import { runOffline } from '../src/core/ops'
import { applyDocOp, replaceInHtml, splitBlocks } from '../src/shared/ops/doc'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-doc-test-'))

test('splitBlocks finds top-level blocks', () => {
  const b = splitBlocks('<h1>Title</h1><p>One <b>bold</b></p><ul><li><p>a</p></li></ul><hr><p>end</p>')
  assert.deepEqual(b, ['<h1>Title</h1>', '<p>One <b>bold</b></p>', '<ul><li><p>a</p></li></ul>', '<hr>', '<p>end</p>'])
})

test('replace only touches text, keeps tags and entities', () => {
  const r = replaceInHtml('<p class="cat">cat &amp; <b>cat</b></p>', 'cat', 'dog', { all: true })
  assert.equal(r.html, '<p class="cat">dog &amp; <b>dog</b></p>')
  assert.equal(r.count, 2)
  const one = replaceInHtml('<p>a a a</p>', 'a', 'b', {})
  assert.equal(one.html, '<p>b a a</p>')
  assert.equal(replaceInHtml('<p>x &lt; y</p>', 'x < y', 'z', {}).html, '<p>z</p>')
})

test('insert after / before a block', () => {
  const html = '<h2>Intro</h2><p>Hello</p><h2>End</h2>'
  const r = applyDocOp(html, { op: 'insert', after: 'hello', content: '**New**' })
  assert.match(r.html!, /<p>Hello<\/p>\n<p><strong>New<\/strong><\/p>\n<h2>End/)
  const b = applyDocOp(html, { op: 'insert', before: 'End', content: 'x', format: 'text' })
  assert.match(b.html!, /<p>x<\/p>\n<h2>End/)
  assert.throws(() => applyDocOp(html, { op: 'insert', after: 'nope', content: 'x' }))
})

test('outline, info, find', () => {
  const html = '<h1>A</h1><p>one two three</p><h2>B</h2><p>four</p>'
  assert.deepEqual((applyDocOp(html, { op: 'outline' }).result as any).headings, [{ level: 1, text: 'A' }, { level: 2, text: 'B' }])
  assert.equal((applyDocOp(html, { op: 'info' }).result as any).words, 6)
  assert.deepEqual((applyDocOp(html, { op: 'find', query: 'FOUR', ignoreCase: true }).result as any).matches, [{ block: 4, text: 'four' }])
})

test('markdown file round trip through runOffline', async () => {
  const f = path.join(tmp, 'notes.md')
  fs.writeFileSync(f, '# Plan\n\nFirst para.\n\n- a\n- b\n')
  await runOffline(f, { op: 'append', content: '## Next\n\nMore *text*.' })
  await runOffline(f, { op: 'replace', find: 'First', with: 'Opening' })
  const md = fs.readFileSync(f, 'utf8')
  assert.match(md, /^# Plan/)
  assert.match(md, /Opening para\./)
  assert.match(md, /## Next/)
  assert.match(md, /More \*text\*\./)
  const read = (await runOffline(f, { op: 'read', format: 'text' })) as { content: string }
  assert.match(read.content, /Opening para\./)
})

test('html file keeps its head on save', async () => {
  const f = path.join(tmp, 'page.html')
  fs.writeFileSync(f, '<!doctype html><html><head><title>Keep me</title></head><body><p>hi</p></body></html>')
  await runOffline(f, { op: 'write', content: '<p>bye</p>', format: 'html' })
  const s = fs.readFileSync(f, 'utf8')
  assert.match(s, /<title>Keep me<\/title>/)
  assert.match(s, /<p>bye<\/p>/)
  assert.doesNotMatch(s, /<p>hi<\/p>/)
})

test('docx round trip', async () => {
  const f = path.join(tmp, 'report.docx')
  await saveFile(f, { kind: 'doc', html: '<h1>Report</h1><p>Hello <strong>world</strong></p><ul><li>one</li></ul>' })
  const back = await loadFile(f)
  assert.equal(back.kind, 'doc')
  const html = (back.payload as { html: string }).html
  assert.match(html, /Report/)
  assert.match(html, /<strong>world<\/strong>/)
  await runOffline(f, { op: 'replace', find: 'world', with: 'there' })
  const again = (await runOffline(f, { op: 'read', format: 'text' })) as { content: string }
  assert.match(again.content, /Hello there/)
})
