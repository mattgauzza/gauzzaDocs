import { useEffect } from 'react'
import { api } from '../lib'

/**
 * The home screen's folder browser and the explorer panel each say which project folder they show; main watches the
 * union and nothing else. `useFolderChanges` calls back when something inside a watched folder changes.
 */
const wanted = new Map<string, number>()
let timer = 0
const sync = () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => api.watchFolders([...wanted.keys()]).catch(() => {}), 50)
}

export function useWatchFolder(root: string | null | undefined) {
  useEffect(() => {
    if (!root) return
    wanted.set(root, (wanted.get(root) || 0) + 1)
    sync()
    return () => {
      const n = (wanted.get(root) || 1) - 1
      if (n <= 0) wanted.delete(root)
      else wanted.set(root, n)
      sync()
    }
  }, [root])
}

const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Calls `onChange(dir)` when something changes in `root` (dir is the folder that changed). */
export function useFolderChanges(root: string | null | undefined, onChange: (dir: string) => void) {
  useEffect(() => {
    if (!root) return
    return window.gd.on('folder-changed', (r: string, dir: string) => same(r, root) && onChange(dir))
  }, [root, onChange])
}

export const samePath = same
