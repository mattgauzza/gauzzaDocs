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

/**
 * Appends an event. The caller holds the file's lock (see appendEvent for everyone else).
 * An agent's edits save as they go, so its ops and its saves interleave (op, save, op, save). To keep a burst to two
 * lines, an agent op merges into that agent's last op within 60 s even when that agent's save line follows it, and a
 * save of the same version updates that version's line even when the same author's op line follows it. Lines keep
 * the order they first appeared in.
 */
export async function appendEventLocked(file: string, ev: HistoryEvent): Promise<void> {
  const target = logPath(historyKey(file))
  // Excluded (secret) files never get quoted text in their work history.
  const next: HistoryEvent = isExcluded(file) ? { ...ev, summary: ev.type === 'agent-op' ? 'edited' : ev.type } : { ...ev }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tail = readTail(target)
  const { size, torn } = tail
  const mergesOp = (into: HistoryEvent) =>
    next.type === 'agent-op' && into.type === 'agent-op' && into.by === next.by && next.at - into.at <= MERGE_MS && next.at >= into.at
  const updatesSave = (into: HistoryEvent) => next.type === 'save' && into.type === 'save' && next.v !== undefined && into.v === next.v
  const merged = (into: HistoryEvent) =>
    JSON.stringify(next.type === 'agent-op' ? { ...next, summary: `${Number(editCount(into)) + 1} edits` } : next) // a save: one event per version
  // What the new event does to the tail: rewrite the last line, or the one before it (keeping the last line as it is).
  let rewrite: { start: number; lines: string[] } | null = null
  const { last, prev } = tail
  if (last && !torn) {
    if (mergesOp(last) || updatesSave(last)) rewrite = { start: tail.lastStart, lines: [merged(last)] }
    else if (prev && last.by === next.by && ((last.type === 'save' && mergesOp(prev)) || (last.type === 'agent-op' && updatesSave(prev))))
      rewrite = { start: tail.prevStart, lines: [merged(prev), tail.lastRaw] }
  }
  const text = (rewrite?.lines ?? [JSON.stringify(next)]).join('\n')
  const base = rewrite ? rewrite.start : size // where the new text goes
  if (base + (torn ? 1 : 0) + Buffer.byteLength(text) + 1 <= MAX_LOG_BYTES) {
    const fd = fs.openSync(target, size === 0 ? 'w' : 'r+')
    try {
      const out = Buffer.from((torn ? '\n' : '') + text + '\n')
      fs.writeSync(fd, out, 0, out.length, base)
      fs.ftruncateSync(fd, base + out.length)
    } finally {
      fs.closeSync(fd)
    }
    return
  }
  // A trim is due: only now is the whole file read.
  const lines = fs.readFileSync(target, 'utf8').split('\n').filter(l => l !== '')
  if (rewrite) lines.splice(lines.length - rewrite.lines.length, rewrite.lines.length, ...rewrite.lines)
  else lines.push(text)
  let size2 = 0
  let from = lines.length
  while (from > 0 && size2 + Buffer.byteLength(lines[from - 1]) + 1 <= MAX_LOG_BYTES / 2) size2 += Buffer.byteLength(lines[--from]) + 1
  await writeAtomic(target, Buffer.from(lines.slice(from).join('\n') + '\n'))
}

const TAIL_BYTES = 64 * 1024
interface Tail {
  size: number
  torn: boolean
  /** The last line: parsed, as written, and where it starts. Null when it does not fit the window. */
  last: HistoryEvent | null
  lastRaw: string
  lastStart: number
  /** The line before it, when it fits the window too. */
  prev: HistoryEvent | null
  prevStart: number
}
/** The size of a log and its last two lines, read from the end of the file only. */
function readTail(target: string): Tail {
  const none = (size: number, torn = false): Tail => ({ size, torn, last: null, lastRaw: '', lastStart: size, prev: null, prevStart: size })
  let fd: number
  try {
    fd = fs.openSync(target, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return none(0)
    throw e
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return none(0)
    const from = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    const torn = buf[buf.length - 1] !== 0x0a
    const end = torn ? buf.length : buf.length - 1
    const nl = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1
    if (nl < 0 && from > 0) return none(size, torn) // a line longer than the window: leave it alone
    const lastRaw = buf.subarray(nl + 1, end).toString('utf8')
    const tail: Tail = { size, torn, last: parse(lastRaw), lastRaw, lastStart: from + nl + 1, prev: null, prevStart: from + nl + 1 }
    if (nl < 0) return tail // the only line
    const nl2 = nl > 0 ? buf.lastIndexOf(0x0a, nl - 1) : -1
    if (nl2 < 0 && from > 0) return tail // the line before does not fit the window
    tail.prev = parse(buf.subarray(nl2 + 1, nl).toString('utf8'))
    tail.prevStart = from + nl2 + 1
    return tail
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
