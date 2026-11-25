import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-log-home-'))
process.env.GAUZZADOCS_HOME = home
process.env.GAUZZADOCS_LARGE_MB = '1'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-log-work-'))

const h = await import('../src/core/history/index')
const { appendEvent, appendEventLocked, readLog, guardedWrite, flushHistory, writeAtomic, withLock, historyKey, logPath, nameVersion, restoreVersion, moveHistory, checkOutside } = h

type Ev = import('../src/core/history/index').HistoryEvent
let seq = 0
const fresh = (name = 'doc.md') => {
  const p = path.join(work, `${++seq}`, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}
const ev = (over: Partial<Ev> = {}): Ev => ({ at: 1_000_000, type: 'agent-op', by: 'Claude', summary: 'edited', ...over })
const logFile = (f: string) => logPath(historyKey(f))
const agent = { authors: [{ name: 'Claude', by: 'agent' as const }] }
const save = async (f: string, bytes: Uint8Array, ctx = agent) => {
  await guardedWrite(f, ctx, async () => (await writeAtomic(f, bytes), bytes))
  await flushHistory()
}

test('consecutive agent ops by the same agent within 60 s merge into "<n> edits"', async () => {
  const f = fresh()
  await appendEvent(f, ev({ at: 1000 }))
  await appendEvent(f, ev({ at: 20_000 }))
  await appendEvent(f, ev({ at: 50_000 }))
  const log = readLog(f)
  assert.equal(log.length, 1)
  assert.equal(log[0].summary, '3 edits')
  assert.equal(log[0].at, 50_000)
})

test('no merge across agents, after 60 s, or past another kind of event', async () => {
  const f = fresh()
  await appendEvent(f, ev({ at: 1000, by: 'Claude' }))
  await appendEvent(f, ev({ at: 2000, by: 'Codex' }))
  await appendEvent(f, ev({ at: 3000 + 61_000, by: 'Codex' }))
  await appendEvent(f, ev({ at: 70_000, type: 'comment', summary: 'commented' }))
  await appendEvent(f, ev({ at: 71_000, by: 'Codex' }))
  assert.equal(readLog(f).length, 5)
})

test('readLog is newest first, honours limit and skips garbage lines', async () => {
  const f = fresh()
  await appendEvent(f, ev({ at: 1, type: 'comment', summary: 'a' }))
  fs.appendFileSync(logFile(f), 'not json\n{"at":"x"}\n{"half":')
  await appendEvent(f, ev({ at: 2, type: 'reply', summary: 'b' }))
  await appendEvent(f, ev({ at: 3, type: 'resolved', summary: 'c' }))
  assert.deepEqual(readLog(f).map(e => e.summary), ['c', 'b', 'a'])
  assert.deepEqual(readLog(f, 2).map(e => e.summary), ['c', 'b'])
  assert.deepEqual(readLog(fresh()), [])
})

test('the log is trimmed to the newest half when it passes 2 MB', async () => {
  const f = fresh()
  const big = 'x'.repeat(1000)
  for (let i = 0; i < 2300; i++) await appendEventLocked(f, ev({ at: i, type: 'comment', summary: `${i} ${big}` }))
  const size = fs.statSync(logFile(f)).size
  assert.ok(size <= 2 * 1024 * 1024, `size ${size}`)
  const log = readLog(f)
  assert.equal(log[0].at, 2299) // newest kept
  assert.ok(log.length > 500 && log.length < 1500, `kept ${log.length}`)
})

test('excluded files get summaries without quoted text', async () => {
  const f = fresh('.env')
  await appendEvent(f, ev({ type: 'comment', by: 'Matt', summary: 'rotate API_KEY=sk-secret-123' }))
  const raw = fs.readFileSync(logFile(f), 'utf8')
  assert.ok(!raw.includes('sk-secret-123'))
  assert.equal(readLog(f).length, 1)
  assert.equal(readLog(f)[0].type, 'comment')
  assert.equal(readLog(f)[0].by, 'Matt')
})

test('appendEventLocked inside a held lock does not deadlock; appendEvent takes the lock itself', async () => {
  const f = fresh()
  await withLock(historyKey(f), async () => appendEventLocked(f, ev({ type: 'comment', summary: 'in lock' })))
  await appendEvent(f, ev({ type: 'reply', summary: 'outside lock' }))
  assert.deepEqual(readLog(f).map(e => e.summary), ['outside lock', 'in lock'])
})

test('a recorded save logs a save event and an outside change logs an outside event', async () => {
  const f = fresh()
  fs.writeFileSync(f, crypto.randomBytes(100))
  await save(f, crypto.randomBytes(100))
  let log = readLog(f)
  assert.deepEqual(log.map(e => e.type).sort(), ['outside', 'save']) // baseline, then the save
  const s = log.find(e => e.type === 'save')!
  assert.equal(s.by, 'Claude')
  assert.match(s.summary, /v2/)
  const o = log.find(e => e.type === 'outside')!
  assert.equal(o.by, 'outside gauzzaDocs')

  fs.writeFileSync(f, crypto.randomBytes(100)) // another program
  await checkOutside(f)
  await flushHistory()
  log = readLog(f)
  assert.equal(log[0].type, 'outside')
  assert.match(log[0].summary, /v3/)
})

test('two authors are joined with ", "', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'a')
  await save(f, Buffer.from('b'), { authors: [{ name: 'Matt', by: 'person' as never }, { name: 'Claude', by: 'agent' }] })
  assert.equal(readLog(f).find(e => e.type === 'save')!.by, 'Matt, Claude')
})

test('naming and restoring a version log named and restored', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'one')
  await save(f, Buffer.from('two'))
  await nameVersion(f, 2, 'Final draft', 'Matt')
  await restoreVersion(f, 1, agent)
  const log = readLog(f)
  assert.equal(log[0].type, 'restored')
  assert.equal(log[0].summary, 'restored v1')
  const named = log.find(e => e.type === 'named')!
  assert.equal(named.summary, 'named v2 "Final draft"')
  assert.equal(named.by, 'Matt')
})

test('20 folded saves of one version leave exactly one save event for it', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'seed')
  for (let i = 0; i < 20; i++) await save(f, Buffer.from(`edit ${i}`), { authors: [{ name: 'Matt', by: 'person' as never }] })
  assert.equal(h.listVersions(f).length, 2) // baseline + one folded version
  const saves = readLog(f).filter(e => e.type === 'save')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].summary, 'saved v2')
  await save(f, Buffer.from('by agent')) // a different author makes a new version: a new event
  assert.deepEqual(readLog(f).filter(e => e.type === 'save').map(e => e.summary), ['saved v3', 'saved v2'])
})

test('save events of an excluded file fold by version number, not by redacted summary', async () => {
  const f = fresh('.env')
  await appendEvent(f, ev({ at: 1, type: 'save', summary: 'saved v1', v: 1 }))
  await appendEvent(f, ev({ at: 2, type: 'save', summary: 'saved v2', v: 2 }))
  await appendEvent(f, ev({ at: 3, type: 'save', summary: 'saved v2', v: 2 })) // a fold of v2
  const log = readLog(f)
  assert.deepEqual(log.map(e => e.v), [2, 1])
  assert.equal(log[0].at, 3)
  assert.ok(log.every(e => e.summary === 'save')) // still redacted
})

test('a normal append reads only the tail, never the whole log', async () => {
  const f = fresh()
  for (let i = 0; i < 50; i++) await appendEventLocked(f, ev({ at: i, type: 'comment', summary: `c${i}` }))
  const target = logFile(f)
  const orig = fs.readFileSync
  const reads: string[] = []
  ;(fs as { readFileSync: unknown }).readFileSync = (p: unknown, ...rest: unknown[]) => {
    if (String(p) === target) reads.push(String(p))
    return (orig as (...a: unknown[]) => unknown)(p, ...rest)
  }
  try {
    await appendEventLocked(f, ev({ at: 100, type: 'comment', summary: 'plain' }))
    await appendEventLocked(f, ev({ at: 101 }))
    await appendEventLocked(f, ev({ at: 102 })) // merge
  } finally {
    ;(fs as { readFileSync: unknown }).readFileSync = orig
  }
  assert.deepEqual(reads, [])
  const log = readLog(f, 3)
  assert.deepEqual(log.map(e => e.summary), ['2 edits', 'plain', 'c49'])
})

test('moving a history logs "moved from" in the new path\'s log and the old log follows', async () => {
  const a = fresh('a.md')
  const b = fresh('b.md')
  fs.writeFileSync(a, 'one')
  await save(a, Buffer.from('two'))
  await moveHistory(a, b)
  assert.ok(!fs.existsSync(logFile(a)))
  const log = readLog(b)
  assert.equal(log[0].type, 'moved')
  assert.ok(log[0].summary.startsWith('moved from '))
  assert.ok(log.some(e => e.type === 'save'))
})

test('a history adopted after an outside move keeps its log and logs "moved from"', async () => {
  const a = fresh('old.md')
  const b = fresh('new.md')
  fs.writeFileSync(a, 'seed')
  await save(a, Buffer.from('content'))
  fs.renameSync(a, b)
  await save(b, Buffer.from('more'), { authors: [{ name: 'Codex', by: 'agent' as const }] })
  const log = readLog(b)
  assert.ok(log.some(e => e.type === 'moved' && e.summary.startsWith('moved from ')))
  assert.ok(log.some(e => e.type === 'save' && e.by === 'Claude')) // the old log came along
  assert.ok(log.some(e => e.type === 'save' && e.by === 'Codex'))
  assert.ok(!fs.existsSync(logFile(a)))
})

test('a log that cannot be written is reported as paused and never fails the save', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'seed')
  const reasons: string[] = []
  h.onHistoryPaused(r => reasons.push(r))
  fs.mkdirSync(logFile(f), { recursive: true }) // a directory where the log file should be
  await save(f, Buffer.from('still saved'))
  assert.equal(fs.readFileSync(f, 'utf8'), 'still saved')
  assert.equal(reasons.length, 1)
  assert.equal(h.listVersions(f).length, 2) // the versions were recorded all the same
})
