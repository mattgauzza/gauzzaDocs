import fs from 'node:fs'
import path from 'node:path'
import { HOME, norm, samePath } from './paths'

/**
 * Projects are folders the person pins to the home screen (Drive / VS Code style). Kept in ~/.gauzzadocs/projects.json.
 * Removing a project only takes it off the list; files are never touched. A folder that no longer exists stays on the
 * list marked missing, so a disconnected drive does not silently lose its project.
 */
export interface Project {
  path: string
  name: string
  added: number
  opened: number
  missing?: boolean
}

const FILE = path.join(HOME, 'projects.json')

function read(): Project[] {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list.filter(p => p && typeof p.path === 'string') : []
  } catch {
    return []
  }
}
function write(list: Project[]) {
  fs.mkdirSync(HOME, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list.map(({ missing: _m, ...p }) => p), null, 2))
  fs.renameSync(tmp, FILE)
}

/** Projects, most recently opened first, each marked missing when its folder is gone. */
export function listProjects(): Project[] {
  return read()
    .map(p => ({ ...p, missing: !isDir(p.path) }))
    .sort((a, b) => b.opened - a.opened || a.name.localeCompare(b.name))
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Finds a project by its folder or its name (case-insensitive). */
export function findProject(key: string): Project | undefined {
  const list = listProjects()
  return list.find(p => samePath(p.path, key)) || list.find(p => p.name.toLowerCase() === key.toLowerCase())
}

export function addProject(dir: string, name?: string): Project {
  const p = norm(dir)
  if (!isDir(p)) throw new Error(`${p} is not a folder`)
  const list = read()
  const existing = list.find(x => samePath(x.path, p))
  if (existing) {
    if (name) existing.name = name
    existing.opened = Date.now()
    write(list)
    return { ...existing, missing: false }
  }
  const now = Date.now()
  const proj: Project = { path: p, name: name?.trim() || path.basename(p) || p, added: now, opened: now }
  write([...list, proj])
  return proj
}

export function removeProject(key: string) {
  const target = findProject(key)
  if (!target) throw new Error(`No project "${key}"`)
  write(read().filter(x => !samePath(x.path, target.path)))
  return target
}

export function renameProject(dir: string, name: string) {
  if (!name.trim()) throw new Error('A project needs a name')
  const list = read()
  const p = list.find(x => samePath(x.path, dir))
  if (!p) throw new Error(`No project at ${dir}`)
  p.name = name.trim()
  write(list)
  return p
}

export function touchProject(dir: string) {
  const list = read()
  const p = list.find(x => samePath(x.path, dir))
  if (!p) return
  p.opened = Date.now()
  write(list)
}

/** The project that contains a file (deepest match), if any. */
export function projectFor(file: string): Project | undefined {
  const f = norm(file).toLowerCase()
  return listProjects()
    .filter(p => f.startsWith(norm(p.path).toLowerCase() + path.sep) || samePath(p.path, file))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

// ---------- folder listing and search (run on the worker thread) ----------

export interface Entry {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: number
}

/** Folders skipped by search and hidden from listings: build output, dependencies and dot folders. */
export const IGNORED = new Set(['node_modules', '.git', 'out', 'dist', 'release', '__pycache__', '.venv', 'venv'])
const hidden = (name: string) => name.startsWith('.') || name === 'desktop.ini' || name === 'Thumbs.db'

/** One level of a folder: folders first, then files, each A to Z. Stats only this level. */
export async function listFolder(dir: string): Promise<Entry[]> {
  const items = await fs.promises.readdir(dir, { withFileTypes: true })
  const out: Entry[] = []
  await Promise.all(
    items
      .filter(d => !hidden(d.name))
      .map(async d => {
        const p = path.join(dir, d.name)
        try {
          const s = await fs.promises.stat(p)
          out.push({ name: d.name, path: p, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs })
        } catch { /* vanished, or a broken link */ }
      })
  )
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1))
}

/**
 * Searches file and folder names under `root` for every word in `query` (case-insensitive), breadth first, skipping
 * IGNORED and dot folders. Stops after `limit` matches or `maxDirs` folders so a huge tree cannot run away.
 */
export async function searchFolder(root: string, query: string, opts: { limit?: number; maxDirs?: number } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const limit = opts.limit ?? 200
  const maxDirs = opts.maxDirs ?? 20_000
  const results: Entry[] = []
  if (!words.length) return { results, truncated: false }
  const queue = [root]
  let dirs = 0
  let truncated = false
  while (queue.length) {
    if (++dirs > maxDirs) {
      truncated = true
      break
    }
    const dir = queue.shift()!
    let items: fs.Dirent[]
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of items) {
      if (hidden(d.name)) continue
      const p = path.join(dir, d.name)
      if (d.isDirectory()) {
        if (IGNORED.has(d.name)) continue
        queue.push(p)
      }
      const rel = path.relative(root, p).toLowerCase()
      if (words.every(w => rel.includes(w))) {
        let size = 0
        let mtime = 0
        try {
          const s = await fs.promises.stat(p)
          size = d.isDirectory() ? 0 : s.size
          mtime = s.mtimeMs
        } catch { /* vanished */ }
        results.push({ name: d.name, path: p, dir: d.isDirectory(), size, mtime })
        if (results.length >= limit) return { results, truncated: true }
      }
    }
  }
  return { results, truncated }
}
