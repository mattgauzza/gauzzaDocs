import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { before, test } from 'node:test'
import { docId } from '../src/shared/docId'

// The CLI runs as a real process against a throwaway app data folder, never the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-history-cli-home-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-history-cli-files-'))
const root = path.resolve(process.cwd())

before(() => {
  const r = spawnSync(process.execPath, ['scripts/build-cli.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

function gdocsWith(env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['dist/cli.mjs', ...args],
      { cwd: root, env: { ...process.env, GAUZZADOCS_HOME: home, GDOCS_AGENT: '', ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  })
}
const gdocs = (...args: string[]) => gdocsWith({}, ...args)
const json = async (...args: string[]) => JSON.parse((await gdocs(...args, '--json')).stdout)

const doc = (name: string, text: string) => {
  const f = path.join(work, name)
  fs.writeFileSync(f, text)
  return f
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

test('two agent edits, history, restore and forget', async () => {
  const f = doc('plan.md', 'Budget is low.\n')
  assert.equal((await gdocs('replace', f, 'low', 'fine', '--agent', 'Claude', '--offline')).code, 0)
  assert.equal((await gdocs('replace', f, 'fine', 'high', '--agent', 'Claude', '--offline')).code, 0)

  const versions = await json('history', f)
  assert.ok(versions.length >= 2)
  assert.equal(versions[0].baseline, true)
  const last = versions[versions.length - 1]
  assert.deepEqual(last.authors, [{ name: 'Claude', by: 'agent' }])
  assert.ok(last.summary && !/^Edited$/.test(last.summary), `plain summary expected, got ${last.summary}`)

  const r = await gdocs('history', 'restore', f, '1', '--offline', '--agent', 'Claude')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(fs.readFileSync(f, 'utf8'), 'Budget is low.\n')

  const f2 = await gdocs('history', 'forget', f)
  assert.equal(f2.code, 0, f2.stderr)
  assert.deepEqual(await json('history', 'list', f), [])
})

test('offline edits carry the agent name and a plain summary in the text list', async () => {
  const f = doc('notes.md', 'Risks are open.\n')
  await gdocs('replace', f, 'open', 'closed', '--agent', 'Claude', '--offline')
  const text = (await gdocs('history', f)).stdout
  assert.match(text, /^v1 {2}.+ {2}Before gauzzaDocs/m)
  assert.match(text, /^v2 {2}[A-Z][a-z]{2} \d+ \d+:\d\d [AP]M {2}Claude {2}Replaced text/m)
  assert.match(text, /baseline/i)
})

test('v7 and 7 both work, and a bad version gives a plain error', async () => {
  const f = doc('ver.md', 'one\n')
  await gdocs('replace', f, 'one', 'two', '--agent', 'Claude', '--offline')
  const a = await gdocs('history', 'show', f, 'v1')
  const b = await gdocs('history', 'show', f, '1')
  assert.equal(a.code, 0, a.stderr)
  assert.equal(a.stdout, b.stdout)
  assert.match(a.stdout, /one/)

  const bad = await gdocs('history', 'show', f, 'banana')
  assert.notEqual(bad.code, 0)
  assert.match(bad.stderr, /not a version number/i)
  const zero = await gdocs('history', 'show', f, '0')
  assert.match(zero.stderr, /not a version number/i)
  const missing = await gdocs('history', 'show', f, '99')
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /no version 99/i)
})

test('history diff marks lines and shows ... where lines were skipped', async () => {
  const f = doc('long.txt', lines(30).join('\n') + '\n')
  await gdocs('replace', f, 'line 2', 'LINE TWO', '--agent', 'Claude', '--offline')
  await gdocs('replace', f, 'line 29', 'LINE END', '--agent', 'Claude', '--offline')
  const d = await gdocs('history', 'diff', f, '1')
  assert.equal(d.code, 0, d.stderr)
  assert.match(d.stdout, /^- line 2$/m)
  assert.match(d.stdout, /^\+ LINE TWO$/m)
  assert.match(d.stdout, /^ {2}line 3$/m)
  assert.match(d.stdout, /^\.\.\.$/m)
  assert.match(d.stdout, /^\+ LINE END$/m)
})

test('history log words agent edits plainly', async () => {
  const f = doc('logged.md', 'alpha\n')
  await gdocs('replace', f, 'alpha', 'beta', '--agent', 'Claude', '--offline')
  const events = await json('history', 'log', f)
  assert.ok(Array.isArray(events))
  const text = (await gdocs('history', 'log', f)).stdout
  assert.doesNotMatch(text, /replaceText|—/)
  assert.match(text, /Claude/)
})

test('history name uses the agent name and shows in the list', async () => {
  const f = doc('named.md', 'x\n')
  await gdocs('replace', f, 'x', 'y', '--agent', 'Claude', '--offline')
  const r = await gdocs('history', 'name', f, 'v2', 'Sent to Dave', '--agent', 'Claude')
  assert.equal(r.code, 0, r.stderr)
  assert.match((await gdocs('history', f)).stdout, /Sent to Dave/)
  const log = (await gdocs('history', 'log', f)).stdout
  assert.match(log, /Claude/)
})

test('history works for a file that no longer exists', async () => {
  const f = doc('gone.md', 'keep me\n')
  await gdocs('replace', f, 'keep', 'lose', '--agent', 'Claude', '--offline')
  fs.rmSync(f)
  const v = await json('history', f)
  assert.ok(v.length >= 2)
  const r = await gdocs('history', 'restore', f, '1', '--offline')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(fs.readFileSync(f, 'utf8'), 'keep me\n')
})

test('forget says so when there is nothing to delete', async () => {
  const f = doc('never.md', 'untouched\n')
  const r = await gdocs('history', 'forget', f)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^No history for /)
  const unknown = await gdocs('history', 'forget', path.join(work, 'nope.md'))
  assert.equal(unknown.code, 0)
  assert.match(unknown.stdout, /^No history for /)
  await gdocs('replace', f, 'untouched', 'touched', '--agent', 'Claude', '--offline')
  assert.match((await gdocs('history', 'forget', f)).stdout, /^Deleted the history of /)
})

const lastAuthors = async (f: string) => {
  const v = await json('history', f)
  return v[v.length - 1].authors
}

test('a doc id works for a file in recent files that has history, also with an old lowercased index', { skip: process.platform !== 'win32' }, async () => {
  const f = doc('Recent Plan.md', 'Budget is low.\n')
  fs.writeFileSync(path.join(home, 'recent.json'), JSON.stringify([{ path: f, kind: 'doc', opened: Date.now() }]))
  assert.equal((await gdocs('replace', f, 'low', 'fine', '--agent', 'Claude', '--offline')).code, 0)
  const id = docId(f)
  for (const pass of ['real case', 'old lowercased index']) {
    const h = await gdocs('history', id)
    assert.equal(h.code, 0, `${pass}: ${h.stderr}`)
    assert.match(h.stdout, /Replaced text/)
    const r = await gdocs('read', id)
    assert.equal(r.code, 0, `${pass}: ${r.stderr}`)
    assert.match(r.stdout, /Budget is fine/)
    // Next pass: the index as it was written before real-case paths, lowercased.
    const dir = path.join(home, 'history', 'files')
    for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const idx = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (idx.path.toLowerCase() === fs.realpathSync.native(f).toLowerCase()) fs.writeFileSync(path.join(dir, n), JSON.stringify({ ...idx, path: idx.path.toLowerCase() }))
    }
  }
})

test('pdf merge --force keeps what <out> held and credits the merge to the agent', async () => {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = async (name: string, pages: number) => {
    const d = await PDFDocument.create()
    for (let i = 0; i < pages; i++) d.addPage([200, 200])
    const f = path.join(work, name)
    fs.writeFileSync(f, await d.save())
    return f
  }
  const a = await pdf('merge-a.pdf', 1)
  const b = await pdf('merge-b.pdf', 2)
  const out = await pdf('merged.pdf', 5)
  const before = fs.readFileSync(out)
  const r = await gdocs('pdf', 'merge', out, a, b, '--force', '--agent', 'Claude')
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await PDFDocument.load(fs.readFileSync(out))).getPageCount(), 3)
  const v = await json('history', out)
  assert.equal(v.length, 2)
  assert.equal(v[0].baseline, true)
  assert.equal(v[0].hash, crypto.createHash('sha256').update(before).digest('hex'), 'the overwritten PDF is kept as the first version')
  assert.deepEqual(v[1].authors, [{ name: 'Claude', by: 'agent' }])
  assert.deepEqual(fs.readdirSync(work).filter(n => n.endsWith('.tmp')), [], 'written atomically')
})

test('convert, new and instructions --set credit the agent named by --agent or GDOCS_AGENT', async () => {
  const src = doc('convert-src.md', '# Title\n\nBody\n')
  const to = path.join(work, 'converted.html')
  assert.equal((await gdocs('convert', src, to, '--agent', 'Claude')).code, 0)
  assert.deepEqual(await lastAuthors(to), [{ name: 'Claude', by: 'agent' }])
  const notes = doc('rules.md', 'Some notes.\n')
  const s = await gdocsWith({ GDOCS_AGENT: 'Codex' }, 'instructions', notes, '--set', 'Keep it short.')
  assert.equal(s.code, 0, s.stderr)
  assert.deepEqual(await lastAuthors(notes), [{ name: 'Codex', by: 'agent' }])
  const made = await gdocs('new', 'text', 'made by claude', '--dir', work, '--no-open', '--agent', 'Claude', '--json')
  assert.equal(made.code, 0, made.stderr)
  assert.deepEqual(await lastAuthors(JSON.parse(made.stdout).path), [{ name: 'Claude', by: 'agent' }])
})

test('restore over a file past the size limit names the --discard-current flag', async () => {
  const f = doc('grown.txt', 'small\n')
  await gdocs('replace', f, 'small', 'still small', '--agent', 'Claude', '--offline')
  fs.writeFileSync(f, Buffer.alloc(1024 * 1024 + 10, 0x61))
  const r = await gdocsWith({ GAUZZADOCS_LARGE_MB: '1' }, 'history', 'restore', f, '1', '--offline')
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--discard-current/)
  assert.doesNotMatch(r.stderr, /discardCurrent/)
  const ok = await gdocsWith({ GAUZZADOCS_LARGE_MB: '1' }, 'history', 'restore', f, '1', '--offline', '--discard-current')
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(fs.readFileSync(f, 'utf8'), 'small\n')
})

test('history diff says "Too many changes to compare here" when the comparison gives up', async () => {
  const { diffText } = await import('../src/cli/history')
  assert.equal(diffText({ tooMany: true }), 'Too many changes to compare here')
})
