import fs from 'node:fs'
import path from 'node:path'
import { IGNORED } from '../core/projects'

/**
 * Watches the project folders the window is showing and tells it when something inside changes, so the folder
 * browser and the explorer refresh by themselves. Only folders in view are watched (the window says which), and
 * watchers are closed as soon as they are not needed. Events are debounced per folder.
 */
type Send = (root: string, dir: string) => void

const watchers = new Map<string, { w: fs.FSWatcher; timers: Map<string, NodeJS.Timeout> }>()
const key = (p: string) => path.resolve(p).toLowerCase()

export function watchFolders(roots: string[], send: Send) {
  const want = new Map(roots.filter(Boolean).map(r => [key(r), path.resolve(r)]))
  for (const [k, v] of watchers) {
    if (!want.has(k)) {
      v.w.close()
      for (const t of v.timers.values()) clearTimeout(t)
      watchers.delete(k)
    }
  }
  for (const [k, root] of want) {
    if (watchers.has(k)) continue
    try {
      const timers = new Map<string, NodeJS.Timeout>()
      const w = fs.watch(root, { recursive: true }, (_ev, file) => {
        const rel = typeof file === 'string' ? file : ''
        const parts = rel.split(/[\\/]/)
        if (parts.some(p => IGNORED.has(p) || p.startsWith('.'))) return // build output and dot folders churn constantly
        const dir = path.join(root, path.dirname(rel))
        clearTimeout(timers.get(dir))
        timers.set(dir, setTimeout(() => (timers.delete(dir), send(root, dir)), 300))
      })
      w.on('error', () => {
        w.close()
        watchers.delete(k)
      })
      watchers.set(k, { w, timers })
    } catch { /* folder gone or not watchable: the window still refreshes when it reopens */ }
  }
}

export const stopWatching = () => watchFolders([], () => {})
