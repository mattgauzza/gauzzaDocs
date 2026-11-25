import fs from 'node:fs'

/**
 * Huge text/CSV files are never read into memory whole. One streaming pass records the byte offset of every
 * STEP-th line (a 2 GB log with 20M lines needs ~160 KB of index); after that any window of lines is read
 * straight from disk, starting at the nearest checkpoint.
 */
export const LARGE_BYTES = Number(process.env.GAUZZADOCS_LARGE_MB || 32) * 1024 * 1024
const STEP = 1024
const CHUNK = 1 << 20

export interface LargeIndex {
  path: string
  size: number
  mtime: number
  lines: number
  checkpoints: number[] // byte offset of line k*STEP
  crlf: boolean
  done: boolean
}

const indexes = new Map<string, LargeIndex>()
const building = new Map<string, Promise<LargeIndex>>()

export const isLarge = (file: string) => {
  try {
    return fs.statSync(file).size > LARGE_BYTES
  } catch {
    return false
  }
}

/** Builds (or returns the cached) line index. `onProgress` gets the fraction read so far. */
export function indexFile(file: string, onProgress?: (f: number) => void): Promise<LargeIndex> {
  const stat = fs.statSync(file)
  const cached = indexes.get(file)
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return Promise.resolve(cached)
  const pending = building.get(file)
  if (pending) return pending
  const p = new Promise<LargeIndex>((resolve, reject) => {
    const idx: LargeIndex = { path: file, size: stat.size, mtime: stat.mtimeMs, lines: 1, checkpoints: [0], crlf: false, done: false }
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = 0
    let line = 0
    let lastReport = 0
    try {
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK, pos)
        if (!n) break
        for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, i + 1)) {
          if (line === 0 && i > 0 && buf[i - 1] === 13) idx.crlf = true
          line++
          if (line % STEP === 0) idx.checkpoints.push(pos + i + 1)
        }
        pos += n
        if (onProgress && pos - lastReport > 64 * CHUNK) {
          lastReport = pos
          onProgress(pos / stat.size)
        }
      }
      idx.lines = line + 1
      idx.done = true
      indexes.set(file, idx)
      resolve(idx)
    } catch (e) {
      reject(e)
    } finally {
      fs.closeSync(fd)
      building.delete(file)
    }
  })
  building.set(file, p)
  return p
}

/** Lines [from, from+count) (0-based). Long lines are cut at `maxLine` characters so one giant line cannot blow up memory. */
export async function readLines(file: string, from: number, count: number, maxLine = 4000): Promise<string[]> {
  const idx = await indexFile(file)
  from = Math.max(0, Math.min(from, idx.lines - 1))
  count = Math.max(0, Math.min(count, idx.lines - from, 5000))
  const cp = Math.floor(from / STEP)
  let skip = from - cp * STEP
  const out: string[] = []
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(CHUNK)
  let pos = idx.checkpoints[cp]
  let carry: Buffer[] = []
  let carryLen = 0
  try {
    while (out.length < count) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos)
      if (!n) break
      let start = 0
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n && out.length < count; i = buf.indexOf(10, i + 1)) {
        if (skip > 0) {
          skip--
        } else {
          const piece = buf.subarray(start, i)
          const whole = carryLen ? Buffer.concat([...carry, piece]) : piece
          out.push(whole.subarray(0, maxLine * 4).toString('utf8').replace(/\r$/, '').slice(0, maxLine))
        }
        carry = []
        carryLen = 0
        start = i + 1
      }
      if (out.length >= count) break
      if (start < n && skip === 0 && carryLen < maxLine * 4) {
        carry.push(Buffer.from(buf.subarray(start, n)))
        carryLen += n - start
      }
      pos += n
    }
    if (out.length < count && carryLen) out.push(Buffer.concat(carry).toString('utf8').replace(/\r$/, '').slice(0, maxLine))
  } finally {
    fs.closeSync(fd)
  }
  return out
}

/** Streams through the file for matches, starting at line `from`. Stops after `limit` matches. */
export async function findInFile(file: string, query: string, opts: { from?: number; limit?: number; regex?: boolean; ignoreCase?: boolean } = {}) {
  const idx = await indexFile(file)
  const limit = opts.limit ?? 200
  const re = opts.regex ? new RegExp(query, opts.ignoreCase ? 'i' : '') : null
  const needle = opts.ignoreCase ? query.toLowerCase() : query
  const matches: { line: number; text: string }[] = []
  const WINDOW = 4096
  for (let l = opts.from ?? 0; l < idx.lines && matches.length < limit; l += WINDOW) {
    const lines = await readLines(file, l, WINDOW, 2000)
    lines.forEach((t, i) => {
      if (matches.length >= limit) return
      const hit = re ? re.test(t) : (opts.ignoreCase ? t.toLowerCase() : t).includes(needle)
      if (hit) matches.push({ line: l + i + 1, text: t.slice(0, 400) })
    })
    if (lines.length < WINDOW) break
  }
  return { matches, truncated: matches.length >= limit }
}

export const forgetIndex = (file: string) => indexes.delete(file)
