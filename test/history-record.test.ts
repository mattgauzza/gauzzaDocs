import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
const { guardedWrite, checkOutside, listVersions, flushHistory, onHistoryPaused, historyHooks, recordVersion, markBeforeRestore, writeAtomic, withLock, historyKey, HISTORY_DIR, pauseReasonText } = h

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

test('noFold only disables folding: identical bytes are still skipped', async () => {
  const f = fresh()
  await guardedWrite(f, person, writeText(f, 'one'))
  await flushHistory()
  await withLock(historyKey(f), async () => {
    const same = Buffer.from('one')
    assert.equal(await recordVersion(f, same, { size: 3, mtime: 1 }, agent('Claude'), { noFold: true }), null)
    const v = await recordVersion(f, Buffer.from('two'), { size: 3, mtime: 2 }, person, { noFold: true })
    assert.equal(v?.n, 2) // same author within 10 minutes would fold; noFold keeps it apart
  })
  assert.deepEqual(listVersions(f).map(x => x.n), [1, 2])
})

test('write errors reject; history is not touched by them', async () => {
  const f = fresh()
  await assert.rejects(guardedWrite(f, person, async () => { throw new Error('disk gone') }), /disk gone/)
  await flushHistory()
  assert.deepEqual(listVersions(f), [])
  await guardedWrite(f, person, writeText(f, 'ok')) // the lock was released
})

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
/** Makes storing this content fail: a plain file where its object folder should be. Returns the undo. */
function blockObject(text: string) {
  const dir = path.dirname(h.objectPath(sha(text)))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  fs.writeFileSync(dir, 'in the way')
  return () => fs.rmSync(dir, { force: true })
}
const authorsOf = (f: string) => listVersions(f).map(x => `${x.authors[0].name}${x.baseline ? '*' : ''}`)

test('first save: the write finishes before the baseline is hashed and stored, and the baseline holds the original', async () => {
  const f = fresh()
  const original = 'first-save-original-bytes'
  fs.writeFileSync(f, original)
  await guardedWrite(f, agent('Claude'), writeText(f, 'first-save-new-bytes'))
  assert.equal(fs.existsSync(h.objectPath(sha(original))), false)
  assert.equal(fs.readFileSync(f, 'utf8'), 'first-save-new-bytes')
  await flushHistory()
  assert.equal(Buffer.from((await h.getObject(sha(original)))!).toString(), original)
  assert.deepEqual(authorsOf(f), ['outside gauzzaDocs*', 'Claude'])
})

test('a version that failed to record is recorded under its real author next time, never as outside', async () => {
  const f = fresh()
  const reasons: string[] = []
  onHistoryPaused(r => reasons.push(r))
  await guardedWrite(f, person, writeText(f, 'rec-one'))
  await flushHistory()
  const unblock = blockObject('rec-two-by-claude')
  await guardedWrite(f, agent('Claude'), writeText(f, 'rec-two-by-claude'))
  await flushHistory()
  assert.equal(reasons.length, 1)
  assert.deepEqual(authorsOf(f), ['Matt']) // not recorded yet
  unblock()
  await guardedWrite(f, person, writeText(f, 'rec-three'))
  await flushHistory()
  assert.deepEqual(authorsOf(f), ['Matt', 'Claude', 'Matt'])
  assert.equal(Buffer.from((await h.getObject(listVersions(f)[1].hash))!).toString(), 'rec-two-by-claude')
})

test('a failed baseline is kept and recorded first next time; the agent edit is never taken for the baseline', async () => {
  const f = fresh()
  const reasons: string[] = []
  onHistoryPaused(r => reasons.push(r))
  fs.writeFileSync(f, 'base-original')
  const unblock = blockObject('base-original')
  await guardedWrite(f, agent('Claude'), writeText(f, 'base-edit'))
  await flushHistory()
  assert.equal(reasons.length, 1)
  assert.deepEqual(listVersions(f), [])
  unblock()
  await guardedWrite(f, person, writeText(f, 'base-later'))
  await flushHistory()
  assert.deepEqual(authorsOf(f), ['outside gauzzaDocs*', 'Claude', 'Matt'])
  assert.equal(Buffer.from((await h.getObject(listVersions(f)[0].hash))!).toString(), 'base-original')
})

test('a write made while the lock was unavailable is later recorded under its real author', async () => {
  const f = fresh()
  onHistoryPaused(() => {})
  await guardedWrite(f, person, writeText(f, 'lk-one'))
  await flushHistory()
  let release!: () => void
  const held = withLock(historyKey(f), () => new Promise<void>(r => (release = r)))
  await new Promise(r => setTimeout(r, 100))
  const p = guardedWrite(f, agent('Claude'), writeText(f, 'lk-two'))
  await new Promise(r => setTimeout(r, 150))
  Date.now = () => realNow() + 11_000
  try {
    await p
  } finally {
    Date.now = realNow
    release()
    await held
  }
  await flushHistory()
  await guardedWrite(f, person, writeText(f, 'lk-three'))
  await flushHistory()
  assert.deepEqual(authorsOf(f), ['Matt', 'Claude', 'Matt'])
})

test('a baseline keeps its place before the write it precedes, also when its record is deferred by a failure', async () => {
  const f = fresh()
  fs.writeFileSync(f, 'order-original')
  await guardedWrite(f, agent('Claude'), writeText(f, 'order-edit'))
  await flushHistory()
  let v = listVersions(f)
  assert.deepEqual(v.map(x => x.n), [1, 2])
  assert.ok(v[0].baseline && v[0].at <= v[1].at && v[0].firstAt <= v[1].firstAt)
  const g = fresh()
  onHistoryPaused(() => {})
  fs.writeFileSync(g, 'order2-original')
  const unblock = blockObject('order2-original')
  await guardedWrite(g, agent('Claude'), writeText(g, 'order2-edit'))
  await flushHistory()
  await new Promise(r => setTimeout(r, 30))
  unblock()
  await guardedWrite(g, person, writeText(g, 'order2-later'))
  await flushHistory()
  v = listVersions(g)
  assert.deepEqual(v.map(x => [x.n, x.baseline ?? false]), [[1, true], [2, false], [3, false]])
  assert.ok(v[0].at <= v[1].at && v[1].at <= v[2].at)
})

test('adoption is blocked when the old drive is unreachable, and the old index is untouched', { skip: process.platform !== 'win32' }, async () => {
  const letter = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find(l => !fs.existsSync(`${l}:\\`))
  if (!letter) return
  const old = `${letter}:\\Docs\\gone.md`
  const key = historyKey(old)
  const canon = h.canonicalPath(old)
  h.writeIndex(key, { path: canon, versions: [{ n: 1, firstAt: 1, at: 1, hash: sha('drive-content'), size: 13, mtime: 1, authors: [], summary: '' }] })
  const b = fresh('here.md')
  fs.writeFileSync(b, 'drive-content')
  const moves: string[] = []
  historyHooks.onMoved = o => moves.push(o)
  await guardedWrite(b, agent('Codex'), writeText(b, 'drive-content-edited'))
  await flushHistory()
  historyHooks.onMoved = () => {}
  assert.deepEqual(moves, [])
  assert.deepEqual(authorsOf(b), ['outside gauzzaDocs*', 'Codex'])
  assert.equal(h.readIndex(key, canon)?.versions.length, 1)
})

test('a folder renamed away does not stop its files adopting their history', async () => {
  const a = fresh('inside.md')
  await guardedWrite(a, agent('Claude'), writeText(a, 'renamed-folder'))
  await flushHistory()
  const renamed = path.join(work, `renamed-${++seq}`)
  fs.renameSync(path.dirname(a), renamed)
  const b = path.join(renamed, 'inside.md')
  const moves: string[] = []
  historyHooks.onMoved = o => moves.push(o)
  await guardedWrite(b, agent('Codex'), writeText(b, 'renamed-folder-edited'))
  await flushHistory()
  historyHooks.onMoved = () => {}
  assert.equal(moves.length, 1)
  assert.deepEqual(authorsOf(b), ['Claude', 'Codex'])
})

test('an empty file never adopts a moved history', async () => {
  const a = fresh('was-empty.md')
  const b = fresh('new-empty.md')
  await guardedWrite(a, person, writeText(a, ''))
  await flushHistory()
  fs.rmSync(a) // folder still there, file gone
  fs.writeFileSync(b, '')
  const moves: string[] = []
  historyHooks.onMoved = o => moves.push(o)
  await guardedWrite(b, person, writeText(b, 'now not empty'))
  await flushHistory()
  historyHooks.onMoved = () => {}
  assert.deepEqual(moves, [])
  assert.deepEqual(authorsOf(b), ['outside gauzzaDocs*', 'Matt'])
  assert.equal(listVersions(a).length, 1)
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
    assert.doesNotMatch(reasons[0], /^E[A-Z]+:/, 'the reason is a sentence, not a raw Node error')
    assert.ok(reasons[0].includes(HISTORY_DIR), reasons[0])
  } finally {
    fs.rmSync(HISTORY_DIR, { force: true })
  }
})

test('pauseReasonText puts file system errors in plain words', () => {
  const err = (code: string) => Object.assign(new Error(`${code}: raw message`), { code })
  assert.equal(pauseReasonText(err('ENOSPC')), 'the disk is full')
  assert.equal(pauseReasonText(err('EROFS')), 'the disk is read-only')
  assert.equal(pauseReasonText(err('EACCES')), `gauzzaDocs can't write to ${HISTORY_DIR}`)
  assert.equal(pauseReasonText(err('EPERM')), `gauzzaDocs can't write to ${HISTORY_DIR}`)
  assert.equal(pauseReasonText(err('ENOTDIR')), `gauzzaDocs can't make its folders in ${HISTORY_DIR}: a file is in the way`)
  assert.equal(pauseReasonText(err('EIO')), `gauzzaDocs can't write to ${HISTORY_DIR} (EIO)`)
  assert.equal(pauseReasonText(new Error('Timed out waiting for the history lock (abc)')), 'Timed out waiting for the history lock (abc)')
  assert.equal(pauseReasonText('already a sentence'), 'already a sentence')
})
