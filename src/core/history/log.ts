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
  let text = ''
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const torn = !!text && !text.endsWith('\n') // a torn last line stays a skipped line of its own
  const lines = text.split('\n').filter(l => l !== '')
  const last = lines.length ? parse(lines[lines.length - 1]) : null
  if (next.type === 'agent-op' && last && last.type === 'agent-op' && last.by === next.by && next.at - last.at <= MERGE_MS && next.at >= last.at) {
    lines[lines.length - 1] = JSON.stringify({ ...next, summary: `${Number(editCount(last)) + 1} edits` })
  } else {
    const line = JSON.stringify(next)
    if (Buffer.byteLength(text) + Buffer.byteLength(line) + 1 <= MAX_LOG_BYTES) {
      fs.appendFileSync(target, (torn ? '\n' : '') + line + '\n') // the common case: no rewrite
      return
    }
    lines.push(line)
  }
  let out = lines.join('\n') + '\n'
  if (Buffer.byteLength(out) > MAX_LOG_BYTES) {
    // Keep the newest half, whole lines only.
    let size = 0
    let from = lines.length
    while (from > 0 && size + Buffer.byteLength(lines[from - 1]) + 1 <= MAX_LOG_BYTES / 2) size += Buffer.byteLength(lines[--from]) + 1
    out = lines.slice(from).join('\n') + '\n'
  }
  await writeAtomic(target, Buffer.from(out))
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
