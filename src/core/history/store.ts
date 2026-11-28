import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { threadId } from 'node:worker_threads'
import type { Author, HistoryIndex, HistoryVersion } from '../../shared/types'
import { DEFAULT_EXCLUDE as DEFAULT_EXCLUDE_LIST, HOME, getSettings, samePath } from '../paths'

export type { Author, HistoryIndex, HistoryVersion }

/** Version history lives only here, never next to the user's files. */
export const HISTORY_DIR = path.join(HOME, 'history')
const OBJECTS_DIR = path.join(HISTORY_DIR, 'objects')
const FILES_DIR = path.join(HISTORY_DIR, 'files')

export const DEFAULT_EXCLUDE: string[] = DEFAULT_EXCLUDE_LIST
const EXCLUDED_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure'])
/** Already compressed formats are stored as they are. */
const STORED_AS_IS = new Set(['docx', 'xlsx', 'pptx', 'gdesign', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip'])

const LOCK_RETRY_MS = 50
const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000
const RENAME_RETRY_MS = 1_000

const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const tmpName = (target: string) =>
  path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${threadId}.${crypto.randomBytes(4).toString('hex')}.tmp`)
const isBusy = (e: unknown) => ['EPERM', 'EBUSY'].includes((e as NodeJS.ErrnoException)?.code ?? '')

/**
 * The path a file's history belongs to: its real path, in the case it has on disk. This is what an index stores and
 * what people see. The history key lowercases it on Windows (see historyKey), so `C:\Docs\Plan.md` and
 * `c:/docs/plan.md` share one history. Indexes written before this kept the lowercased path: readers compare paths
 * with samePath, and the next recorded version rewrites it in its real case.
 */
export function canonicalPath(file: string): string {
  const abs = path.resolve(file)
  let real = abs
  try {
    real = fs.realpathSync.native(abs)
  } catch {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)) // file gone, folder still there
    } catch {
      /* keep the resolved path */
    }
  }
  return real
}
/**
 * The drive, share or mounted volume a file lives on: the thing that has to be reachable before "the file is not
 * there" means anything. A disconnected drive makes the whole volume root vanish.
 */
export function volumeRoot(file: string, platform: string = process.platform): string {
  if (platform === 'win32') return path.win32.parse(file).root
  const m =
    platform === 'darwin'
      ? file.match(/^\/Volumes\/[^/]+/)
      : platform === 'linux'
        ? file.match(/^(?:\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)(?=\/|$)/)
        : null
  return m ? m[0] : '/'
}
/**
 * Whether the volume a file lives on is there. On Windows the drive or share root must be readable. Elsewhere a
 * volume folder (/Volumes/X, /mnt/x ...) only counts when something is mounted on it: after an unclean unplug the
 * folder stays behind as an empty plain directory. `stat` is injectable for tests.
 */
export function volumeReachable(
  file: string,
  platform: string = process.platform,
  stat: (p: string) => { dev: number } = p => fs.statSync(p),
): boolean {
  const root = volumeRoot(file, platform)
  try {
    const st = stat(root)
    if (platform === 'win32' || root === '/') return true
    return st.dev !== stat(path.posix.dirname(root)).dev
  } catch {
    return false
  }
}
/** SHA-256 of the canonical path, lowercased on Windows only. */
export const historyKey = (file: string) => {
  const canon = canonicalPath(file)
  return sha256(process.platform === 'win32' ? canon.toLowerCase() : canon)
}

export const objectPath = (hash: string) => path.join(OBJECTS_DIR, hash.slice(0, 2), hash)
export const indexPath = (key: string) => path.join(FILES_DIR, `${key}.json`)
export const bakPath = (key: string) => `${indexPath(key)}.bak`
/** The work history log of a file. */
export const logPath = (key: string) => path.join(FILES_DIR, `${key}.log.jsonl`)
const lockPath = (key: string) => path.join(FILES_DIR, `${key}.lock`)

async function renameRetry(from: string, to: string) {
  const until = Date.now() + RENAME_RETRY_MS
  for (;;) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (e) {
      if (!isBusy(e) || Date.now() >= until) throw e
      await sleep(25)
    }
  }
}
export function renameRetrySync(from: string, to: string) {
  const until = Date.now() + RENAME_RETRY_MS
  for (;;) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (!isBusy(e) || Date.now() >= until) throw e
      sleepSync(25)
    }
  }
}

/** Writes via a temp file in the same folder, so readers never see half a file. */
export async function writeAtomic(file: string, bytes: Uint8Array): Promise<{ size: number; mtime: number }> {
  const tmp = tmpName(file)
  try {
    await fs.promises.writeFile(tmp, bytes)
    await renameRetry(tmp, file)
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  const st = await fs.promises.stat(file)
  return { size: st.size, mtime: st.mtimeMs }
}

export const isHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)

/** Who created an object: its inode and exact mtime when it was linked into place. Any reuse changes the mtime. */
export interface ObjectStamp {
  ino: bigint
  mtimeNs: bigint
}

/**
 * Refreshes a stored object's mtime to strictly later than it is now (never the same tick), so cleanup leaves it alone
 * and its creator's stamp can never match it again. Every reuse of an object goes through here. Returns the new mtime.
 */
async function touchLater(file: string): Promise<number> {
  const cur = (await fs.promises.stat(file)).mtimeMs
  const t = Math.max(Date.now(), cur + 1) / 1000
  await fs.promises.utimes(file, t, t)
  return (await fs.promises.stat(file)).mtimeMs
}

/**
 * Stores bytes as an object and says what it left on disk: the object's mtime afterwards and whether this call
 * created it. An object that is already stored is never written again: it is reused, and its mtime moves strictly
 * later (touchLater). A damaged one is rewritten.
 * `created` is true only when the object was not there at all and this writer alone made it: its temp file is linked
 * into place, which fails when another writer got there first, and that writer then reuses the object instead of
 * replacing it. `stamp` is the created object's inode and mtime (from the temp file, before the link): while both
 * still match, no other history can have started using it. No stamp where inodes are 0 (they cannot be trusted).
 */
export async function storeObject(bytes: Uint8Array, ext: string): Promise<{ hash: string; mtime: number; created: boolean; stamp?: ObjectStamp }> {
  const hash = sha256(bytes)
  const dest = objectPath(hash)
  if (await getObject(hash)) {
    try {
      return { hash, mtime: await touchLater(dest), created: false } // already stored and good: reuse it
    } catch {
      /* fall through and store it again */
    }
  } // missing or damaged: (re)write it below
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  const stored = STORED_AS_IS.has(ext.replace(/^\./, '').toLowerCase()) ? bytes : zlib.gzipSync(bytes)
  const tmp = tmpName(dest)
  try {
    await fs.promises.writeFile(tmp, stored)
    const st = await fs.promises.stat(tmp, { bigint: true })
    const mtime = (await fs.promises.stat(tmp)).mtimeMs
    try {
      await fs.promises.link(tmp, dest) // only if nothing is there: dest is now this very inode
      const stamp = st.ino ? { ino: st.ino, mtimeNs: st.mtimeNs } : undefined
      return { hash, mtime, created: true, stamp }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        await renameRetry(tmp, dest) // no hard links on this drive: replace it the old way (a new inode, so no stamp matches)
        return { hash, mtime: (await fs.promises.stat(dest)).mtimeMs, created: false }
      }
    }
    // Another writer got there first (or a damaged copy is there). Never replace a good one: reuse it.
    if (!(await getObject(hash))) await renameRetry(tmp, dest) // damaged (or gone meanwhile): rewrite it
    try {
      return { hash, mtime: await touchLater(dest), created: false }
    } catch {
      await renameRetry(tmp, dest).catch(() => {}) // moved away meanwhile (a fold dropped it): put this copy there
      return { hash, mtime: (await fs.promises.stat(dest)).mtimeMs, created: false }
    }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
}

export const putObject = async (bytes: Uint8Array, ext: string): Promise<string> => (await storeObject(bytes, ext)).hash

/**
 * Where a fold moves an object aside while it judges whether it may delete it (dropReplaced in record.ts): next to the
 * object, named after its hash. Cleanup never sweeps these: recoverDroppedObjects puts them back.
 */
export const asidePath = (hash: string) =>
  path.join(path.dirname(objectPath(hash)), `.${hash}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.drop.tmp`)
const DROPPED = /^\.([0-9a-f]{64})\.[^.]+\.[^.]+\.drop\.tmp$/
export const isDropped = (name: string) => DROPPED.test(name)

/**
 * Puts an object a fold moved aside back in place, retrying for up to a second (without blocking the thread) while
 * Windows refuses with EPERM or EBUSY. When a good copy is already there (another writer stored the same content
 * meanwhile), that copy's mtime moves strictly later, so whoever created it can no longer take it for unused, and the
 * aside copy goes. The aside copy is only ever deleted once the object is in place. Returns false when that could not
 * be done: the aside copy stays, and recoverDroppedObjects puts it back later.
 */
export async function putBack(aside: string, hash: string): Promise<boolean> {
  const obj = objectPath(hash)
  const until = Date.now() + RENAME_RETRY_MS
  for (;;) {
    if (!fs.existsSync(aside)) return fs.existsSync(obj) // someone else put it back meanwhile
    try {
      if (fs.existsSync(obj)) {
        if (await getObject(hash)) await touchLater(obj) // reuse the copy that is there
        else await fs.promises.rename(aside, obj) // that copy is damaged: this one replaces it
      } else {
        try {
          await fs.promises.link(aside, obj)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST' && Date.now() < until) continue // a copy appeared meanwhile: reuse it (above)
          await fs.promises.rename(aside, obj)
        }
      }
      await fs.promises.rm(aside, { force: true }).catch(() => {}) // the object is in place: a leftover goes next time
      return true
    } catch {
      if (Date.now() >= until) return false
      await sleep(25)
    }
  }
}

/**
 * Puts back every object a fold moved aside and could not put back (the process died in between, or Windows refused
 * for over a second), so the versions that use it can be read again. Run when the app's history worker starts and by
 * every cleanup. Returns how many were put back or found in place.
 */
export async function recoverDroppedObjects(): Promise<number> {
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(OBJECTS_DIR)
  } catch {
    return 0
  }
  let n = 0
  for (const d of dirs) {
    let names: string[]
    try {
      names = await fs.promises.readdir(path.join(OBJECTS_DIR, d))
    } catch {
      continue
    }
    for (const name of names) {
      const m = DROPPED.exec(name)
      if (m && (await putBack(path.join(OBJECTS_DIR, d, name), m[1]))) n++
    }
  }
  return n
}

export async function getObject(hash: string): Promise<Uint8Array | null> {
  let raw: Buffer
  try {
    raw = await fs.promises.readFile(objectPath(hash))
  } catch {
    return null
  }
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      const plain = zlib.gunzipSync(raw)
      if (sha256(plain) === hash) return plain
    } catch {
      /* maybe stored as is */
    }
  }
  return sha256(raw) === hash ? raw : null
}

const validIndex = (x: unknown): x is HistoryIndex =>
  !!x && typeof (x as HistoryIndex).path === 'string' && Array.isArray((x as HistoryIndex).versions)
const parseIndex = (file: string): HistoryIndex | null | undefined => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined // missing
    throw e // unreadable right now: never mistake it for a missing index
  }
  try {
    const x = JSON.parse(text)
    return validIndex(x) ? x : null
  } catch {
    return null // corrupt
  }
}

/** Moves a corrupt index out of the way (with rename retries). Throws if it cannot, rather than letting it be overwritten. */
const setAsideCorrupt = (file: string) => {
  try {
    renameRetrySync(file, `${file}.corrupt-${Date.now()}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** The saved index, or null. A corrupt index is set aside (never overwritten) and the .bak is used instead. */
export function readIndex(key: string, expectedPath?: string): HistoryIndex | null {
  let idx = parseIndex(indexPath(key))
  if (idx === null) {
    setAsideCorrupt(indexPath(key))
  }
  if (!idx) idx = parseIndex(bakPath(key)) ?? null
  if (!idx) return null
  if (expectedPath !== undefined && !samePath(idx.path, expectedPath)) return null
  return idx
}

export function writeIndex(key: string, index: HistoryIndex): void {
  const file = indexPath(key)
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const current = parseIndex(file)
  if (current === null) setAsideCorrupt(file) // never write over a corrupt index
  else if (current) {
    const bak = tmpName(bakPath(key)) // keep the last good one, written whole or not at all
    try {
      fs.writeFileSync(bak, fs.readFileSync(file))
      renameRetrySync(bak, bakPath(key))
    } catch (e) {
      fs.rmSync(bak, { force: true })
      throw e
    }
  }
  const tmp = tmpName(file)
  try {
    fs.writeFileSync(tmp, JSON.stringify(index))
    renameRetrySync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours
  }
}
/** The lock's content when it is stale (dead pid, over 30 s old, or unreadable and old), else null. */
function staleContent(file: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const l = JSON.parse(raw) as { pid?: number; at?: number }
    if (typeof l.pid === 'number' && typeof l.at === 'number') return Date.now() - l.at > LOCK_STALE_MS || !alive(l.pid) ? raw : null
  } catch {
    /* half-written or garbage: go by age */
  }
  try {
    return Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS ? raw : null
  } catch {
    return null
  }
}

/** Test seam: runs between judging a lock stale and moving it aside. */
export const lockHooks: { beforeTakeover?: () => void } = {}

/**
 * Compare-and-swap takeover. Moves the lock aside under a unique name and reads it back: only if it is
 * exactly what was judged stale is it deleted. Otherwise a fresh lock was moved by mistake and is put back.
 * Returns true when the lock path is now free to try.
 */
function takeOver(file: string, judged: string): boolean {
  lockHooks.beforeTakeover?.()
  const aside = `${file}.stale-${process.pid}-${threadId}-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return false // gone or taken by someone else
  }
  let moved: string | null = null
  try {
    moved = fs.readFileSync(aside, 'utf8')
  } catch {
    /* unreadable: treat as different */
  }
  if (moved === judged) {
    fs.rmSync(aside, { force: true })
    return true
  }
  try {
    fs.linkSync(aside, file) // put it back only if the lock path is still free
  } catch {
    /* occupied: leave it to the new holder */
  }
  fs.rmSync(aside, { force: true })
  return false
}

/** Takes the lock file if it is free (or stale). Returns what was written into it, or null while someone else holds it. */
function tryAcquire(file: string): string | null {
  for (;;) {
    const mine = JSON.stringify({ pid: process.pid, at: Date.now(), id: crypto.randomBytes(4).toString('hex') }) // stamped when taken, not when we started waiting
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeSync(fd, mine)
      } finally {
        fs.closeSync(fd)
      }
      return mine
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const judged = staleContent(file)
      if (judged !== null && takeOver(file, judged)) continue
      return null
    }
  }
}
function release(file: string, mine: string) {
  try {
    if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file, { force: true }) // never delete a lock that is no longer ours
  } catch {
    /* already gone */
  }
}

/** The file a history key belongs to, for messages: from its index (or .bak), else a plain stand-in. */
function fileOfKey(key: string): string {
  try {
    const idx = parseIndex(indexPath(key)) || parseIndex(bakPath(key))
    if (idx) return idx.path
  } catch {
    /* unreadable right now */
  }
  return 'a file'
}

/**
 * After lock files kept failing with EPERM or EBUSY for over a second (a history folder that can't be written), every
 * lock fails at once with that error for the next 30 s, in this process. Saves then go ahead without history at once
 * instead of each waiting a second first. The first lock taken after that clears it.
 */
const LOCK_DENIED_MS = 30_000
let lockDenied: { until: number; error: unknown } | null = null

/**
 * One writer at a time per file history, across processes. `file` is only for the message when the wait runs out
 * (it becomes the "Version history paused" reason, so it names the file, never the key).
 * On Windows an antivirus or indexer can hold the lock file for a moment, and creating it then fails with EPERM or
 * EBUSY: that counts as busy, like EEXIST. Only when nothing but EPERM or EBUSY comes back for over a second is it
 * taken for a real permission problem and thrown (and remembered for 30 s, see lockDenied).
 */
export async function withLock<T>(key: string, fn: () => Promise<T>, file?: string): Promise<T> {
  if (lockDenied && Date.now() < lockDenied.until) throw lockDenied.error // fail fast: a save must not wait a second each time
  const lock = lockPath(key)
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const until = Date.now() + LOCK_WAIT_MS
  let busySince = 0
  let mine: string | null
  for (;;) {
    mine = null
    try {
      mine = tryAcquire(lock)
      busySince = 0
      if (mine) lockDenied = null
    } catch (e) {
      if (!isBusy(e)) throw e
      busySince ||= Date.now()
      if (Date.now() - busySince > RENAME_RETRY_MS) {
        lockDenied = { until: Date.now() + LOCK_DENIED_MS, error: e }
        throw e
      }
    }
    if (mine) break
    if (Date.now() >= until) throw new Error(`Timed out waiting for the history lock of ${file ?? fileOfKey(key)}`)
    await sleep(LOCK_RETRY_MS)
  }
  try {
    return await fn()
  } finally {
    release(lock, mine)
  }
}

/** Several histories' locks at once, taken in sorted key order so two movers never wait on each other. */
export async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(keys)].sort()
  if (first === undefined) return fn()
  return withLock(first, () => (rest.length ? withLocks(rest, fn) : fn()))
}

const globToRegExp = (g: string) => new RegExp(`^${g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

/** Secret files are never versioned: names match the pattern list, or sit under .ssh, .aws, .gnupg, .azure. */
export function isExcluded(file: string, patterns: string[] = getSettings().historyExclude ?? DEFAULT_EXCLUDE): boolean {
  const parts = file.split(/[\\/]+/).filter(Boolean)
  if (parts.some(p => EXCLUDED_DIRS.has(p.toLowerCase()))) return true
  const base = parts[parts.length - 1] ?? ''
  return patterns.some(p => globToRegExp(p).test(base))
}

/** Every stored index (including ones only the .bak survives for) as { key, path }. Unreadable ones are left out. */
export function listHistoryEntries(): { key: string; path: string }[] {
  let names: string[]
  try {
    names = fs.readdirSync(FILES_DIR)
  } catch {
    return []
  }
  const keys = new Set(names.filter(n => n.endsWith('.json') || n.endsWith('.json.bak')).map(n => n.replace(/\.json(\.bak)?$/, '')))
  const out: { key: string; path: string }[] = []
  for (const key of keys) {
    try {
      const idx = parseIndex(indexPath(key)) || parseIndex(bakPath(key))
      if (idx) out.push({ key, path: idx.path })
    } catch {
      /* unreadable right now */
    }
  }
  return out
}

/**
 * Hashes used by every history except `key`'s (index and .bak of each; every history when `key` is left out). Null
 * when anything cannot be read with certainty: the caller must then keep every object.
 */
export function hashesUsedElsewhere(key?: string): Set<string> | null {
  let names: string[]
  try {
    names = fs.readdirSync(FILES_DIR)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null
  }
  const used = new Set<string>()
  for (const n of names) {
    const m = n.match(/^(.+)\.json(\.bak)?$/)
    if (!m || m[1] === key) continue
    try {
      const idx = parseIndex(path.join(FILES_DIR, n))
      if (idx === null) return null // corrupt: cannot tell what it uses
      for (const v of idx?.versions ?? []) used.add(v.hash)
    } catch {
      return null
    }
  }
  return used
}

/** Paths recorded in every index, for resolving a doc id back to a file. */
export function listHistoryPaths(): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(FILES_DIR)
  } catch {
    return []
  }
  const keys = new Set(names.filter(n => n.endsWith('.json') || n.endsWith('.json.bak')).map(n => n.replace(/\.json(\.bak)?$/, '')))
  const out: string[] = []
  for (const k of keys) {
    try {
      const idx = parseIndex(indexPath(k)) || parseIndex(bakPath(k)) // a set-aside index still has its backup
      if (idx) out.push(idx.path)
    } catch {
      /* unreadable right now: leave it out of this listing */
    }
  }
  return [...new Set(out)]
}
