import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDocInstructions, inFile, splitInstructions, withInstructions } from '../instructions'
import { LARGE_BYTES } from '../large'
import { discardPending, flushHistory, historyHooks, logEventLocked, markBeforeRestore, recordVersion, reportHistoryFailure } from './record'
import {
  bakPath,
  canonicalPath,
  getObject,
  hashesUsedElsewhere,
  historyKey,
  indexPath,
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

const DAY_MS = 24 * 60 * 60 * 1000
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
  })
}

/**
 * Deletes a file's index, its backup, its log and every object no other history uses. If any other index cannot
 * be read, every object is kept: nothing is deleted on incomplete information.
 */
export async function forgetHistory(file: string): Promise<void> {
  const key = historyKey(file)
  await flushHistory() // writes still queued would otherwise bring it back
  await withLock(key, async () => {
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
    if (!elsewhere) return
    for (const hash of mine) {
      if (elsewhere.has(hash)) continue
      try {
        if (Date.now() - fs.statSync(objectPath(hash)).mtimeMs < DAY_MS) continue // a writer may just have reused it: cleanup removes it later
      } catch {
        continue // missing already
      }
      fs.rmSync(objectPath(hash), { force: true })
      try {
        fs.rmdirSync(path.dirname(objectPath(hash))) // only when empty
      } catch {
        /* not empty */
      }
    }
  })
}

const inside = (root: string, p: string): string | null => {
  const rel = path.relative(root, p) // canonical paths are already lowercased on win32
  return rel === '' ? '' : rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}
const hasHistory = (key: string) => fs.existsSync(indexPath(key)) || fs.existsSync(bakPath(key))

/** Moves the history of a file, or of every file under a folder, to follow a rename. Refuses to overwrite a history at the destination. */
export async function moveHistory(from: string, to: string): Promise<void> {
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
      writeIndex(j.newKey, { ...old, path: j.newPath })
      try {
        const bak = JSON.parse(fs.readFileSync(bakPath(j.oldKey), 'utf8')) as HistoryIndex
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
      await logEventLocked(j.newPath, { type: 'moved', by: 'outside gauzzaDocs', summary: `moved from ${j.oldPath}` })
    })
    try {
      historyHooks.onMoved(j.oldPath, j.newPath)
    } catch {
      /* a hook must never break a move */
    }
  }
}

/**
 * Puts a stored version back on disk (spec "Restoring"). Holds the file's lock throughout. In order: the bytes on
 * disk are kept if they differ from the latest version (as an outside change), then unsaved editor content is kept
 * (without writing it), so the newest state is the one marked as before the restore; the stored bytes are written
 * exactly (with the current standing instructions swapped in for .md and .html); the result is recorded with
 * `restoredFrom`. Resolves with the version now in effect: the new one, or the latest when the bytes were the same.
 */
export async function restoreVersion(
  file: string,
  n: number,
  opts: { authors: Author[]; unsaved?: Uint8Array; discardCurrent?: boolean },
): Promise<HistoryVersion> {
  return withLock(historyKey(file), async () => {
    const { version } = find(file, n)
    const stored = await getObject(version.hash)
    if (!stored) throw new Error(`Version ${n} of ${file} can't be read: its stored content is missing or damaged.`)

    const tooBig = `${file} is over 32 MB, so its current content can't be kept. Restore anyway with discardCurrent.`
    if (opts.unsaved && opts.unsaved.length > LARGE_BYTES && !opts.discardCurrent) throw new Error(tooBig) // would be dropped unrecorded
    let disk: Buffer | null = null
    let mtime = Date.now()
    try {
      const st = await fs.promises.stat(file)
      if (st.isFile()) {
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
    if (opts.unsaved) await recordVersion(file, opts.unsaved, { size: opts.unsaved.length, mtime: Date.now() }, { authors: opts.authors }, { noFold: true })

    let out: Uint8Array = stored
    if (inFile(file)) {
      // Only re-encode when the standing instructions actually change; otherwise the stored bytes go back untouched.
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
  })
}
