import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-clean-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-clean-work-'))

const h = await import('../src/core/history/index')
const { cleanupHistory, cleanupHooks, putObject, objectPath, historyKey, indexPath, bakPath, logPath, writeIndex, readIndex, listVersions, guardedWrite, writeAtomic, flushHistory, readLog, HISTORY_DIR } = h

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const BIG = 1e12
// Every test runs against one fixed "now" (override with GD_TEST_NOW to prove date independence) and every seeded
// time sits at UTC noon of its target day, so no test depends on the wall clock or the hour it runs at.
const NOW = process.env.GD_TEST_NOW ? Date.parse(process.env.GD_TEST_NOW) : Date.UTC(2026, 5, 15, 12)
const noonToday = Math.floor(NOW / DAY) * DAY + 12 * HOUR
const atDay = (days: number, hours = 0) => (days === 0 ? NOW - HOUR : noonToday - days * DAY + hours * HOUR)
const month = (t: number) => new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth()
/** Two consecutive days (older first) at about `days` old that fall in the same UTC month. */
const sameMonth = (days: number): [number, number] => (month(atDay(days + 1)) === month(atDay(days)) ? [days + 1, days] : [days, days - 1])

type V = import('../src/core/history/index').HistoryVersion
let seq = 0
const reset = () => {
  fs.rmSync(HISTORY_DIR, { recursive: true, force: true })
  cleanupHooks.afterScan = undefined
  ;(cleanupHooks as any).afterList = undefined
  ;(cleanupHooks as any).reachable = undefined
}
const fresh = (name = 'doc.bin') => {
  const p = path.join(work, `${++seq}`, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}
const age = (p: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(p, t, t)
}
interface Spec { days: number; h?: number; bytes?: number; name?: string; baseline?: boolean }
/** Writes an index whose versions sit at noon of their day, each with its own (backdated) object. Specs run oldest first. */
async function seed(file: string, specs: Spec[], opts: { exists?: boolean; missingSince?: number } = {}) {
  if (opts.exists) fs.writeFileSync(file, 'x')
  const versions: V[] = []
  for (const [i, s] of specs.entries()) {
    const bytes = crypto.randomBytes(s.bytes ?? 100)
    const hash = await putObject(bytes, 'bin')
    age(objectPath(hash), 2 * DAY)
    const at = atDay(s.days, s.h ?? 0)
    versions.push({ n: i + 1, firstAt: at, at, hash, size: bytes.length, mtime: at, authors: [{ name: 'A', by: 'agent' }], summary: `v${i + 1}`, ...(s.name ? { name: s.name } : {}), ...(s.baseline ? { baseline: true } : {}) })
  }
  writeIndex(historyKey(file), { path: file, versions, ...(opts.missingSince !== undefined ? { missingSince: opts.missingSince } : {}) })
  return versions
}
const ns = (file: string) => readIndex(historyKey(file))!.versions.map(v => v.n)
const exists = (hash: string) => fs.existsSync(objectPath(hash))
const objSize = (hash: string) => fs.statSync(objectPath(hash)).size
const clean = (cap = BIG) => cleanupHistory(NOW, cap)
const writeLog = (key: string, events: { at: number; summary: string }[]) => {
  fs.mkdirSync(path.dirname(logPath(key)), { recursive: true })
  fs.writeFileSync(logPath(key), events.map(e => JSON.stringify({ type: 'comment', by: 'A', ...e })).join('\n') + '\n')
}
const logSummaries = (key: string) => fs.readFileSync(logPath(key), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).summary as string)

test('31 days old thins to one per day; 400 days old to one per month', async () => {
  reset()
  const f = fresh()
  const [a, b] = sameMonth(400)
  await seed(f, [{ days: 700 }, { days: a }, { days: b }, { days: 40 }, { days: 40, h: 1 }, { days: 39 }, { days: 20 }, { days: 0 }])
  const r = await clean()
  assert.deepEqual(ns(f), [1, 3, 5, 6, 7, 8])
  assert.equal(r.removedVersions, 2)
})

test('latest, under 7 days, baseline and named survive everything', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 500, baseline: true }, { days: 500, h: 1, name: 'keeper' }, { days: 500, h: 2 }, { days: 500, h: 3 }, { days: 3 }, { days: 3, h: 1 }, { days: 3, h: 2 }])
  await clean(1) // a cap nothing can meet
  assert.deepEqual(ns(f), [1, 2, 5, 6, 7])
})

test('over the cap the largest file is thinned first, and a smaller file that early thinning would have cut is left alone', async () => {
  reset()
  const big = fresh('big.bin')
  const small = fresh('small.bin')
  const bigSpecs: Spec[] = []
  for (const d of [25, 24, 23, 22, 21]) for (const hh of [0, 1, 2, 3]) bigSpecs.push({ days: d, h: hh, bytes: 1000 })
  await seed(big, [...bigSpecs, { days: 0, bytes: 1000 }])
  // small has same-day duplicates 8-25 days old: early thinning would remove 4 of them, so they survive only if big goes first and is enough
  await seed(small, [{ days: 25, bytes: 100 }, { days: 25, h: 1, bytes: 100 }, { days: 25, h: 2, bytes: 100 }, { days: 12, bytes: 100 }, { days: 12, h: 1, bytes: 100 }, { days: 12, h: 2, bytes: 100 }, { days: 0, bytes: 100 }])
  const r = await clean(8000) // big alone: ~21 KB -> ~6 KB after one per day
  assert.deepEqual(ns(small), [1, 2, 3, 4, 5, 6, 7], 'processing small first would thin it and fail here')
  assert.deepEqual(ns(big), [4, 8, 12, 16, 20, 21])
  assert.equal(r.overCapBytes, undefined)
})

test('early daily thinning is tried before anything else is removed', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 20, bytes: 1000 }, { days: 20, h: 1, bytes: 1000 }, { days: 20, h: 2, bytes: 1000 }, { days: 20, h: 3, bytes: 1000 }, { days: 0, bytes: 1000 }])
  const r = await clean(3000)
  assert.deepEqual(ns(f), [4, 5])
  assert.equal(r.overCapBytes, undefined)
})

test('beyond one per day, unprotected versions go one at a time, oldest first, only as many as needed', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 20 }, { days: 19 }, { days: 18 }, { days: 17 }, { days: 16 }, { days: 0 }].map(s => ({ ...s, bytes: 1000 })))
  const sz = vs.map(v => objSize(v.hash))
  const total = sz.reduce((a, b) => a + b, 0)
  const r = await clean(total - sz[0] - sz[1] - sz[2]) // exactly the three oldest have to go
  assert.deepEqual(ns(f), [4, 5, 6])
  assert.equal(r.overCapBytes, undefined)
})

test('protected versions alone over the cap: overCapBytes returned, nothing protected removed', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 100, bytes: 1000, name: 'a' }, { days: 100, h: 1, bytes: 1000, baseline: true }, { days: 100, h: 2, bytes: 1000 }, { days: 1, bytes: 1000 }])
  const r = await clean(500)
  assert.deepEqual(ns(f), [1, 2, 4])
  const left = readIndex(historyKey(f))!.versions.reduce((a, v) => a + objSize(v.hash), 0)
  assert.equal(r.overCapBytes, left - 500)
})

test('a file whose file has been missing 91 days loses all but named versions; an unreachable drive keeps everything', async () => {
  reset()
  const gone = fresh()
  const named = fresh()
  const nofolder = path.join(work, 'deleted-folder', 'x', 'doc.bin') // folder gone too, drive fine: can still expire
  const away = path.join(work, 'no-such-drive', 'doc.bin')
  const miss = NOW - 91 * DAY
  const g = await seed(gone, [{ days: 95 }, { days: 93 }], { missingSince: miss })
  const nm = await seed(named, [{ days: 95, name: 'final' }, { days: 93 }], { missingSince: miss })
  const nf = await seed(nofolder, [{ days: 95 }, { days: 93 }], { missingSince: miss })
  await seed(away, [{ days: 200 }, { days: 150 }, { days: 93 }], { missingSince: miss })
  ;(cleanupHooks as any).reachable = (file: string) => !file.includes('no-such-drive')
  for (const f of [gone, named]) writeLog(historyKey(f), [{ at: atDay(91), summary: 's' }])
  const r = await clean()
  assert.equal(fs.existsSync(indexPath(historyKey(gone))), false)
  assert.equal(fs.existsSync(logPath(historyKey(gone))), false)
  assert.equal(exists(g[0].hash) || exists(g[1].hash), false)
  assert.equal(fs.existsSync(indexPath(historyKey(nofolder))), false, 'a deleted folder expires too')
  assert.equal(exists(nf[0].hash), false)
  assert.deepEqual(ns(named), [1])
  assert.equal(fs.existsSync(logPath(historyKey(named))), true, 'named versions keep the log')
  assert.ok(exists(nm[0].hash))
  assert.equal(exists(nm[1].hash), false)
  assert.equal(ns(away).length, 3)
  assert.ok(r.freedBytes > 0 && r.removedVersions === 5)
})

test('an old file that was only just deleted keeps everything and starts its 90 days now', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 200, baseline: true }, { days: 190 }, { days: 150 }]) // last saved long ago, file absent since yesterday
  await clean()
  assert.deepEqual(ns(f), [1, 2, 3])
  assert.equal(readIndex(historyKey(f))!.missingSince, NOW)
  // a later run keeps the original date
  await cleanupHistory(NOW + 30 * DAY, BIG)
  assert.equal(readIndex(historyKey(f))!.missingSince, NOW)
  assert.deepEqual(ns(f), [1, 2, 3])
})

test('missing for under 90 days keeps everything; a file that came back clears the mark', async () => {
  reset()
  const young = fresh()
  const back = fresh()
  await seed(young, [{ days: 200 }, { days: 150 }], { missingSince: NOW - 60 * DAY })
  await seed(back, [{ days: 200 }, { days: 150 }], { exists: true, missingSince: NOW - 100 * DAY })
  await clean()
  assert.deepEqual(ns(young), [1, 2])
  assert.equal(readIndex(historyKey(young))!.missingSince, NOW - 60 * DAY)
  assert.deepEqual(ns(back), [1, 2])
  assert.equal(readIndex(historyKey(back))!.missingSince, undefined)
})

test('an object modified in the last 24 hours is never deleted even if no index uses it', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 0 }])
  const recent = await putObject(crypto.randomBytes(50), 'bin') // fresh mtime, unreferenced
  const old = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(old), 3 * DAY)
  await clean()
  assert.ok(exists(recent))
  assert.equal(exists(old), false)
})

test('an unreadable index makes the run skip and remove nothing', async () => {
  reset()
  const f = fresh()
  const g = fresh()
  const vs = await seed(f, [{ days: 100 }, { days: 100, h: 1 }, { days: 0 }])
  await seed(g, [{ days: 0 }])
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  fs.writeFileSync(indexPath(historyKey(g)), '{ not json')
  const r = await clean()
  assert.deepEqual(r, { removedVersions: 0, freedBytes: 0, skipped: 'corrupt-index' })
  assert.equal(ns(f).length, 3)
  assert.ok(exists(vs[0].hash) && exists(orphan))
  assert.ok(fs.existsSync(indexPath(historyKey(g))), 'not set aside either')
})

test('a listing of the files folder that fails deletes nothing', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 100 }, { days: 100, h: 1 }, { days: 0 }])
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  const real = fs.readdirSync
  for (const code of ['EPERM', 'EIO']) {
    ;(fs as any).readdirSync = (p: any, ...rest: any[]) => {
      if (String(p).endsWith(`${path.sep}files`)) throw Object.assign(new Error(code), { code })
      return (real as any)(p, ...rest)
    }
    try {
      const r = await clean()
      assert.equal(r.skipped, 'corrupt-index', code)
      assert.equal(r.removedVersions, 0)
    } finally {
      ;(fs as any).readdirSync = real
    }
    assert.ok(exists(vs[0].hash) && exists(vs[2].hash) && exists(orphan), code)
  }
})

test('a history moved while objects are being judged keeps its objects', async () => {
  reset()
  const a = fresh('a.bin')
  const b = fresh('b.bin')
  const vs = await seed(a, [{ days: 5 }, { days: 0 }], { exists: true })
  let scans = 0
  ;(cleanupHooks as any).afterList = () => {
    // the second listing has been taken: the move now writes the new index and removes the old one
    if (++scans !== 2) return
    const idx = readIndex(historyKey(a))!
    writeIndex(historyKey(b), { ...idx, path: b })
    for (const f of [indexPath(historyKey(a)), bakPath(historyKey(a))]) fs.rmSync(f, { force: true })
  }
  const r = await clean()
  assert.equal(scans, 2)
  assert.ok(vs.every(v => exists(v.hash)), 'objects the new index uses are still there')
  assert.equal(r.skipped, undefined)
})

test('a recent .corrupt-* set-aside blocks object deletion; old temp and aside files are swept', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 100 }, { days: 100, h: 1 }, { days: 0 }])
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  const dir = path.dirname(indexPath(historyKey(f)))
  const aside = path.join(dir, `${historyKey(f)}.json.corrupt-${NOW - 2 * DAY}`)
  fs.writeFileSync(aside, 'junk')
  const r = await clean()
  assert.equal(r.skipped, undefined)
  assert.equal(ns(f).length, 2, 'versions are still thinned')
  assert.ok(exists(orphan), 'orphan kept while a recent corrupt index exists')
  assert.ok(exists(vs[0].hash) || exists(vs[1].hash))
  const tmp = path.join(dir, `.${historyKey(f)}.json.1.0.abcd.tmp`)
  const stale = path.join(dir, `${historyKey(f)}.lock.stale-1-0-abcd`)
  const fresher = path.join(dir, '.other.json.1.0.abcd.tmp') // in flight: left alone
  for (const x of [tmp, stale, fresher]) fs.writeFileSync(x, 'x')
  age(tmp, 3 * DAY)
  age(stale, 3 * DAY)
  await cleanupHistory(NOW + 31 * DAY, BIG)
  assert.equal(fs.existsSync(aside), false)
  assert.equal(fs.existsSync(tmp), false)
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(fresher), true)
  assert.equal(exists(orphan), false)
})

test('a save landing between the scan and the rewrite is not lost', async () => {
  reset()
  const f = fresh('live.bin')
  await seed(f, [{ days: 100 }, { days: 100, h: 1 }, { days: 50 }], { exists: true })
  const before = listVersions(f).length
  cleanupHooks.afterScan = async () => {
    cleanupHooks.afterScan = undefined
    const bytes = crypto.randomBytes(80)
    await guardedWrite(f, { authors: [{ name: 'B', by: 'agent' }] }, async () => (await writeAtomic(f, bytes), bytes))
    await flushHistory()
  }
  await clean()
  const vs = listVersions(f)
  assert.ok(vs.some(v => v.authors[0].name === 'B'), 'the concurrent save survived')
  assert.ok(vs.length > before - 1)
  assert.ok(exists(vs.at(-1)!.hash))
})

test('thinned objects are really freed: the .bak does not keep them alive', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 100 }, { days: 100, h: 1 }, { days: 0 }])
  await clean()
  assert.equal(exists(vs[0].hash), false)
  assert.ok(exists(vs[1].hash))
  assert.equal(JSON.parse(fs.readFileSync(bakPath(historyKey(f)), 'utf8')).versions.length, 2)
})

test('log events follow the same age rules', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 0 }], { exists: true })
  const [a, b] = sameMonth(400)
  writeLog(historyKey(f), [
    { at: atDay(a), summary: 'a' },
    { at: atDay(b), summary: 'b' },
    { at: atDay(40), summary: 'c' },
    { at: atDay(40, 1), summary: 'd' },
    { at: atDay(20), summary: 'e' },
    { at: atDay(20, 1), summary: 'f' },
  ])
  await clean()
  assert.deepEqual(readLog(f).map(e => e.summary).sort(), ['b', 'd', 'e', 'f'])
})

test('orphan logs are thinned by age, and removed once their newest event is 90 days old and no index remains', async () => {
  reset()
  const key = () => crypto.randomBytes(32).toString('hex')
  const dead = key()
  const live = key()
  const bakOnly = key()
  writeLog(dead, [{ at: atDay(200), summary: 'x' }, { at: atDay(100), summary: 'y' }])
  writeLog(live, [{ at: atDay(40), summary: 'a' }, { at: atDay(40, 1), summary: 'b' }, { at: atDay(10), summary: 'c' }])
  writeLog(bakOnly, [{ at: atDay(100), summary: 'p' }, { at: atDay(100, 1), summary: 'q' }])
  // a key with only a .bak
  const f = fresh()
  await seed(f, [{ days: 0 }])
  fs.renameSync(indexPath(historyKey(f)), bakPath(bakOnly))
  fs.writeFileSync(bakPath(bakOnly), JSON.stringify({ path: f, versions: [] }))
  const r = await clean()
  assert.equal(r.skipped, undefined)
  assert.equal(fs.existsSync(logPath(dead)), false, 'no index, newest event over 90 days')
  assert.deepEqual(logSummaries(live), ['b', 'c'], 'no index but recent: kept and thinned')
  assert.deepEqual(logSummaries(bakOnly), ['q'], 'a .bak remains: thinned, never deleted')
})

test('a stale missingSince (a version was saved after it) never wipes recent versions', async () => {
  reset()
  const f = fresh()
  const mark = NOW - 100 * DAY
  // the file came back and was saved after the mark; it is absent again at this run
  await seed(f, [{ days: 150 }, { days: 120 }, { days: 50 }, { days: 1 }, { days: 0 }], { missingSince: mark })
  await clean()
  assert.deepEqual(ns(f), [1, 2, 3, 4, 5])
  assert.equal(readIndex(historyKey(f))!.missingSince, NOW)
})

test('an index that vanishes after the listing makes the run keep every object, even when its .bak is still there', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 5 }, { days: 0 }], { exists: true })
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  // a .bak that lacks the latest version
  fs.writeFileSync(bakPath(historyKey(f)), JSON.stringify({ path: f, versions: [{ ...vs[0] }] }))
  let scans = 0
  ;(cleanupHooks as any).afterList = () => {
    if (++scans === 2) fs.rmSync(indexPath(historyKey(f)), { force: true })
  }
  await clean()
  assert.equal(scans, 2)
  assert.ok(exists(vs[0].hash) && exists(vs[1].hash) && exists(orphan), 'no object deleted this run')
})

test('a key with only a .bak does not block object deletion', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 5 }, { days: 0 }], { exists: true })
  fs.renameSync(indexPath(historyKey(f)), bakPath(historyKey(f))) // index set aside; only the .bak is left
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  const r = await clean()
  assert.equal(r.skipped, undefined)
  assert.ok(exists(vs[0].hash) && exists(vs[1].hash), 'the .bak keeps its objects')
  assert.equal(exists(orphan), false)
})
