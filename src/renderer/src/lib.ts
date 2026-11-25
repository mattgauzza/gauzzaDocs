import type { InstalledPlugin, OpenFile, RecentFile, Settings, FilePayload } from '../../shared/types'
import type { Kind } from '../../shared/kinds'

/** Mirrors src/core/comments.ts (kept here so the window does not import Node code). */
export interface Reply { id: string; author: string; by: 'user' | 'agent'; text: string; created: number }
export interface Thread extends Reply {
  quote?: string
  anchor?: { line?: number; cell?: string; page?: number }
  resolved?: boolean
  replies: Reply[]
}
/** Mirrors core/plugins.ts Market (the marketplace.json listing, with install state). */
export interface MarketPlugin {
  id: string; name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]
  icon?: string; languages?: string[]; size?: number; installed?: string; update?: boolean; compatible?: boolean
}
export interface Market { source: string; name?: string; categories: string[]; plugins: MarketPlugin[]; offline?: string }
export interface Listener { id: number; agent: string; path?: string; since: number }

/** Typed wrappers over window.gd.call (main process API in src/main/index.ts). */
export const api = {
  load: (path: string) => window.gd.call<OpenFile>('load', path),
  save: (path: string, payload: FilePayload) => window.gd.call<number>('save', path, payload),
  newFile: (kind: Kind, ext?: string) => window.gd.call<string>('newFile', kind, ext),
  openDialog: () => window.gd.call<string[]>('openDialog'),
  saveAsDialog: (path: string) => window.gd.call<string | null>('saveAsDialog', path),
  exportFile: (path: string, payload: FilePayload, format: string, html?: string) => window.gd.call<string | null>('exportFile', path, payload, format, html),
  print: (html: string, title: string) => window.gd.call<string>('print', html, title),
  rename: (path: string, stem: string) => window.gd.call<string>('rename', path, stem),
  instructions: (path?: string) => window.gd.call<{ global: string; file: string; stored?: string }>('instructions', path),
  setInstructions: (path: string | null, text: string) => window.gd.call<number>('setInstructions', path, text),
  commentsList: (path: string, all = false) => window.gd.call<Thread[]>('commentsList', path, all),
  commentAdd: (path: string, c: { text: string; quote?: string; anchor?: Thread['anchor'] }) => window.gd.call<Thread>('commentAdd', path, c),
  commentReply: (path: string, id: string, text: string) => window.gd.call('commentReply', path, id, text),
  commentResolve: (path: string, id: string, resolved: boolean) => window.gd.call('commentResolve', path, id, resolved),
  commentDelete: (path: string, id: string) => window.gd.call('commentDelete', path, id),
  listeners: () => window.gd.call<Listener[]>('listeners'),
  recent: () => window.gd.call<RecentFile[]>('recent'),
  removeRecent: (path: string) => window.gd.call('removeRecent', path),
  listDir: (dir: string) => window.gd.call<{ name: string; path: string; dir: boolean; mtime: number }[]>('listDir', dir),
  stat: (path: string) => window.gd.call<{ size: number; mtime: number; created: number } | null>('stat', path),
  mtime: (path: string) => window.gd.call<number>('mtime', path),
  settings: () => window.gd.call<Settings>('settings'),
  setSettings: (patch: Partial<Settings>) => window.gd.call<Settings>('setSettings', patch),
  reveal: (path: string) => window.gd.call('reveal', path),
  openExternal: (url: string) => window.gd.call('openExternal', url),
  pluginsInstalled: () => window.gd.call<InstalledPlugin[]>('pluginsInstalled'),
  pluginsLibrary: () => window.gd.call<Market>('pluginsLibrary'),
  pluginsUpdateAll: () => window.gd.call<{ id: string; from: string; to: string }[]>('pluginsUpdateAll'),
  pluginsInstall: (id: string) => window.gd.call<InstalledPlugin>('pluginsInstall', id),
  pluginsRemove: (id: string) => window.gd.call('pluginsRemove', id),
  pluginsSetEnabled: (id: string, on: boolean) => window.gd.call('pluginsSetEnabled', id, on),
  cliInfo: () => window.gd.call<{ port?: number; cli: string; home: string }>('cliInfo'),
  largeIndex: (path: string) => window.gd.call<{ lines: number; size: number; crlf: boolean }>('largeIndex', path),
  largeLines: (path: string, from: number, count: number) => window.gd.call<string[]>('largeLines', path, from, count),
  largeFind: (path: string, q: string, opts: { from?: number; limit?: number; regex?: boolean; ignoreCase?: boolean } = {}) =>
    window.gd.call<{ matches: { line: number; text: string }[]; truncated: boolean }>('largeFind', path, q, opts),
  largeForget: (path: string) => window.gd.call('largeForget', path),
  updateReady: () => window.gd.call<string>('updateReady'),
  installUpdate: () => window.gd.call('installUpdate'),
  openDefaultApps: () => window.gd.call('openDefaultApps'),
  agentsDetect: () => window.gd.call<{ id: string; label: string; detected: boolean; installed: boolean }[]>('agentsDetect'),
  agentsInstall: (ids: string[]) => window.gd.call<{ id: string; label: string; detected: boolean; installed: boolean }[]>('agentsInstall', ids),
  welcomed: () => window.gd.call<boolean>('welcomed'),
  setWelcomed: () => window.gd.call('setWelcomed'),
  openUrl: (url: string) => window.gd.call('openUrl', url),
  quit: () => window.gd.call('quit')
}

export const when = (ms: number) => {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
export const dirOf = (p: string) => p.replace(/[\/][^\/]*$/, '')
export const shortDir = (p: string, home: string) => {
  const d = dirOf(p)
  return home && d.toLowerCase().startsWith(home.toLowerCase()) ? '~' + d.slice(home.length) : d
}
