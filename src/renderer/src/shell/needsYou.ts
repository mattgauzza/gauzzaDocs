import { useSyncExternalStore } from 'react'
import { type Thread, api } from '../lib'
import { askingYou } from '../../../shared/mentions'

/**
 * Threads where an agent @mentioned the person and is waiting on them ("Needs you"). Tracks every open tab's file so
 * the comments button, the tabs, the panel and the doc highlights agree. A thread stops needing you when you reply,
 * resolve it or click it (the clicked messages are remembered here as seen).
 */
const SEEN_KEY = 'gd-asked-seen'
const EMPTY: ReadonlySet<string> = new Set()
let me = ''
const seen = new Set<string>(readSeen())
const files = new Map<string, string>() // lowercased path -> path, for every tracked file
const byFile = new Map<string, ReadonlySet<string>>() // lowercased path -> ids of threads that need you
const subs = new Set<() => void>()
let version = 0

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function saveSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000)))
  } catch { /* storage blocked: seen state lasts this session */ }
}
const emit = () => {
  version++
  for (const f of subs) f()
}
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f))

/** The threads of `ts` that need you now. */
export const needingYou = (ts: Thread[]): Set<string> =>
  new Set(me ? ts.filter(t => askingYou(t, me).some(id => !seen.has(id))).map(t => t.id) : [])

async function refresh(path: string) {
  const ts = await api.commentsList(path).catch(() => null)
  const key = path.toLowerCase()
  if (!ts || !files.has(key)) return
  byFile.set(key, needingYou(ts))
  emit()
}

/** Keep these files' threads tracked (the open tabs). */
export function trackFiles(paths: string[]) {
  const want = new Map(paths.map(p => [p.toLowerCase(), p]))
  for (const key of [...files.keys()]) if (!want.has(key)) (files.delete(key), byFile.delete(key))
  for (const [key, p] of want) if (!files.has(key)) (files.set(key, p), refresh(p))
  emit()
}

/** The person clicked or answered this thread: what it asked them so far counts as seen. */
export function markSeen(path: string, t: Thread) {
  const ids = me ? askingYou(t, me) : []
  if (!ids.length) return
  for (const id of ids) seen.add(id)
  saveSeen()
  const key = path.toLowerCase()
  const cur = byFile.get(key)
  if (cur?.has(t.id)) {
    const next = new Set(cur)
    next.delete(t.id)
    byFile.set(key, next)
    emit()
  }
}

/** Ids of the threads in this file that need you. */
export const useNeedsYou = (path: string): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => byFile.get(path.toLowerCase()) ?? EMPTY)

/** Re-renders when any tracked file's state changes; pair with needsYouIn(path). */
export const useNeedsYouVersion = () => useSyncExternalStore(subscribe, () => version)
export const needsYouIn = (path: string) => (byFile.get(path.toLowerCase())?.size ?? 0) > 0

/** The person's name, once main has told us ('' until then). */
export const personName = () => me

window.gd.on('comments-changed', (file: string) => {
  const p = files.get(file.toLowerCase())
  if (p) refresh(p)
})
api.userName().then(
  n => {
    me = n
    for (const p of files.values()) refresh(p)
    emit()
  },
  () => {}
)
