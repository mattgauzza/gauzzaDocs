import type { Hunk } from '../../../shared/diff'
import type { Author } from '../../../shared/types'

/**
 * Pure helpers for the version history panel (History.tsx) and the per-tab authors in App.tsx: grouping by day,
 * turning a line diff into rows, the work history wording and what a save says about who changed the file.
 */

export const OUTSIDE = 'outside gauzzaDocs'

// ---------- days ----------
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** "Today", "Yesterday", or the date ("November 23", with the year when it is not this year). */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  if (dayKey(d) === dayKey(today)) return 'Today'
  if (dayKey(d) === dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** The time of day: "3:04 PM". */
export const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** For a sentence: "today at 3:04 PM", "yesterday at 9:10 AM", "November 23 at 8:00 AM". */
export function atText(ms: number, now = Date.now()): string {
  const day = dayLabel(ms, now)
  return `${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day} at ${timeOf(ms)}`
}

export interface DayGroup<T> {
  key: string
  label: string
  items: T[]
}

/** Items grouped by the local day of `at(item)`. Groups come in the order their first item does, and items keep their order: sort newest first before calling. */
export function groupByDay<T>(items: T[], at: (x: T) => number, now = Date.now()): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>()
  for (const x of items) {
    const ms = at(x)
    const key = dayKey(new Date(ms))
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, label: dayLabel(ms, now), items: [] }))
    g.items.push(x)
  }
  return [...groups.values()]
}

// ---------- diff ----------
export type DiffRow = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'gap' }

/**
 * One row per line. Two adjacent `same` hunks mean unchanged lines were left out between them (src/shared/diff.ts),
 * so a gap row goes there. At most `max` line rows; `cut` says some were left out.
 */
export function diffRows(hunks: Hunk[], max = 3000): { rows: DiffRow[]; cut: boolean } {
  const rows: DiffRow[] = []
  let lines = 0
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]
    if (i > 0 && h.kind === 'same' && hunks[i - 1].kind === 'same') rows.push({ kind: 'gap' })
    for (const text of h.lines) {
      if (lines === max) return { rows, cut: true }
      rows.push({ kind: h.kind, text })
      lines++
    }
  }
  return { rows, cut: false }
}

/** Lines added and removed. */
export function diffStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    if (h.kind === 'add') added += h.lines.length
    else if (h.kind === 'del') removed += h.lines.length
  }
  return { added, removed }
}

/** "3 lines added and 1 removed", "1 line added", "2 lines removed", or "" for none. */
export function statsText({ added, removed }: { added: number; removed: number }): string {
  const n = (k: number) => `${k} ${k === 1 ? 'line' : 'lines'}`
  if (added && removed) return `${n(added)} added and ${removed} removed`
  if (added) return `${n(added)} added`
  if (removed) return `${n(removed)} removed`
  return ''
}

// ---------- who changed it ----------
/** An agent op name as words: "replaceText" becomes "replace text". */
export const opWords = (op: string) =>
  op
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase()

/** What a save's agent ops did, in order, counted: "replace (2), append". Undefined when there were none (the store then says "Edited"). */
export function opsSummary(ops: string[], most = 4): string | undefined {
  if (!ops.length) return undefined
  const counts = new Map<string, number>()
  for (const op of ops) {
    const w = opWords(op)
    if (w) counts.set(w, (counts.get(w) || 0) + 1)
  }
  if (!counts.size) return undefined
  const parts = [...counts].map(([w, k]) => (k > 1 ? `${w} (${k})` : w))
  return parts.length > most ? `${parts.slice(0, most).join(', ')} and ${parts.length - most} more` : parts.join(', ')
}

/** The ctx a save passes: who changed the tab since its last save, and the agent ops' summary. Undefined when nobody did (main then credits the person). */
export function saveContext(authors: Author[], ops: string[]): { authors: Author[]; summary?: string } | undefined {
  if (!authors.length) return undefined
  const summary = opsSummary(ops)
  return summary ? { authors, summary } : { authors }
}

/** Who a work history name is: the person, an agent, or a change made outside gauzzaDocs. */
export function whoIs(name: string, person: string): Author['by'] {
  if (name === OUTSIDE) return 'outside'
  return name.toLowerCase() === person.toLowerCase() ? 'person' : 'agent'
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * A work history event as a line: the names to show (a save by several authors lists each) and what they did.
 * `named` is false when the text already says who (changes made outside gauzzaDocs).
 */
export function eventLine(e: { type: string; by: string; summary: string }): { names: string[]; text: string; named: boolean } {
  const names = e.by.split(', ').filter(Boolean)
  if (e.type === 'outside' || e.by === OUTSIDE) return { names: [OUTSIDE], text: cap(e.summary), named: false }
  if (e.type === 'agent-op') {
    const many = /^(\d+) edits$/.exec(e.summary)
    return { names, text: many ? `made ${many[1]} edits` : `made an edit (${opWords(e.summary)})`, named: true }
  }
  return { names, text: e.summary, named: true }
}

/** An error's message without the prefix Electron adds to a failed call to main ("Error invoking remote method 'api': Error: "). */
export const errorText = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')

// ---------- sizes ----------
const MB = 1024 * 1024

/** Bytes as megabytes: "0.4 MB", "12.4 MB", "1024 MB". */
export function mb(bytes: number): string {
  const v = bytes / MB
  return `${v < 100 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString()} MB`
}

/** A size that is readable when small too: "0 KB", "6 KB", then megabytes from 1 MB. */
export function sizeText(bytes: number): string {
  if (bytes >= MB) return mb(bytes)
  return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`
}
