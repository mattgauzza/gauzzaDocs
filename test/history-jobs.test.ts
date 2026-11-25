import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-jobs-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-jobs-work-'))
const docs = path.join(work, 'docs')

const { historyJobs: jobs, copyName } = await import('../src/main/historyJobs')
const { saveFile } = await import('../src/core/files')
const { runOffline } = await import('../src/core/ops')
const { flushHistory, listVersions, readLog, showVersion } = await import('../src/core/history')
const { setSettings } = await import('../src/core/paths')
setSettings({ docsDir: docs })

type Version = { n: number; authors: { name: string; by: string }[]; beforeRestore?: boolean; restoredFrom?: number; name?: string }
const claude = { authors: [{ name: 'Claude', by: 'agent' as const }] }
const matt = [{ name: 'Matt', by: 'person' as const }]
const text = (t: string) => ({ kind: 'text' as const, text: t, eol: '\n' as const })
let seq = 0
const fresh = (name = 'note.txt') => {
  const p = path.join(work, `${++seq}`, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}
/** A file with versions v1 "one" (Claude) and v2 "two" (Codex: other authors, so it never folds into v1). */
async function twoVersions(name?: string) {
  const f = fresh(name)
  await saveFile(f, text('one'), claude)
  await flushHistory()
  await saveFile(f, text('two'), { authors: [{ name: 'Codex', by: 'agent' }] })
  await flushHistory()
  assert.equal(listVersions(f).length, 2)
  return f
}
after(() => {
  for (const d of [work, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
/** Fails if `p` takes longer than `ms`; the timer is cleared either way, so it never keeps the process alive. */
const within = <T>(p: Promise<T>, ms = 15_000) => {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`still waiting after ${ms} ms`)), ms)))
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

test('copies are named <stem> (v<n>).<ext>, never over an existing file', () => {
  const dir = fs.mkdtempSync(path.join(work, 'names-'))
  assert.equal(copyName(dir, path.join(work, 'Plan.md'), 3), path.join(dir, 'Plan (v3).md'))
  fs.writeFileSync(path.join(dir, 'Plan (v3).md'), '')
  assert.equal(copyName(dir, path.join(work, 'Plan.md'), 3), path.join(dir, 'Plan (v3) (2).md'))
  assert.equal(copyName(dir, path.join(work, 'Makefile'), 2), path.join(dir, 'Makefile (v2)'))
  assert.equal(copyName(dir, path.join(work, 'Q3 report.final.docx'), 12), path.join(dir, 'Q3 report.final (v12).docx'))
})

test('historyOpenCopy writes the stored bytes to the docs folder and returns the path', async () => {
  const f = await twoVersions('Plan.md')
  const p = (await jobs.historyOpenCopy([f, 1])) as string
  assert.equal(p, path.join(docs, 'Plan (v1).md'))
  assert.deepEqual(fs.readFileSync(p), Buffer.from(await showVersion(f, 1)))
  const again = (await jobs.historyOpenCopy([f, 'v1'])) as string
  assert.equal(again, path.join(docs, 'Plan (v1) (2).md'))
  await assert.rejects(Promise.resolve().then(() => jobs.historyOpenCopy([f, 9])), /no version 9/)
})

test('historyRestore turns an unsaved payload into bytes and keeps it before restoring', async () => {
  const f = await twoVersions()
  const v = (await jobs.historyRestore([f, 1, { unsavedPayload: text('typed, not saved'), authors: matt }])) as Version
  assert.equal(fs.readFileSync(f, 'utf8'), 'one')
  assert.equal(v.restoredFrom, 1)
  const list = listVersions(f)
  const unsaved = list.at(-2)! // v1 one, v2 two, v3 the unsaved text, v4 restored
  assert.equal(Buffer.from(await showVersion(f, unsaved.n)).toString(), 'typed, not saved')
  assert.equal(unsaved.beforeRestore, true)
  assert.deepEqual(unsaved.authors, matt)
  assert.deepEqual(list.at(-1)!.authors, matt)
})

test('historyRestore needs authors and a real version number', async () => {
  const f = await twoVersions()
  await assert.rejects(Promise.resolve().then(() => jobs.historyRestore([f, 1, {}])), /authors/)
  await assert.rejects(Promise.resolve().then(() => jobs.historyRestore([f, 'seven', { authors: matt }])), /Not a version number/)
  assert.equal(fs.readFileSync(f, 'utf8'), 'two')
})

test('historyRestore waits for a save of the same file queued before it', async () => {
  const f = await twoVersions()
  const saving = saveFile(f, text('three'), claude) // not awaited: the restore is asked for while it is queued
  const restoring = jobs.historyRestore([f, 1, { authors: matt }])
  await Promise.all([saving, restoring])
  await flushHistory()
  assert.equal(fs.readFileSync(f, 'utf8'), 'one', 'the queued save must not land over the restore')
  const list = listVersions(f) as Version[]
  const three = list.find(x => x.authors[0].name === 'Claude' && x.n > 2)!
  assert.ok(three, 'the queued save is kept as a version')
  assert.equal(Buffer.from(await showVersion(f, three.n)).toString(), 'three')
  assert.equal(list.at(-1)!.restoredFrom, 1)
})

test('historyName names a version, credited to who named it', async () => {
  const f = await twoVersions()
  await jobs.historyName([f, 'v2', 'Sent to Dave', 'Matt'])
  assert.equal(listVersions(f)[1].name, 'Sent to Dave')
  const ev = readLog(f).find(e => e.type === 'named')!
  assert.equal(ev.by, 'Matt')
  await assert.rejects(Promise.resolve().then(() => jobs.historyName([f, 2, 'x'])), /who named it/)
})

test('historyDiff compares a version with the file now, or with another version', async () => {
  const f = await twoVersions()
  fs.writeFileSync(f, 'four')
  const toNow = (await jobs.historyDiff([f, 1])) as { hunks: { kind: string; lines: string[] }[] }
  const flat = (r: typeof toNow) => r.hunks.flatMap(h => h.lines.map(l => `${h.kind}:${l}`))
  assert.deepEqual(flat(toNow).sort(), ['add:four', 'del:one'].sort())
  const between = (await jobs.historyDiff([f, 1, 2])) as typeof toNow
  assert.deepEqual(flat(between).sort(), ['add:two', 'del:one'].sort())
  await assert.rejects(Promise.resolve().then(() => jobs.historyDiff([f, 7])), /no version 7/)
})

test('historyDiff says too large without reading a big file', async () => {
  const f = await twoVersions()
  fs.writeFileSync(f, Buffer.alloc(9 * 1024 * 1024, 'a'))
  assert.deepEqual(await jobs.historyDiff([f, 1]), { tooLarge: true })
  fs.rmSync(f)
  await assert.rejects(Promise.resolve().then(() => jobs.historyDiff([f, 1])), /not on disk/)
})

test('historyCheck keeps a change made by another program', async () => {
  const f = await twoVersions()
  fs.writeFileSync(f, 'edited in Notepad')
  await jobs.historyCheck([f])
  const last = listVersions(f).at(-1)!
  assert.equal(last.authors[0].by, 'outside')
  assert.equal(Buffer.from(await showVersion(f, last.n)).toString(), 'edited in Notepad')
})

test('historyCheckChanged looks only at changed files that have a history, in one batch', async () => {
  const kept = await twoVersions()
  fs.writeFileSync(kept, 'changed by git')
  const plain = fresh('plain.txt')
  fs.writeFileSync(plain, 'never saved by gauzzaDocs')
  const checked = await jobs.historyCheckChanged([[kept, plain, path.dirname(plain), kept, path.join(work, 'gone.txt')]])
  assert.equal(checked, 1)
  const last = listVersions(kept).at(-1)!
  assert.equal(last.authors[0].by, 'outside')
  assert.equal(Buffer.from(await showVersion(kept, last.n)).toString(), 'changed by git')
  assert.equal(listVersions(plain).length, 0, 'no history is started for a file gauzzaDocs never wrote')
})

test('historyEvent adds to the work history, stamped now when main gives no time', async () => {
  const f = fresh()
  const before = Date.now()
  await jobs.historyEvent([f, { type: 'comment', by: 'Matt', summary: 'commented: tighten this' }])
  const [ev] = readLog(f)
  assert.equal(ev.summary, 'commented: tighten this')
  assert.ok(ev.at >= before)
  await jobs.historyEvent([f, { type: 'connected', by: 'Claude', summary: 'started listening', at: 1234 }])
  assert.equal(readLog(f)[0].at, 1234)
  // An explicit at: undefined still gets stamped (it used to erase the stamp, and readers then skipped the line).
  await jobs.historyEvent([f, { type: 'reply', by: 'Matt', summary: 'replied: ok', at: undefined }])
  const [reply] = readLog(f)
  assert.equal(reply.summary, 'replied: ok')
  assert.ok(reply.at >= before)
  await assert.rejects(Promise.resolve().then(() => jobs.historyEvent([f, { by: 'Matt', summary: 'no type' }])), /needs a type/)
  await assert.rejects(Promise.resolve().then(() => jobs.historyEvent([f, null])), /needs a type/)
  assert.equal(readLog(f).length, 3)
})

test("an agent's burst of on-disk edits leaves at most two work history lines", async () => {
  const f = fresh()
  await saveFile(f, text('alpha beta gamma'), { authors: [{ name: 'Matt', by: 'person' }] })
  await flushHistory()
  const before = readLog(f).length
  const asClaude = { ...claude, summary: 'replace' }
  for (const [find, to] of [['alpha', 'one'], ['beta', 'two'], ['gamma', 'three']]) {
    // What main's rpc `op` case does: run the op with the agent as author, then log the op.
    await runOffline(f, { op: 'replace', find, with: to }, asClaude)
    await jobs.historyEvent([f, { type: 'agent-op', by: 'Claude', summary: 'replace' }])
  }
  await flushHistory()
  assert.equal(fs.readFileSync(f, 'utf8'), 'one two three')
  const added = readLog(f).slice(0, readLog(f).length - before)
  assert.ok(added.length <= 2, `added ${added.length} lines: ${JSON.stringify(added)}`)
  assert.deepEqual(added.map(e => `${e.type} ${e.summary}`).sort(), ['agent-op 3 edits', `save saved v${listVersions(f).at(-1)!.n}`].sort())
})

test('historyMove carries a renamed file history; historyForget removes it without waiting on itself', async () => {
  const f = await twoVersions()
  const to = path.join(path.dirname(f), 'renamed.txt')
  fs.renameSync(f, to)
  await within(Promise.resolve(jobs.historyMove([f, to, 'Matt'])))
  assert.equal(listVersions(to).length, 2)
  assert.equal(listVersions(f).length, 0)
  const moved = readLog(to).find(e => e.type === 'moved')!
  assert.equal(moved.by, 'Matt') // a rename in the app is the person's
  // Left out, the mover is "outside gauzzaDocs" (moves noticed after the fact).
  const again = path.join(path.dirname(f), 'renamed again.txt')
  fs.renameSync(to, again)
  await within(Promise.resolve(jobs.historyMove([to, again])))
  assert.equal(readLog(again)[0].by, 'outside gauzzaDocs')
  fs.renameSync(again, to)
  await within(Promise.resolve(jobs.historyMove([again, to, 'Matt'])))
  await within(Promise.resolve(jobs.historyForget([to])))
  assert.equal(listVersions(to).length, 0)
  assert.deepEqual(await jobs.historyList([to]), [])
})

test('historyStats reports the store size, the cap and what the last cleanup could not remove', async () => {
  await twoVersions()
  const s = (await jobs.historyStats([])) as { bytes: number; capBytes: number; overCapBytes?: number }
  assert.ok(s.bytes > 0)
  assert.equal(s.capBytes, 1024 * 1024 * 1024)
  assert.equal(s.overCapBytes, undefined)
  setSettings({ historyCapMB: 0.0001 }) // about 100 bytes: recent versions are all protected, so cleanup stays over
  try {
    await jobs.historyCleanup([])
    const after = (await jobs.historyStats([])) as typeof s
    assert.ok(after.overCapBytes! > 0)
    assert.equal(after.capBytes, 0.0001 * 1024 * 1024)
  } finally {
    setSettings({ historyCapMB: 1024 })
  }
})
