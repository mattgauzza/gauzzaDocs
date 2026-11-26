import type { Author, CommentAnchor, HistoryVersion, InstalledPlugin, OpenFile, RecentFile, Settings, FilePayload } from '../../shared/types'
import type { Kind } from '../../shared/kinds'
import type { Hunk } from '../../shared/diff'
import type { ElkGraph, FontRef } from '../../shared/design/types'

/** Mirrors src/core/comments.ts (kept here so the window does not import Node code). */
export interface Reply { id: string; author: string; by: 'user' | 'agent'; text: string; created: number }
export interface Thread extends Reply {
  quote?: string
  anchor?: CommentAnchor
  resolved?: boolean
  replies: Reply[]
}
/** Mirrors core/plugins.ts Market (the marketplace.json listing, with install state). */
export interface MarketPlugin {
  id: string; name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]
  icon?: string; languages?: string[]; size?: number; installed?: string; update?: boolean; compatible?: boolean
}
export interface Market { source: string; name?: string; categories: string[]; plugins: MarketPlugin[]; offline?: string }
/** Mirrors core/projects.ts. */
export interface Project { path: string; name: string; added: number; opened: number; missing?: boolean }
export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number }
export interface Listener { id: number; agent: string; path?: string; since: number; virtual?: boolean }
/** Mirrors src/main/agents.ts AgentStatus: an agent subscribed to a document and what it is doing. */
export interface AgentStatus {
  id: string
  path: string
  name: string
  agent: 'claude' | 'codex' | 'gemini' | 'copilot'
  role: 'writer' | 'reviewer' | 'editor' | 'custom'
  brief: string
  state: 'idle' | 'working' | 'waiting' | 'paused' | 'error'
  pausedReason?: string
  error?: string
  access: 'limited' | 'full'
  lastRun?: { start: number; end?: number; code?: number | null; log: string }
  nextAt?: number
}

/** Mirrors src/core/history/log.ts HistoryEvent: one line of a file's work history. */
export interface HistoryEvent { at: number; type: string; by: string; summary: string; v?: number }
/** What changed between two versions (src/core/history/compare.ts), too large to compare here, or too many changes to compare in time. */
export type HistoryDiff = { hunks: Hunk[] } | { tooLarge: true } | { tooMany: true }
/** The history store's size and cap; paused: why history stopped recording this session; dir: where it is kept. */
export interface HistoryStats { bytes: number; capBytes: number; overCapBytes?: number; paused?: string; dir?: string }
/** Who changed a file since its last save, and what the agents did (a save's version authors and summary). */
export interface SaveContext { authors: Author[]; summary?: string }
/** A design's artboard, as the design op `read` lists it. */
export interface DesignArtboard { id: string; name: string; width: number; height: number }
/** Mirrors core/design/export.ts DesignImage: one artboard drawn for a document, written nowhere. */
export interface DesignImage {
  data: string | Uint8Array
  artboard: { id: string; name: string }
  width: number
  height: number
  downgrades: string[]
  leftOut: { artboard: string; layer: string; name: string; reason: string }[]
}

/** Typed wrappers over window.gd.call (main process API in src/main/index.ts). */
export const api = {
  load: (path: string) => window.gd.call<OpenFile>('load', path),
  /** ctx: who changed it since the last save; main credits the person when it is left out. */
  save: (path: string, payload: FilePayload, ctx?: SaveContext) => window.gd.call<number>('save', path, payload, ctx),
  /** preset: a new design's size (a PRESETS name, shared/design/model.ts). */
  newFile: (kind: Kind, ext?: string, dir?: string, preset?: string) => window.gd.call<string>('newFile', kind, ext, dir, preset),
  projectsList: () => window.gd.call<Project[]>('projectsList'),
  projectsAdd: (dir: string, name?: string) => window.gd.call<Project>('projectsAdd', dir, name),
  projectsRemove: (dir: string) => window.gd.call('projectsRemove', dir),
  projectsRename: (dir: string, name: string) => window.gd.call('projectsRename', dir, name),
  projectsTouch: (dir: string) => window.gd.call('projectsTouch', dir),
  projectFor: (file: string) => window.gd.call<Project | null>('projectFor', file),
  listFolder: (dir: string) => window.gd.call<Entry[]>('listFolder', dir),
  searchFolder: (root: string, q: string) => window.gd.call<{ results: Entry[]; truncated: boolean }>('searchFolder', root, q),
  pickFolder: () => window.gd.call<string | null>('pickFolder'),
  isFolder: (p: string) => window.gd.call<boolean>('isFolder', p),
  renameEntry: (p: string, name: string) => window.gd.call<string>('renameEntry', p, name),
  trash: (p: string) => window.gd.call('trash', p),
  openWithSystem: (p: string) => window.gd.call<string>('openWithSystem', p),
  watchFolders: (roots: string[]) => window.gd.call('watchFolders', roots),
  openDialog: () => window.gd.call<string[]>('openDialog'),
  saveAsDialog: (path: string) => window.gd.call<string | null>('saveAsDialog', path),
  exportFile: (path: string, payload: FilePayload, format: string, html?: string) => window.gd.call<string | null>('exportFile', path, payload, format, html),
  print: (html: string, title: string) => window.gd.call<string>('print', html, title),
  rename: (path: string, stem: string) => window.gd.call<string>('rename', path, stem),
  instructions: (path?: string) => window.gd.call<{ global: string; file: string; stored?: string }>('instructions', path),
  setInstructions: (path: string | null, text: string) => window.gd.call<number>('setInstructions', path, text),
  userName: () => window.gd.call<string>('userName'),
  commentsList: (path: string, all = false) => window.gd.call<Thread[]>('commentsList', path, all),
  commentAdd: (path: string, c: { text: string; quote?: string; anchor?: Thread['anchor'] }) => window.gd.call<Thread>('commentAdd', path, c),
  commentReply: (path: string, id: string, text: string) => window.gd.call('commentReply', path, id, text),
  commentResolve: (path: string, id: string, resolved: boolean) => window.gd.call('commentResolve', path, id, resolved),
  commentDelete: (path: string, id: string) => window.gd.call('commentDelete', path, id),
  listeners: () => window.gd.call<Listener[]>('listeners'),
  listenerDisconnect: (id: number) => window.gd.call<boolean>('listenerDisconnect', id),
  listenersBlocked: () => window.gd.call<{ agent: string; path?: string; since: number }[]>('listenersBlocked'),
  listenerUnblock: (agent: string, path?: string) => window.gd.call('listenerUnblock', agent, path),
  agentsOn: (path: string) => window.gd.call<AgentStatus[]>('agentsOn', path),
  agentSubscribe: (path: string, s: { agent: AgentStatus['agent']; name?: string; role?: AgentStatus['role']; brief?: string; start?: boolean }) => window.gd.call('agentSubscribe', path, s),
  agentUpdate: (id: string, patch: { brief?: string; role?: AgentStatus['role']; paused?: boolean }) => window.gd.call('agentUpdate', id, patch),
  agentRemove: (id: string) => window.gd.call('agentRemove', id),
  agentWake: (id: string, note?: string) => window.gd.call('agentWake', id, note),
  agentLog: (id: string) => window.gd.call<string>('agentLog', id),
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
  systemFont: (name: string) => window.gd.call<Uint8Array | null>('systemFont', name),
  // ---------- designs (worker jobs: the window can't scan installed fonts or run ELK) ----------
  /** The installed face closest to a design's font reference, or null when none of that family is installed. */
  designFontBytes: (ref: FontRef) => window.gd.call<Uint8Array | null>('designFontBytes', ref),
  /** The fallback font's bytes (Liberation Sans Regular). */
  designFallbackFont: () => window.gd.call<Uint8Array>('designFallbackFont'),
  /** A diagram's graph laid out by ELK, for the design ops' `services.layout`. */
  designLayout: (graph: ElkGraph) => window.gd.call<ElkGraph>('designLayout', graph),
  /** Every installed font face by family, weight, style and PostScript name (the font picker). */
  fontFaces: () => window.gd.call<FontRef[]>('fontFaces'),
  /** A design's thumbnail as a PNG data URL for its Home card, or null (none, or stale) to show the kind's icon. */
  designThumbnail: (path: string) => window.gd.call<string | null>('designThumbnail', path),
  /** A design's artboards, from its open tab when it's open (Insert > Design). */
  designArtboards: (path: string) => window.gd.call<DesignArtboard[]>('designArtboards', path),
  /** One artboard (the first when left out) drawn for a document as an export draws it: SVG text or PNG bytes at 2x. */
  designImage: (path: string, artboard: string | undefined, format: 'svg' | 'png') =>
    window.gd.call<DesignImage>('designImage', path, artboard, format),
  updateReady: () => window.gd.call<string>('updateReady'),
  installUpdate: () => window.gd.call('installUpdate'),
  openDefaultApps: () => window.gd.call('openDefaultApps'),
  defaultsStatus: () => window.gd.call<{ ext: string; name: string; ours: boolean }[]>('defaultsStatus'),
  agentsDetect: () => window.gd.call<{ id: string; label: string; detected: boolean; installed: boolean }[]>('agentsDetect'),
  agentsInstall: (ids: string[]) => window.gd.call<{ id: string; label: string; detected: boolean; installed: boolean }[]>('agentsInstall', ids),
  welcomed: () => window.gd.call<boolean>('welcomed'),
  setWelcomed: () => window.gd.call('setWelcomed'),
  openUrl: (url: string) => window.gd.call('openUrl', url),
  /** The person's name, as comments and versions credit them. */
  // ---------- version history (src/main/historyJobs.ts) ----------
  /** Versions, oldest first. */
  historyList: (path: string) => window.gd.call<HistoryVersion[]>('historyList', path),
  /** The work history, newest first. */
  historyLog: (path: string) => window.gd.call<HistoryEvent[]>('historyLog', path),
  /** Changes from version a to version b, or to the file on disk now when b is left out. */
  historyDiff: (path: string, a: number, b?: number) => window.gd.call<HistoryDiff>('historyDiff', path, a, b),
  /**
   * Unsaved editor content goes as unsavedPayload (kept as a version, never written), credited to unsavedAuthors.
   * authors: who asks for the restore (default the person); unsavedAuthors default to them.
   */
  historyRestore: (path: string, n: number, opts: { unsavedPayload?: FilePayload; unsavedAuthors?: Author[]; discardCurrent?: boolean; authors?: Author[] } = {}) =>
    window.gd.call<HistoryVersion>('historyRestore', path, n, opts),
  /** An empty name clears it. Main credits the person (userName). */
  historyName: (path: string, n: number, name: string) => window.gd.call('historyName', path, n, name),
  historyForget: (path: string) => window.gd.call('historyForget', path),
  /** Records the file on disk as an outside change when it differs from its latest version. */
  historyCheck: (path: string) => window.gd.call('historyCheck', path),
  historyStats: () => window.gd.call<HistoryStats>('historyStats'),
  /** Writes version n to a new file in the docs folder and returns its path. */
  historyOpenCopy: (path: string, n: number) => window.gd.call<string>('historyOpenCopy', path, n),
  quit: () => window.gd.call('quit')
}

export const when = (ms: number) => {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
export const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
export const shortDir = (p: string, home: string) => {
  const d = dirOf(p)
  return home && d.toLowerCase().startsWith(home.toLowerCase()) ? '~' + d.slice(home.length) : d
}
