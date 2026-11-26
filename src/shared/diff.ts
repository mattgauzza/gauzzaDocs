import { diffLines } from 'diff'

export type Hunk = { kind: 'same' | 'add' | 'del'; lines: string[] }
/** The comparison gave up: the versions differ in too many places to compare in reasonable time. */
export type TooMany = { tooMany: true }

/**
 * How long a line diff may run before it gives up. Its cost grows with lines times changes (10,000 lines that all
 * changed took over 20 s), and it runs on the one worker thread that also does every save.
 */
export const DIFF_TIMEOUT_MS = 1500

/** CRLF becomes LF and one final newline is dropped, so line endings and a missing last newline are not changes. */
const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '')

const split = (value: string): string[] => {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Line diff (Myers). Unchanged runs keep only `context` lines next to a change. A long run between two changes
 * becomes two adjacent `same` hunks, so two adjacent `same` hunks always mean lines were skipped between them.
 * No changes gives []. Gives `{ tooMany: true }` when it runs longer than `timeout` ms.
 */
export function lineDiff(a: string, b: string, context = 3, timeout = DIFF_TIMEOUT_MS): Hunk[] | TooMany {
  const parts = diffLines(normalize(a), normalize(b), { timeout })
  if (!parts) return { tooMany: true }
  const raw: Hunk[] = parts.map(p => ({ kind: p.added ? 'add' : p.removed ? 'del' : 'same', lines: split(p.value) }))
  if (!raw.some(h => h.kind !== 'same')) return []
  const out: Hunk[] = []
  raw.forEach((h, i) => {
    if (h.kind !== 'same') return void out.push(h)
    const first = i === 0
    const last = i === raw.length - 1
    const n = h.lines.length
    if (first) out.push({ kind: 'same', lines: h.lines.slice(Math.max(0, n - context)) })
    else if (last) out.push({ kind: 'same', lines: h.lines.slice(0, context) })
    else if (n <= 2 * context) out.push(h)
    else {
      out.push({ kind: 'same', lines: h.lines.slice(0, context) })
      out.push({ kind: 'same', lines: h.lines.slice(n - context) })
    }
  })
  return out.filter(h => h.lines.length > 0)
}
