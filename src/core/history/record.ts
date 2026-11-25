import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LARGE_BYTES } from '../large'
import { samePath } from '../paths'
import { enqueue, idle } from './queue'
import {
  canonicalPath,
  historyKey,
  indexPath,
  isExcluded,
  listHistoryPaths,
  putObject,
  readIndex,
  withLock,
  writeIndex,
  type Author,
  type HistoryVersion,
} from './store'

export interface WriteContext {
  authors: Author[]
  summary?: string
}

const FOLD_MS = 10 * 60 * 1000
const OUTSIDE: Author = { name: 'outside gauzzaDocs', by: 'outside' }
const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Hooks other parts wire up later. onMoved is where the work log hears about an adopted history. */
export const historyHooks: { onMoved: (oldPath: string, newPath: string) => void } = { onMoved: () => {} }

// ---- "Version history paused" reporting: once per registered listener ----
let pausedCb: ((reason: string) => void) | null = null
let pausedReported = false
let pausedReason: string | null = null

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
function pause(e: unknown) {
  if (pausedReported) return
  const reason = reasonOf(e)
  if (!pausedCb) {
    pausedReason ??= reason // nobody is listening yet: tell the first listener
    return
  }
  pausedReported = true
  try {
    pausedCb(reason)
  } catch {
    /* a listener must never break a save */
  }
}

/** The callback hears the reason once. Registering a new one starts a new "session". */
export function onHistoryPaused(cb: (reason: string) => void): void {
  pausedCb = cb
  pausedReported = false
  if (pausedReason !== null) {
    const r = pausedReason
    pausedReason = null
    pause(new Error(r))
  }
}

export const flushHistory = (): Promise<void> => idle()

// ---- reading ----
/** Versions of a file, oldest first. Throws if the index cannot be read (so callers do not mistake that for "none"). */
export function listVersions(file: string): HistoryVersion[] {
  return readIndex(historyKey(file), canonicalPath(file))?.versions ?? []
}

// ---- recording (caller holds the file's lock) ----
const authorKey = (a: Author) => `${a.by}:${a.name}`
function sameAuthors(a: Author[], b: Author[]) {
  const sa = new Set(a.map(authorKey))
  const sb = new Set(b.map(authorKey))
  return sa.size === sb.size && [...sa].every(k => sb.has(k))
}
function defaultSummary(authors: Author[], extra?: { baseline?: boolean }) {
  if (extra?.baseline) return 'Before gauzzaDocs'
  if (authors.length && authors.every(a => a.by === 'outside')) return 'Changed outside gauzzaDocs'
  return 'Edited'
}

/**
 * Records `bytes` as the next version of `file`. The caller holds the file's lock.
 * Skips (returns null) files that are excluded or over the size limit, and bytes identical to the latest version.
 * Folds into the latest version per the folding rules. `noFold` bypasses both the identical-bytes skip and folding.
 * Throws on storage errors: callers on the save path catch and report them as "paused".
 */
export async function recordVersion(
  file: string,
  bytes: Uint8Array,
  stat: { size: number; mtime: number },
  ctx: WriteContext,
  extra?: { restoredFrom?: number; beforeRestore?: boolean; baseline?: boolean; noFold?: boolean },
): Promise<HistoryVersion | null> {
  if (isExcluded(file) || bytes.length > LARGE_BYTES) return null
  const key = historyKey(file)
  const canon = canonicalPath(file)
  const hash = sha256(bytes)
  const idx = readIndex(key, canon) ?? { path: canon, versions: [] }
  const latest = idx.versions[idx.versions.length - 1]
  const noFold = !!extra?.noFold
  if (!noFold && latest && latest.hash === hash) return null
  const now = Date.now()
  await putObject(bytes, path.extname(file)) // the object exists before any index points at it
  const canFold =
    !noFold &&
    !!latest &&
    !latest.name &&
    !latest.baseline &&
    !latest.beforeRestore &&
    latest.restoredFrom === undefined &&
    !extra?.restoredFrom &&
    !extra?.baseline &&
    !extra?.beforeRestore &&
    sameAuthors(latest.authors, ctx.authors) &&
    now - latest.firstAt <= FOLD_MS
  let version: HistoryVersion
  if (canFold && latest) {
    Object.assign(latest, { at: now, hash, size: stat.size, mtime: stat.mtime, summary: ctx.summary ?? latest.summary })
    version = latest
  } else {
    version = {
      n: (latest?.n ?? 0) + 1,
      firstAt: now,
      at: now,
      hash,
      size: stat.size,
      mtime: stat.mtime,
      authors: ctx.authors.map(a => ({ ...a })),
      summary: ctx.summary ?? defaultSummary(ctx.authors, extra),
    }
    if (extra?.baseline) version.baseline = true
    if (extra?.beforeRestore) version.beforeRestore = true
    if (extra?.restoredFrom !== undefined) version.restoredFrom = extra.restoredFrom
    idx.versions.push(version)
  }
  writeIndex(key, idx)
  return version
}

/** Marks the latest version as the state before a restore. The caller holds the file's lock. */
export function markBeforeRestore(file: string): HistoryVersion | null {
  const key = historyKey(file)
  const idx = readIndex(key, canonicalPath(file))
  const latest = idx?.versions[idx.versions.length - 1]
  if (!idx || !latest) return null
  latest.beforeRestore = true
  writeIndex(key, idx)
  return latest
}

// ---- detection (caller holds the file's lock) ----
/** A missing file's history whose latest version has this hash moves to `canon`. Returns whether one was adopted. */
async function adoptMoved(canon: string, key: string, hash: string): Promise<boolean> {
  let best: { oldKey: string; oldPath: string; at: number } | null = null
  for (const p of listHistoryPaths()) {
    if (samePath(p, canon) || fs.existsSync(p)) continue
    const oldKey = historyKey(p)
    if (oldKey === key) continue
    let old
    try {
      old = readIndex(oldKey, p)
    } catch {
      continue
    }
    const last = old?.versions[old.versions.length - 1]
    if (last && last.hash === hash && (!best || last.at > best.at)) best = { oldKey, oldPath: old!.path, at: last.at }
  }
  if (!best) return false
  const { oldKey, oldPath } = best
  return withLock(oldKey, async () => {
    const old = readIndex(oldKey, oldPath)
    const last = old?.versions[old.versions.length - 1]
    if (!old || !last || last.hash !== hash || fs.existsSync(oldPath)) return false // changed while we looked
    writeIndex(key, { path: canon, versions: old.versions })
    const oldIndex = indexPath(oldKey)
    const oldLog = oldIndex.replace(/\.json$/, '.log.jsonl')
    try {
      fs.renameSync(oldLog, indexPath(key).replace(/\.json$/, '.log.jsonl'))
    } catch {
      /* no log, or the new one already has one */
    }
    for (const f of [oldIndex, `${oldIndex}.bak`]) fs.rmSync(f, { force: true })
    try {
      historyHooks.onMoved(oldPath, canon)
    } catch {
      /* a hook must never break recording */
    }
    return true
  })
}

/**
 * Looks at the file on disk before it is written over. With `baseline`, a file without history is kept as it is
 * (or takes over a moved file's history). Otherwise records an outside change. The caller holds the file's lock.
 */
async function inspect(file: string, baseline: boolean): Promise<HistoryVersion | null> {
  if (isExcluded(file)) return null
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null // a new file has nothing to keep
    throw e
  }
  if (!st.isFile() || st.size > LARGE_BYTES) return null
  const key = historyKey(file)
  const canon = canonicalPath(file)
  let idx = readIndex(key, canon)
  let latest = idx?.versions[idx.versions.length - 1]
  if (!latest) {
    if (!baseline) return null // opening or watching records nothing for a file with no history
    const bytes = await fs.promises.readFile(file)
    if (!(await adoptMoved(canon, key, sha256(bytes)))) {
      return recordVersion(file, bytes, { size: bytes.length, mtime: st.mtimeMs }, { authors: [OUTSIDE] }, { baseline: true, noFold: true })
    }
    idx = readIndex(key, canon)
    latest = idx?.versions[idx.versions.length - 1]
    if (!idx || !latest) return null
  }
  if (latest.size === st.size && latest.mtime === st.mtimeMs) return null
  const bytes = await fs.promises.readFile(file)
  if (sha256(bytes) === latest.hash) {
    latest.size = st.size // same content, touched only: remember it so it is not hashed again
    latest.mtime = st.mtimeMs
    writeIndex(key, idx!)
    return null
  }
  return recordVersion(file, bytes, { size: bytes.length, mtime: st.mtimeMs }, { authors: [OUTSIDE] })
}

/**
 * Records a change made by another program, if there is one. Used on load, before saves and by the folder watcher
 * (`low`: waits behind loads and saves). Never rejects: a history failure is reported as "paused" and gives null.
 */
export function checkOutside(file: string, opts: { low?: boolean } = {}): Promise<HistoryVersion | null> {
  return new Promise(resolve => {
    let key: string
    try {
      if (isExcluded(file)) return resolve(null)
      key = historyKey(file)
    } catch (e) {
      pause(e)
      return resolve(null)
    }
    enqueue(
      key,
      async () => {
        try {
          resolve(await withLock(key, () => inspect(file, false)))
        } catch (e) {
          pause(e)
          resolve(null)
        }
      },
      opts,
    )
  })
}

// ---- the write path ----
async function doWrite(file: string, write: () => Promise<Uint8Array>) {
  const bytes = await write()
  let stat: { size: number; mtime: number }
  try {
    const st = await fs.promises.stat(file)
    stat = { size: st.size, mtime: st.mtimeMs }
  } catch {
    stat = { size: bytes.length, mtime: Date.now() } // written, but cannot be looked at: still a successful save
  }
  return { bytes, stat }
}

/**
 * Every save goes through here. Holds the file's lock from before the write until the version is recorded,
 * records the baseline or an outside change first, calls `write` (which writes atomically and returns the bytes),
 * and resolves as soon as the write is done. Recording continues on the file's queue (see flushHistory).
 * A history failure never rejects or delays this: it is reported through onHistoryPaused. Only `write` can reject it.
 */
export function guardedWrite(file: string, ctx: WriteContext, write: () => Promise<Uint8Array>): Promise<{ size: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    const direct = async () => {
      try {
        resolve((await doWrite(file, write)).stat)
      } catch (e) {
        reject(e)
      }
    }
    let key: string
    try {
      if (isExcluded(file)) return void direct()
      key = historyKey(file)
    } catch (e) {
      pause(e)
      return void direct()
    }
    enqueue(key, async () => {
      let locked = false
      try {
        await withLock(key, async () => {
          locked = true
          let ok = true
          try {
            await inspect(file, true)
          } catch (e) {
            ok = false // the index is in an unknown state: write anyway, record nothing
            pause(e)
          }
          let done: { bytes: Uint8Array; stat: { size: number; mtime: number } }
          try {
            done = await doWrite(file, write)
          } catch (e) {
            reject(e)
            return
          }
          resolve(done.stat)
          if (!ok) return
          try {
            await recordVersion(file, done.bytes, done.stat, ctx)
          } catch (e) {
            pause(e)
          }
        })
      } catch (e) {
        pause(e)
        if (!locked) await direct() // no lock to be had: the save still happens
      }
    })
  })
}
