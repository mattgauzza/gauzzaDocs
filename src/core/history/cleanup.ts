import fs from 'node:fs'
import path from 'node:path'
import { HISTORY_DIR, indexPath, bakPath, logPath, withLock, writeAtomic, writeIndex, type HistoryIndex, type HistoryVersion } from './store'

const DAY = 24 * 60 * 60 * 1000
const FILES_DIR = path.join(HISTORY_DIR, 'files')
const OBJECTS_DIR = path.join(HISTORY_DIR, 'objects')
const KEEP_ALL_MS = 30 * DAY
const KEEP_DAILY_MS = 365 * DAY
const PROTECT_MS = 7 * DAY
const GONE_MS = 90 * DAY
const ASIDE_MS = 30 * DAY // a set-aside corrupt index may still be the only record of what its objects were for
const FRESH_MS = DAY // objects and temp files younger than this may belong to a writer in flight

/** Test seam: runs after the first scan and before any index is rewritten. */
export const cleanupHooks: { afterScan?: () => void | Promise<void> } = {}

export interface CleanupResult {
  removedVersions: number
  freedBytes: number
  overCapBytes?: number
  skipped?: 'corrupt-index'
}

type Mode = 'normal' | 'early' | 'protected'

/** Index state: a parsed index, undefined when missing, null when it cannot be trusted. */
function parse(file: string): HistoryIndex | undefined | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null
  }
  try {
    const x = JSON.parse(text) as HistoryIndex
    return x && typeof x.path === 'string' && Array.isArray(x.versions) ? x : null
  } catch {
    return null
  }
}

const readdir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

interface Scan {
  bad: boolean
  json: Map<string, HistoryIndex> // keys with a readable index
  bakOnly: Map<string, HistoryIndex>
  refs: Set<string>
  names: string[]
}

/** Reads every index and .bak directly. Unlike listHistoryPaths, an unreadable one is reported, not skipped. */
function scan(): Scan {
  const names = readdir(FILES_DIR)
  const keys = new Set<string>()
  for (const n of names) {
    const m = n.match(/^(.+)\.json(\.bak)?$/)
    if (m) keys.add(m[1])
  }
  const out: Scan = { bad: false, json: new Map(), bakOnly: new Map(), refs: new Set(), names }
  for (const key of keys) {
    const idx = parse(indexPath(key))
    const bak = parse(bakPath(key))
    if (idx === null || bak === null) out.bad = true
    for (const i of [idx, bak]) for (const v of i?.versions ?? []) out.refs.add(v.hash)
    if (idx) out.json.set(key, idx)
    else if (bak) out.bakOnly.set(key, bak)
  }
  return out
}

const isProtected = (v: HistoryVersion, last: HistoryVersion | undefined, now: number) =>
  v === last || !!v.baseline || !!v.name || now - v.at < PROTECT_MS

const monthOf = (at: number) => {
  const d = new Date(at)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}
/** The retention bucket a timestamp falls in, or null when everything in its age range is kept. */
function bucketOf(at: number, now: number, mode: Mode): string | null {
  const age = now - at
  if (age > KEEP_DAILY_MS) return `m${monthOf(at)}`
  if (age > KEEP_ALL_MS || (mode === 'early' && age > PROTECT_MS)) return `d${Math.floor(at / DAY)}`
  return null
}

/** The versions that remain. Protected ones always do; of the rest, the newest in each bucket does. */
function thin(versions: HistoryVersion[], now: number, mode: Mode, gone: boolean): HistoryVersion[] {
  if (gone) return versions.filter(v => !!v.name)
  const last = versions[versions.length - 1]
  const keep = new Set<HistoryVersion>()
  const taken = new Set<string>()
  for (const v of versions) {
    if (!isProtected(v, last, now)) continue
    keep.add(v)
    const b = bucketOf(v.at, now, mode)
    if (b) taken.add(b)
  }
  for (const v of [...versions].sort((a, b) => b.at - a.at)) {
    if (keep.has(v)) continue
    if (mode === 'protected') continue
    const b = bucketOf(v.at, now, mode)
    if (b === null) keep.add(v)
    else if (!taken.has(b)) (taken.add(b), keep.add(v))
  }
  return versions.filter(v => keep.has(v))
}

/** True only when the file's folder is reachable and the file is not in it, and it was last known 90 days ago. */
function isGone(idx: HistoryIndex, indexFile: string, now: number): boolean {
  try {
    if (!fs.statSync(path.dirname(idx.path)).isDirectory()) return false
  } catch {
    return false // unreachable (missing drive, share, folder): never gone
  }
  try {
    fs.lstatSync(idx.path)
    return false
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  let known = idx.versions[idx.versions.length - 1]?.at
  if (known === undefined) {
    try {
      known = fs.statSync(indexFile).mtimeMs
    } catch {
      return false
    }
  }
  return now - known > GONE_MS
}

const asideTime = (name: string, dir: string): number | null => {
  const m = name.match(/\.corrupt-(\d+)$/)
  if (!m) return null
  const t = Number(m[1])
  if (Number.isFinite(t) && t > 0) return t
  try {
    return fs.statSync(path.join(dir, name)).mtimeMs
  } catch {
    return null
  }
}

/** Log events follow the version rules: all for 30 days, then one per day, after a year one per month. */
function thinLog(text: string, now: number): string {
  const events: { at: number; line: string }[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line) as { at?: unknown }
      if (typeof e.at === 'number') events.push({ at: e.at, line })
    } catch {
      /* unreadable line: readers skip it, so it goes */
    }
  }
  const taken = new Set<string>()
  const keep = new Set<number>()
  for (let i = events.length - 1; i >= 0; i--) {
    const b = bucketOf(events[i].at, now, 'normal')
    if (b === null) keep.add(i)
    else if (!taken.has(b)) (taken.add(b), keep.add(i))
  }
  const kept = events.filter((_, i) => keep.has(i))
  return kept.length ? kept.map(e => e.line).join('\n') + '\n' : ''
}

const objectFiles = (): { hash: string; file: string; size: number; mtime: number }[] => {
  const out: { hash: string; file: string; size: number; mtime: number }[] = []
  for (const d of readdir(OBJECTS_DIR)) {
    const dir = path.join(OBJECTS_DIR, d)
    for (const n of readdir(dir)) {
      if (!/^[0-9a-f]{64}$/.test(n)) continue
      try {
        const st = fs.statSync(path.join(dir, n))
        if (st.isFile()) out.push({ hash: n, file: path.join(dir, n), size: st.size, mtime: st.mtimeMs })
      } catch {
        /* gone since listing */
      }
    }
  }
  return out
}

/** Sweeps old temp files, lock set-asides and stale corrupt set-asides. Returns bytes freed. */
function sweep(dir: string, now: number): number {
  let freed = 0
  for (const n of readdir(dir)) {
    const f = path.join(dir, n)
    let old = false
    try {
      const st = fs.statSync(f)
      if (!st.isFile()) continue
      const aside = asideTime(n, dir)
      if (aside !== null) old = now - aside > ASIDE_MS
      else if (n.endsWith('.tmp') || n.includes('.lock.stale-')) old = now - st.mtimeMs > FRESH_MS
      else continue
      if (!old) continue
      fs.rmSync(f, { force: true })
      freed += st.size
    } catch {
      /* in use or gone: next run */
    }
  }
  return freed
}

/**
 * Retention and the size cap. Thins versions and log events, removes history of files gone 90 days, then deletes
 * objects nothing refers to. Reads every index directly and does nothing at all if any cannot be read.
 */
export async function cleanupHistory(now: number, capBytes: number): Promise<CleanupResult> {
  const first = scan()
  if (first.bad) return { removedVersions: 0, freedBytes: 0, skipped: 'corrupt-index' }

  const blocked = first.names.some(n => {
    if (!/\.json\.corrupt-\d+$/.test(n)) return false
    const t = asideTime(n, FILES_DIR)
    return t === null || now - t <= ASIDE_MS
  })

  // Plan: which mode each file gets, so the biggest files are thinned first when over the cap.
  const sizes = new Map<string, number>()
  const recent = new Set<string>()
  for (const o of objectFiles()) {
    sizes.set(o.hash, o.size)
    if (now - o.mtime < FRESH_MS) recent.add(o.hash)
  }
  const gone = new Map<string, boolean>()
  for (const [key, idx] of first.json) gone.set(key, isGone(idx, indexPath(key), now))
  const modes = new Map<string, Mode>([...first.json.keys()].map(k => [k, 'normal']))
  const planned = (key: string) => thin(first.json.get(key)!.versions, now, modes.get(key)!, gone.get(key)!)
  const usage = () => {
    const refs = new Map<string, Set<string>>()
    const all = new Set<string>()
    for (const key of first.json.keys()) {
      const hs = new Set(planned(key).map(v => v.hash))
      refs.set(key, hs)
      for (const h of hs) all.add(h)
    }
    for (const idx of first.bakOnly.values()) for (const v of idx.versions) all.add(v.hash)
    let total = 0
    for (const [h, s] of sizes) if (all.has(h) || recent.has(h)) total += s
    return { total, refs }
  }
  if (!blocked) {
    for (const stage of ['early', 'protected'] as const) {
      let u = usage()
      if (u.total <= capBytes) break
      const bySpace = [...first.json.keys()]
        .map(key => ({ key, bytes: [...u.refs.get(key)!].reduce((a, h) => a + (sizes.get(h) ?? 0), 0) }))
        .sort((a, b) => b.bytes - a.bytes)
      for (const { key } of bySpace) {
        modes.set(key, stage)
        u = usage()
        if (u.total <= capBytes) break
      }
    }
  }

  await cleanupHooks.afterScan?.()

  // Rewrite each index under its own lock, from a fresh read, so a save that landed since the scan is kept.
  let removedVersions = 0
  let freedBytes = 0
  let bad = false
  for (const key of first.json.keys()) {
    try {
      await withLock(key, async () => {
        const idx = parse(indexPath(key))
        if (idx === null) return void (bad = true)
        if (!idx) return
        const isGoneNow = isGone(idx, indexPath(key), now)
        const versions = thin(idx.versions, now, modes.get(key)!, isGoneNow)
        if (isGoneNow && versions.length === 0) {
          removedVersions += idx.versions.length
          for (const f of [indexPath(key), bakPath(key), logPath(key)]) {
            try {
              freedBytes += fs.statSync(f).size
            } catch {
              /* not there */
            }
            fs.rmSync(f, { force: true })
          }
          return
        }
        if (versions.length !== idx.versions.length) {
          removedVersions += idx.versions.length - versions.length
          writeIndex(key, { ...idx, versions })
          fs.copyFileSync(indexPath(key), bakPath(key)) // the .bak must not keep the thinned versions' objects alive
        }
        try {
          const text = fs.readFileSync(logPath(key), 'utf8')
          const next = thinLog(text, now)
          if (next !== text) {
            if (next) await writeAtomic(logPath(key), Buffer.from(next))
            else fs.rmSync(logPath(key), { force: true })
            freedBytes += Buffer.byteLength(text) - Buffer.byteLength(next)
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      })
    } catch {
      /* busy or failing: leave this one for the next run */
    }
  }

  // Objects: a fresh scan decides what is referenced; nothing recent, and nothing while a corrupt index may still need it.
  const second = scan()
  if (bad || second.bad) return { removedVersions, freedBytes, skipped: 'corrupt-index' }
  if (!blocked) {
    for (const o of objectFiles()) {
      if (second.refs.has(o.hash) || now - o.mtime < FRESH_MS) continue
      try {
        fs.rmSync(o.file, { force: true })
        freedBytes += o.size
        try {
          fs.rmdirSync(path.dirname(o.file)) // only when empty
        } catch {
          /* not empty */
        }
      } catch {
        /* in use: next run */
      }
    }
  }
  freedBytes += sweep(FILES_DIR, now)
  for (const d of readdir(OBJECTS_DIR)) freedBytes += sweep(path.join(OBJECTS_DIR, d), now)

  const total = objectFiles().reduce((a, o) => a + o.size, 0)
  return total > capBytes ? { removedVersions, freedBytes, overCapBytes: total - capBytes } : { removedVersions, freedBytes }
}
