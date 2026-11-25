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
  extra?: { restoredFrom?: number; beforeRestore?: boolean; baseline?: boolean; noFold?: boolean; at?: number },
): Promise<HistoryVersion | null> {
  if (isExcluded(file) || bytes.length > LARGE_BYTES) return null
  const key = historyKey(file)
  const canon = canonicalPath(file)
  const hash = sha256(bytes)
  const idx = readIndex(key, canon) ?? { path: canon, versions: [] }
  const latest = idx.versions[idx.versions.length - 1]
  const noFold = !!extra?.noFold
  if (!noFold && latest && latest.hash === hash) return null
  const now = extra?.at ?? Date.now()
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


// ---- detection and deferred work (caller holds the file's lock) ----
/** A file is only "missing" when its drive and folder are reachable and it is not there (a disconnected drive is not a move). */
const reallyMissing = (p: string) => fs.existsSync(path.parse(p).root) && fs.existsSync(path.dirname(p)) && !fs.existsSync(p)

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

/** The file as it was before gauzzaDocs first wrote it. Only the bytes are taken before the write; the rest waits. */
interface Captured {
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
  await recordVersion(file, cap.bytes, { size: cap.bytes.length, mtime: cap.mtime }, { authors: [OUTSIDE] }, { baseline: true, noFold: true })
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
    if (onBaseline) onBaseline({ bytes: await fs.promises.readFile(file), mtime: st.mtimeMs }) // opening or watching records nothing
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
          resolve(await withLock(key, async () => ((await flushPending(file, key)) ? null : inspect(file))))
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
        })
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
