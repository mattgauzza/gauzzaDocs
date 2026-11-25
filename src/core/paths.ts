import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RecentFile, Settings } from '../shared/types'
import { kindOf } from '../shared/kinds'

/** App data: settings, recent files, the live-edit server address and installed plugins. Files themselves stay where they are. */
export const HOME = process.env.GAUZZADOCS_HOME || path.join(os.homedir(), '.gauzzadocs')
export const SERVER_FILE = path.join(HOME, 'server.json')
export const PLUGINS_DIR = path.join(HOME, 'plugins')
const SETTINGS_FILE = path.join(HOME, 'settings.json')
const RECENT_FILE = path.join(HOME, 'recent.json')

export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/mattgauzza/gauzzaDocs/main/plugins/marketplace.json'

/** Secret files that are never versioned (name patterns, * wildcard). */
export const DEFAULT_EXCLUDE = ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.kdbx', 'id_rsa*', 'id_ed25519*']

export const DEFAULT_SETTINGS: Settings = {
  docsDir: path.join(os.homedir(), 'Documents', 'gauzzaDocs'),
  newDocFormat: 'html',
  autosave: true,
  theme: 'system',
  registry: DEFAULT_REGISTRY,
  textWrap: false,
  fontSize: 14,
  spellcheck: true,
  historyExclude: DEFAULT_EXCLUDE,
  historyCapMB: 1024
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

export const getSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(SETTINGS_FILE, {}) })
/** Saves only what was set (the file plus this patch), so a setting nobody changed keeps following the app's default. */
export function setSettings(patch: Partial<Settings>): Settings {
  const saved = { ...readJson<Partial<Settings>>(SETTINGS_FILE, {}), ...patch }
  writeJson(SETTINGS_FILE, saved)
  return { ...DEFAULT_SETTINGS, ...saved }
}

export const norm = (p: string) => path.resolve(p)
/** Same file? Windows paths compare case-insensitively. */
export const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)

export function getRecent(): RecentFile[] {
  return readJson<RecentFile[]>(RECENT_FILE, []).filter(r => fs.existsSync(r.path))
}
export function addRecent(file: string) {
  const list = readJson<RecentFile[]>(RECENT_FILE, []).filter(r => !samePath(r.path, file))
  list.unshift({ path: norm(file), kind: kindOf(file), opened: Date.now() })
  writeJson(RECENT_FILE, list.slice(0, 200))
}
export function renameRecent(from: string, to: string) {
  writeJson(RECENT_FILE, readJson<RecentFile[]>(RECENT_FILE, []).map(r => (samePath(r.path, from) ? { ...r, path: norm(to), kind: kindOf(to) } : r)))
}
export function removeRecent(file: string) {
  writeJson(RECENT_FILE, readJson<RecentFile[]>(RECENT_FILE, []).filter(r => !samePath(r.path, file)))
}

export interface ServerInfo { port: number; token: string; pid: number }
export const readServer = (): ServerInfo | null => readJson<ServerInfo | null>(SERVER_FILE, null)
export const writeServer = (info: ServerInfo) => writeJson(SERVER_FILE, info)
export function clearServer(pid: number) {
  const cur = readServer()
  if (cur?.pid === pid) fs.rmSync(SERVER_FILE, { force: true })
}

/** A free name in `dir`: "Untitled document.html", "Untitled document (2).html", ... */
export function freeName(dir: string, stem: string, ext: string) {
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${stem}${n > 1 ? ` (${n})` : ''}.${ext}`)
    if (!fs.existsSync(file)) return file
  }
}
