import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load. No size override: these files are 1 MB.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-fold-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-fold-work-'))

const h = await import('../src/core/history/index')
const { guardedWrite, listVersions, flushHistory, writeAtomic, objectPath, showVersion, HISTORY_DIR } = h

after(() => {
  for (const d of [work, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const agent = (name: string) => ({ authors: [{ name, by: 'agent' as const }] })
const matt = { authors: [{ name: 'Matt', by: 'person' as const }] }
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const save = async (f: string, bytes: Uint8Array, ctx: { authors: { name: string; by: 'person' | 'agent' | 'outside' }[] }) => {
  await guardedWrite(f, ctx, async () => (await writeAtomic(f, bytes), bytes))
  await flushHistory()
}
let seq = 0
const fresh = (name: string) => {
  const p = path.join(work, `${++seq}`, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}
const objects = (): string[] => {
  const dir = path.join(HISTORY_DIR, 'objects')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).flatMap(d => fs.readdirSync(path.join(dir, d)).filter(n => /^[0-9a-f]{64}$/.test(n)))
}
const MB = 1024 * 1024

test('20 folded saves of a 1 MB file leave 1 or 2 objects, not 20', async () => {
  const f = fresh('big.docx') // stored as it is, so each object is the full 1 MB
  const before = new Set(objects())
  let last = new Uint8Array()
  for (let i = 0; i < 20; i++) await save(f, (last = crypto.randomBytes(MB)), matt)
  const v = listVersions(f)
  assert.equal(v.length, 1, 'all 20 saves folded into one version')
  const mine = objects().filter(o => !before.has(o))
  assert.ok(mine.length >= 1 && mine.length <= 2, `${mine.length} objects left`)
  assert.ok(mine.includes(v[0].hash))
  assert.deepEqual(Buffer.from(await showVersion(f, 1)), Buffer.from(last))
  // The .bak never points at a deleted object either.
  const bak = JSON.parse(fs.readFileSync(`${h.indexPath(h.historyKey(f))}.bak`, 'utf8')) as { versions: { hash: string }[] }
  for (const x of bak.versions) assert.ok(fs.existsSync(objectPath(x.hash)), 'every object the .bak names is there')
})

/** Every version in every index (and .bak) whose object is missing. */
const missingObjects = (): string[] => {
  const gone: string[] = []
  for (const e of h.listHistoryEntries()) {
    for (const p of [h.indexPath(e.key), h.bakPath(e.key)]) {
      if (!fs.existsSync(p)) continue
      for (const v of (JSON.parse(fs.readFileSync(p, 'utf8')) as { versions: { n: number; hash: string }[] }).versions)
        if (!fs.existsSync(objectPath(v.hash))) gone.push(`${e.path} v${v.n}`)
    }
  }
  return gone
}

test('identical new content saved to two files at once, then a fold of the first, never loses an object (50 runs)', async () => {
  const t0 = Date.now()
  const write = (f: string, bytes: Uint8Array) => async () => (await writeAtomic(f, bytes), bytes)
  let lost = 0
  for (let i = 0; i < 50; i++) {
    const a = fresh('race-a.docx')
    const b = fresh('race-b.docx')
    const shared = crypto.randomBytes(1000) // brand new: neither file can reuse an object that was there before
    await Promise.all([guardedWrite(a, matt, write(a, shared)), guardedWrite(b, matt, write(b, shared))])
    await flushHistory()
    await save(a, crypto.randomBytes(1000), matt) // folds into a's v1, replacing the shared object
    assert.equal(listVersions(a).length, 1)
    assert.equal(listVersions(b)[0].hash, sha(shared))
    if (!fs.existsSync(objectPath(sha(shared)))) lost++
  }
  assert.equal(lost, 0, `${lost} of 50 runs lost b's object`)
  assert.deepEqual(missingObjects(), [], 'every version in every index has its object')
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`)
})

test("an object shared with another file's index is never deleted by a fold", async () => {
  const shared = crypto.randomBytes(1000)
  const b = fresh('b.docx')
  await save(b, shared, matt) // b's history uses it
  const a = fresh('a.docx')
  await save(a, shared, agent('Claude')) // a stores the same object (reused)
  await save(a, crypto.randomBytes(1000), agent('Claude')) // folds: a no longer uses it
  assert.equal(listVersions(a).length, 1)
  assert.ok(fs.existsSync(objectPath(sha(shared))), 'still used by b')
  assert.deepEqual(Buffer.from(await showVersion(b, 1)), shared)
})

test('a fold keeps an object touched since this file wrote it, or used by an earlier version of the same file', async () => {
  // Touched since: another file reused it and has not written its index yet.
  const a = fresh('touched.docx')
  const first = crypto.randomBytes(1000)
  await save(a, first, matt)
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(objectPath(sha(first)), later, later)
  await save(a, crypto.randomBytes(1000), matt)
  assert.equal(listVersions(a).length, 1)
  assert.ok(fs.existsSync(objectPath(sha(first))), 'someone touched it since: left for cleanup')

  // Earlier version of the same file with the same content.
  const c = fresh('same.docx')
  const x = crypto.randomBytes(1000)
  await save(c, x, matt) // v1 (Matt)
  await save(c, crypto.randomBytes(1000), agent('Claude')) // v2 (Claude)
  await save(c, x, agent('Claude')) // folds into v2: back to v1's content
  await save(c, crypto.randomBytes(1000), agent('Claude')) // folds again: v2 no longer uses x, but v1 does
  assert.deepEqual(listVersions(c).map(v => v.n), [1, 2])
  assert.deepEqual(Buffer.from(await showVersion(c, 1)), x)
})
