import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// One writer at a time for a .gdesign: every write from the CLI or the worker holds `<file>.lock`, created with the
// exclusive `wx` flag and holding `{ pid, at }`. A lock older than 60 seconds belongs to a writer that stopped without
// letting go, and the next writer takes it over.

/** A lock taken longer ago than this is stale. */
export const LOCK_STALE_MS = 60_000
const RETRY_MS = 25
/** Past the stale time a lock is taken over, so this only stops a writer that keeps losing the race for a free one. */
const WAIT_MS = LOCK_STALE_MS + 15_000
/** How far ahead of the clock a lock's time may be and still be believed (clocks between programs drift a little). */
const SKEW_MS = 5_000

export const BUSY = 'This design is being saved by another program. Try again in a moment.'

export const lockPath = (file: string): string => path.resolve(file) + '.lock'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? ''

/** Creates the lock if nobody holds it. Returns what it wrote, or null when it's held. */
async function create(lock: string): Promise<string | null> {
  const body = JSON.stringify({ pid: process.pid, at: Date.now() })
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(lock, 'wx')
  } catch (e) {
    // EPERM and EBUSY: Windows refuses the name while another writer's lock is being deleted
    if (['EEXIST', 'EPERM', 'EBUSY'].includes(codeOf(e))) return null
    throw e
  }
  try {
    await fh.writeFile(body)
  } finally {
    await fh.close()
  }
  return body
}

/** When a lock was taken: its `at`, or the file's own time when the content can't be read or can't be right. */
function takenAt(raw: string, mtime: number): number {
  try {
    const at = (JSON.parse(raw) as { at?: unknown })?.at
    if (typeof at === 'number' && Number.isFinite(at) && at <= Date.now() + SKEW_MS) return at
  } catch {
    // empty (its writer is between creating and writing it) or not ours: the file's time says when
  }
  return mtime
}

/** What the lock holds now and when it was written, or null when it's gone. */
async function current(lock: string): Promise<{ raw: string; mtime: number } | null> {
  try {
    const fh = await fs.promises.open(lock, 'r')
    try {
      const st = await fh.stat()
      return { raw: await fh.readFile('utf8'), mtime: st.mtimeMs }
    } finally {
      await fh.close()
    }
  } catch (e) {
    if (['ENOENT', 'EPERM', 'EBUSY'].includes(codeOf(e))) return null
    throw e
  }
}

/**
 * Moves a stale lock aside so the next attempt can create a fresh one. If what was moved isn't the stale lock that was
 * seen (another writer took the lock over and took it in the meantime), it's put back, unless a lock is there again.
 */
async function takeOver(lock: string, seen: string): Promise<void> {
  const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`
  try {
    await fs.promises.rename(lock, aside)
  } catch {
    return // someone else moved it first
  }
  try {
    const got = await fs.promises.readFile(aside, 'utf8').catch(() => seen)
    if (got !== seen) await fs.promises.copyFile(aside, lock, fs.constants.COPYFILE_EXCL).catch(() => {})
  } finally {
    await fs.promises.rm(aside, { force: true }).catch(() => {})
  }
}

/** Removes the lock if it's still the one this writer made (one that ran past the stale time may have lost it). */
async function release(lock: string, mine: string): Promise<void> {
  const now = await current(lock).catch(() => null)
  if (now?.raw === mine) await fs.promises.rm(lock, { force: true }).catch(() => {})
}

/**
 * Runs `fn` holding `<file>.lock`. Waits while another writer holds it, takes over a lock older than 60 seconds, and
 * lets go when `fn` settles, whether it succeeded or threw. Not re-entrant: code holding the lock must not ask again.
 */
export async function withDesignLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(file)
  const until = Date.now() + WAIT_MS
  let mine: string | null = null
  for (;;) {
    mine = await create(lock)
    if (mine) break
    const held = await current(lock)
    if (!held) continue // let go meanwhile: try again at once
    if (Date.now() - takenAt(held.raw, held.mtime) > LOCK_STALE_MS) {
      await takeOver(lock, held.raw)
      continue
    }
    if (Date.now() > until) throw new Error(BUSY)
    await sleep(RETRY_MS)
  }
  try {
    return await fn()
  } finally {
    await release(lock, mine)
  }
}
