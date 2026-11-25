import fs from 'node:fs'
import path from 'node:path'
import { historyKey, isExcluded, logPath, withLock, writeAtomic } from './store'

export type HistoryEventType =
  | 'save'
  | 'agent-op'
  | 'comment'
  | 'reply'
  | 'resolved'
  | 'connected'
  | 'disconnected'
  | 'subscribed'
  | 'unsubscribed'
  | 'woken'
  | 'outside'
  | 'named'
  | 'restored'
  | 'moved'

export interface HistoryEvent {
  at: number
  type: HistoryEventType
  by: string
  summary: string
  /** The version number a save or outside event is about. */
  v?: number
}

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MERGE_MS = 60 * 1000
const TYPES = new Set<string>([
  'save', 'agent-op', 'comment', 'reply', 'resolved', 'connected', 'disconnected', 'subscribed', 'unsubscribed', 'woken', 'outside', 'named', 'restored', 'moved',
])

const valid = (x: unknown): x is HistoryEvent => {
  const e = x as HistoryEvent | null
  return !!e && typeof e.at === 'number' && typeof e.by === 'string' && typeof e.summary === 'string' && TYPES.has(e.type)
}
const parse = (line: string): HistoryEvent | null => {
  try {
    const e = JSON.parse(line)
    return valid(e) ? e : null
  } catch {
    return null
  }
}

const editCount = (e: HistoryEvent) => /^(\d+) edits$/.exec(e.summary)?.[1] ?? '1'

/** Appends an event. The caller holds the file's lock (see appendEvent for everyone else). */
export async function appendEventLocked(file: string, ev: HistoryEvent): Promise<void> {
  const target = logPath(historyKey(file))
  // Excluded (secret) files never get quoted text in their work history.
  const next: HistoryEvent = isExcluded(file) ? { ...ev, summary: ev.type === 'agent-op' ? 'edited' : ev.type } : { ...ev }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const { size, last, lastStart, torn } = readTail(target)
  // What the new event does to the last one: merge agent ops, or update a folded save in place.
  let replacement: string | null = null
  if (last && !torn) {
    if (next.type === 'agent-op' && last.type === 'agent-op' && last.by === next.by && next.at - last.at <= MERGE_MS && next.at >= last.at) {
      replacement = JSON.stringify({ ...next, summary: `${Number(editCount(last)) + 1} edits` })
    } else if (next.type === 'save' && last.type === 'save' && next.v !== undefined && last.v === next.v) {
      replacement = JSON.stringify(next) // the same version saved again: one event per version
    }
  }
  const line = replacement ?? JSON.stringify(next)
  const base = replacement !== null ? lastStart : size // where the new line goes
  if (base + (torn ? 1 : 0) + Buffer.byteLength(line) + 1 <= MAX_LOG_BYTES) {
    const fd = fs.openSync(target, size === 0 ? 'w' : 'r+')
    try {
      const out = Buffer.from((torn ? '\n' : '') + line + '\n')
      fs.writeSync(fd, out, 0, out.length, base)
      fs.ftruncateSync(fd, base + out.length)
    } finally {
      fs.closeSync(fd)
    }
    return
  }
  // A trim is due: only now is the whole file read.
  const lines = fs.readFileSync(target, 'utf8').split('\n').filter(l => l !== '')
  if (replacement !== null) lines[lines.length - 1] = line
  else lines.push(line)
  let size2 = 0
  let from = lines.length
  while (from > 0 && size2 + Buffer.byteLength(lines[from - 1]) + 1 <= MAX_LOG_BYTES / 2) size2 += Buffer.byteLength(lines[--from]) + 1
  await writeAtomic(target, Buffer.from(lines.slice(from).join('\n') + '\n'))
}

const TAIL_BYTES = 64 * 1024
/** The size of a log and its last line, read from the end of the file only. */
function readTail(target: string): { size: number; last: HistoryEvent | null; lastStart: number; torn: boolean } {
  let fd: number
  try {
    fd = fs.openSync(target, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0, last: null, lastStart: 0, torn: false }
    throw e
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return { size, last: null, lastStart: 0, torn: false }
    const from = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    const torn = buf[buf.length - 1] !== 0x0a
    const end = torn ? buf.length : buf.length - 1
    const nl = buf.lastIndexOf(0x0a, end - 1)
    if (nl < 0 && from > 0) return { size, last: null, lastStart: size, torn } // a line longer than the window: leave it alone
    const start = nl + 1
    return { size, last: parse(buf.subarray(start, end).toString('utf8')), lastStart: from + start, torn }
  } finally {
    fs.closeSync(fd)
  }
}

/** Appends an event under the file's lock. Do not call this while holding that lock: use appendEventLocked. */
export function appendEvent(file: string, ev: HistoryEvent): Promise<void> {
  return withLock(historyKey(file), () => appendEventLocked(file, ev))
}

/** The work history of a file, newest first. Lines that do not parse are skipped. */
export function readLog(file: string, limit?: number): HistoryEvent[] {
  let text: string
  try {
    text = fs.readFileSync(logPath(historyKey(file)), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: HistoryEvent[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && (limit === undefined || out.length < limit); i--) {
    if (!lines[i]) continue
    const e = parse(lines[i])
    if (e) out.push(e)
  }
  return out
}
