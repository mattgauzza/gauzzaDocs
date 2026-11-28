import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// One writer at a time for a .gdesign: every write from the CLI or the worker holds `<file>.lock`, created with the
// exclusive `wx` flag and holding `{ pid, at }`. A lock older than 60 seconds belongs to a writer that stopped without
// letting go, and the next writer takes it over.

/** A lock taken longer ago than this is stale. */
export const LOCK_STALE_MS = 60_000
/** How far ahead of the clock a lock's time may be and still be believed (clocks between programs drift a little). */
const SKEW_MS = 5_000
/** Refusals to create the lock, with no lock there, before the folder itself is tried. */
const DENIED_TRIES = 3

/**
 * How long a writer waits between tries, and for how long in all. Past the stale time a lock is taken over, so the
 * wait only stops a writer that keeps losing the race for a free one, or a lock that can't be moved aside. Tests
 * shorten them.
 */
export const lockTiming = { retryMs: 25, waitMs: LOCK_STALE_MS + 15_000 }

/** The file calls the lock makes, so tests can stand in for a folder that refuses them on any system. */
export const lockIo = {
  open: (p: string, flags: string): Promise<fs.promises.FileHandle> => fs.promises.open(p, flags),
  rename: (from: string, to: string): Promise<void> => fs.promises.rename(from, to),
  readFile: (p: string): Promise<string> => fs.promises.readFile(p, 'utf8'),
  copyFile: (from: string, to: string, mode: number): Promise<void> => fs.promises.copyFile(from, to, mode),
  rm: (p: string): Promise<void> => fs.promises.rm(p, { force: true })
}

export const BUSY = 'This design is being saved by another program. Try again in a moment.'
export const NO_WRITE = "Can't save here: this folder doesn't allow new files."
export const stuckLock = (lock: string): string =>
  `Can't save: an old lock file is in the way and can't be removed. Delete ${path.basename(lock)} and try again.`

export const lockPath = (file: string): string => path.resolve(file) + '.lock'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? ''
/** Codes a folder gives when it won't take a new file (Windows reports access denied as EPERM). */
const DENIED = ['EPERM', 'EACCES', 'EROFS']

/** Creates the lock if nobody holds it: what it wrote, or why it couldn't (the error's code). */
async function create(lock: string): Promise<{ mine: string } | { code: string }> {
  const body = JSON.stringify({ pid: process.pid, at: Date.now() })
  let fh: fs.promises.FileHandle
  try {
    fh = await lockIo.open(lock, 'wx')
  } catch (e) {
    // EPERM and EBUSY: Windows refuses the name while another writer's lock is being deleted; EPERM, EACCES and EROFS
    // are also what a folder that takes no new files says, which the caller tells apart (folderTakesFiles)
    const code = codeOf(e)
    if (code === 'EEXIST' || code === 'EBUSY' || DENIED.includes(code)) return { code }
    throw e
  }
  try {
    await fh.writeFile(body)
  } finally {
    await fh.close()
  }
  return { mine: body }
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

/** What the lock holds now and when it was written, or null when it's gone (or can't be read just now). */
async function current(lock: string): Promise<{ raw: string; mtime: number } | null> {
  try {
    const fh = await lockIo.open(lock, 'r')
    try {
      const st = await fh.stat()
      return { raw: await fh.readFile('utf8'), mtime: st.mtimeMs }
    } finally {
      await fh.close()
    }
  } catch (e) {
    if (['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(codeOf(e))) return null
    throw e
  }
}

/**
 * Whether the lock's folder takes a new file: one with a name of its own is made and removed. False only when the
 * folder refuses it; anything else (the folder is gone, say) is thrown as it is.
 */
async function folderTakesFiles(lock: string): Promise<boolean> {
  const probe = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.probe`
  let fh: fs.promises.FileHandle
  try {
    fh = await lockIo.open(probe, 'wx')
  } catch (e) {
    if (DENIED.includes(codeOf(e))) return false
    throw e
  }
  await fh.close().catch(() => {})
  await lockIo.rm(probe).catch(() => {})
  return true
}

/**
 * Moves a stale lock aside so the next attempt can create a fresh one. If what was moved isn't the stale lock that was
 * seen (another writer took the lock over and took it in the meantime), it's put back, unless a lock is there again.
 * Null when it was moved, else why not (the error's code): someone else moved it first, or the folder won't let it go.
 */
async function takeOver(lock: string, seen: string): Promise<string | null> {
  const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`
  try {
    await lockIo.rename(lock, aside)
  } catch (e) {
    return codeOf(e) || 'unknown'
  }
  try {
    const got = await lockIo.readFile(aside).catch(() => seen)
    if (got !== seen) await lockIo.copyFile(aside, lock, fs.constants.COPYFILE_EXCL).catch(() => {})
  } finally {
    await lockIo.rm(aside).catch(() => {})
  }
  return null
}

/** Removes the lock if it's still the one this writer made (one that ran past the stale time may have lost it). */
async function release(lock: string, mine: string): Promise<void> {
  const now = await current(lock).catch(() => null)
  if (now?.raw === mine) await lockIo.rm(lock).catch(() => {})
}

/**
 * Runs `fn` holding `<file>.lock`. Waits while another writer holds it, takes over a lock older than 60 seconds, and
 * lets go when `fn` settles, whether it succeeded or threw. Not re-entrant: code holding the lock must not ask again.
 * Every try that fails waits a moment and counts toward the deadline, so it never spins. A folder that refuses new
 * files fails soon with NO_WRITE (after a few refusals to create the lock with no lock there, or to move a stale one
 * aside, a file of its own is tried), and a lock that stays (held, or stale and impossible to move aside) fails at the
 * deadline.
 */
export async function withDesignLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(file)
  const until = Date.now() + lockTiming.waitMs
  let denied = 0
  let mine: string
  for (;;) {
    const got = await create(lock)
    if ('mine' in got) {
      mine = got.mine
      break
    }
    const held = await current(lock)
    let refused = !held && DENIED.includes(got.code)
    let stuck = false
    if (held && Date.now() - takenAt(held.raw, held.mtime) > LOCK_STALE_MS) {
      const why = await takeOver(lock, held.raw)
      if (why !== null) {
        stuck = true
        refused = DENIED.includes(why)
      }
    }
    if (!refused) denied = 0
    else if (++denied >= DENIED_TRIES) {
      // refused again and again: is it the folder?
      if (!(await folderTakesFiles(lock))) throw new Error(NO_WRITE)
      denied = 0
    }
    if (Date.now() > until) throw new Error(stuck ? stuckLock(lock) : BUSY)
    await sleep(lockTiming.retryMs)
  }
  try {
    return await fn()
  } finally {
    await release(lock, mine)
  }
}
