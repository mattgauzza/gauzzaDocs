import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-fh-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-fh-work-'))

const { saveFile, createFile } = await import('../src/core/files')
const { runOffline } = await import('../src/core/ops/index')
const { setDocInstructions } = await import('../src/core/instructions')
const { listVersions, flushHistory } = await import('../src/core/history/index')
const { newDeck } = await import('../src/shared/slides/model')

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const p = (name: string) => path.join(work, name)
const person = (name: string) => ({ authors: [{ name, by: 'person' as const }] })

const samples: [string, any][] = [
  ['a.md', { kind: 'doc', html: '<p>Hello</p>' }],
  ['a.html', { kind: 'doc', html: '<p>Hello</p>' }],
  ['a.docx', { kind: 'doc', html: '<p>Hello</p>' }],
  ['a.xlsx', { kind: 'sheet', workbook: { sheets: [{ name: 'Sheet1', cells: { A1: { v: 'x' } } }] } }],
  ['a.csv', { kind: 'sheet', workbook: { sheets: [{ name: 'Sheet1', cells: { A1: { v: 'x' } } }] } }],
  ['a.pptx', { kind: 'slides', deck: newDeck() }],
  ['a.pdf', { kind: 'pdf', bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]) }],
  ['a.txt', { kind: 'text', text: 'one\ntwo\n', eol: '\r\n' }]
]

test('saveFile writes every kind in memory then atomically, and records a version', async () => {
  for (const [name, payload] of samples) {
    const mtime = await saveFile(p(name), payload, person('Matt'))
    await flushHistory()
    const bytes = fs.readFileSync(p(name))
    assert.equal(mtime, fs.statSync(p(name)).mtimeMs, name)
    assert.equal(listVersions(p(name)).at(-1)!.hash, sha256(bytes), name)
  }
  assert.deepEqual(fs.readdirSync(work).filter(n => n.endsWith('.tmp')), [])
})

test('saveFile defaults to crediting the agent', async () => {
  await saveFile(p('def.txt'), { kind: 'text', text: 'x', eol: '\n' })
  await flushHistory()
  assert.deepEqual(listVersions(p('def.txt')).at(-1)!.authors, [{ name: 'Agent', by: 'agent' }])
})

test('runOffline credits the agent', async () => {
  fs.writeFileSync(p('ro.md'), 'hello world\n')
  await runOffline(p('ro.md'), { op: 'replace', find: 'hello', with: 'bye' } as any, { authors: [{ name: 'Claude', by: 'agent' }] })
  await flushHistory()
  assert.equal(fs.readFileSync(p('ro.md'), 'utf8').includes('bye'), true)
  const v = listVersions(p('ro.md'))
  assert.equal(v.at(-1)!.authors[0].name, 'Claude')
  assert.equal(v.at(-1)!.authors[0].by, 'agent')
})

test('setDocInstructions records a version of the .md file', async () => {
  fs.writeFileSync(p('ins.md'), '# T\n')
  await setDocInstructions(p('ins.md'), 'be nice', { authors: [{ name: 'Matt', by: 'person' }] })
  await flushHistory()
  assert.match(fs.readFileSync(p('ins.md'), 'utf8'), /be nice/)
  const v = listVersions(p('ins.md'))
  assert.equal(v.at(-1)!.hash, sha256(fs.readFileSync(p('ins.md'))))
  assert.equal(v.length, 2) // baseline + the edit
})

test('createFile over an existing file keeps it as the baseline', async () => {
  fs.writeFileSync(p('over.txt'), 'precious')
  await createFile(p('over.txt'))
  await flushHistory()
  const v = listVersions(p('over.txt'))
  assert.equal(v[0].baseline, true)
  assert.equal(v[0].hash, sha256(Buffer.from('precious')))
  assert.equal(fs.readFileSync(p('over.txt'), 'utf8'), '')
})
