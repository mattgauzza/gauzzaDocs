import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-rec-home-'))
process.env.GAUZZADOCS_HOME = home
process.env.GAUZZADOCS_LARGE_MB = '1'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-rec-work-'))

const h = await import('../src/core/history/index')
const { guardedWrite, checkOutside, listVersions, flushHistory, onHistoryPaused, historyHooks, recordVersion, markBeforeRestore, writeAtomic, withLock, historyKey, HISTORY_DIR } = h

const MIN = 60_000
const agent = (name: string) => ({ authors: [{ name, by: 'agent' as const }] })
const person = { authors: [{ name: 'Matt', by: 'person' as const }] }
const writeText = (f: string, text: string) => async () => {
  const b = Buffer.from(text)
  await writeAtomic(f, b)
  return b
}
let seq = 0
const fresh = (name = 'doc.md') => path.join(work, `${++seq}`, name).replace(/^(.*)$/, p => (fs.mkdirSync(path.dirname(p), { recursive: true }), p))
const realNow = Date.now
async function withClock<T>(start: number, fn: (set: (t: number) => void) => Promise<T>): Promise<T> {
  let t = start
  Date.now = () => t
  try {
    return await fn(x => (t = x))
  } finally {
    Date.now = realNow
  }
}
const setMtime = (f: string, ms: number) => fs.utimesSync(f, new Date(ms), new Date(ms))

test('baseline: the first write keeps the file as it was before it', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'original')
  await guardedWrite(f, agent('Claude'), writeText(f, 'changed'))
  await flushHistory()
  const v = listVersions(f)
  assert.deepEqual(v.map(x => [x.n, x.baseline ?? false, x.authors[0].name]), [[1, true, 'outside gauzzaDocs'], [2, false, 'Claude']])
  assert.equal(v[0].authors[0].by, 'outside')
})

test('a new file has no baseline', async () => {
  const f = fresh()
  const st = await guardedWrite(f, person, writeText(f, 'hello'))
  await flushHistory()
  assert.equal(st.size, 5)
  assert.deepEqual(listVersions(f).map(x => x.n), [1])
  assert.equal(listVersions(f)[0].baseline, undefined)
})

test('folding: same authors within 10 minutes of firstAt fold; a different author starts a new version', async () => {
  const f = fresh()
  await withClock(1_000_000, async set => {
    await guardedWrite(f, agent('Claude'), writeText(f, 'a'))
    set(1_000_000 + 5 * MIN)
    await guardedWrite(f, agent('Claude'), writeText(f, 'b'))
    await flushHistory()
    assert.deepEqual(listVersions(f).map(x => x.n), [1])
    assert.equal(listVersions(f)[0].at, 1_000_000 + 5 * MIN)
    assert.equal(listVersions(f)[0].firstAt, 1_000_000)
    set(1_000_000 + 6 * MIN)
    await guardedWrite(f, agent('Codex'), writeText(f, 'c'))
    await flushHistory()
    assert.deepEqual(listVersions(f).map(x => [x.n, x.authors[0].name]), [[1, 'Claude'], [2, 'Codex']])
  })
})

test('folding: a session longer than 10 minutes gets a version every 10 minutes, not one all day', async () => {
  const f = fresh()
  await withClock(2_000_000, async set => {
    for (const [min, text] of [[0, 'a'], [6, 'b'], [12, 'c'], [14, 'd'], [23, 'e']] as const) {
      set(2_000_000 + min * MIN)
      await guardedWrite(f, agent('Claude'), writeText(f, text))
    }
    await flushHistory()
    assert.deepEqual(listVersions(f).map(x => [x.n, x.firstAt - 2_000_000]), [[1, 0], [2, 12 * MIN], [3, 23 * MIN]])
  })
})

test('folding never touches the baseline', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'original')
  await guardedWrite(f, { authors: [{ name: 'outside gauzzaDocs', by: 'outside' }] }, writeText(f, 'x'))
  await flushHistory()
  assert.equal(listVersions(f).length, 2)
})

test('outside change: a file edited by another program is recorded before gauzzaDocs writes over it', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'original')
  await guardedWrite(f, agent('Claude'), writeText(f, 'changed'))
  await flushHistory()
  fs.writeFileSync(f, 'by Word')
  setMtime(f, realNow() + 10_000)
  await guardedWrite(f, agent('Claude'), writeText(f, 'claude again'))
  await flushHistory()
  assert.deepEqual(listVersions(f).map(x => x.authors[0].name), ['outside gauzzaDocs', 'Claude', 'outside gauzzaDocs', 'Claude'])
  assert.deepEqual(listVersions(f).map(x => x.baseline ?? false), [true, false, false, false])
})

test('checkOutside records a change made elsewhere, once, and nothing for an untouched or unknown file', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'x')
  assert.equal(await checkOutside(f), null) // no history: opening records nothing
  await guardedWrite(f, person, writeText(f, 'mine'))
  await flushHistory()
  assert.equal(await checkOutside(f), null)
  fs.writeFileSync(f, 'theirs')
  setMtime(f, realNow() + 20_000)
  const v = await checkOutside(f, { low: true })
  assert.equal(v?.authors[0].by, 'outside')
  assert.equal(await checkOutside(f), null)
  assert.equal(listVersions(f).length, 3)
})

test('identical bytes record nothing', async () => {
  const f = fresh()
  await guardedWrite(f, person, writeText(f, 'same'))
  await guardedWrite(f, agent('Claude'), writeText(f, 'same'))
  await flushHistory()
  assert.deepEqual(listVersions(f).map(x => x.authors[0].name), ['Matt'])
})

test('excluded and over-32MB files are written but never versioned', async () => {
  const env = fresh('.env')
  const st = await guardedWrite(env, person, writeText(env, 'SECRET=1'))
  assert.equal(st.size, 8)
  assert.equal(fs.readFileSync(env, 'utf8'), 'SECRET=1')
  const big = fresh('big.txt')
  const bigText = 'x'.repeat(2 * 1024 * 1024) // the limit is 1 MB in this test file
  await guardedWrite(big, person, writeText(big, bigText))
  await flushHistory()
  assert.equal(fs.statSync(big).size, bigText.length)
  assert.deepEqual(listVersions(env), [])
  assert.deepEqual(listVersions(big), [])
  const grows = fresh('grows.txt')
  await guardedWrite(grows, person, writeText(grows, 'small'))
  await guardedWrite(grows, person, writeText(grows, bigText))
  await flushHistory()
  assert.equal(listVersions(grows).length, 1)
})

test('moved outside the app: a new path with the same content takes over the history', async () => {
  const a = fresh('old.md')
  const b = fresh('new.md')
  fs.writeFileSync(a, 'seed')
  await guardedWrite(a, agent('Claude'), writeText(a, 'content'))
  await flushHistory()
  fs.renameSync(a, b)
  const moves: string[][] = []
  historyHooks.onMoved = (o, n) => moves.push([o, n])
  await guardedWrite(b, agent('Codex'), writeText(b, 'more'))
  await flushHistory()
  historyHooks.onMoved = () => {}
  assert.deepEqual(listVersions(b).map(x => x.authors[0].name), ['outside gauzzaDocs', 'Claude', 'Codex'])
  assert.deepEqual(listVersions(a), [])
  assert.equal(moves.length, 1)
})

test('recordVersion and markBeforeRestore set the flags and never fold into them', async () => {
  const f = fresh()
  await guardedWrite(f, person, writeText(f, 'one'))
  await flushHistory()
  await withLock(historyKey(f), async () => {
    assert.equal(markBeforeRestore(f)?.beforeRestore, true)
    const bytes = Buffer.from('restored')
    const stat = await writeAtomic(f, bytes)
    const v = await recordVersion(f, bytes, stat, person, { restoredFrom: 1 })
    assert.equal(v?.n, 2)
    assert.equal(v?.restoredFrom, 1)
  })
  await guardedWrite(f, person, writeText(f, 'after'))
  await flushHistory()
  assert.deepEqual(listVersions(f).map(x => x.n), [1, 2, 3]) // restoredFrom blocks folding
})

test('write errors reject; history is not touched by them', async () => {
  const f = fresh()
  await assert.rejects(guardedWrite(f, person, async () => { throw new Error('disk gone') }), /disk gone/)
  await flushHistory()
  assert.deepEqual(listVersions(f), [])
  await guardedWrite(f, person, writeText(f, 'ok')) // the lock was released
})

test('lock unavailable: the file is still written and paused is reported once', async () => {
  const f = fresh()
  const reasons: string[] = []
  onHistoryPaused(r => reasons.push(r))
  let release!: () => void
  const held = withLock(historyKey(f), () => new Promise<void>(r => (release = r)))
  await new Promise(r => setTimeout(r, 100))
  const offset = 11_000
  const p = guardedWrite(f, person, writeText(f, 'written anyway'))
  await new Promise(r => setTimeout(r, 150))
  Date.now = () => realNow() + offset // the lock wait runs out
  try {
    const st = await p
    assert.equal(st.size, 'written anyway'.length)
  } finally {
    Date.now = realNow
    release()
    await held
  }
  assert.equal(fs.readFileSync(f, 'utf8'), 'written anyway')
  await flushHistory()
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /lock/i)
})

test('a history failure (store unavailable) still writes the file and reports paused once', async () => {
  const reasons: string[] = []
  onHistoryPaused(r => reasons.push(r))
  fs.rmSync(HISTORY_DIR, { recursive: true, force: true })
  fs.writeFileSync(HISTORY_DIR, 'not a folder') // mkdir under it now fails
  try {
    const f = fresh()
    const st = await guardedWrite(f, person, writeText(f, 'still saved'))
    await guardedWrite(f, person, writeText(f, 'saved twice'))
    await flushHistory()
    assert.equal(fs.readFileSync(f, 'utf8'), 'saved twice')
    assert.equal(st.size, 'still saved'.length)
    assert.equal(reasons.length, 1)
  } finally {
    fs.rmSync(HISTORY_DIR, { force: true })
  }
})
