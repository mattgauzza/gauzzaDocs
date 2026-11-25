import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { before, test } from 'node:test'

// The CLI runs as a real process against a throwaway app data folder, never the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-history-cli-home-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-history-cli-files-'))
const root = path.resolve(process.cwd())

before(() => {
  const r = spawnSync(process.execPath, ['scripts/build-cli.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

function gdocs(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['dist/cli.mjs', ...args],
      { cwd: root, env: { ...process.env, GAUZZADOCS_HOME: home, GDOCS_AGENT: '' }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  })
}
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
