import fs from 'node:fs'
import path from 'node:path'
import { payloadBytes } from '../core/files'
import { getSettings } from '../core/paths'
import {
  COMPARE_MAX_BYTES,
  HISTORY_DIR,
  appendEvent,
  bakPath,
  checkOutside,
  cleanupHistory,
  compareVersions,
  enqueue,
  flushHistory,
  forgetHistory,
  historyKey,
  indexPath,
  listVersions,
  moveHistory,
  nameVersion,
  readLog,
  restoreVersion,
  showVersion,
  type Author,
  type CleanupResult,
  type HistoryEvent,
} from '../core/history'
import { reportHistoryFailure } from '../core/history/record'
import { extOf, stem } from '../shared/kinds'
import type { FilePayload } from '../shared/types'

/**
 * The version history jobs the file worker runs (worker.ts). Main and the window only ever reach the history store
 * through these, so the worker is the app's one history writer (CLI processes write directly, under the same locks).
 * Kept apart from worker.ts so they can be tested without a worker thread.
 */
type Job = (args: any[]) => unknown

const DEFAULT_CAP_MB = 1024

/** Runs `fn` on the file's history queue, after every save and recording already queued for it. */
function onQueue<T>(file: string, fn: () => Promise<T>, opts: { low?: boolean } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    enqueue(
      historyKey(file),
      async () => {
        try {
          resolve(await fn())
        } catch (e) {
          reject(e)
        }
      },
      opts,
    ),
  )
}

const versionNo = (n: unknown): number => {
  const v = typeof n === 'string' ? Number(n.replace(/^v/i, '')) : n
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`Not a version number: ${String(n)}`)
  return v
}

/** `<stem> (v<n>).<ext>` in `dir`, or `<stem> (v<n>) (2).<ext>` and so on when that name is taken. */
export function copyName(dir: string, file: string, n: number): string {
  const ext = extOf(file)
  const base = `${stem(file)} (v${n})`
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}${ext ? `.${ext}` : ''}`)
    if (!fs.existsSync(p)) return p
  }
}

export const capBytes = (): number => {
  const mb = getSettings().historyCapMB
  return (typeof mb === 'number' && mb > 0 ? mb : DEFAULT_CAP_MB) * 1024 * 1024
}

/** Everything the history store holds on disk: objects, indexes, logs. */
function storeBytes(): number {
  let total = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  walk(HISTORY_DIR)
  return total
}

let lastCleanup: CleanupResult | null = null
let cleaning: Promise<CleanupResult> | null = null

export const historyJobs: Record<string, Job> = {
  historyList: ([file]) => onQueue(file, async () => listVersions(file)),
  historyLog: ([file]) => onQueue(file, async () => readLog(file)),
  /** Changes from version a to version b, or to the file on disk now when b is left out. Not queued: a slow comparison must never hold up a save. */
  historyDiff: async ([file, a, b]) => {
    const versions = listVersions(file)
    const sizeOf = (n: number) => {
      const v = versions.find(x => x.n === n)
      if (!v) throw new Error(`${file} has no version ${n}.`)
      return v.size
    }
    const na = versionNo(a)
    const nb = b === undefined || b === null ? null : versionNo(b)
    if (sizeOf(na) > COMPARE_MAX_BYTES || (nb !== null && sizeOf(nb) > COMPARE_MAX_BYTES)) return { tooLarge: true }
    let now: Uint8Array
    if (nb !== null) now = await showVersion(file, nb)
    else {
      let st: fs.Stats
      try {
        st = await fs.promises.stat(file)
      } catch {
        throw new Error(`${file} is not on disk any more. Compare two of its versions instead.`)
      }
      if (st.size > COMPARE_MAX_BYTES) return { tooLarge: true }
      now = await fs.promises.readFile(file)
    }
    return compareVersions(file, await showVersion(file, na), now)
  },
  /**
   * opts: { unsavedPayload?, unsavedAuthors?, discardCurrent?, authors } (unsaved editor content arrives as a payload
   * and is turned into bytes here; unsavedAuthors made it, authors asked for the restore).
   */
  historyRestore: async ([file, n, opts]) => {
    const o = (opts ?? {}) as { unsavedPayload?: FilePayload; unsavedAuthors?: Author[]; discardCurrent?: boolean; authors?: Author[] }
    if (!Array.isArray(o.authors) || !o.authors.length) throw new Error('A restore needs to say who asked for it (authors).')
    const p = path.resolve(file)
    const v = versionNo(n)
    let unsaved = o.unsavedPayload ? await payloadBytes(p, o.unsavedPayload) : undefined
    if (unsaved && unsaved.length === 0 && o.unsavedPayload?.kind === 'pdf') unsaved = undefined // a PDF streamed from disk holds no bytes of its own
    const unsavedAuthors = Array.isArray(o.unsavedAuthors) && o.unsavedAuthors.length ? o.unsavedAuthors : undefined
    return onQueue(p, () => restoreVersion(p, v, { authors: o.authors!, unsaved, unsavedAuthors, discardCurrent: !!o.discardCurrent }))
  },
  historyName: ([file, n, name, by]) => {
    if (typeof by !== 'string' || !by) throw new Error('Naming a version needs to say who named it.')
    const v = versionNo(n)
    return onQueue(file, () => nameVersion(file, v, String(name ?? ''), by))
  },
  /** Not queued: forgetHistory first waits for every queued history job, so it would wait on itself. */
  historyForget: ([file]) => forgetHistory(file),
  /**
   * `by`: who renamed it (the person for a rename in the app; "outside gauzzaDocs" when left out). Waits for every
   * queued job first: a folder move carries the history of files that may still be recording.
   */
  historyMove: async ([from, to, by]) => {
    await flushHistory()
    return onQueue(from, () => moveHistory(from, to, typeof by === 'string' && by ? by : undefined))
  },
  historyCheck: ([file]) => checkOutside(path.resolve(file), { low: true }),
  /**
   * The folder watcher's changed paths, in one batch: only files that already have a history are looked at, each as a
   * low-priority outside check. The hashing for that filter happens here, never on main's thread.
   */
  historyCheckChanged: async ([files]) => {
    const checks: Promise<unknown>[] = []
    let i = 0
    for (const f of new Set((files as string[]) ?? [])) {
      if (++i % 50 === 0) await new Promise(r => setImmediate(r)) // a big checkout: let saves through meanwhile
      try {
        const key = historyKey(f)
        if (fs.existsSync(indexPath(key)) || fs.existsSync(bakPath(key))) checks.push(checkOutside(path.resolve(f), { low: true }))
      } catch {
        /* nothing to look at */
      }
    }
    await Promise.all(checks)
    return checks.length
  },
  /** A work history event from main ({ type, by, summary, at? }). A failure is a history failure: reported, never thrown. */
  historyEvent: ([file, ev]) => {
    const e = (ev ?? {}) as Partial<HistoryEvent>
    if (typeof e.type !== 'string' || typeof e.by !== 'string' || typeof e.summary !== 'string')
      throw new Error('A work history event needs a type, a by and a summary.')
    const event = { ...e, at: e.at ?? Date.now() } as HistoryEvent // an explicit at: undefined still gets stamped
    return onQueue(file, async () => {
      try {
        await appendEvent(file, event)
      } catch (err) {
        reportHistoryFailure(err)
      }
    })
  },
  historyCleanup: async () => {
    cleaning ??= cleanupHistory(Date.now(), capBytes())
      .then(r => (lastCleanup = r))
      .finally(() => (cleaning = null))
    return cleaning
  },
  /** overCapBytes: what the last cleanup could not get under the cap (versions it must keep). */
  historyStats: () => {
    const stats: { bytes: number; capBytes: number; overCapBytes?: number } = { bytes: storeBytes(), capBytes: capBytes() }
    if (lastCleanup?.overCapBytes) stats.overCapBytes = lastCleanup.overCapBytes
    return stats
  },
  historyFlush: () => flushHistory(),
  /** Writes version n, exactly as stored, to a new file in the docs folder and returns its path. */
  historyOpenCopy: async ([file, n]) => {
    const bytes = await showVersion(file, versionNo(n))
    const dir = getSettings().docsDir
    await fs.promises.mkdir(dir, { recursive: true })
    const dest = copyName(dir, file, versionNo(n))
    await fs.promises.writeFile(dest, bytes, { flag: 'wx' }) // never over an existing file
    return dest
  },
}
