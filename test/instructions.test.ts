import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-ins-home-'))
process.env.GAUZZADOCS_HOME = home

test('agent instructions: global, in-file for md/html (surviving editor saves), app data for others', async () => {
  const ins = await import('../src/core/instructions')
  const { loadFile, saveFile } = await import('../src/core/files')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-ins-'))

  ins.setGlobal('Look up my voice first.')
  assert.equal(ins.getGlobal(), 'Look up my voice first.')

  // Markdown: hidden comment, not shown in the editor, kept when the editor saves.
  const md = path.join(dir, 'a.md')
  fs.writeFileSync(md, '# Title\n\nBody text.\n')
  await ins.setDocInstructions(md, 'Keep it short.\nNo jargon --> ever.')
  assert.ok(fs.readFileSync(md, 'utf8').startsWith('<!-- gdocs:instructions'))
  const loaded = await loadFile(md)
  assert.ok(loaded.payload.kind === 'doc' && !loaded.payload.html.includes('gdocs'))
  await saveFile(md, { kind: 'doc', html: '<h1>Title</h1><p>Edited.</p>' })
  assert.equal(ins.getDocInstructions(md), 'Keep it short.\nNo jargon -- > ever.')
  assert.ok(fs.readFileSync(md, 'utf8').includes('Edited.'))

  // HTML: inert script in <head>, kept when the body is saved.
  const html = path.join(dir, 'b.html')
  await saveFile(html, { kind: 'doc', html: '<p>Hello</p>' })
  await ins.setDocInstructions(html, 'Never touch </script> sections.')
  await saveFile(html, { kind: 'doc', html: '<p>Changed</p>' })
  assert.equal(ins.getDocInstructions(html), 'Never touch </script> sections.')
  const h = await loadFile(html)
  assert.ok(h.payload.kind === 'doc' && h.payload.html.includes('Changed') && !h.payload.html.includes('Never touch'))

  // Other formats: app data, follows a rename, cleared with empty text.
  const x = path.join(dir, 'c.xlsx')
  fs.writeFileSync(x, '')
  await ins.setDocInstructions(x, 'Totals row is sacred.')
  assert.equal(ins.getDocInstructions(x), 'Totals row is sacred.')
  const y = path.join(dir, 'd.xlsx')
  ins.renameInstructions(x, y)
  assert.equal(ins.getDocInstructions(y), 'Totals row is sacred.')
  assert.equal(ins.getDocInstructions(x), '')
  await ins.setDocInstructions(y, '')
  assert.equal(ins.getDocInstructions(y), '')

  // With YAML front matter, the front matter stays on line 1 and the instructions follow it.
  const fm = path.join(dir, 'fm.md')
  fs.writeFileSync(fm, '---\ntitle: Plan\n---\n\n# Plan\n')
  await ins.setDocInstructions(fm, 'Use British spelling.')
  assert.ok(fs.readFileSync(fm, 'utf8').startsWith('---\ntitle: Plan\n---\n<!-- gdocs:instructions'))
  assert.equal(ins.getDocInstructions(fm), 'Use British spelling.')
  await ins.setDocInstructions(fm, '')
  assert.equal(fs.readFileSync(fm, 'utf8'), '---\ntitle: Plan\n---\n\n# Plan\n')

  // Removing from md leaves the text untouched.
  await ins.setDocInstructions(md, '')
  assert.ok(fs.readFileSync(md, 'utf8').startsWith('# Title'))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})
