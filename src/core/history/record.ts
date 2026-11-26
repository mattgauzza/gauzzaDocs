import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LARGE_BYTES } from '../large'
import { samePath } from '../paths'
import { appendEventLocked, type HistoryEvent } from './log'
import { enqueue, idle } from './queue'
import {
  HISTORY_DIR,
  bakPath,
  canonicalPath,
  historyKey,
  indexPath,
  isExcluded,
  isHash,
  listHistoryPaths,
  logPath,
  objectPath,
  readIndex,
  renameRetrySync,
  storeObject,
  withLock,
  volumeReachable,
  writeAtomic,
  writeIndex,
  type Author,
  type HistoryIndex,
  type HistoryVersion,
  type ObjectStamp,
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

/**
 * Why history paused, as a plain sentence: the app shows it after "Version history paused: " (a toast, and in
 * Settings). File system errors say what is wrong in words; our own errors (and reasons replayed from earlier) are
 * already sentences and pass through.
 */
export function pauseReasonText(e: unknown): string {
  const code = typeof (e as NodeJS.ErrnoException)?.code === 'string' ? (e as NodeJS.ErrnoException).code! : ''
  switch (code) {
    case 'ENOSPC':
      return 'the disk is full'
    case 'EROFS':
      return 'the disk is read-only'
    case 'EACCES':
    case 'EPERM':
      return `gauzzaDocs can't write to ${HISTORY_DIR}`
    case 'ENOTDIR':
      return `gauzzaDocs can't make its folders in ${HISTORY_DIR}: a file is in the way`
  }
  if (code) return `gauzzaDocs can't write to ${HISTORY_DIR} (${code})`
  return e instanceof Error ? e.message : String(e)
}
const reasonOf = pauseReasonText
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

/** Reports a history failure that must not fail the caller (shown once as "Version history paused"). */
export const reportHistoryFailure = (e: unknown): void => pause(e)

/**
 * Appends a work history event for a caller that holds the file's lock. A log failure is a history failure: it is
 * reported as "paused" and never thrown.
 */
export async function logEventLocked(file: string, ev: Omit<HistoryEvent, 'at'> & { at?: number }): Promise<void> {
  try {
    await appendEventLocked(file, { at: Date.now(), ...ev })
  } catch (e) {
    pause(e)
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
 * The object each file's latest record in this process stored, and when that record created it, its stamp (inode
 * and mtime). A record made by another process is not known here: its object is left for cleanup.
 */
const lastStored = new Map<string, { hash: string; created: boolean; stamp?: ObjectStamp }>()

/**
 * After a fold replaced the latest version's object, deletes that object right away when only this file used it and
 * nothing touched it since this file wrote it. Every autosave would otherwise leave a whole copy of the file on disk
 * for a day, outside the size cap. Caller holds the file's lock and has written the new index.
 * No other history can use the object while its inode and mtime both still equal the stamp this file's record took
 * when it created it: another history can only start using an object through storeObject, which never replaces an
 * existing object and moves its mtime strictly later (and any rewrite is a new inode). That is checked here rather
 * than by reading every index in the store, which takes a second with a thousand histories (on every autosave).
 * The object is moved aside before it is judged, so nobody can start reusing it in between: a reuse that finds it
 * gone stores its own copy. Best effort: anything uncertain keeps the object, and cleanup's 24 hour rule covers it.
 */
async function dropReplaced(key: string, idx: HistoryIndex, replaced: string, seen: { hash: string; created: boolean; stamp?: ObjectStamp } | undefined) {
  try {
    if (!isHash(replaced) || seen?.hash !== replaced || !seen.created || !seen.stamp) return // no stamp: inodes cannot be trusted here
    if (idx.versions.some(v => v.hash === replaced)) return // an earlier version of this file has the same content
    await writeAtomic(bakPath(key), fs.readFileSync(indexPath(key))) // the .bak must not point at it either
    const obj = objectPath(replaced)
    const aside = path.join(path.dirname(obj), `.${replaced}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.drop.tmp`)
    fs.renameSync(obj, aside) // gone or held: leave it
    let st: fs.BigIntStats | null = null
    try {
      st = fs.statSync(aside, { bigint: true })
    } catch {
      /* cannot tell: put it back */
    }
    if (st && st.ino === seen.stamp.ino && st.mtimeNs === seen.stamp.mtimeNs) {
      fs.rmSync(aside, { force: true })
      try {
        fs.rmdirSync(path.dirname(obj)) // only when empty
      } catch {
        /* not empty */
      }
      return
    }
    // Reused by another history since: theirs now. Back where it was, unless a fresh copy is already there.
    try {
      fs.linkSync(aside, obj)
    } catch {
      if (!fs.existsSync(obj)) renameRetrySync(aside, obj)
    }
    fs.rmSync(aside, { force: true })
  } catch {
    /* left for cleanup */
  }
}

/**
 * Records `bytes` as the next version of `file`. The caller holds the file's lock.
 * Skips (returns null) files that are excluded or over the size limit, and bytes identical to the latest version.
 * Folds into the latest version per the folding rules. `noFold` only turns folding off: identical bytes are always skipped.
 * Throws on storage errors: callers on the save path catch and report them as "paused".
 */
export async function recordVersion(
  file: string,
  bytes: Uint8Array,
  stat: { size: number; mtime: number },
  ctx: WriteContext,
  extra?: { restoredFrom?: number; beforeRestore?: boolean; baseline?: boolean; noFold?: boolean; at?: number },
): Promise<HistoryVersion | null> {
  if (isExcluded(file) || bytes.length > LARGE_BYTES) return null
  const key = historyKey(file)
  const canon = canonicalPath(file)
  const hash = sha256(bytes)
  const idx = readIndex(key, canon) ?? { path: canon, versions: [] }
  idx.path = canon // its real case (indexes from before kept it lowercased on Windows)
  const latest = idx.versions[idx.versions.length - 1]
  const noFold = !!extra?.noFold
  if (latest && latest.hash === hash) return null
  const now = extra?.at ?? Date.now()
  const seen = lastStored.get(key)
  lastStored.set(key, await storeObject(bytes, path.extname(file))) // the object exists before any index points at it
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
  let replaced: string | null = null
  if (canFold && latest) {
    replaced = latest.hash
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
  if (replaced) await dropReplaced(key, idx, replaced, seen)
  if (extra?.restoredFrom === undefined) {
    // restoreVersion logs its own "restored" event
    const outside = ctx.authors.length > 0 && ctx.authors.every(a => a.by === 'outside')
    await logEventLocked(file, {
      at: now,
      type: outside ? 'outside' : 'save',
      by: ctx.authors.map(a => a.name).join(', '),
      v: version.n,
      summary: extra?.baseline ? `kept the original as v${version.n}` : outside ? `changed outside gauzzaDocs, kept as v${version.n}` : `saved v${version.n}`,
    })
  }
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


// ---- detection and deferred work (caller holds the file's lock) ----
/** A file is only "missing" when its drive or share is reachable and it is not there (a disconnected drive is not a move). The folder may be gone: it may have been renamed. */
const reallyMissing = (p: string) => volumeReachable(p) && !fs.existsSync(p)

/** A missing file's history whose latest version has this hash moves to `canon`. Returns whether one was adopted. */
async function adoptMoved(canon: string, key: string, hash: string): Promise<boolean> {
  let best: { oldKey: string; oldPath: string; at: number } | null = null
  for (const p of listHistoryPaths()) {
    if (samePath(p, canon) || !reallyMissing(p)) continue
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
    if (!old || !last || last.hash !== hash || !reallyMissing(oldPath)) return false // changed while we looked
    writeIndex(key, { path: canon, versions: old.versions })
    const oldIndex = indexPath(oldKey)
    try {
      renameRetrySync(logPath(oldKey), logPath(key)) // replaces a log the new path already has: the moved history's log is the true one
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') pause(e) // no log is fine; a log that cannot be moved is a history failure
    }
    for (const f of [oldIndex, `${oldIndex}.bak`]) fs.rmSync(f, { force: true })
    await logEventLocked(canon, { type: 'moved', by: 'outside gauzzaDocs', summary: `moved from ${oldPath}` }) // we hold the new path's lock too
    try {
      historyHooks.onMoved(oldPath, canon)
    } catch {
      /* a hook must never break recording */
    }
    return true
  }, oldPath)
}

/** The file as it was before gauzzaDocs first wrote it. Only the bytes are taken before the write; the rest waits. */
interface Captured {
  at: number // when it was taken, so the baseline keeps its place before the write that follows
  bytes: Uint8Array
  mtime: number
}
interface Own {
  bytes: Uint8Array
  stat: { size: number; mtime: number }
  ctx: WriteContext
  at: number // when it was written, not when it got recorded
}
interface Pending {
  baseline?: Captured
  own: Own[]
}
/** Work that could not be recorded yet (history trouble). The next locked job for the file does it first, in order. */
const pending = new Map<string, Pending>()
const MAX_PENDING_OWN = 20

/** Drops work still waiting to be recorded for this file (its history is being forgotten). */
export const discardPending = (file: string): void => void pending.delete(historyKey(file))

function stash(key: string, own?: Own, baseline?: Captured) {
  const p = pending.get(key) ?? { own: [] }
  if (baseline) p.baseline = baseline
  if (own && own.bytes.length <= LARGE_BYTES) {
    p.own.push(own)
    if (p.own.length > MAX_PENDING_OWN) p.own.shift()
  }
  if (p.baseline || p.own.length) pending.set(key, p)
}

/** Keeps the original as the baseline, or lets it take over a moved file's history. Hashing and compressing happen here. */
async function baselineStep(file: string, cap: Captured): Promise<void> {
  const key = historyKey(file)
  const canon = canonicalPath(file)
  if (readIndex(key, canon)?.versions.length) return // history appeared meanwhile: not a first write any more
  if (cap.bytes.length > 0 && (await adoptMoved(canon, key, sha256(cap.bytes)))) return
  await recordVersion(file, cap.bytes, { size: cap.bytes.length, mtime: cap.mtime }, { authors: [OUTSIDE] }, { baseline: true, noFold: true, at: cap.at })
}

/** Records what an earlier failure left unrecorded. Returns true when something is still stuck (do not record or inspect now). */
async function flushPending(file: string, key: string): Promise<boolean> {
  const p = pending.get(key)
  if (!p) return false
  try {
    if (p.baseline) {
      await baselineStep(file, p.baseline)
      p.baseline = undefined
    }
    while (p.own.length) {
      const o = p.own[0]
      await recordVersion(file, o.bytes, o.stat, o.ctx, { at: o.at })
      p.own.shift()
    }
  } catch (e) {
    pause(e)
    return true
  }
  pending.delete(key)
  return false
}

/**
 * Records what an earlier history failure left unrecorded for this file, credited to whoever wrote it. The caller
 * holds the file's lock. Returns true when something is still stuck.
 */
export const flushPendingLocked = (file: string): Promise<boolean> => flushPending(file, historyKey(file))

/**
 * Looks at the file on disk before it is written over and records an outside change. With `onBaseline`, a file
 * without history hands its current bytes to the callback instead (to be kept after the write). Caller holds the lock.
 */
async function inspect(file: string, onBaseline?: (c: Captured) => void): Promise<HistoryVersion | null> {
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
  const idx = readIndex(key, canonicalPath(file))
  const latest = idx?.versions[idx.versions.length - 1]
  if (!idx || !latest) {
    if (onBaseline) onBaseline({ at: Date.now(), bytes: await fs.promises.readFile(file), mtime: st.mtimeMs }) // opening or watching records nothing
    return null
  }
  if (latest.size === st.size && latest.mtime === st.mtimeMs) return null
  const bytes = await fs.promises.readFile(file)
  if (sha256(bytes) === latest.hash) {
    latest.size = st.size // same content, touched only: remember it so it is not hashed again
    latest.mtime = st.mtimeMs
    writeIndex(key, idx)
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
          resolve(await withLock(key, async () => ((await flushPending(file, key)) ? null : inspect(file)), file))
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
 * checks for an outside change, calls `write` (which writes atomically and returns the bytes), and resolves as soon
 * as the write is done. Only after that does it keep the baseline (hash, compress) and record the new version, on
 * the file's queue (see flushHistory). A history failure never rejects or delays this: it is reported through
 * onHistoryPaused, and whatever could not be recorded is kept in memory and recorded, credited to its real authors,
 * by the next job for the file. Only `write` can reject it.
 */
export function guardedWrite(file: string, ctx: WriteContext, write: () => Promise<Uint8Array>): Promise<{ size: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    const direct = async () => {
      try {
        const done = await doWrite(file, write)
        resolve(done.stat)
        return done
      } catch (e) {
        reject(e)
        return null
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
          const blocked = await flushPending(file, key) // earlier writes first, so they are never taken for outside changes
          let captured: Captured | undefined
          if (!blocked) {
            try {
              await inspect(file, c => (captured = c))
            } catch (e) {
              pause(e)
            }
          }
          let done: { bytes: Uint8Array; stat: { size: number; mtime: number } }
          try {
            done = await doWrite(file, write)
          } catch (e) {
            reject(e)
            return
          }
          const at = Date.now()
          resolve(done.stat)
          await new Promise<void>(r => setImmediate(r)) // let the caller carry on before the heavy work
          const own: Own = { bytes: done.bytes, stat: done.stat, ctx, at }
          if (blocked) return stash(key, own)
          const cap = captured as Captured | undefined
          if (cap) {
            try {
              await baselineStep(file, cap)
            } catch (e) {
              pause(e)
              return stash(key, own, cap) // the baseline must come first when it is retried
            }
          }
          try {
            await recordVersion(file, own.bytes, own.stat, ctx, { at })
          } catch (e) {
            pause(e)
            stash(key, own)
          }
        }, file)
      } catch (e) {
        pause(e)
        if (!locked) {
          const done = await direct() // no lock to be had: the save still happens
          if (done) stash(key, { bytes: done.bytes, stat: done.stat, ctx, at: Date.now() })
        }
      }
    })
  })
}
