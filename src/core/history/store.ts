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
const STORED_AS_IS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip'])

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

/** The path a file's history is keyed on: real path, lowercased on Windows only. */
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
  return process.platform === 'win32' ? real.toLowerCase() : real
}
export const historyKey = (file: string) => sha256(canonicalPath(file))

export const objectPath = (hash: string) => path.join(OBJECTS_DIR, hash.slice(0, 2), hash)
export const indexPath = (key: string) => path.join(FILES_DIR, `${key}.json`)
const bakPath = (key: string) => `${indexPath(key)}.bak`
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
function renameRetrySync(from: string, to: string) {
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

export async function putObject(bytes: Uint8Array, ext: string): Promise<string> {
  const hash = sha256(bytes)
  const dest = objectPath(hash)
  try {
    const now = new Date()
    await fs.promises.utimes(dest, now, now) // already stored: keep it fresh so cleanup leaves it alone
    return hash
  } catch {
    /* not stored yet */
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  const stored = STORED_AS_IS.has(ext.replace(/^\./, '').toLowerCase()) ? bytes : zlib.gzipSync(bytes)
  await writeAtomic(dest, stored)
  return hash
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
  } catch {
    return undefined // missing
  }
  try {
    const x = JSON.parse(text)
    return validIndex(x) ? x : null
  } catch {
    return null // corrupt
  }
}

/** The saved index, or null. A corrupt index is set aside (never overwritten) and the .bak is used instead. */
export function readIndex(key: string, expectedPath?: string): HistoryIndex | null {
  let idx = parseIndex(indexPath(key))
  if (idx === null) {
    try {
      fs.renameSync(indexPath(key), `${indexPath(key)}.corrupt-${Date.now()}`)
    } catch {
      /* keep going with the backup */
    }
  }
  if (!idx) idx = parseIndex(bakPath(key)) ?? null
  if (!idx) return null
  if (expectedPath !== undefined && !samePath(idx.path, expectedPath)) return null
  return idx
}

export function writeIndex(key: string, index: HistoryIndex): void {
  const file = indexPath(key)
  fs.mkdirSync(FILES_DIR, { recursive: true })
  if (parseIndex(file)) fs.copyFileSync(file, bakPath(key)) // keep the last good one
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
function lockIsStale(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const l = JSON.parse(raw) as { pid?: number; at?: number }
    if (typeof l.pid !== 'number' || typeof l.at !== 'number') return true
    return Date.now() - l.at > LOCK_STALE_MS || !alive(l.pid)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    try {
      return Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS // unreadable content: go by age
    } catch {
      return false
    }
  }
}

/** One writer at a time per file history, across processes. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const file = lockPath(key)
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (lockIsStale(file)) {
        const aside = `${file}.stale-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
        try {
          fs.renameSync(file, aside) // only one taker wins the rename
          fs.rmSync(aside, { force: true })
        } catch {
          /* someone else took it over */
        }
        continue
      }
      if (Date.now() >= until) throw new Error(`Timed out waiting for the history lock (${key})`)
      await sleep(LOCK_RETRY_MS)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const globToRegExp = (g: string) => new RegExp(`^${g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

/** Secret files are never versioned: names match the pattern list, or sit under .ssh, .aws, .gnupg, .azure. */
export function isExcluded(file: string, patterns: string[] = getSettings().historyExclude ?? DEFAULT_EXCLUDE): boolean {
  const parts = file.split(/[\\/]+/).filter(Boolean)
  if (parts.some(p => EXCLUDED_DIRS.has(p.toLowerCase()))) return true
  const base = parts[parts.length - 1] ?? ''
  return patterns.some(p => globToRegExp(p).test(base))
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
    const idx = parseIndex(indexPath(k)) || parseIndex(bakPath(k)) // a set-aside index still has its backup
    if (idx) out.push(idx.path)
  }
  return out
}
