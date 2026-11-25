import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { backupPath, docBytes, loadDoc, saveDoc } from '../src/core/formats/doc'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const HTML = [
  '<h1>Quarterly plan</h1>',
  '<p style="text-align: center">Centered line</p>',
  '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> and <span style="color: #c5221f">red words</span> and <span style="font-size: 16pt">big</span>.</p>',
  '<ul><li><p>First</p></li><li><p>Second</p></li></ul>',
  '<ol><li><p>One</p></li><li><p>Two</p></li></ol>',
  '<table><tbody><tr><td><p>Item</p></td><td><p>Cost</p></td></tr><tr><td><p>Laptop</p></td><td><p>1200</p></td></tr></tbody></table>',
  `<p><img src="${PNG}"></p>`,
  '<p>Visit <a href="https://example.com">the site</a>.</p>',
  '<h2>Next steps</h2>',
  '<p>Done.</p>'
].join('')

test('docx: a plain Word document round-trips without loss and keeps formatting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-docx-'))
  const file = path.join(dir, 'plan.docx')
  fs.writeFileSync(file, await docBytes(file, HTML))
  const a = await loadDoc(file)
  assert.equal(a.lossy, false, `unexpected loss: ${a.lossyReasons}`)
  const h = a.html
  assert.match(h, /<h1[^>]*>Quarterly plan<\/h1>/)
  assert.match(h, /<h2[^>]*>Next steps<\/h2>/)
  assert.match(h, /text-align: center[^>]*>Centered line/)
  assert.match(h, /<strong>bold<\/strong>/)
  assert.match(h, /<u>under<\/u>/)
  assert.match(h, /color: #c5221f[^>]*>red words/)
  assert.match(h, /font-size: 16pt[^>]*>big/)
  assert.match(h, /<ul>[\s\S]*First[\s\S]*Second[\s\S]*<\/ul>/)
  assert.match(h, /<ol>[\s\S]*One[\s\S]*Two[\s\S]*<\/ol>/)
  assert.match(h, /<table>[\s\S]*Laptop[\s\S]*1200[\s\S]*<\/table>/)
  assert.match(h, /<img src="data:image\/png;base64,/)
  assert.match(h, /<a href="https:\/\/example.com">the site<\/a>/)

  // Saving what was loaded keeps it all (a second round trip), and no backup is made for a lossless file.
  await saveDoc(file, a.html)
  const b = await loadDoc(file)
  assert.equal(b.lossy, false)
  for (const s of ['Quarterly plan', 'red words', 'Laptop', 'the site', 'Done.']) assert.ok(b.html.includes(s), s)
  assert.match(b.html, /color: #c5221f/)
  assert.ok(!fs.existsSync(backupPath(file)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('docx: headers and tracked changes make it lossy, and the first save keeps a backup once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-docx-'))
  const file = path.join(dir, 'contract.docx')
  const zip = await JSZip.loadAsync(await docBytes(file, '<p>Terms apply.</p>'))
  zip.file('word/header1.xml', '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>ACME Confidential</w:t></w:r></w:p></w:hdr>')
  const doc = await zip.file('word/document.xml')!.async('string')
  zip.file('word/document.xml', doc.replace(/<w:body>/, '<w:body><w:p><w:ins w:id="1" w:author="Pat" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Inserted clause.</w:t></w:r></w:ins></w:p>'))
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))

  const a = await loadDoc(file)
  assert.equal(a.lossy, true)
  assert.ok(a.lossyReasons!.includes('headers or footers'), String(a.lossyReasons))
  assert.ok(a.lossyReasons!.includes('tracked changes'), String(a.lossyReasons))

  const original = fs.readFileSync(file)
  await saveDoc(file, a.html)
  assert.deepEqual(fs.readFileSync(backupPath(file)), original, 'backup is the untouched original')
  // A later save never overwrites the backup (and the file is no longer lossy anyway).
  fs.writeFileSync(backupPath(file), 'keep me')
  await saveDoc(file, '<p>Edited again.</p>')
  assert.equal(fs.readFileSync(backupPath(file), 'utf8'), 'keep me')
  assert.equal((await loadDoc(file)).lossy, false)
  fs.rmSync(dir, { recursive: true, force: true })
})
