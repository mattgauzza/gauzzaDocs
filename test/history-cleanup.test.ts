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
const BIG = 1e12
type V = import('../src/core/history/index').HistoryVersion
let seq = 0
const reset = () => {
  fs.rmSync(HISTORY_DIR, { recursive: true, force: true })
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
interface Spec { days: number; bytes?: number; name?: string; baseline?: boolean; hoursApart?: number }
/** Writes an index whose versions are `days` old, each with its own (backdated) object. */
async function seed(file: string, specs: Spec[], opts: { exists?: boolean } = {}) {
  if (opts.exists) fs.writeFileSync(file, 'x')
  const versions: V[] = []
  for (const [i, s] of specs.entries()) {
    const bytes = crypto.randomBytes(s.bytes ?? 100)
    const hash = await putObject(bytes, 'bin')
    age(objectPath(hash), 2 * DAY)
    const at = Date.now() - s.days * DAY - (s.hoursApart ?? 0) * 3600_000
    versions.push({ n: i + 1, firstAt: at, at, hash, size: bytes.length, mtime: at, authors: [{ name: 'A', by: 'agent' }], summary: `v${i + 1}`, ...(s.name ? { name: s.name } : {}), ...(s.baseline ? { baseline: true } : {}) })
  }
  writeIndex(historyKey(file), { path: file, versions })
  return versions
}
const ns = (file: string) => readIndex(historyKey(file))!.versions.map(v => v.n)
const exists = (hash: string) => fs.existsSync(objectPath(hash))

test('31 days old thins to one per day; 400 days old to one per month', async () => {
  reset()
  const f = fresh()
  // v1..v3 on one day at 400 days (same month), v4..v6 same month a bit later; v7,v8 on one day at 40 days; v9 latest
  await seed(f, [
    { days: 400, hoursApart: 0 },
    { days: 400, hoursApart: -1 },
    { days: 400, hoursApart: -2 },
    { days: 380 },
    { days: 40, hoursApart: 0 },
    { days: 40, hoursApart: -1 },
    { days: 39 },
    { days: 20 },
    { days: 0 },
  ])
  const r = await cleanupHistory(Date.now(), BIG)
  assert.ok(r.removedVersions > 0)
  const kept = ns(f)
  assert.ok(kept.includes(9) && kept.includes(8), 'recent ones stay')
  assert.equal(kept.filter(n => n === 5 || n === 6).length, 1, 'one per day at 40 days')
  assert.ok(kept.includes(7), 'a different day stays')
  assert.equal(kept.filter(n => n <= 3).length, 1, 'one per month at 400 days')
  assert.ok(kept.includes(6) || kept.includes(5))
})

test('latest, under 7 days, baseline and named survive everything', async () => {
  reset()
  const f = fresh()
  await seed(f, [
    { days: 500, baseline: true },
    { days: 500, name: 'keeper' },
    { days: 500 },
    { days: 500 },
    { days: 3 },
    { days: 3 },
    { days: 3 },
  ])
  await cleanupHistory(Date.now(), 1) // a cap nothing can meet
  const kept = ns(f)
  assert.deepEqual(kept, [1, 2, 5, 6, 7])
})

test('over the cap: the largest file is thinned first and another file recent week is untouched', async () => {
  reset()
  const big = fresh('big.bin')
  const small = fresh('small.bin')
  // big: 10 old versions on 10 distinct days (all kept by normal rules, within 30 days) of 1000 bytes each
  await seed(big, Array.from({ length: 10 }, (_, i) => ({ days: 25 - i, bytes: 1000 })).concat([{ days: 0, bytes: 1000 }]))
  const bigBefore = ns(big).length
  // small: a day-old pair
  await seed(small, [{ days: 2, bytes: 100 }, { days: 1, bytes: 100 }, { days: 0, bytes: 100 }])
  // 11 * 1000 + 300 = 11300 bytes on disk. Early daily thinning cannot remove anything here (one per day already), so
  // protected-only is what gets under the cap. Cap leaves room for big's protected + small.
  const r = await cleanupHistory(Date.now(), 6000)
  assert.deepEqual(ns(small), [1, 2, 3], 'the small file recent week is untouched')
  assert.ok(ns(big).length < bigBefore)
  assert.ok(ns(big).includes(11), 'latest stays')
  assert.equal(r.overCapBytes, undefined)
})

test('early daily thinning is tried before protected-only', async () => {
  reset()
  const f = fresh()
  // 5 versions on the same day 20 days ago (all kept by normal rules), 1 latest
  await seed(f, [{ days: 20, bytes: 1000, hoursApart: 0 }, { days: 20, bytes: 1000, hoursApart: -1 }, { days: 20, bytes: 1000, hoursApart: -2 }, { days: 20, bytes: 1000, hoursApart: -3 }, { days: 0, bytes: 1000 }])
  const r = await cleanupHistory(Date.now(), 3000)
  assert.deepEqual(ns(f), [4, 5]) // one for that day, plus the latest
  assert.equal(r.overCapBytes, undefined)
})

test('protected versions alone over the cap: overCapBytes returned, nothing protected removed', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 100, bytes: 1000, name: 'a' }, { days: 100, bytes: 1000, baseline: true }, { days: 100, bytes: 1000 }, { days: 1, bytes: 1000 }])
  const r = await cleanupHistory(Date.now(), 500)
  assert.deepEqual(ns(f), [1, 2, 4])
  const left = readIndex(historyKey(f))!.versions.reduce((a, v) => a + fs.statSync(objectPath(v.hash)).size, 0)
  assert.equal(r.overCapBytes, left - 500)
})

test('a file gone 91 days keeps only named versions; one on a missing drive keeps everything', async () => {
  reset()
  const gone = fresh()
  const named = fresh()
  const away = path.join(work, 'no-such-drive', 'x', 'doc.bin')
  const g = await seed(gone, [{ days: 95 }, { days: 91 }])
  const nm = await seed(named, [{ days: 95, name: 'final' }, { days: 91 }])
  await seed(away, [{ days: 200 }, { days: 150 }, { days: 91 }])
  fs.writeFileSync(logPath(historyKey(gone)), JSON.stringify({ at: Date.now() - 91 * DAY, type: 'save', by: 'A', summary: 's' }) + '\n')
  fs.writeFileSync(logPath(historyKey(named)), JSON.stringify({ at: Date.now() - 91 * DAY, type: 'save', by: 'A', summary: 's' }) + '\n')
  const r = await cleanupHistory(Date.now(), BIG)
  assert.equal(fs.existsSync(indexPath(historyKey(gone))), false)
  assert.equal(fs.existsSync(logPath(historyKey(gone))), false)
  assert.equal(exists(g[0].hash) || exists(g[1].hash), false)
  assert.deepEqual(ns(named), [1])
  assert.equal(fs.existsSync(logPath(historyKey(named))), true, 'named versions keep the log')
  assert.ok(exists(nm[0].hash))
  assert.equal(exists(nm[1].hash), false)
  assert.equal(ns(away).length, 3)
  assert.ok(r.freedBytes > 0 && r.removedVersions >= 3)
})

test('a file that is still there is not gone', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 200 }, { days: 150 }], { exists: true })
  await cleanupHistory(Date.now(), BIG)
  assert.ok(ns(f).includes(2))
})

test('an object modified in the last 24 hours is never deleted even if no index uses it', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 0 }])
  const recent = await putObject(crypto.randomBytes(50), 'bin') // fresh mtime, unreferenced
  const old = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(old), 3 * DAY)
  await cleanupHistory(Date.now(), BIG)
  assert.ok(exists(recent))
  assert.equal(exists(old), false)
})

test('an unreadable index makes the run skip and remove nothing', async () => {
  reset()
  const f = fresh()
  const g = fresh()
  const vs = await seed(f, [{ days: 100 }, { days: 100 }, { days: 0 }])
  await seed(g, [{ days: 0 }])
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  fs.writeFileSync(indexPath(historyKey(g)), '{ not json')
  const r = await cleanupHistory(Date.now(), BIG)
  assert.deepEqual(r, { removedVersions: 0, freedBytes: 0, skipped: 'corrupt-index' })
  assert.equal(ns(f).length, 3)
  assert.ok(exists(vs[0].hash) && exists(orphan))
  assert.ok(fs.existsSync(indexPath(historyKey(g))), 'not set aside either')
})

test('a recent .corrupt-* set-aside blocks object deletion; old temp and aside files are swept', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 100, hoursApart: 0 }, { days: 100, hoursApart: -1 }, { days: 0 }])
  const orphan = await putObject(crypto.randomBytes(50), 'bin')
  age(objectPath(orphan), 3 * DAY)
  const dir = path.dirname(indexPath(historyKey(f)))
  const aside = path.join(dir, `${historyKey(f)}.json.corrupt-${Date.now() - 2 * DAY}`)
  fs.writeFileSync(aside, 'junk')
  const r = await cleanupHistory(Date.now(), BIG)
  assert.equal(r.skipped, undefined)
  assert.equal(ns(f).length, 2, 'versions are still thinned')
  assert.ok(exists(orphan), 'orphan kept while a recent corrupt index exists')
  assert.ok(exists(vs[0].hash) || exists(vs[1].hash))
  // 31 days later the aside is old: swept, and objects can go
  const later = Date.now() + 31 * DAY
  const tmp = path.join(dir, `.${historyKey(f)}.json.1.0.abcd.tmp`)
  const stale = path.join(dir, `${historyKey(f)}.lock.stale-1-0-abcd`)
  fs.writeFileSync(tmp, 'x')
  fs.writeFileSync(stale, 'x')
  age(tmp, 3 * DAY)
  age(stale, 3 * DAY)
  const fresher = path.join(dir, `.other.json.1.0.abcd.tmp`)
  fs.writeFileSync(fresher, 'x') // in flight: left alone
  const t = new Date(later)
  fs.utimesSync(fresher, t, t)
  await cleanupHistory(later, BIG)
  assert.equal(fs.existsSync(aside), false)
  assert.equal(fs.existsSync(tmp), false)
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(fresher), true)
  assert.equal(exists(orphan), false)
})

test('a save landing between the scan and the rewrite is not lost', async () => {
  reset()
  const f = fresh('live.bin')
  fs.writeFileSync(f, 'start')
  await seed(f, [{ days: 100, hoursApart: 0 }, { days: 100, hoursApart: -1 }, { days: 50 }], { exists: true })
  const before = listVersions(f).length
  cleanupHooks.afterScan = async () => {
    cleanupHooks.afterScan = undefined
    const bytes = crypto.randomBytes(80)
    await guardedWrite(f, { authors: [{ name: 'B', by: 'agent' }] }, async () => (await writeAtomic(f, bytes), bytes))
    await flushHistory()
  }
  await cleanupHistory(Date.now(), BIG)
  const vs = listVersions(f)
  assert.ok(vs.length >= 3)
  assert.ok(vs.some(v => v.authors[0].name === 'B'), 'the concurrent save survived')
  assert.ok(vs.length > before - 1)
  assert.ok(exists(vs.at(-1)!.hash))
})

test('thinned objects are really freed: the .bak does not keep them alive', async () => {
  reset()
  const f = fresh()
  const vs = await seed(f, [{ days: 100, hoursApart: 0 }, { days: 100, hoursApart: -1 }, { days: 0 }])
  await cleanupHistory(Date.now(), BIG)
  assert.equal(exists(vs[0].hash), false)
  assert.ok(exists(vs[1].hash))
  const bak = JSON.parse(fs.readFileSync(bakPath(historyKey(f)), 'utf8'))
  assert.equal(bak.versions.length, 2)
})

test('log events follow the same age rules', async () => {
  reset()
  const f = fresh()
  await seed(f, [{ days: 0 }], { exists: true })
  const ev = (days: number, hrs: number, summary: string) => ({ at: Date.now() - days * DAY - hrs * 3600_000, type: 'comment', by: 'A', summary })
  const lines = [ev(400, 0, 'a'), ev(399, 0, 'b'), ev(40, 2, 'c'), ev(40, 1, 'd'), ev(20, 1, 'e'), ev(20, 0, 'f')]
  fs.writeFileSync(logPath(historyKey(f)), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  await cleanupHistory(Date.now(), BIG)
  const summaries = readLog(f).map(e => e.summary).sort()
  assert.deepEqual(summaries, ['b', 'd', 'e', 'f'])
})
