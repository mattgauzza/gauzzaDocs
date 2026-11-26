import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, type WebContents, app, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { inFile, instructionsFor, renameInstructions, setDocInstructions, setGlobal } from '../core/instructions'
import type { HistoryEventType, WriteContext } from '../core/history'
import {
  HOME, PLUGINS_DIR, addRecent, freeName, getRecent, getSettings, removeRecent, renameRecent, samePath, setSettings
} from '../core/paths'
import { wrapHtml } from '../shared/convert'
import { describeOps } from '../shared/history/describe'
import { type Kind, OPEN_FILTERS, extOf, kindOf, stem } from '../shared/kinds'
import type { AgentInfo, AgentOp, FilePayload, OpenFile } from '../shared/types'
import * as comments from '../core/comments'
import { type Bridge, type Listener, startBridge } from './server'
import { AgentRunner, writeLaunchers } from './agents'
import * as subs from '../core/subscriptions'
import { attachContextMenu, setupSpelling } from './contextMenu'
import { onWorkerEvent, stopWorker, warmUp, work } from './work'
import { stopWatching, watchFolders } from './folders'
import { closeSettings, defaultsPageUrl, defaultsStatus, registerWithWindows } from './winAssoc'
import { installUpdate, updateReady, watchForUpdates } from './updates'
import { LOOK_MAX, closeLook, look } from './look'
import { personName } from '../core/person'
import { mentionsName } from '../shared/mentions'

app.setAppUserModelId('app.gauzzadocs.desktop')
protocol.registerSchemesAsPrivileged([
  { scheme: 'gdplugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'gdfile', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let win: BrowserWindow | null = null
let bridge: Bridge | null = null
/** Bundled copy of the plugin library, used when GitHub cannot be reached. */
const BUNDLED_PLUGINS = path.join(app.getAppPath(), 'plugins')

// ---------- what the window has open (it tells us; we answer the CLI from this) ----------
interface TabInfo { path: string; kind: Kind; dirty: boolean; active?: boolean; large?: boolean }
let tabs: TabInfo[] = []
// Large-file tabs are views, not editors: agent ops on them go straight to the file on disk.
const isOpen = (file: string) => tabs.some(t => !t.large && samePath(t.path, file))
const isShown = (file: string) => tabs.some(t => samePath(t.path, file)) || openingNow.has(file.toLowerCase())
const openingNow = new Set<string>()

/** URL the window reads an open file through, by byte range (PDFs stream their pages from it). */
const fileUrl = (file: string, mtime: number) => `gdfile://f/${encodeURIComponent(file)}?v=${Math.round(mtime)}`

// ---------- requests to the window (agent ops), answered over 'agent:reply' ----------
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
function askWindow(channel: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
  if (!win) return Promise.reject(new Error('The app window is not open'))
  return askWeb(win.webContents, channel, payload, timeoutMs)
}
/** The same request and reply, to any of our windows (the app window, or the hidden one `gdocs look` renders in). */
function askWeb(wc: WebContents, channel: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The app did not answer in time'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    wc.send(channel, { id, ...payload })
  })
}
ipcMain.handle('agent:reply', (_e, id: number, reply: { result?: unknown; error?: string }) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (reply.error) p.reject(new Error(reply.error))
  else p.resolve(reply.result)
})

/** Opens a file in the window (or focuses its tab) and waits until its editor is ready for agent ops. */
async function openInWindow(file: string, opts: { focus?: boolean } = {}) {
  const p = path.resolve(file)
  if (!fs.existsSync(p)) throw new Error(`No such file: ${p}`)
  if (!win) createWindow()
  if (opts.focus !== false) {
    if (win!.isMinimized()) win!.restore()
    win!.show()
    win!.focus()
  }
  await askWindow('open', { path: p }, 30_000)
  return p
}

/** `ctx` says who created it: its first version is theirs. `preset` is a new design's size (a PRESETS name or <w>x<h>). */
async function newFilePath(kind: Kind, ext: string | undefined, name: string | undefined, dir: string | undefined, ctx: WriteContext, preset?: string) {
  const s = getSettings()
  const e = ext || { doc: s.newDocFormat, sheet: 'xlsx', text: 'txt', pdf: 'pdf', slides: 'pptx', design: 'gdesign' }[kind]
  const base = name || { doc: 'Untitled document', sheet: 'Untitled spreadsheet', text: 'Untitled', pdf: 'Untitled', slides: 'Untitled presentation', design: 'Untitled design' }[kind]
  const file = freeName(dir || s.docsDir, base, e)
  await work('createFile', [file, ctx, preset])
  return file
}

// ---------- the CLI bridge ----------
async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const file = typeof params.path === 'string' ? path.resolve(params.path) : ''
  const agent: AgentInfo = (params.agent as AgentInfo) || { name: 'Agent' }
  switch (method) {
    case 'ping':
      return { app: 'gauzzaDocs', version: app.getVersion(), pid: process.pid }
    case 'list':
      return tabs
    case 'open':
      return { path: await openInWindow(file, { focus: params.focus !== false }) }
    case 'new': {
      const preset = typeof params.preset === 'string' ? params.preset : undefined
      const created = await newFilePath(String(params.kind || 'doc') as Kind, params.ext as string, params.name as string, undefined, asAgent(agent), preset)
      if (params.open !== false) await openInWindow(created)
      return { path: created }
    }
    // The CLI asks before an --offline op on a design: one open here takes every op in its editor.
    case 'isOpen':
      return { open: isOpen(file) }
    // ---------- comments: agents read and answer the person's comments ----------
    case 'comments':
      return comments.list(file, { all: !!params.all })
    case 'comment': {
      const t = comments.add(file, { text: String(params.text || ''), quote: params.quote as string, anchor: params.anchor as never, author: agent.name, by: 'agent' })
      commentsChanged(file, { type: 'comment', by: 'agent', author: agent.name, thread: t })
      flashIfAsked(t.text)
      return t
    }
    case 'reply': {
      const r = comments.reply(file, String(params.id), { text: String(params.text || ''), author: agent.name, by: 'agent' })
      commentsChanged(file, { type: 'reply', by: 'agent', author: agent.name, thread: r.thread, reply: r.reply })
      flashIfAsked(r.reply.text)
      return r
    }
    case 'resolve': {
      const t = comments.resolve(file, String(params.id), params.reopen ? false : true)
      commentsChanged(file, { type: 'resolved', by: 'agent', author: agent.name, thread: t, resolved: t.resolved })
      return t
    }
    // ---------- agents subscribed to a document ----------
    case 'subscribe': {
      const sub = subs.subscribe(file, { agent: params.agent_kind as subs.AgentKind, name: params.name as string, role: params.role as subs.Role, brief: params.brief as string })
      if (params.start) runner?.wake(sub.id)
      agentsChanged()
      logHistory(sub.path, 'subscribed', agent.name, `added ${sub.name} as ${sub.role}`)
      return sub
    }
    case 'unsubscribe': {
      const sub = subs.findSubscription(file, String(params.name || ''))
      if (!sub) throw new Error(`No agent called ${params.name} on this document`)
      runner?.stop(sub.id)
      subs.unsubscribe(sub.id)
      agentsChanged()
      logHistory(sub.path, 'unsubscribed', agent.name, `removed ${sub.name}`)
      return { ok: true, removed: sub.name }
    }
    case 'participants':
      return runner?.states(file) || subs.listSubscriptions(file)
    case 'wake': {
      const sub = subs.findSubscription(file, String(params.name || ''))
      if (!sub) throw new Error(`No agent called ${params.name} on this document`)
      if (sub.paused) subs.updateSubscription(sub.id, { paused: false })
      runner?.wake(sub.id, params.note as string | undefined)
      return { ok: true, woke: sub.name }
    }
    case 'listeners':
      return bridge?.listeners() || []
    // ---------- agents seeing the document: screenshots of it as the app shows it ----------
    case 'look': {
      if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`)
      let content = isOpen(file) ? ((await askWindow('snapshot', { path: file, agent }, 30_000).catch(() => null)) as { kind: Kind; payload: FilePayload } | null) : null
      if (!content) {
        const st = fs.statSync(file)
        if (kindOf(file) === 'pdf') content = { kind: 'pdf', payload: { kind: 'pdf', bytes: new Uint8Array(0), url: fileUrl(file, st.mtimeMs) } as FilePayload }
        else {
          if (st.size > 32 * 1024 * 1024) throw new Error('That file is too big to picture. Use gdocs read or gdocs find to check it instead.')
          const f = await work<OpenFile>('loadFile', [file])
          content = { kind: f.kind, payload: f.payload }
        }
      }
      return look(
        {
          path: file,
          kind: content.kind,
          payload: content.payload,
          from: params.from as number | undefined,
          count: params.all ? LOOK_MAX : (params.count as number | undefined),
          width: params.width as number | undefined,
          height: params.height as number | undefined,
          theme: params.theme as string | undefined,
          out: params.out as string | undefined
        },
        askWeb,
        path.join(__dirname, '../preload/index.js'),
        w => (process.env.ELECTRON_RENDERER_URL ? w.loadURL(process.env.ELECTRON_RENDERER_URL + '#look') : w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'look' }))
      )
    }
    case 'close':
      if (!isOpen(file)) return { ok: true, wasOpen: false }
      return askWindow('close', { path: file, force: !!params.force })
    case 'op': {
      const op = params.op as AgentOp
      if (!op?.op) throw new Error('missing op')
      const edits = !READ_ONLY_OPS.has(op.op) && op.op !== 'save' && !op.dryRun // what goes in the work history
      // --live: open it, or bring its tab to the front, so the person can watch the edit happen.
      // (Just opened counts as open: the window's tab list can arrive a moment after the editor is ready.)
      let opened = false
      if (params.live) opened = !!(await openInWindow(file, { focus: params.focus !== false }))
      // Replacing text in a PDF needs the page drawn to match its text and background colors: only the app can.
      else if (kindOf(file) === 'pdf' && (op.op === 'replaceText' || op.op === 'replace') && !isOpen(file) && win)
        opened = !!(await openInWindow(file, { focus: false }))
      if (opened || isOpen(file)) {
        const result = await askWindow('agent', { path: file, op, agent })
        if (edits) logHistory(file, 'agent-op', agent.name, op.op)
        return { result, live: true }
      }
      if (op.op === 'save') return { result: { ok: true, note: 'not open; nothing to save' }, live: false }
      // The version this edit keeps is credited to the agent.
      const offline = await work('runOffline', [file, op, { ...asAgent(agent), summary: describeOps([op.op], kindOf(file)) }])
      // Other agents hear about edits made on disk too (live edits are diffed by the window instead).
      if (!READ_ONLY_OPS.has(op.op)) bridge?.emit({ type: 'edit', by: 'agent', author: agent.name, path: file, summary: `${op.op} (on disk)` })
      if (edits) logHistory(file, 'agent-op', agent.name, op.op)
      return { result: offline, live: false }
    }
    // ---------- version history (the CLI reads and writes it directly; these need the app) ----------
    case 'historyRestore': {
      // An open file is restored through its tab, which keeps unsaved edits as a version and then reloads.
      const n = Number(String(params.n ?? '').replace(/^v/i, ''))
      if (!Number.isInteger(n) || n < 1) throw new Error(`Not a version number: ${params.n}`)
      const opts = { discardCurrent: !!params.discardCurrent, authors: asAgent(agent).authors }
      if (win && isOpen(file)) return { version: await askWindow('history-restore', { path: file, n, ...opts }), live: true }
      return { version: await work('historyRestore', [file, n, opts]), live: false }
    }
    case 'historyName':
      return work('historyName', [file, params.n, String(params.name ?? ''), agent.name])
    case 'historyForget':
      await work('historyForget', [file])
      return { ok: true }
    default:
      throw new Error(`Unknown method "${method}"`)
  }
}

/** Ops that only look, so they're not news to other agents. */
const READ_ONLY_OPS = new Set(['read', 'info', 'find', 'outline', 'get', 'sheets', 'charts', 'rules', 'merges', 'comments'])

// ---------- subscribed agents ----------
let runner: AgentRunner | null = null
/** Listeners the window diffs edits for: agents connected with `gdocs listen`, plus every active subscription. */
function allListeners(): Listener[] {
  const live = bridge?.listeners() || []
  const virtual = subs.listSubscriptions().filter(s => !s.paused).map((s, i) => ({ id: -1 - i, agent: s.name, path: s.path, since: s.created, virtual: true }))
  return [...live, ...virtual] as Listener[]
}
function agentsChanged() {
  win?.webContents.send('listeners', allListeners())
  runner?.publish()
}

/** Tells the window (to redraw the comment panel) and every listening agent that a thread changed, and logs it. */
function commentsChanged(file: string, event: Record<string, unknown>) {
  win?.webContents.send('comments-changed', path.resolve(file))
  bridge?.emit({ ...event, type: String(event.type), path: path.resolve(file) })
  const by = String(event.author || '')
  const thread = event.thread as comments.Thread | undefined
  if (event.type === 'comment' && thread) logHistory(file, 'comment', by, `commented: ${clip(thread.text)}`)
  else if (event.type === 'reply' && event.reply) logHistory(file, 'reply', by, `replied: ${clip((event.reply as comments.Reply).text)}`)
  else if (event.type === 'resolved' && thread) logHistory(file, 'resolved', by, `${event.resolved ? 'resolved' : 'reopened'} a comment: ${clip(thread.text)}`)
}
const userName = personName

/** An agent asked the person something (@Name): flash the taskbar button if gauzzaDocs isn't the window in front. */
function flashIfAsked(text: string) {
  if (win && !win.isDestroyed() && !win.isFocused() && mentionsName(text, userName())) win.flashFrame(true)
}

// ---------- version history and work history (kept by the worker; see src/core/history) ----------
/** What the window saves, restores and creates is the person's. */
const person = (): WriteContext => ({ authors: [{ name: userName(), by: 'person' }] })
const asAgent = (agent: AgentInfo): WriteContext => ({ authors: [{ name: agent.name, by: 'agent' }] })
const clip = (s: string, n = 80) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}

/**
 * A work history event. Main hears about these first; the worker, the app's one history writer, keeps them. Once
 * kept, the window hears 'history-changed' so an open version history panel shows it.
 */
function logHistory(file: string, type: HistoryEventType, by: string, summary: string, at = Date.now()) {
  const p = path.resolve(file)
  work('historyEvent', [p, { at, type, by, summary }]).then(() => sendToWindow('history-changed', p), () => {})
}

/** Tells the window something, unless it is gone (closing during quit): a late history job must not throw then. */
function sendToWindow(channel: string, ...args: unknown[]) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
  } catch {
    /* the window went away meanwhile */
  }
}

/** A rename in the app takes the version history of the file (or of every file in the folder) with it, credited to the person. Never fails the rename. */
const carryHistory = (from: string, to: string) => void work('historyMove', [path.resolve(from), path.resolve(to), userName()]).catch(() => {})

/**
 * folders.ts reports each changed file of a folder that settled, all in one go. The window refreshes each folder once,
 * and the worker gets every changed path in one batch: it looks for outside changes in the ones it keeps history for
 * (main does no per-file work here, so a big checkout into a watched folder cannot stall the window).
 */
const changedDirs = new Map<string, [string, string]>()
const changedFiles = new Set<string>()
function folderChanged(root: string, dir: string, file: string) {
  if (!changedDirs.size && !changedFiles.size) {
    setImmediate(() => {
      // Taken and cleared first: if sending throws, later changes still get their own flush.
      const dirs = [...changedDirs.values()]
      const files = [...changedFiles]
      changedDirs.clear()
      changedFiles.clear()
      for (const [r, d] of dirs) sendToWindow('folder-changed', r, d)
      if (files.length) work('historyCheckChanged', [files]).catch(() => {})
    })
  }
  changedDirs.set(`${root}|${dir}`.toLowerCase(), [root, dir])
  changedFiles.add(file)
}

// Agents connected with `gdocs listen` come and go: `listen --once` reconnects after every comment it handles. Only
// arriving and leaving for good belong in the work history, so a departure is logged after a grace period.
const LISTEN_GRACE_MS = 2 * 60_000
let listening = new Map<string, Listener>()
const leaving = new Map<string, { timer: NodeJS.Timeout; log: () => void }>()
const listenKey = (l: Listener) => `${l.agent.toLowerCase()}|${path.resolve(l.path!).toLowerCase()}`
function listenersChanged(list: Listener[]) {
  const now = new Map(list.filter(l => l.path).map(l => [listenKey(l), l]))
  for (const [k, l] of now) {
    if (listening.has(k)) continue
    const away = leaving.get(k)
    if (away) {
      clearTimeout(away.timer) // back within the grace period: the same visit
      leaving.delete(k)
    } else logHistory(l.path!, 'connected', l.agent, 'started listening')
  }
  for (const [k, l] of listening) {
    if (now.has(k) || leaving.has(k)) continue
    const at = Date.now()
    const log = () => {
      leaving.delete(k)
      logHistory(l.path!, 'disconnected', l.agent, 'stopped listening', at)
    }
    leaving.set(k, { timer: setTimeout(log, LISTEN_GRACE_MS), log })
  }
  listening = now
  win?.webContents.send('listeners', allListeners())
}

/** "Version history paused: <reason>": the window hears it once per session, however often the worker reports it. */
let historyPaused: string | null = null
let historyPausedShown = false
function showHistoryPaused() {
  if (!historyPaused || historyPausedShown || !win || win.webContents.isLoading()) return
  historyPausedShown = true
  win.webContents.send('history-paused', historyPaused)
}
onWorkerEvent((name, data) => {
  if (name !== 'history-paused' || historyPaused) return
  historyPaused = String((data as { reason?: unknown })?.reason || 'unknown error')
  showHistoryPaused()
})

// ---------- window ----------
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'gauzzaDocs',
    backgroundColor: dark ? '#1b1c1f' : '#f9fbfd',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#e3e3e3' : '#444746', height: 40 },
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, spellcheck: true }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => win?.flashFrame(false))
  // A history failure reported before the window could hear it (a moment for its listeners to be set up).
  win.webContents.on('did-finish-load', () => setTimeout(showHistoryPaused, 1000))
  win.on('closed', () => {
    win = null
    tabs = []
    closeLook()
  })
  // Links in documents open in the browser, never inside the app.
  attachContextMenu(win) // right-click menu with spelling suggestions (see contextMenu.ts)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    }
  })
  // The window asks before closing when files have unsaved changes.
  win.on('close', e => {
    if (forceQuit || !tabs.some(t => t.dirty)) return
    e.preventDefault()
    win!.webContents.send('confirm-quit')
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}
let forceQuit = false

/** Renders HTML to PDF bytes in a hidden window (Export → PDF for documents, sheets and printing). */
async function htmlToPdf(html: string, title: string): Promise<Uint8Array> {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, offscreen: true } })
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.startsWith('<!doctype') ? html : wrapHtml(html, title)))
    return await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true }) // slides: @page sets 16:9
  } finally {
    w.destroy()
  }
}

// ---------- the window's API (window.gd.call(method, ...args)) ----------
const api: Record<string, (...a: any[]) => unknown> = {
  load: async (file: string) => {
    const p = path.resolve(file)
    openingNow.add(p.toLowerCase())
    setTimeout(() => openingNow.delete(p.toLowerCase()), 30_000)
    // PDFs are not read here: the window streams the pages it shows through gdfile:.
    if (kindOf(p) === 'pdf') {
      const st = fs.statSync(p)
      addRecent(p)
      work('historyCheck', [p]).catch(() => {}) // the worker's loadFile does this for every other kind
      return { path: p, kind: 'pdf', payload: { kind: 'pdf', bytes: new Uint8Array(0), url: fileUrl(p, st.mtimeMs) }, mtime: st.mtimeMs }
    }
    const f = await work<OpenFile>('loadFile', [p])
    addRecent(f.path)
    return f
  },
  largeIndex: async (file: string) => {
    return work('largeIndex', [file], f => win?.webContents.send('large-progress', file, f))
  },
  largeLines: (file: string, from: number, count: number) => work('largeLines', [file, from, count]),
  largeFind: (file: string, q: string, opts: { from?: number; limit?: number; regex?: boolean; ignoreCase?: boolean }) => work('largeFind', [file, q, opts]),
  largeForget: (file: string) => work('largeForget', [file]),
  /** An installed font's file for a PDF font name (PDF text edits keep the PDF's own font when it's installed). */
  systemFont: (name: string) => work('systemFont', [name]),
  // ---------- designs: fonts and diagram layout come from the worker (the window can't scan fonts or run ELK) ----------
  /** The installed face closest to a design's font reference ({ family, weight, style, postscript? }), or null. */
  designFontBytes: (ref: unknown) => work('designFontBytes', [ref]),
  /** Liberation Sans Regular, what a design's text falls back to. */
  designFallbackFont: () => work('designFallbackFont'),
  /** A diagram's graph laid out by ELK. */
  designLayout: (graph: unknown) => work('designLayout', [graph]),
  /** ctx: who changed it since the last save ({ authors, summary }); the person when the window does not say. */
  save: (file: string, payload: FilePayload, ctx?: WriteContext) => work<number>('saveFile', [file, payload, ctx ?? person()]),
  /** preset: a new design's size (a PRESETS name or <w>x<h>). */
  newFile: (kind: Kind, ext?: string, dir?: string, preset?: string) => newFilePath(kind, ext, undefined, dir, person(), preset),
  /** The person's name: comments and versions credit it, and agents @mention it to ask them something. */
  userName: () => userName(),
  // ---------- version history (worker jobs; see historyJobs.ts) ----------
  historyList: (file: string) => work('historyList', [file]),
  historyLog: (file: string) => work('historyLog', [file]),
  historyDiff: (file: string, a: number, b?: number) => work('historyDiff', [file, a, b]),
  /** opts: { unsavedPayload?, unsavedAuthors?, discardCurrent?, authors? }; authors (who asks) default to the person; unsavedAuthors (who made the unsaved edits) to authors. */
  historyRestore: (
    file: string,
    n: number,
    opts: { unsavedPayload?: FilePayload; unsavedAuthors?: WriteContext['authors']; discardCurrent?: boolean; authors?: WriteContext['authors'] } = {}
  ) =>
    work('historyRestore', [file, n, { ...opts, authors: opts.authors?.length ? opts.authors : person().authors }]),
  historyName: (file: string, n: number, name: string) => work('historyName', [file, n, name, userName()]),
  historyForget: (file: string) => work('historyForget', [file]),
  historyMove: (from: string, to: string) => work('historyMove', [from, to, userName()]),
  historyCheck: (file: string) => work('historyCheck', [file]),
  historyEvent: (file: string, event: { type: HistoryEventType; by: string; summary: string; at?: number }) => work('historyEvent', [file, event]),
  historyCleanup: () => work('historyCleanup'),
  /** { bytes, capBytes, overCapBytes?, paused?, dir } (paused: the reason history stopped recording this session; dir: where it is kept). */
  historyStats: async () => ({
    ...(await work<Record<string, unknown>>('historyStats')),
    ...(historyPaused ? { paused: historyPaused } : {}),
    dir: path.join(HOME, 'history')
  }),
  historyFlush: () => work('historyFlush'),
  /** Writes version n to a new file in the docs folder and returns its path (Open as a copy). */
  historyOpenCopy: (file: string, n: number) => work<string>('historyOpenCopy', [file, n]),
  // ---------- projects: folders on the home screen and in the explorer (listing and search run on the worker) ----------
  projectsList: () => work('projectsList'),
  projectsAdd: (dir: string, name?: string) => work('projectsAdd', [dir, name]),
  projectsRemove: (dir: string) => work('projectsRemove', [dir]),
  projectsRename: (dir: string, name: string) => work('projectsRename', [dir, name]),
  projectsTouch: (dir: string) => work('projectsTouch', [dir]),
  projectFor: (file: string) => work('projectFor', [file]),
  listFolder: (dir: string) => work('listFolder', [dir]),
  searchFolder: (root: string, q: string) => work('searchFolder', [root, q, { limit: 300 }]),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  isFolder: (p: string) => fs.promises.stat(p).then(s => s.isDirectory(), () => false),
  /** Folder browser rename: the full name (with extension) of a file or folder. Keeps recent files, comments and instructions with it. */
  renameEntry: async (p: string, name: string) => {
    const clean = name.replace(/[\\/:*?"<>|]/g, '').trim()
    if (!clean) throw new Error('Name cannot be empty')
    const to = path.join(path.dirname(p), clean)
    if (samePath(to, p)) return p
    if (fs.existsSync(to)) throw new Error(`${clean} already exists`)
    await fs.promises.rename(p, to)
    renameRecent(p, to)
    renameInstructions(p, to)
    comments.renameComments(p, to)
    carryHistory(p, to)
    return to
  },
  /** To the Recycle Bin (or the OS trash), never a hard delete. */
  trash: (p: string) => shell.trashItem(p),
  /** Files gauzzaDocs does not edit (images, zips, ...) open in their usual app. */
  openWithSystem: (p: string) => shell.openPath(p),
  /** The window says which project folders it is showing; only those are watched. */
  watchFolders: (roots: string[]) => watchFolders(roots, folderChanged),
  openDialog: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: OPEN_FILTERS })
    return r.canceled ? [] : r.filePaths
  },
  saveAsDialog: async (file: string) => {
    const ext = extOf(file)
    const kind = kindOf(file)
    const choices: Record<Kind, string[]> = { doc: ['html', 'md', 'docx'], sheet: ['xlsx', 'csv', 'tsv'], pdf: ['pdf'], text: [ext || 'txt'], slides: ['pptx'], design: ['gdesign'] }
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: file,
      filters: [...new Set([ext, ...choices[kind]])].filter(Boolean).map(e => ({ name: e.toUpperCase(), extensions: [e] }))
    })
    return r.canceled ? null : r.filePath
  },
  /** Export to another format without changing which file is open. */
  exportFile: async (file: string, payload: FilePayload, format: string, html?: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(path.dirname(file), `${stem(file)}.${format}`),
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    if (r.canceled || !r.filePath) return null
    // A save like any other: exporting over an existing file keeps a version of it, credited to the person.
    if (format === 'pdf' && payload.kind !== 'pdf') await work('saveFile', [r.filePath, { kind: 'pdf', bytes: await htmlToPdf(html || '', stem(file)) }, person()])
    else await work('saveFile', [r.filePath, payload, person()])
    return r.filePath
  },
  print: async (html: string, title: string) => {
    const tmp = path.join(os.tmpdir(), `gauzzadocs-print-${Date.now()}.pdf`)
    fs.writeFileSync(tmp, await htmlToPdf(html, title))
    await shell.openPath(tmp)
    return tmp
  },
  rename: (file: string, newStem: string) => {
    const clean = newStem.replace(/[\\/:*?"<>|]/g, '').trim()
    if (!clean) throw new Error('Name cannot be empty')
    const to = path.join(path.dirname(file), `${clean}${path.extname(file)}`)
    if (samePath(to, file)) return file
    if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists`)
    fs.renameSync(file, to)
    renameRecent(file, to)
    renameInstructions(file, to)
    subs.renameSubscriptions(file, to)
    comments.renameComments(file, to)
    carryHistory(file, to)
    return to
  },
  instructions: (file?: string) => instructionsFor(file),
  /**
   * file null = the global instructions. Per-file ones in HTML/Markdown are written into the file itself: a save, so
   * the worker does it and keeps a version credited to the person. Resolves with the file's mtime, so the open tab
   * does not take this for someone else's edit.
   */
  setInstructions: async (file: string | null, text: string) => {
    if (!file) return setGlobal(text), 0
    if (inFile(file)) return work<number>('setDocInstructions', [file, text, person()])
    await setDocInstructions(file, text)
    return fs.statSync(file).mtimeMs
  },
  recent: () => getRecent(),
  removeRecent: (file: string) => removeRecent(file),
  listDir: (dir: string) =>
    fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.'))
      .map(d => {
        const p = path.join(dir, d.name)
        let mtime = 0
        try { mtime = fs.statSync(p).mtimeMs } catch { /* vanished */ }
        return { name: d.name, path: p, dir: d.isDirectory(), mtime }
      }),
  stat: (file: string) => {
    try {
      const s = fs.statSync(file)
      return { size: s.size, mtime: s.mtimeMs, created: s.birthtimeMs }
    } catch {
      return null
    }
  },
  mtime: (file: string) => {
    try { return fs.statSync(file).mtimeMs } catch { return 0 }
  },
  settings: () => getSettings(),
  setSettings: (patch: Record<string, unknown>) => {
    const next = setSettings(patch)
    if ('spellcheck' in patch) setupSpelling(next.spellcheck !== false) // View > Check spelling
    return next
  },
  reveal: (file: string) => shell.showItemInFolder(file),
  openExternal: (url: string) => (/^https?:/i.test(url) ? shell.openExternal(url) : undefined),
  agentsDetect: () => work('agentsDetect'),
  agentsInstall: (ids: string[]) => work('agentsInstall', [ids, app.getVersion()]),
  agentsRemove: (ids: string[]) => work('agentsRemove', [ids]),
  /** First run: the welcome screen shows until it has been closed once. */
  welcomed: () => fs.existsSync(path.join(HOME, 'welcomed')),
  setWelcomed: () => {
    fs.mkdirSync(HOME, { recursive: true })
    fs.writeFileSync(path.join(HOME, 'welcomed'), app.getVersion())
  },
  pluginsInstalled: () => work('pluginsInstalled'),
  pluginsLibrary: () => work('pluginsLibrary', [BUNDLED_PLUGINS]),
  pluginsInstall: (id: string) => work('pluginsInstall', [id, BUNDLED_PLUGINS]),
  pluginsUpdateAll: () => work('pluginsUpdateAll', [BUNDLED_PLUGINS]),
  pluginsRemove: (id: string) => work('pluginsRemove', [id]),
  pluginsSetEnabled: (id: string, on: boolean) => work('pluginsSetEnabled', [id, on]),
  // Comments made in the window are the person's.
  commentsList: (file: string, all?: boolean) => comments.list(file, { all }),
  commentAdd: (file: string, c: { text: string; quote?: string; anchor?: comments.Thread['anchor'] }) => {
    const t = comments.add(file, { ...c, author: userName(), by: 'user' })
    commentsChanged(file, { type: 'comment', by: 'user', author: t.author, thread: t })
    return t
  },
  commentReply: (file: string, id: string, text: string) => {
    const r = comments.reply(file, id, { text, author: userName(), by: 'user' })
    commentsChanged(file, { type: 'reply', by: 'user', author: r.reply.author, thread: r.thread, reply: r.reply })
    return r
  },
  commentResolve: (file: string, id: string, resolved: boolean) => {
    const t = comments.resolve(file, id, resolved)
    commentsChanged(file, { type: 'resolved', by: 'user', author: userName(), thread: t, resolved })
    return t
  },
  commentDelete: (file: string, id: string) => {
    comments.remove(file, id)
    commentsChanged(file, { type: 'deleted', by: 'user', id })
  },
  listenerDisconnect: (id: number) => bridge?.disconnect(id) ?? false,
  listenersBlocked: () => bridge?.blocked() || [],
  listenerUnblock: (agent: string, p?: string) => bridge?.unblock(agent, p),
  listeners: () => allListeners(),
  // Agents subscribed to documents (Add agent, the participant strip).
  agentsOn: (file: string) => runner?.states(file) || [],
  agentSubscribe: (file: string, s: { agent: subs.AgentKind; name?: string; role?: subs.Role; brief?: string; start?: boolean }) => {
    const sub = subs.subscribe(file, s)
    if (s.start) runner?.wake(sub.id)
    agentsChanged()
    logHistory(sub.path, 'subscribed', userName(), `added ${sub.name} as ${sub.role}`)
    return sub
  },
  agentUpdate: (id: string, patch: { brief?: string; role?: subs.Role; paused?: boolean }) => {
    const sub = subs.updateSubscription(id, patch)
    if (patch.paused) runner?.stop(id)
    agentsChanged()
    return sub
  },
  agentRemove: (id: string) => {
    const sub = subs.listSubscriptions().find(x => x.id === id)
    runner?.stop(id)
    subs.unsubscribe(id)
    agentsChanged()
    if (sub) logHistory(sub.path, 'unsubscribed', userName(), `removed ${sub.name}`)
  },
  agentWake: (id: string, note?: string) => {
    const s = subs.listSubscriptions().find(x => x.id === id)
    if (s?.paused) subs.updateSubscription(id, { paused: false })
    runner?.wake(id, note)
    agentsChanged()
  },
  agentLog: (id: string) => runner?.lastLog(id) || '',
  cliInfo: () => ({ port: bridge?.port, cli: path.join(app.getAppPath(), 'dist', 'cli.mjs'), home: os.homedir() }),
  updateReady: () => updateReady(),
  installUpdate: () => {
    forceQuit = true
    installUpdate()
  },
  /** Windows only lets the person pick default apps; this opens that page (or the OS equivalent). */
  defaultsStatus: () => defaultsStatus(),
  openDefaultApps: () => {
    if (process.platform === 'win32') {
      // Straight to gauzzaDocs' own page (every file type, one click each). Make sure the registration is in place first.
      return (app.isPackaged ? registerWithWindows(process.execPath).catch(() => {}) : Promise.resolve()).then(closeSettings).then(() => shell.openExternal(defaultsPageUrl()))
    }
    if (process.platform === 'darwin') return dialog.showMessageBox(win!, { message: 'In Finder, select a file, press Cmd+I, pick gauzzaDocs under "Open with" and click Change All.' })
    return dialog.showMessageBox(win!, { message: 'Right-click a file in your file manager, choose Open With, pick gauzzaDocs and set it as the default.' })
  },
  openUrl: (url: string) => (/^https:\/\//i.test(url) ? shell.openExternal(url) : undefined),
  quit: () => {
    forceQuit = true
    app.quit()
  }
}

ipcMain.handle('api', async (_e, method: string, args: unknown[]) => {
  const fn = api[method]
  if (!fn) throw new Error(`Unknown api method ${method}`)
  return fn(...args)
})
ipcMain.on('tabs', (_e, list: TabInfo[]) => {
  const before = new Set(tabs.map(t => t.path))
  tabs = list
  for (const t of list) if (!before.has(t.path)) bridge?.emit({ type: 'opened', path: t.path })
  for (const p of before) if (!list.some(t => t.path === p)) bridge?.emit({ type: 'closed', path: p })
})
ipcMain.on('changed', (_e, file: string, info: Record<string, unknown>) => bridge?.emit({ type: 'changed', path: file, ...info }))

// ---------- CLI launcher (installed copies only), like quickMail ----------
/**
 * Installed copies put the CLI on PATH: `gauzzadocs` always, and the short `gdocs` too unless another program already
 * owns that name (a launcher we did not write is left alone; the long name still works). Rewritten on start so they
 * follow app updates. Windows: the per-user WindowsApps folder, already on PATH. macOS/Linux: ~/.local/bin.
 */
function installCli() {
  if (!app.isPackaged || /[\\/]release[\\/]/i.test(process.execPath)) return
  const cli = path.join(app.getAppPath(), 'dist', 'cli.mjs')
  const ours = (text: string) => text.includes('ELECTRON_RUN_AS_NODE') && /gauzzadocs/i.test(text)
  const put = (file: string, body: string, always: boolean, mode?: number) => {
    try {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      if (cur === body) return
      if (cur !== null && !always && !ours(cur)) return // someone else's gdocs: keep it
      fs.writeFileSync(file, body, mode ? { mode } : undefined)
    } catch { /* no launcher; the app still works */ }
  }
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) return
    const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
    const body = `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`
    put(path.join(dir, 'gauzzadocs.cmd'), body, true)
    put(path.join(dir, 'gdocs.cmd'), body, false)
    // Git Bash (the shell Claude Code uses on Windows) can't run a .cmd by its bare name; npm writes these too.
    const fwd = (p: string) => p.replace(/\\/g, '/')
    const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${fwd(process.execPath)}" "${fwd(cli)}" "$@"\n`
    put(path.join(dir, 'gauzzadocs'), sh, true)
    put(path.join(dir, 'gdocs'), sh, false)
  } else if (!process.env.APPIMAGE) {
    const bin = path.join(os.homedir(), '.local', 'bin')
    const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" "$@"\n`
    try { fs.mkdirSync(bin, { recursive: true }) } catch { return }
    put(path.join(bin, 'gauzzadocs'), sh, true, 0o755)
    put(path.join(bin, 'gdocs'), sh, false, 0o755)
  }
}

// ---------- startup ----------
const filesFromArgv = (argv: string[]) => argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile())

if (!app.requestSingleInstanceLock()) app.quit()
else {
  // macOS hands double-clicked files over as events (possibly before the window exists).
  const pendingOpen: string[] = []
  app.on('open-file', (e, file) => {
    e.preventDefault()
    if (win && app.isReady()) openInWindow(file).catch(() => {})
    else pendingOpen.push(file)
  })
  app.on('second-instance', (_e, argv) => {
    if (!win) createWindow()
    else {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    for (const f of filesFromArgv(argv)) openInWindow(f).catch(() => {})
  })

  app.whenReady().then(async () => {
    // Byte-range file reads for the window, limited to files it has open.
    protocol.handle('gdfile', async req => {
      const u = new URL(req.url)
      const file = decodeURIComponent(u.pathname.slice(1))
      if (!isShown(file) || !fs.existsSync(file)) return new Response('', { status: 403 })
      const size = fs.statSync(file).size
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '')
      const headers = { 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }
      if (!range) return new Response(fs.readFileSync(file), { status: 200, headers: { ...headers, 'content-length': String(size) } })
      const start = Number(range[1])
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1)
      if (start >= size || end < start) return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } })
      const buf = Buffer.allocUnsafe(end - start + 1)
      const fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }
      return new Response(buf, { status: 206, headers: { ...headers, 'content-length': String(buf.length), 'content-range': `bytes ${start}-${end}/${size}` } })
    })
    protocol.handle('gdplugin', req => {
      const u = new URL(req.url)
      const file = path.join(PLUGINS_DIR, u.hostname, decodeURIComponent(u.pathname))
      if (!file.startsWith(path.join(PLUGINS_DIR, u.hostname) + path.sep)) return new Response('', { status: 403 })
      return net.fetch(`file://${file.replace(/\\/g, '/')}`).then(r =>
        new Response(r.body, {
          status: r.status,
          headers: {
            'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript',
            'access-control-allow-origin': '*'
          }
        })
      )
    })
    fs.mkdirSync(getSettings().docsDir, { recursive: true })
    warmUp()
    // Version history retention and size cap: at start (once the first file has had time to open) and once a day.
    const cleanHistory = () => void work('historyCleanup').catch(() => {})
    setTimeout(cleanHistory, 30_000)
    setInterval(cleanHistory, 24 * 60 * 60_000)
    if (app.isPackaged) registerWithWindows(process.execPath).catch(() => {}) // Open with + the Default apps page
    if (app.isPackaged) work('agentsRefresh', [app.getVersion()]).catch(() => {}) // keep installed skills current
    setupSpelling(getSettings().spellcheck !== false)
    // Agents subscribed to documents run through their own CLIs; they use launchers that point at this app's CLI.
    const binDir = path.join(HOME, 'bin')
    try {
      writeLaunchers(binDir, process.execPath, path.join(app.getAppPath(), 'dist', 'cli.mjs'))
    } catch { /* agents fall back to the gdocs on PATH */ }
    runner = new AgentRunner({
      binDir,
      notify: states => win?.webContents.send('agents-state', states),
      // Every turn a subscribed agent takes (asked for by the person, by `gdocs wake`, or by something on the doc).
      onRunStart: sub => logHistory(sub.path, 'woken', sub.name, 'woke up and took a turn')
    })
    bridge = await startBridge(rpc, listenersChanged, ev => runner?.onEvent(ev as subs.DocEvent))
    installCli()
    createWindow()
    watchForUpdates(() => win)
    const initial = [...filesFromArgv(process.argv), ...pendingOpen.splice(0)]
    if (initial.length) win!.webContents.once('did-finish-load', () => setTimeout(() => initial.forEach(f => openInWindow(f).catch(() => {})), 300))
  })
  // Queued history writes get up to 5 seconds to finish before the worker stops (a slow disk must not hold up quitting).
  let historyFlushed = false
  let flushing = false
  app.on('before-quit', e => {
    forceQuit = true
    if (!historyFlushed) {
      e.preventDefault()
      if (flushing) return
      flushing = true
      for (const away of [...leaving.values()]) {
        clearTimeout(away.timer)
        away.log() // agents that left during the grace period
      }
      Promise.race([work('historyFlush'), new Promise(r => setTimeout(r, 5_000))])
        .catch(() => {})
        .finally(() => {
          historyFlushed = true
          app.quit()
        })
      return
    }
    closeLook()
    runner?.shutdown()
    stopWorker()
    stopWatching()
    bridge?.close()
  })
  app.on('window-all-closed', () => app.quit())
}
