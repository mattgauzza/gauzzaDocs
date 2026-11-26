import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDocInstructions, inFile, splitInstructions, withInstructions } from '../instructions'
import { LARGE_BYTES } from '../large'
import {
  discardPending,
  flushHistory,
  flushPendingLocked,
  historyHooks,
  logEventLocked,
  markBeforeRestore,
  recordVersion,
  reportHistoryFailure,
} from './record'
import {
  bakPath,
  canonicalPath,
  getObject,
  hashesUsedElsewhere,
  historyKey,
  indexPath,
  isExcluded,
  isHash,
  listHistoryEntries,
  logPath,
  objectPath,
  readIndex,
  renameRetrySync,
  withLock,
  withLocks,
  writeAtomic,
  writeIndex,
  type Author,
  type HistoryIndex,
  type HistoryVersion,
} from './store'

/** An object touched this recently may be in use by a writer that has not written its index yet. */
const FORGET_FRESH_MS = 2 * 60 * 1000
const OUTSIDE: Author = { name: 'outside gauzzaDocs', by: 'outside' }
const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex')

function find(file: string, n: number): { idx: HistoryIndex; version: HistoryVersion } {
  const idx = readIndex(historyKey(file), canonicalPath(file))
  const version = idx?.versions.find(v => v.n === n)
  if (!idx || !version) throw new Error(`${file} has no version ${n}.`)
  return { idx, version }
}

/** The exact bytes of a stored version. */
export async function showVersion(file: string, n: number): Promise<Uint8Array> {
  const { version } = find(file, n)
  const bytes = await getObject(version.hash)
  if (!bytes) throw new Error(`Version ${n} of ${file} can't be read: its stored content is missing or damaged.`)
  return bytes
}

/** Gives a version a name (kept for good by cleanup). An empty name clears it. */
export async function nameVersion(file: string, n: number, name: string, by: string): Promise<void> {
  const key = historyKey(file)
  await withLock(key, async () => {
    const { idx, version } = find(file, n)
    const t = name.trim()
    if (t) version.name = t
    else delete version.name
    writeIndex(key, idx)
    await logEventLocked(file, { type: 'named', by, summary: t ? `named v${n} "${t}"` : `cleared the name of v${n}` })
  }, file)
}

/**
 * Deletes the objects in `hashes` that no history in `used` refers to. Ones touched in the last 2 minutes may have
 * just been reused by a writer that has not written its index yet: they are kept and returned, for a retry.
 */
function deleteUnused(hashes: Iterable<string>, used: Set<string>): string[] {
  const left: string[] = []
  for (const hash of hashes) {
    if (!isHash(hash) || used.has(hash)) continue // never build a path from anything but a hash
    const obj = objectPath(hash)
    try {
      if (Date.now() - fs.statSync(obj).mtimeMs < FORGET_FRESH_MS) {
        left.push(hash)
        continue
      }
      fs.rmSync(obj, { force: true })
    } catch {
      continue // missing already, or held: cleanup removes it later
    }
    try {
      fs.rmdirSync(path.dirname(obj)) // only when empty
    } catch {
      /* not empty */
    }
  }
  return left
}

/**
 * Deletes a file's index, its backup, its log and every object no other history uses. If any other index cannot
 * be read, every object is kept: nothing is deleted on incomplete information. Resolves with the objects it left
 * because they were touched in the last 2 minutes: the app retries those once a few minutes later (forgetObjects),
 * and cleanup removes whatever is still left after a day.
 */
export async function forgetHistory(file: string): Promise<string[]> {
  const key = historyKey(file)
  await flushHistory() // writes still queued would otherwise bring it back
  return withLock(key, async () => {
    const mine = new Set<string>()
    for (const f of [indexPath(key), bakPath(key)]) {
      try {
        for (const v of (JSON.parse(fs.readFileSync(f, 'utf8')) as HistoryIndex).versions ?? []) mine.add(v.hash)
      } catch {
        /* missing or unreadable: nothing known to delete from it */
      }
    }
    const elsewhere = hashesUsedElsewhere(key)
    discardPending(file)
    const dir = path.dirname(indexPath(key))
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      /* no store yet */
    }
    for (const n of names) if (n.startsWith(`${key}.`) && !n.endsWith('.lock')) fs.rmSync(path.join(dir, n), { force: true }) // index, .bak, set-aside copies, log
    if (!elsewhere) return []
    return deleteUnused(mine, elsewhere)
  }, file)
}

/**
 * The retry after forgetHistory: deletes the objects it left, unless a history uses them by now (the file may have
 * been saved again since) or they were touched in the last 2 minutes. Returns the ones still left.
 */
export function forgetObjects(hashes: string[]): string[] {
  const used = hashesUsedElsewhere() // every history, the forgotten file's new one included
  return used ? deleteUnused(hashes, used) : hashes.filter(isHash)
}

const inside = (root: string, p: string): string | null => {
  const rel = path.relative(root, p) // ignores case on win32 (indexes may hold a lowercased or a real-case path)
  return rel === '' ? '' : rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}
const hasHistory = (key: string) => fs.existsSync(indexPath(key)) || fs.existsSync(bakPath(key))

/**
 * Moves the history of a file, or of every file under a folder, to follow a rename. Refuses to overwrite a history at
 * the destination. `by` is who renamed it (the work history's "moved from" event): the person for a rename in the app.
 */
export async function moveHistory(from: string, to: string, by = 'outside gauzzaDocs'): Promise<void> {
  const src = canonicalPath(from)
  const dst = canonicalPath(to)
  const jobs: { oldKey: string; oldPath: string; newKey: string; newPath: string }[] = []
  for (const e of listHistoryEntries()) {
    const rel = inside(src, e.path)
    if (rel === null) continue
    const newPath = rel ? path.join(dst, rel) : dst
    const newKey = historyKey(newPath)
    if (newKey === e.key) continue // same file, only its case differs
    jobs.push({ oldKey: e.key, oldPath: e.path, newKey, newPath })
  }
  const moving = new Set(jobs.map(j => j.oldKey))
  for (const j of jobs) {
    if (hasHistory(j.newKey) && !moving.has(j.newKey)) throw new Error(`${j.newPath} already has a history, so ${j.oldPath} can't be moved onto it.`)
  }
  for (const j of jobs) {
    await withLocks([j.oldKey, j.newKey], async () => {
      const old = readIndex(j.oldKey, j.oldPath)
      if (!old) return
      if (hasHistory(j.newKey)) throw new Error(`${j.newPath} already has a history, so ${j.oldPath} can't be moved onto it.`)
      const moved: HistoryIndex = { ...old, path: j.newPath }
      delete moved.missingSince // it is where it belongs again
      writeIndex(j.newKey, moved)
      try {
        const bak = JSON.parse(fs.readFileSync(bakPath(j.oldKey), 'utf8')) as HistoryIndex
        delete bak.missingSince
        fs.writeFileSync(bakPath(j.newKey), JSON.stringify({ ...bak, path: j.newPath }))
      } catch {
        /* no usable backup to carry over */
      }
      try {
        renameRetrySync(logPath(j.oldKey), logPath(j.newKey))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') reportHistoryFailure(e) // no log is fine; one that cannot move is a history failure
      }
      for (const f of [indexPath(j.oldKey), bakPath(j.oldKey)]) fs.rmSync(f, { force: true })
      await logEventLocked(j.newPath, { type: 'moved', by, summary: `moved from ${j.oldPath}` })
    })
    try {
      historyHooks.onMoved(j.oldPath, j.newPath)
    } catch {
      /* a hook must never break a move */
    }
  }
}

/** Restore refuses a file that matches a secret file pattern (one renamed to .env after it had history, say). */
export const SECRET_RESTORE = "This file is a secret file, so gauzzaDocs doesn't keep versions of it."

/**
 * Puts a stored version back on disk (spec "Restoring"). Holds the file's lock throughout. In order: writes an
 * earlier history failure left unrecorded are recorded first, under their real authors; the bytes on disk are kept
 * if they differ from the latest version (as an outside change), then unsaved editor content is kept (without
 * writing it), so the newest state is the one marked as before the restore; the stored bytes are written exactly
 * (with the file's current standing instructions swapped in for .md and .html, when the file is there to have
 * any); the result is recorded with `restoredFrom`. Resolves with the version now in effect: the new one, or the
 * latest when the bytes were the same. A secret file (see isExcluded) is never written: it has no versions to keep.
 */
export async function restoreVersion(
  file: string,
  n: number,
  opts: { authors: Author[]; unsaved?: Uint8Array; unsavedAuthors?: Author[]; discardCurrent?: boolean },
): Promise<HistoryVersion> {
  if (isExcluded(file)) throw new Error(SECRET_RESTORE)
  return withLock(historyKey(file), async () => {
    // Saves a history failure left unrecorded go first, credited to who made them: otherwise the bytes on disk
    // below would be kept as an outside change, and those saves would land after the restore.
    if (await flushPendingLocked(file))
      throw new Error(`Version history can't keep the earlier saves of ${file} right now, so it can't restore yet. Try again in a moment.`)
    const { version } = find(file, n)
    const stored = await getObject(version.hash)
    if (!stored) throw new Error(`Version ${n} of ${file} can't be read: its stored content is missing or damaged.`)

    const tooBig = `${file} is over 32 MB, so its current content can't be kept. Restore anyway with discardCurrent.`
    if (opts.unsaved && opts.unsaved.length > LARGE_BYTES && !opts.discardCurrent) throw new Error(tooBig) // would be dropped unrecorded
    let disk: Buffer | null = null
    let exists = false
    let mtime = Date.now()
    try {
      const st = await fs.promises.stat(file)
      if (st.isFile()) {
        exists = true
        if (st.size > LARGE_BYTES) {
          if (!opts.discardCurrent) throw new Error(tooBig)
        } else {
          disk = await fs.promises.readFile(file)
          mtime = st.mtimeMs
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // deleted from disk: restoring recreates it
    }

    if (disk) await recordVersion(file, disk, { size: disk.length, mtime }, { authors: [OUTSIDE] }, { noFold: true })
    // Unsaved edits are credited to whoever made them (the tab knows), not to whoever asked for the restore.
    const unsavedBy = opts.unsavedAuthors?.length ? opts.unsavedAuthors : opts.authors
    if (opts.unsaved) await recordVersion(file, opts.unsaved, { size: opts.unsaved.length, mtime: Date.now() }, { authors: unsavedBy }, { noFold: true })

    let out: Uint8Array = stored
    if (inFile(file) && exists) {
      // Only re-encode when the standing instructions actually change; otherwise the stored bytes go back untouched.
      // A deleted file has no instructions of its own any more: the version's go back with it.
      const text = Buffer.from(stored).toString('utf8')
      const current = getDocInstructions(file)
      if (splitInstructions(file, text).instructions !== current) out = Buffer.from(withInstructions(file, text, current))
    }

    const after = readIndex(historyKey(file), canonicalPath(file))
    const latest = after?.versions[after.versions.length - 1]
    if (latest && latest.hash !== sha256(out)) markBeforeRestore(file)

    await fs.promises.mkdir(path.dirname(path.resolve(file)), { recursive: true })
    const stat = await writeAtomic(file, out)
    const recorded = await recordVersion(file, out, stat, { authors: opts.authors, summary: `Restored v${n}` }, { restoredFrom: n, noFold: true })
    await logEventLocked(file, { type: 'restored', by: opts.authors.map(a => a.name).join(', '), summary: `restored v${n}` })
    if (recorded) return recorded
    const final = readIndex(historyKey(file), canonicalPath(file))
    return final?.versions[final.versions.length - 1] ?? version
  }, file)
}
