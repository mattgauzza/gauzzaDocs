import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const home = process.env.GAUZZADOCS_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'gd-hist-home-'))
process.env.GAUZZADOCS_HOME = home
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const LOCK_FILE = path.join(home, 'Shared.md')

const s = await import('../src/core/history/store')
const { putObject, getObject, objectPath, indexPath, readIndex, writeIndex, withLock, writeAtomic, isExcluded, historyKey, listHistoryPaths, lockHooks } = s
const filesDir = path.dirname(indexPath('x'))

const ver = (n: number) => ({ n, firstAt: n, at: n, hash: 'h', size: 1, mtime: 1, authors: [], summary: '' })
async function appendMany(key: string, count: number) {
  for (let i = 0; i < count; i++) {
    await withLock(key, async () => {
      const idx = readIndex(key) ?? { path: LOCK_FILE, versions: [] }
      const n = (idx.versions[idx.versions.length - 1]?.n ?? 0) + 1
      await new Promise(r => setTimeout(r, 2))
      idx.versions.push(ver(n))
      writeIndex(key, idx)
    })
  }
}

if (process.env.HISTORY_CHILD) {
  await appendMany(historyKey(LOCK_FILE), 20)
  process.exit(0)
}

test('objects: stored once by hash, verified on read', async () => {
  const h = await putObject(Buffer.from('hello'), 'md')
  assert.equal(h, sha256('hello'))
  assert.deepEqual(Buffer.from((await getObject(h))!), Buffer.from('hello'))
  assert.equal(await putObject(Buffer.from('hello'), 'md'), h)
  const bin = await putObject(Buffer.from('PK-not-really'), 'docx')
  assert.deepEqual(fs.readFileSync(objectPath(bin)), Buffer.from('PK-not-really')) // stored as is
  fs.writeFileSync(objectPath(h), 'garbage') // corrupted object
  assert.equal(await getObject(h), null)
  assert.equal(await getObject(sha256('missing')), null)
  assert.equal(await putObject(Buffer.from('hello'), 'md'), h) // saved again: the bad object is rewritten
  assert.deepEqual(Buffer.from((await getObject(h))!), Buffer.from('hello'))
})

test('index: writeIndex straight onto a corrupt index sets it aside', () => {
  const k = 'c'.repeat(64)
  fs.mkdirSync(filesDir, { recursive: true })
  fs.writeFileSync(indexPath(k), '{ broken')
  writeIndex(k, { path: 'C:/c.md', versions: [ver(1)] })
  const aside = fs.readdirSync(filesDir).filter(f => f.startsWith(`${k}.json.corrupt-`))
  assert.equal(aside.length, 1)
  assert.equal(fs.readFileSync(path.join(filesDir, aside[0]), 'utf8'), '{ broken')
  assert.equal(readIndex(k)!.versions.length, 1)
})

test('index: a read error other than "missing" throws instead of falling back', () => {
  const k = 'd'.repeat(64)
  writeIndex(k, { path: 'C:/d.md', versions: [ver(1)] })
  writeIndex(k, { path: 'C:/d.md', versions: [ver(1), ver(2)] }) // .bak exists
  const real = fs.readFileSync
  fs.readFileSync = ((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(f) === indexPath(k)) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return (real as (...a: unknown[]) => unknown)(f, ...rest)
  }) as typeof fs.readFileSync
  try {
    assert.throws(() => readIndex(k), /busy/)
  } finally {
    fs.readFileSync = real
  }
  assert.equal(readIndex(k)!.versions.length, 2)
})

test('locks: the timestamp is taken when the lock is acquired, not when waiting began', async () => {
  const lock = path.join(filesDir, 'stamp.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), id: 'other' }))
  setTimeout(() => fs.rmSync(lock, { force: true }), 300)
  const began = Date.now()
  let at = 0
  await withLock('stamp', async () => {
    at = JSON.parse(fs.readFileSync(lock, 'utf8')).at
  })
  assert.ok(at >= began + 250, `lock stamped ${at - began} ms after waiting began`)
})

test('index: .bak kept; a corrupt index is set aside, never overwritten', () => {
  const k = 'a'.repeat(64)
  const idx1 = { path: 'C:/a.md', versions: [ver(1)] }
  const idx2 = { path: 'C:/a.md', versions: [ver(1), ver(2)] }
  writeIndex(k, idx1)
  writeIndex(k, idx2)
  assert.deepEqual(readIndex(k), idx2)
  fs.writeFileSync(indexPath(k), '{ broken')
  assert.deepEqual(readIndex(k), idx1) // falls back to .bak
  assert.ok(fs.readdirSync(filesDir).some(f => f.startsWith(`${k}.json.corrupt-`)))
  assert.ok(listHistoryPaths().includes('C:/a.md'))
})

test('locks: two processes recording at once lose nothing', async () => {
  const k = historyKey(LOCK_FILE)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, HISTORY_CHILD: '1', GAUZZADOCS_HOME: home },
    stdio: 'inherit'
  })
  const exited = new Promise<number | null>(r => child.on('exit', r))
  await appendMany(k, 20)
  assert.equal(await exited, 0)
  const ns = readIndex(k)!.versions.map(v => v.n)
  assert.equal(ns.length, 40)
  assert.deepEqual([...ns].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1))
  assert.equal(new Set(ns).size, 40)
})

test('locks: EPERM or EBUSY creating the lock file counts as busy, like EEXIST (an antivirus or indexer holds it)', async () => {
  fs.mkdirSync(filesDir, { recursive: true })
  const lock = path.join(filesDir, 'av.lock')
  const real = fs.openSync
  let calls = 0
  let failWith: string[] = ['EPERM', 'EBUSY']
  fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p) === lock) {
      calls++
      const code = failWith.length ? failWith.shift() : null
      if (code) throw Object.assign(new Error(`${code}: held`), { code })
    }
    return (real as (...a: unknown[]) => number)(p, ...rest)
  }) as typeof fs.openSync
  try {
    assert.equal(await withLock('av', async () => 'ok'), 'ok')
    assert.equal(calls, 3)
    assert.ok(!fs.existsSync(lock))
    // Nothing but EPERM for over a second is a real permission problem, not a passing hold: it is thrown.
    failWith = Array.from({ length: 1000 }, () => 'EPERM')
    const t0 = Date.now()
    await assert.rejects(withLock('av', async () => 'never'), (e: NodeJS.ErrnoException) => e.code === 'EPERM')
    const waited = Date.now() - t0
    assert.ok(waited >= 1000 && waited < 5000, `gave up after ${waited} ms`)
  } finally {
    fs.openSync = real
  }
})

test('locks: a stale lock (dead pid or older than 30 s) is taken over', async () => {
  fs.mkdirSync(filesDir, { recursive: true })
  const lock = path.join(filesDir, 'dead.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() }))
  assert.equal(await withLock('dead', async () => 'ok'), 'ok')
  const old = path.join(filesDir, 'old.lock')
  fs.writeFileSync(old, JSON.stringify({ pid: process.pid, at: Date.now() - 31_000 }))
  assert.equal(await withLock('old', async () => 'ok'), 'ok')
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(old))
})

test('locks: a fresh lock appearing during takeover is never stolen', async () => {
  const lock = path.join(filesDir, 'race.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() })) // stale
  let otherHolds = false
  let overlapped = false
  lockHooks.beforeTakeover = () => {
    lockHooks.beforeTakeover = undefined
    // the other acquirer took over the stale lock and made a fresh one just before our rename
    fs.rmSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), id: 'other' }))
    otherHolds = true
    setTimeout(() => {
      otherHolds = false
      fs.rmSync(lock, { force: true })
    }, 300)
  }
  await withLock('race', async () => {
    overlapped = otherHolds
  })
  assert.equal(overlapped, false)
  assert.ok(!fs.existsSync(lock))
  assert.deepEqual(fs.readdirSync(filesDir).filter(f => f.startsWith('race.lock.')), [])
})

test('storeObject says whether it created the object; reusing one refreshes its mtime', async () => {
  const bytes = crypto.randomBytes(100)
  const first = await s.storeObject(bytes, 'bin')
  assert.equal(first.created, true)
  assert.equal(first.mtime, fs.statSync(objectPath(first.hash)).mtimeMs)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(objectPath(first.hash), old, old)
  const again = await s.storeObject(bytes, 'bin')
  assert.equal(again.created, false)
  assert.ok(again.mtime > old.getTime() + 30_000, 'reuse refreshed the mtime')
  fs.writeFileSync(objectPath(first.hash), 'damaged')
  const fixed = await s.storeObject(bytes, 'bin')
  assert.equal(fixed.created, false, 'rewriting a damaged object is not creating it: a history may already use it')
  assert.deepEqual(Buffer.from((await getObject(first.hash))!), bytes)
  assert.deepEqual(fs.readdirSync(path.dirname(objectPath(first.hash))).filter(n => n.endsWith('.tmp')), [])
})

test('an index for another path is refused', () => {
  const k = 'b'.repeat(64)
  writeIndex(k, { path: 'C:/a.md', versions: [] })
  assert.equal(readIndex(k, 'C:/b.md'), null)
  assert.ok(process.platform !== 'win32' || readIndex(k, 'c:/A.md'))
})

test('writeAtomic retries a rename that fails with EPERM or EBUSY', async () => {
  const target = path.join(home, 'atomic.txt')
  const real = fs.promises.rename
  let calls = 0
  fs.promises.rename = (async (a: fs.PathLike, b: fs.PathLike) => {
    if (++calls <= 2) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' })
    return real(a, b)
  }) as typeof fs.promises.rename
  try {
    const r = await writeAtomic(target, Buffer.from('data'))
    assert.equal(r.size, 4)
  } finally {
    fs.promises.rename = real
  }
  assert.equal(calls, 3)
  assert.equal(fs.readFileSync(target, 'utf8'), 'data')
  assert.deepEqual(fs.readdirSync(home).filter(f => f.endsWith('.tmp')), [])
})

test('exclusions: secrets are not versioned', () => {
  for (const f of ['.env', 'app/.env.local', 'k.pem', 'id_rsa', 'C:/Users/m/.ssh/config', 'x/.aws/credentials']) assert.ok(isExcluded(f), f)
  for (const f of ['plan.md', 'env.md', 'keynote.pptx']) assert.ok(!isExcluded(f), f)
})

test('identity: one history for one file however it is written', { skip: process.platform !== 'win32' }, () => {
  assert.equal(historyKey('C:\\Docs\\Plan.md'), historyKey('c:/docs/plan.md'))
})

test('volumeRoot finds the drive, share or mounted volume of a file', () => {
  const { volumeRoot } = s
  assert.equal(volumeRoot('/Volumes/X/a/b.docx', 'darwin'), '/Volumes/X')
  assert.equal(volumeRoot('/media/u/X/a.txt', 'linux'), '/media/u/X')
  assert.equal(volumeRoot('/run/media/u/X/a.txt', 'linux'), '/run/media/u/X')
  assert.equal(volumeRoot('/mnt/x/a.txt', 'linux'), '/mnt/x')
  assert.equal(volumeRoot('/home/u/a.txt', 'linux'), '/')
  assert.equal(volumeRoot('/home/u/a.txt', 'darwin'), '/')
  assert.equal(volumeRoot('C:\\a\\b.txt', 'win32'), 'C:\\')
  assert.equal(volumeRoot('\\\\server\\share\\a.txt', 'win32'), '\\\\server\\share\\')
})

test('volumeReachable: off Windows a volume folder counts only when something is mounted on it', () => {
  const { volumeReachable } = s
  const devs: Record<string, number> = { '/': 1, '/mnt': 1, '/mnt/plain': 1, '/mnt/disk': 2, '/media/u': 1, '/media/u/usb': 3 }
  const stat = (p: string) => {
    if (!(p in devs)) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    return { dev: devs[p] }
  }
  assert.equal(volumeReachable('/mnt/disk/a.txt', 'linux', stat), true)
  assert.equal(volumeReachable('/media/u/usb/a.txt', 'linux', stat), true)
  assert.equal(volumeReachable('/mnt/plain/a.txt', 'linux', stat), false, 'a leftover empty folder')
  assert.equal(volumeReachable('/mnt/gone/a.txt', 'linux', stat), false, 'not even a folder')
  assert.equal(volumeReachable('/home/u/a.txt', 'linux', stat), true)
  assert.equal(volumeReachable('C:\\a.txt', 'win32', () => ({ dev: 1 })), true)
  assert.equal(volumeReachable('Q:\\a.txt', 'win32', () => { throw new Error('no drive') }), false)
})
