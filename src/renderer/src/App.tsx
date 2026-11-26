import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Kind, baseName, extOf, kindOf, lossy, stem } from '../../shared/kinds'
import type { AgentInfo, AgentOp, Author, CommentAnchor, FilePayload, HistoryVersion, Settings } from '../../shared/types'
import type { EditorHandle, EditorProps, MenuItem, MenuName } from './editor'
import { type Listener, api, dirOf } from './lib'
import { DONATE, EMPIRICAL_VOICE, REPO, SUBMIT_PLUGIN } from '../../shared/links'
import { AgentDialog, Confirm, DonateDialog, InstructionsDialog, PluginsDialog, SettingsDialog, ShortcutsDialog } from './shell/Dialogs'
import { Home } from './shell/Home'
import { EDITORS } from './editors'
import { StatusBar } from './shell/StatusBar'
import { Connections } from './shell/Connections'
import { needsYouIn, trackFiles, useNeedsYou, useNeedsYouVersion } from './shell/needsYou'
import { EditorSkeleton } from './shell/Skeleton'
import { agentColor } from '../../shared/agentColors'
import { isReadOp } from '../../shared/ops/readOps'
import { ToolbarOverflow } from './shell/ToolbarOverflow'
import { usePanelSize } from './shell/resize'
import { Onboarding } from './shell/Onboarding'
import { Explorer } from './shell/Explorer'
import { TabBoundary } from './shell/TabBoundary'
import { CommentsPanel } from './shell/Comments'
import { HistoryPanel } from './shell/History'
import { errorText, saveContext } from './shell/historyView'
import { diffLines } from './shell/diff'
import LargeViewer from './shell/LargeViewer'
import { Participants } from './shell/Participants'
import { SelectionBubble } from './shell/SelectionBubble'
import { Icon, KindIcon, Logo } from './shell/icons'
import { designSizeItems } from './design/presets'
import { savePayload } from './shell/savePayload'
import { MenuBar, MenuList } from './shell/Menus'
import { type EditorAccess, type LoadedPlugins, fits, loadPlugins } from './shell/plugins'


interface Tab {
  id: number
  path: string
  kind: Kind
  payload: FilePayload | null // null = asleep: editor unmounted and content dropped; reloaded from disk on focus
  large?: boolean // shown by the large-file viewer
  mtime: number
  version: number // bumped to remount the editor with fresh content (reload from disk)
  dirty: boolean
  saving: boolean
  saved: number // time of last save, 0 = not saved this session
  error?: string
  external?: boolean // changed on disk while it had unsaved changes here
  agent?: AgentInfo & { until: number; reading?: boolean }
}

const HOME = -1
/** Save only on Ctrl+S? Word files say so per file (only when they hold things the editor would drop); PDFs always. */
const isLossy = (t: { path: string; payload: FilePayload | null }) =>
  (t.payload?.kind === 'doc' || t.payload?.kind === 'slides') && t.payload.lossy !== undefined ? t.payload.lossy : lossy(t.path)
/** Tabs kept loaded besides the active one (most recently used). The rest sleep once saved, to keep memory low. */
const WARM = 2
const SLEEP_AFTER_MS = 45_000
let nextId = 1
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<number>(HOME)
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [homeDir, setHomeDir] = useState('')
  const [plugins, setPlugins] = useState<LoadedPlugins | null>(null)
  const [dialog, setDialog] = useState<null | 'plugins' | 'settings' | 'agent' | 'shortcuts' | 'instructions' | 'donate'>(null)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; buttons: { label: string; primary?: boolean; run(): void }[] }>(null)
  const [toast, setToast] = useState('')
  const [preview, setPreview] = useState<string | null>(null) // plugin preview id shown beside the editor
  const [homeKey, setHomeKey] = useState(0)
  const [, force] = useState(0) // re-render when a handle registers (menus depend on it)

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeRef = useRef(active)
  activeRef.current = active
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const handles = useRef(new Map<number, EditorHandle>())
  const waiters = useRef(new Map<number, (() => void)[]>())
  const saveTimers = useRef(new Map<number, number>())
  const changeSeq = useRef(new Map<number, number>()) // bumps on every edit, so a save knows if edits came in meanwhile
  const [tabMenu, setTabMenu] = useState<null | { id: number; x: number; y: number }>(null)
  const dragTab = useRef<number | null>(null)

  const say = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout((say as any).t)
    ;(say as any).t = window.setTimeout(() => setToast(''), 3500)
  }, [])
  const patch = (id: number, p: Partial<Tab> | ((t: Tab) => Partial<Tab>)) =>
    setTabs(ts => ts.map(t => (t.id === id ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t)))
  const tabFor = (path: string) => tabsRef.current.find(t => same(t.path, path))
  const cur = tabs.find(t => t.id === active) || null
  // Whether the file in focus carries its own agent instructions (shown as a chip in the header).
  const [hasInstructions, setHasInstructions] = useState(false)
  // The list of agents connected to this file (click the listening chip, or Manage in the comments panel).
  const [connOpen, setConnOpen] = useState(false)
  useEffect(() => {
    const show = () => setConnOpen(true)
    window.addEventListener('gd-show-connections', show)
    return () => window.removeEventListener('gd-show-connections', show)
  }, [])
  useEffect(() => {
    if (dialog) setConnOpen(false) // a dialog takes over the screen
  }, [dialog])
  // The project explorer beside the editor (View > Explorer, Ctrl+Shift+E); remembered between sessions.
  const [explorer, setExplorerState] = useState(() => {
    try {
      return localStorage.getItem('explorerOpen') === '1'
    } catch {
      return false
    }
  })
  const setExplorer = (on: boolean) => {
    setExplorerState(on)
    try { localStorage.setItem('explorerOpen', on ? '1' : '0') } catch { /* storage off */ }
  }
  // First run: the setup screen (default app, AI agents, writing voice). Also Help > Set up gauzzaDocs.
  const [welcome, setWelcome] = useState(false)
  useEffect(() => void api.welcomed().then(w => !w && setWelcome(true), () => {}), [])
  // A downloaded update waiting for a restart (installed copies only).
  const [update, setUpdate] = useState('')
  useEffect(() => {
    api.updateReady().then(v => v && setUpdate(v))
    return window.gd.on('update', (v: string) => setUpdate(v))
  }, [])
  // A history failure never stops saving; main says so once per session.
  useEffect(() => window.gd.on('history-paused', (reason: string) => say(`Version history paused: ${reason}`)), [])
  // The person's name, as their versions credit them.
  const personRef = useRef('You')
  useEffect(() => void api.userName().then(n => void (n && (personRef.current = n)), () => {}), [])

  // ---------- two-way: comments and the agents listening ----------
  const [listeners, setListeners] = useState<Listener[]>([])
  const listenersRef = useRef<Listener[]>([])
  listenersRef.current = listeners
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentCount, setCommentCount] = useState(0)
  const [draftQuote, setDraftQuote] = useState('')
  const [draftAnchor, setDraftAnchor] = useState<CommentAnchor | undefined>()
  const [focusDraft, setFocusDraft] = useState(0)
  // Threads where an agent @mentioned the person and is waiting on them, for every open tab.
  useNeedsYouVersion()
  const asking = useNeedsYou(cur?.path ?? '')
  useEffect(() => {
    api.listeners().then(setListeners)
    return window.gd.on('listeners', (l: Listener[]) => setListeners(l))
  }, [])
  useEffect(() => {
    setCommentCount(0)
    if (cur) api.commentsList(cur.path).then(ts => setCommentCount(ts.length), () => {})
  }, [cur?.path])
  // Version history takes the comments' place beside the file (File > Version history, Ctrl+Alt+Shift+H).
  const [historyOpen, setHistoryOpen] = useState(false)
  const showHistory = (on: boolean) => {
    setHistoryOpen(on)
    if (on) setCommentsOpen(false)
  }
  useEffect(() => {
    if (commentsOpen) setHistoryOpen(false)
  }, [commentsOpen])
  const listensTo = (file: string) => listenersRef.current.filter(l => !l.path || l.path.toLowerCase() === file.toLowerCase())
  const addComment = () => {
    const t = tabsRef.current.find(x => x.id === activeRef.current)
    const h = t ? handles.current.get(t.id) : undefined
    // a design comments on its selected layer (quoted by name); text editors quote the selected text
    const at = h?.commentAnchor?.() ?? null
    const sel = at ? at.quote : h?.getSelection?.() || ''
    setDraftAnchor(at?.anchor)
    setDraftQuote(sel.trim())
    setDraftText('')
    setCommentsOpen(true)
    setFocusDraft(n => n + 1)
  }

  // ---------- editing UX: right-click menu commands, "ask the agent", clicking a comment highlight ----------
  const [draftText, setDraftText] = useState('')
  const [focusedThread, setFocusedThread] = useState<{ id: string; n: number } | undefined>()
  /** Puts a request to the agent on the selection, as a comment thread a listening agent picks up. */
  const askAgent = async (prompt: string) => {
    const t = tabsRef.current.find(x => x.id === activeRef.current)
    const quote = t ? handles.current.get(t.id)?.getSelection?.()?.trim() || '' : ''
    if (!t || !quote) return say('Select some text first')
    try {
      await api.commentAdd(t.path, { text: `@agent: ${prompt}`, quote })
      setCommentsOpen(true)
      say(listensTo(t.path).length
        ? 'Sent to the agent. Its answer will show up in the comments.'
        : 'Added to the comments. No agent is listening yet: click Agent (top right) to connect one and it will pick this up.')
    } catch (e) {
      say((e as Error).message)
    }
  }
  useEffect(() => {
    // Tell main what kind of editor a right-click landed in, so the native menu can offer the right actions.
    const onContext = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      window.gd.contextTarget(el?.closest('.ProseMirror') ? 'doc' : el?.closest('.cm-content') ? 'text' : 'other')
    }
    window.addEventListener('contextmenu', onContext, true)
    const offCmd = window.gd.on('context-command', (c: { id: string; prompt?: string }) => {
      const t = tabsRef.current.find(x => x.id === activeRef.current)
      const h = t ? handles.current.get(t.id) : undefined
      if (c.id === 'comment') addComment()
      else if (c.id === 'ask' && c.prompt) askAgent(c.prompt)
      else if (c.id === 'ask-custom') {
        addComment()
        setDraftText('@agent: ')
      } else if (c.id === 'toggle-spelling') {
        const on = settingsRef.current?.spellcheck !== false
        api.setSettings({ spellcheck: !on }).then(setSettingsState)
        say(on ? 'Spelling check off' : 'Spelling check on')
      } else h?.command?.(c.id) // bold, italic, link, clearFormatting
    })
    const onFocusThread = (e: Event) => {
      const { path, id } = (e as CustomEvent<{ path: string; id: string }>).detail
      const t = tabsRef.current.find(x => x.id === activeRef.current)
      if (!t || t.path.toLowerCase() !== path.toLowerCase()) return
      setCommentsOpen(true)
      setFocusedThread(f => ({ id, n: (f?.n || 0) + 1 }))
    }
    window.addEventListener('gd-focus-thread', onFocusThread)
    return () => {
      window.removeEventListener('contextmenu', onContext, true)
      window.removeEventListener('gd-focus-thread', onFocusThread)
      offCmd()
    }
  }, [])
  useEffect(() => {
    setHasInstructions(false)
    if (cur) api.instructions(cur.path).then(r => setHasInstructions(!!r.file), () => {})
  }, [cur?.path, cur?.mtime])

  // ---------- settings, theme, plugins ----------
  useEffect(() => {
    api.settings().then(setSettingsState)
    api.cliInfo().then(i => setHomeDir(i.home))
    reloadPlugins()
    // Reopen the tabs from last time, like a code editor.
    try {
      // Restored tabs start asleep: only the one in focus is loaded.
      const last = JSON.parse(localStorage.getItem('openTabs') || '[]') as string[]
      Promise.all(last.map(async f => ((await api.mtime(f)) ? f : null))).then(found => {
        // Files opened meanwhile (by the CLI, or a double-click) are not restored twice, and keep the focus:
        // restoring finishes in the background and must never pull the window away from what was just opened.
        const wantIdx = Number(localStorage.getItem('activeTab') || -1)
        const wantPath = found[wantIdx] || null
        const restored: Tab[] = found
          .filter((f): f is string => !!f && !tabFor(f))
          .map(f => ({ id: nextId++, path: f, kind: kindOf(f), payload: null, mtime: 0, version: 0, dirty: false, saving: false, saved: 0 }))
        if (!restored.length) return
        tabsRef.current = [...restored, ...tabsRef.current]
        setTabs(ts => [...restored.filter(r => !ts.some(t => same(t.path, r.path))), ...ts])
        if (activeRef.current === HOME) {
          const pick = restored.find(r => wantPath && same(r.path, wantPath)) || restored[restored.length - 1]
          setActive(pick.id)
        }
      })
    } catch { /* first run */ }
  }, [])
  useEffect(() => {
    if (!settings) return
    if (settings.theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = settings.theme
  }, [settings?.theme])
  const reloadPlugins = () => loadPlugins(say).then(p => {
    setPlugins(p)
    if (p.errors.length) say(`Plugin error: ${p.errors.map(e => `${e.id}: ${e.error}`).join('; ')}`)
  })
  const saveSettings = async (p: Partial<Settings>) => setSettingsState(await api.setSettings(p))

  // ---------- tell main what is open ----------
  useEffect(() => trackFiles(tabs.map(t => t.path)), [tabs.map(t => t.path).join('|')])
  useEffect(() => {
    window.gd.tabs(tabs.map(t => ({ path: t.path, kind: t.kind, dirty: t.dirty, active: t.id === active, large: t.large })))
    try {
      localStorage.setItem('openTabs', JSON.stringify(tabs.map(x => x.path)))
      localStorage.setItem('activeTab', String(tabs.findIndex(x => x.id === active)))
    } catch { /* storage off */ }
    const t = tabs.find(x => x.id === active)
    document.title = t ? `${stem(t.path)} - gauzzaDocs` : 'gauzzaDocs'
  }, [tabs.map(t => `${t.path}|${t.dirty}|${t.large}`).join(), active])

  // ---------- opening ----------
  const whenReady = (id: number) =>
    new Promise<void>(resolve => {
      if (handles.current.has(id)) return resolve()
      waiters.current.set(id, [...(waiters.current.get(id) || []), resolve])
    })
  /** For agent requests: ready, or a clear reason instead of a silent hang (the bridge would time out vaguely). */
  const readyOrFail = (id: number, ms = 25_000) =>
    Promise.race([
      whenReady(id),
      new Promise<void>((_, reject) =>
        window.setTimeout(() => {
          const t = tabsRef.current.find(x => x.id === id)
          reject(new Error(t?.error ? `The editor could not open ${baseName(t.path)}: ${t.error}` : `The editor for ${t ? baseName(t.path) : 'this file'} did not finish loading; try again`))
        }, ms)
      )
    ])

  /** Loads a sleeping tab's content so its editor mounts (hidden if not active). */
  const waking = useRef(new Map<number, Promise<void>>())
  const wake = (id: number): Promise<void> => {
    const t = tabsRef.current.find(x => x.id === id)
    if (!t || t.payload) return Promise.resolve()
    if (!waking.current.has(id)) {
      const p = api.load(t.path).then(
        f => {
          const next = { payload: f.payload, large: f.payload.kind === 'large', mtime: f.mtime }
          tabsRef.current = tabsRef.current.map(x => (x.id === id ? { ...x, ...next } : x))
          patch(id, x => ({ ...next, version: x.version + 1, error: undefined }))
        },
        e => patch(id, { error: (e as Error).message })
      ).finally(() => waking.current.delete(id))
      waking.current.set(id, p)
    }
    return waking.current.get(id)!
  }
  const lastUsed = useRef(new Map<number, number>())
  useEffect(() => {
    if (active === HOME) return
    lastUsed.current.set(active, Date.now())
    wake(active)
  }, [active])
  // Put tabs to sleep: saved, not in focus, not among the WARM most recent, untouched for a while, no agent working.
  useEffect(() => {
    const iv = window.setInterval(() => {
      const now = Date.now()
      const recent = [...tabsRef.current]
        .filter(t => t.id !== activeRef.current)
        .sort((a, b) => (lastUsed.current.get(b.id) || 0) - (lastUsed.current.get(a.id) || 0))
        .slice(0, WARM)
        .map(t => t.id)
      for (const t of tabsRef.current) {
        if (!t.payload || t.id === activeRef.current || recent.includes(t.id)) continue
        if (t.dirty || t.saving || t.external || (t.agent && t.agent.until > now)) continue
        if (now - (lastUsed.current.get(t.id) || 0) < SLEEP_AFTER_MS) continue
        handles.current.delete(t.id)
        tabsRef.current = tabsRef.current.map(x => (x.id === t.id ? { ...x, payload: null } : x))
        patch(t.id, { payload: null })
      }
    }, 10_000)
    return () => window.clearInterval(iv)
  }, [])

  const openFile = useCallback(async (path: string): Promise<number> => {
    const existing = tabFor(path)
    if (existing) {
      setActive(existing.id)
      return existing.id
    }
    const f = await api.load(path)
    const again = tabFor(f.path) // opened meanwhile
    if (again) {
      setActive(again.id)
      return again.id
    }
    const tab: Tab = { id: nextId++, path: f.path, kind: f.kind, payload: f.payload, large: f.payload.kind === 'large', mtime: f.mtime, version: 0, dirty: false, saving: false, saved: 0 }
    tabsRef.current = [...tabsRef.current, tab]
    setTabs(ts => [...ts, tab])
    setActive(tab.id)
    return tab.id
  }, [])
  const open = (path: string) => openFile(path).catch(e => say((e as Error).message))
  const openDialog = async () => (await api.openDialog()).forEach(open)
  /** preset: a new design's size (a PRESETS name). */
  const newFile = async (kind: Kind, ext?: string, dir?: string, preset?: string) => {
    try {
      await open(await api.newFile(kind, ext, dir, preset))
    } catch (e) {
      say((e as Error).message)
    }
  }

  // ---------- who changed each tab since its last save: its next version's authors ----------
  // Every edit adds the person, or the agent whose op is landing on that tab; agent ops that changed something are
  // named in the version's summary. A save takes them all and starts afresh.
  const tabAuthors = useRef(new Map<number, { authors: Map<string, Author>; ops: string[] }>())
  const agentRunning = useRef(new Map<number, { name: string; op: string; changed?: boolean }[]>())
  const noteChange = (id: number) => {
    const run = agentRunning.current.get(id)?.at(-1)
    const a: Author = run ? { name: run.name, by: 'agent' } : { name: personRef.current, by: 'person' }
    let e = tabAuthors.current.get(id)
    if (!e) tabAuthors.current.set(id, (e = { authors: new Map(), ops: [] }))
    e.authors.set(`${a.by}:${a.name}`, a)
    if (run && !run.changed) {
      run.changed = true
      e.ops.push(run.op)
    }
  }
  /** A save that failed gives its authors back, ahead of anyone who edited meanwhile. */
  const giveBack = (id: number, taken: { authors: Map<string, Author>; ops: string[] }) => {
    const now = tabAuthors.current.get(id)
    tabAuthors.current.set(id, now ? { authors: new Map([...taken.authors, ...now.authors]), ops: [...taken.ops, ...now.ops] } : taken)
  }
  /** The ctx a save of this tab passes: its authors and what its agents did (undefined: nobody changed it, main credits the person). */
  const ctxOf = (t: Tab, taken: { authors: Map<string, Author>; ops: string[] } | undefined) =>
    taken ? saveContext([...taken.authors.values()], taken.ops, t.kind) : undefined
  /** Restores under way per tab (a counter: the panel and the CLI may both ask). No saves meanwhile, or the old content would land over the restore. */
  const restoring = useRef(new Map<number, number>())
  const isRestoring = (id: number) => (restoring.current.get(id) || 0) > 0
  /** Resolves when every restore of the tab is done, so a save asked for meanwhile can wait for them. */
  const restored = useRef(new Map<number, { done: Promise<void>; resolve(): void }>())
  /** The change count a reload from disk left the tab at: its content is the file's then, with nothing to save. */
  const loadedAt = useRef(new Map<number, number>())
  /** The save each tab has under way, so a restore can wait for it (React state lags behind). */
  const inFlight = useRef(new Map<number, Promise<void>>())

  // ---------- saving ----------
  const save = useCallback(async (id: number, opts: { explicit?: boolean } = {}) => {
    if (isRestoring(id)) {
      // Writing now would put the old content over the restore. An autosave just stops: typing during a restore marks
      // the tab changed outside when it ends, and the banner lets the person choose. A save someone asked for waits
      // for the restore and then saves: Close's Save, a rename, restart to update and an agent's save all go on as if
      // it saved.
      window.clearTimeout(saveTimers.current.get(id))
      if (!opts.explicit) return
      for (let w = restored.current.get(id); w; w = restored.current.get(id)) await w.done
      // The restore kept the unsaved edits as a version and reloaded the tab: unless the person typed since, the
      // file already holds what the tab shows.
      if ((changeSeq.current.get(id) || 0) === loadedAt.current.get(id)) return
    }
    const t = tabsRef.current.find(x => x.id === id)
    const h = handles.current.get(id)
    if (!t || !h || !t.payload || t.large) return
    window.clearTimeout(saveTimers.current.get(id))
    if (t.external && !opts.explicit) return // never overwrite someone else's change without being asked
    patch(id, { saving: true, error: undefined })
    const seq = changeSeq.current.get(id) || 0
    const taken = tabAuthors.current.get(id)
    tabAuthors.current.delete(id)
    let done = () => {}
    const flight = new Promise<void>(r => (done = r))
    inFlight.current.set(id, flight)
    try {
      // a design's partial save that fails is made again in full (see savePayload)
      const { payload, mtime } = await savePayload(h, p => api.save(t.path, p, ctxOf(t, taken)))
      h.saved?.(payload)
      patch(id, { saving: false, dirty: (changeSeq.current.get(id) || 0) !== seq, mtime, saved: Date.now(), external: false })
      window.gd.changed(t.path, { type: 'saved' })
    } catch (e) {
      if (taken) giveBack(id, taken)
      patch(id, { saving: false, error: (e as Error).message })
      say(`Could not save ${baseName(t.path)}: ${(e as Error).message}`)
    } finally {
      if (inFlight.current.get(id) === flight) inFlight.current.delete(id)
      done()
    }
  }, [])

  // ---------- the person's edits, streamed to listening agents as small diffs ----------
  const agentBusy = useRef(new Set<number>())
  const snapshots = useRef(new Map<number, string>())
  const editTimers = useRef(new Map<number, number>())
  /** The file's content as an agent reads it (docs as markdown, sheets as CSV); null when not comparable. */
  const textOf = async (id: number): Promise<string | null> => {
    const t = tabsRef.current.find(x => x.id === id)
    const hh = handles.current.get(id)
    if (!t || !hh || t.large) return null
    try {
      if (t.kind === 'text') return hh.getText?.() ?? null
      if (t.kind === 'doc' || t.kind === 'sheet' || t.kind === 'slides') {
        const r = (await hh.agent({ op: 'read', format: t.kind === 'sheet' ? 'csv' : 'md' }, { name: 'gauzzaDocs' })) as { content?: string }
        return typeof r?.content === 'string' ? r.content : null
      }
      if (t.kind === 'design') {
        // one line per layer on every artboard, the same text version history compares
        const r = (await hh.agent({ op: 'read', format: 'text', allArtboards: true }, { name: 'gauzzaDocs' })) as { content?: string }
        return typeof r?.content === 'string' ? r.content : null
      }
    } catch { /* not ready */ }
    return null
  }
  const snapshotNow = async (id: number) => {
    const t = tabsRef.current.find(x => x.id === id)
    if (!t || !listensTo(t.path).length) return void snapshots.current.delete(id)
    const text = await textOf(id)
    if (text !== null) snapshots.current.set(id, text)
  }
  /** Sends what changed since the last snapshot, signed by whoever made the change (the person or an agent). */
  const emitDiff = async (id: number, by: { by: 'user' } | { by: 'agent'; author: string }) => {
    const now = tabsRef.current.find(x => x.id === id)
    if (!now) return
    if (now.kind === 'pdf') return window.gd.changed(now.path, { type: 'edit', ...by, summary: 'PDF markup or pages changed' })
    const before = snapshots.current.get(id)
    const after = await textOf(id)
    if (after === null) return
    snapshots.current.set(id, after)
    if (before === undefined || before === after) return
    window.gd.changed(now.path, { type: 'edit', ...by, ...diffLines(before, after) })
  }
  const userEdited = (id: number) => {
    const t = tabsRef.current.find(x => x.id === id)
    if (!t || !listensTo(t.path).length) return // nobody listening: no snapshots, no diffing, no memory spent
    window.clearTimeout(editTimers.current.get(id))
    editTimers.current.set(id, window.setTimeout(() => {
      editTimers.current.delete(id)
      emitDiff(id, { by: 'user' })
    }, 1500))
  }
  // Start snapshots when an agent starts listening to an open file; drop them when nobody listens.
  useEffect(() => {
    for (const t of tabsRef.current) {
      if (t.payload && listensTo(t.path).length) {
        if (!snapshots.current.has(t.id)) snapshotNow(t.id)
      } else snapshots.current.delete(t.id)
    }
  }, [listeners, tabs.length])

  const onChange = useCallback((id: number) => {
    const t = tabsRef.current.find(x => x.id === id)
    if (!t) return
    changeSeq.current.set(id, (changeSeq.current.get(id) || 0) + 1)
    noteChange(id)
    if (!t.dirty) patch(id, { dirty: true })
    window.gd.changed(t.path, { type: 'changed' })
    if (!agentBusy.current.has(id)) userEdited(id)
    if (settingsRef.current?.autosave && !isLossy(t)) {
      window.clearTimeout(saveTimers.current.get(id))
      saveTimers.current.set(id, window.setTimeout(() => save(id), 1200))
    }
  }, [save])

  const saveAs = async (t: Tab) => {
    const to = await api.saveAsDialog(t.path)
    if (!to) return
    const h = handles.current.get(t.id)!
    let payload = await h.getPayload()
    // A design's save sends only its new assets, the rest coming from its own file: a new file needs all of them.
    if (payload.kind === 'design' && payload.partial && h.peekPayload) payload = await h.peekPayload()
    if (kindOf(to) !== t.kind) return say('Pick a format of the same kind (use File → Download to convert)')
    await api.save(to, payload, ctxOf(t, tabAuthors.current.get(t.id))) // the tab's authors, when it was changed since its last save
    // Reopen as the new file so its editor follows the new format (e.g. .md vs .html).
    closeNow(t.id)
    open(to)
  }

  const rename = async (t: Tab, newStem: string) => {
    if (!newStem.trim() || newStem === stem(t.path)) return
    try {
      if (t.dirty) await save(t.id, { explicit: true })
      const to = await api.rename(t.path, newStem)
      patch(t.id, { path: to })
    } catch (e) {
      say((e as Error).message)
    }
  }

  // ---------- closing ----------
  const closeNow = (id: number) => {
    window.clearTimeout(saveTimers.current.get(id))
    handles.current.delete(id)
    tabAuthors.current.delete(id)
    agentRunning.current.delete(id)
    loadedAt.current.delete(id)
    const list = tabsRef.current
    const i = list.findIndex(t => t.id === id)
    const rest = list.filter(t => t.id !== id)
    tabsRef.current = rest
    setTabs(rest)
    if (activeRef.current === id) setActive(rest[Math.min(i, rest.length - 1)]?.id ?? HOME)
    setHomeKey(k => k + 1)
  }
  const close = (id: number): Promise<boolean> =>
    new Promise(resolve => {
      const t = tabsRef.current.find(x => x.id === id)
      if (!t) return resolve(true)
      if (!t.dirty) {
        closeNow(id)
        return resolve(true)
      }
      setActive(id)
      setConfirm({
        title: 'Save changes?',
        text: `${baseName(t.path)} has changes that are not saved.`,
        buttons: [
          { label: 'Cancel', run: () => (setConfirm(null), resolve(false)) },
          { label: "Don't save", run: () => (setConfirm(null), closeNow(id), resolve(true)) },
          { label: 'Save', primary: true, run: async () => (setConfirm(null), await save(id, { explicit: true }), closeNow(id), resolve(true)) }
        ]
      })
    })
  // Editors can ask the shell to open a file in a new tab (PDF > Open as document writes a .docx and opens it).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path
      if (!p) return
      e.preventDefault()
      open(p)
    }
    window.addEventListener('gd-open-file', onOpen)
    return () => window.removeEventListener('gd-open-file', onOpen)
  }, [])
  useEffect(() => window.gd.on('confirm-quit', async () => {
    for (const t of tabsRef.current.filter(x => x.dirty)) if (!(await close(t.id))) return
    api.quit()
  }), [])

  // ---------- reload when the file changes on disk ----------
  useEffect(() => {
    const iv = window.setInterval(async () => {
      for (const t of tabsRef.current) {
        if (t.saving || !t.payload || isRestoring(t.id)) continue // asleep: it reloads from disk when woken anyway
        const m = await api.mtime(t.path)
        const now = tabsRef.current.find(x => x.id === t.id)
        if (!m || !now || now.saving || isRestoring(t.id) || Math.abs(m - now.mtime) < 1) continue
        if (now.dirty) {
          if (!now.external) {
            patch(t.id, { external: true })
            // Their version is kept before anything here can be saved over it; an open history panel shows it.
            api.historyCheck(t.path).then(() => historyChanged(t.path), () => {})
          }
          continue
        }
        reloadFromDisk(t.id)
      }
    }, 2000)
    return () => window.clearInterval(iv)
  }, [])
  const reloadFromDisk = async (id: number) => {
    const t = tabsRef.current.find(x => x.id === id)
    if (!t) return
    const seq = changeSeq.current.get(id) || 0
    try {
      const f = await api.load(t.path)
      if ((changeSeq.current.get(id) || 0) !== seq) {
        // Typed while it loaded: never thrown away. The tab is marked changed outside, and the banner lets the person choose.
        patch(id, { dirty: true, external: true })
        return
      }
      handles.current.delete(id)
      tabAuthors.current.delete(id) // the edits they were credited for are gone
      loadedAt.current.set(id, seq)
      patch(id, x => ({ payload: f.payload, mtime: f.mtime, version: x.version + 1, dirty: false, external: false }))
    } catch (e) {
      patch(id, { mtime: Date.now(), error: (e as Error).message })
    }
  }

  /** Tells an open version history panel that the file's history changed without a save (see History.tsx). */
  const historyChanged = (path: string) => window.dispatchEvent(new CustomEvent('gd-history-changed', { detail: path }))

  /**
   * Restores version n of an open file (from the panel, or from `gdocs history restore` while it is open). Unsaved
   * edits go along as a payload, credited to whoever made them: the store keeps them as a version, never written to
   * the file. Then the tab reloads from disk, unless the person typed while the restore ran: those edits are not
   * thrown away, the tab is marked changed outside instead and the banner lets them choose. A sleeping tab has
   * nothing unsaved and loads the restored file when it wakes.
   */
  const restoreInTab = async (id: number, n: number, opts: { discardCurrent?: boolean; authors?: Author[] } = {}): Promise<HistoryVersion> => {
    restoring.current.set(id, (restoring.current.get(id) || 0) + 1)
    if (!restored.current.has(id)) {
      let resolve = () => {}
      const done = new Promise<void>(r => (resolve = r))
      restored.current.set(id, { done, resolve })
    }
    window.clearTimeout(saveTimers.current.get(id))
    let taken: { authors: Map<string, Author>; ops: string[] } | undefined
    try {
      while (inFlight.current.has(id)) await inFlight.current.get(id) // a save already on its way finishes first
      const t = tabsRef.current.find(x => x.id === id)
      if (!t) throw new Error('That file is no longer open')
      const h = handles.current.get(id)
      const seq = changeSeq.current.get(id) || 0
      let unsavedPayload: FilePayload | undefined
      let unsavedAuthors: Author[] | undefined
      if (t.dirty && h && t.payload && !t.large) {
        taken = tabAuthors.current.get(id) // edits from here on are not in the payload: they start a fresh set
        tabAuthors.current.delete(id)
        unsavedAuthors = taken?.authors.size ? [...taken.authors.values()] : [{ name: personRef.current, by: 'person' }]
        unsavedPayload = await (h.peekPayload ?? h.getPayload)()
      }
      const v = await api.historyRestore(t.path, n, { unsavedPayload, unsavedAuthors, discardCurrent: opts.discardCurrent, authors: opts.authors })
      taken = undefined // the unsaved edits are a version now
      if (tabsRef.current.find(x => x.id === id)?.payload) {
        if ((changeSeq.current.get(id) || 0) !== seq) patch(id, { external: true })
        else await reloadFromDisk(id)
      }
      return v
    } finally {
      if (taken) giveBack(id, taken)
      const left = (restoring.current.get(id) || 1) - 1
      if (left > 0) restoring.current.set(id, left)
      else {
        restoring.current.delete(id)
        restored.current.get(id)?.resolve() // saves that waited for the restore go ahead
        restored.current.delete(id)
      }
    }
  }

  // ---------- requests from the CLI (through main) ----------
  useEffect(() => {
    const offOpen = window.gd.serve('open', async (req: { path: string }) => {
      const id = await openFile(req.path)
      await wake(id)
      await readyOrFail(id)
      return { ok: true }
    })
    const offClose = window.gd.serve('close', async (req: { path: string; force?: boolean }) => {
      const t = tabFor(req.path)
      if (!t) return { ok: true }
      if (req.force) {
        closeNow(t.id)
        return { ok: true }
      }
      return { ok: await close(t.id) }
    })
    const offAgent = window.gd.serve('agent', async (req: { path: string; op: AgentOp; agent: AgentInfo }) => {
      const t = tabFor(req.path)
      if (!t) throw new Error('That file is no longer open')
      lastUsed.current.set(t.id, Date.now())
      await wake(t.id)
      await readyOrFail(t.id)
      const h = handles.current.get(t.id)!
      // ops that only look show as "reading" and never count as the agent's edits
      const reading = isReadOp(req.op)
      // Each agent highlights in its own color: set it on this file's editor so other tabs keep theirs.
      const color = req.agent.color || agentColor(req.agent.name)
      document.querySelector<HTMLElement>(`.editor-host[data-tab="${t.id}"]`)?.style.setProperty('--agent', color)
      patch(t.id, { agent: { ...req.agent, color, reading, until: Date.now() + 8000 } })
      window.setTimeout(() => force(n => n + 1), 8100)
      if (req.op.op === 'save') {
        await save(t.id, { explicit: true })
        return { ok: true, path: t.path }
      }
      const watched = listensTo(t.path).length > 0 && !reading
      if (watched) {
        // The person's unsent typing is theirs: send it before the agent's change so nothing is misattributed.
        if (editTimers.current.has(t.id)) {
          window.clearTimeout(editTimers.current.get(t.id))
          editTimers.current.delete(t.id)
          await emitDiff(t.id, { by: 'user' })
        } else if (!snapshots.current.has(t.id)) await snapshotNow(t.id)
      }
      agentBusy.current.add(t.id)
      // Edits while this op lands are the agent's (its name goes on the next version, and the op in its summary).
      const run = { name: req.agent?.name || 'Agent', op: req.op.op }
      if (!reading) agentRunning.current.set(t.id, [...(agentRunning.current.get(t.id) || []), run])
      try {
        return await h.agent(req.op, req.agent)
      } finally {
        // Other listeners (other agents) hear this agent's change as a diff signed with its name; the agent itself
        // filters its own events out. Wait a moment for the edit to land in the editor.
        window.setTimeout(async () => {
          const left = (agentRunning.current.get(t.id) || []).filter(r => r !== run)
          if (left.length) agentRunning.current.set(t.id, left)
          else agentRunning.current.delete(t.id)
          if (watched) await emitDiff(t.id, { by: 'agent', author: req.agent?.name || 'Agent' })
          else await snapshotNow(t.id)
          agentBusy.current.delete(t.id)
        }, 400)
      }
    })
    // `gdocs look`: the content as it is now, unsaved changes included. null: not loaded here (asleep), use the disk.
    const offSnapshot = window.gd.serve('snapshot', async (req: { path: string; agent?: AgentInfo }) => {
      const t = tabFor(req.path)
      const h = t && handles.current.get(t.id)
      if (!t || !h || !t.payload) return null
      if (req.agent) {
        const color = req.agent.color || agentColor(req.agent.name)
        patch(t.id, { agent: { ...req.agent, color, reading: true, until: Date.now() + 6000 } })
        window.setTimeout(() => force(n => n + 1), 6100)
      }
      return { kind: t.kind, payload: await (h.peekPayload ?? h.getPayload)() }
    })
    // `gdocs history restore` on a file open here: restored through its tab, as the panel does.
    const offRestore = window.gd.serve('history-restore', async (req: { path: string; n: number; discardCurrent?: boolean; authors?: Author[] }) => {
      const t = tabFor(req.path)
      try {
        if (!t) return await api.historyRestore(req.path, req.n, { discardCurrent: req.discardCurrent, authors: req.authors })
        return await restoreInTab(t.id, req.n, { discardCurrent: req.discardCurrent, authors: req.authors })
      } catch (e) {
        throw new Error(errorText(e))
      }
    })
    return () => (offOpen(), offClose(), offAgent(), offSnapshot(), offRestore())
  }, [])

  // ---------- Ctrl+scroll zooms the document in focus (trackpad pinch arrives as Ctrl+wheel too) ----------
  useEffect(() => {
    let acc = 0
    let last = 0
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      const host = (e.target as HTMLElement).closest?.('.editor-host[data-tab]') as HTMLElement | null
      if (!host) return
      e.preventDefault()
      const h = handles.current.get(Number(host.dataset.tab))
      if (!h?.zoomBy) return
      // A mouse notch is about 100; trackpads send many small deltas. One step per notch's worth, at most every 60 ms.
      if (Date.now() - last > 400) acc = 0
      acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      if (Math.abs(acc) < 50 || Date.now() - last < 60) return
      h.zoomBy(acc < 0 ? 1 : -1)
      acc = 0
      last = Date.now()
    }
    window.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', wheel, { capture: true })
  }, [])

  // ---------- editor handles ----------
  const setHandleFor = useCallback((id: number) => (h: EditorHandle | null) => {
    if (h) {
      handles.current.set(id, h)
      for (const w of waiters.current.get(id) || []) w()
      waiters.current.delete(id)
    } else handles.current.delete(id)
    force(n => n + 1)
  }, [])
  const setHandleCache = useRef(new Map<string, (h: EditorHandle | null) => void>())
  const handleSetter = (t: Tab) => {
    const key = `${t.id}:${t.version}`
    if (!setHandleCache.current.has(key)) setHandleCache.current.set(key, setHandleFor(t.id))
    return setHandleCache.current.get(key)!
  }
  const changeCache = useRef(new Map<number, () => void>())
  const changeFor = (id: number) => {
    if (!changeCache.current.has(id)) changeCache.current.set(id, () => onChange(id))
    return changeCache.current.get(id)!
  }

  const h = cur ? handles.current.get(cur.id) : undefined
  const editorAccess = (): EditorAccess | null =>
    cur && h?.getText
      ? {
          path: cur.path,
          language: h.language || 'text',
          getText: () => h.getText!(),
          setText: t => h.setText?.(t),
          getSelection: () => h.getSelection?.() || '',
          replaceSelection: t => h.replaceSelection?.(t)
        }
      : null

  // ---------- plugin actions ----------
  const lang = h?.language || 'text'
  const formatters = plugins?.formatters.filter(f => fits(f, lang)) || []
  const previews = plugins?.previews.filter(p => fits(p, lang)) || []
  const commands = plugins?.commands.filter(c => fits(c, lang)) || []
  const runFormatter = async (fid?: string) => {
    const f = fid ? plugins?.formatters.find(x => x.id === fid) : formatters[0]
    if (!f || !h?.getText || !cur) return say(`No formatter for ${lang}. Find one under Plugins → Manage plugins.`)
    try {
      h.setText?.(await f.format(h.getText(), { language: lang, path: cur.path }))
      say(`Formatted with ${f.name}`)
    } catch (e) {
      say(`${f.name}: ${(e as Error).message}`)
    }
  }

  // ---------- print / export ----------
  const print = async (t: Tab) => {
    const hh = handles.current.get(t.id)
    if (t.kind === 'pdf') return api.reveal(t.path)
    try {
      const html = (await hh?.getPrintHtml?.()) ?? `<pre style="font: 10pt Consolas, monospace; white-space: pre-wrap">${(hh?.getText?.() || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
      say('Preparing to print...')
      await api.print(html, stem(t.path))
    } catch (e) {
      say(`Could not print ${baseName(t.path)}: ${errorText(e)}`)
    }
  }
  const exportAs = async (t: Tab, format: string) => {
    const hh = handles.current.get(t.id)
    if (!hh) return
    const payload = await (hh.peekPayload ?? hh.getPayload)()
    const out = await api.exportFile(t.path, payload, format, format === 'pdf' ? await hh.getPrintHtml?.() : undefined)
    if (out) say(`Saved ${baseName(out)}`)
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const t = tabsRef.current.find(x => x.id === activeRef.current)
      const key = e.key.toLowerCase()
      const go = (fn: () => void) => (e.preventDefault(), fn())
      if (key === 's' && e.shiftKey && t) go(() => saveAs(t))
      else if (key === 's' && t) go(() => save(t.id, { explicit: true }))
      else if (key === 'o') go(openDialog)
      else if (key === 'n' && !e.shiftKey) go(() => newFile('doc'))
      else if (key === 'w' && t) go(() => close(t.id))
      else if (key === 'p' && t && !e.shiftKey) go(() => print(t))
      else if (key === '/') go(() => setDialog('shortcuts'))
      else if (key === 'm' && e.altKey && t) go(addComment)
      else if (key === 'f' && e.shiftKey && t) go(() => runFormatter())
      else if (key === 'e' && e.shiftKey) go(() => setExplorer(!explorer))
      else if (key === 'tab') {
        const ids = [HOME, ...tabsRef.current.map(x => x.id)]
        const i = ids.indexOf(activeRef.current)
        go(() => setActive(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]))
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  // Ctrl+Alt+Shift+H, as in Google Docs. Caught before the editors see it (the sheet's Ctrl+H would open its find bar).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey || !e.shiftKey || (e.code !== 'KeyH' && e.key.toLowerCase() !== 'h')) return
      e.preventDefault()
      e.stopPropagation()
      if (tabsRef.current.some(x => x.id === activeRef.current)) showHistory(!historyOpen)
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  })

  // ---------- menus ----------
  const menus = useMemo(() => {
    if (!cur) return []
    const extra = h?.menus?.() || {}
    const ed = (name: MenuName) => extra[name] || []
    const cmd = (id: string) => () => h?.command?.(id)
    const exportsFor: Record<Kind, [string, string][]> = {
      doc: [['Word (.docx)', 'docx'], ['PDF (.pdf)', 'pdf'], ['Markdown (.md)', 'md'], ['Web page (.html)', 'html']],
      sheet: [['Excel (.xlsx)', 'xlsx'], ['Comma separated (.csv)', 'csv'], ['Tab separated (.tsv)', 'tsv'], ['PDF (.pdf)', 'pdf']],
      pdf: [],
      text: [],
      slides: [['PowerPoint (.pptx)', 'pptx'], ['PDF (.pdf)', 'pdf'], ['Markdown outline (.md)', 'md']], // slides
      design: [] // SVG, PNG and PDF exports come with design export
    }
    const sep: MenuItem = { label: '', sep: true }
    const file: MenuItem[] = [
      { label: 'New', submenu: [
        { label: 'Document', run: () => newFile('doc') },
        { label: 'Spreadsheet', run: () => newFile('sheet') },
        { label: 'Presentation', run: () => newFile('slides') }, // slides
        { label: 'Design', submenu: designSizeItems(preset => newFile('design', undefined, undefined, preset)) },
        { label: 'Markdown document', run: () => newFile('doc', 'md') },
        { label: 'Word document', run: () => newFile('doc', 'docx') },
        { label: 'Text file', run: () => newFile('text') }
      ] },
      { label: 'Open', shortcut: 'Ctrl+O', run: openDialog },
      sep,
      { label: 'Save', shortcut: 'Ctrl+S', run: () => save(cur.id, { explicit: true }) },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', run: () => saveAs(cur) },
      { label: 'Rename', run: () => (document.querySelector('.title-input') as HTMLInputElement)?.select() },
      ...(exportsFor[cur.kind].length ? [{ label: 'Download', submenu: exportsFor[cur.kind].map(([label, f]) => ({ label, run: () => exportAs(cur, f) })) }] : []),
      { label: 'Show in folder', run: () => api.reveal(cur.path) },
      { label: 'Reload from disk', run: () => reloadFromDisk(cur.id) },
      { label: 'Version history', shortcut: 'Ctrl+Alt+Shift+H', run: () => showHistory(true) },
      sep,
      { label: 'Print', shortcut: 'Ctrl+P', run: () => print(cur) },
      { label: 'Close', shortcut: 'Ctrl+W', run: () => close(cur.id) }
    ]
    const edit: MenuItem[] = [
      { label: 'Undo', shortcut: 'Ctrl+Z', run: cmd('undo') },
      { label: 'Redo', shortcut: 'Ctrl+Y', run: cmd('redo') },
      sep,
      { label: 'Cut', shortcut: 'Ctrl+X', run: cmd('cut') },
      { label: 'Copy', shortcut: 'Ctrl+C', run: cmd('copy') },
      { label: 'Paste', shortcut: 'Ctrl+V', run: cmd('paste') },
      { label: 'Select all', shortcut: 'Ctrl+A', run: cmd('selectAll') },
      sep,
      { label: 'Find and replace', shortcut: 'Ctrl+H', run: cmd('replace') },
      ...(ed('Edit').length ? [sep, ...ed('Edit')] : [])
    ]
    const view: MenuItem[] = [
      { label: 'Explorer', shortcut: 'Ctrl+Shift+E', checked: explorer, run: () => setExplorer(!explorer) },
      sep,
      ...ed('View'),
      ...(cur.kind === 'doc' || cur.kind === 'text'
        ? [{ label: 'Check spelling', checked: settings?.spellcheck !== false, run: () => api.setSettings({ spellcheck: settings?.spellcheck === false }).then(setSettingsState) }, sep]
        : []),
      ...(previews.length ? [...(ed('View').length ? [sep] : []), { label: 'Preview pane', submenu: [
        { label: 'Off', checked: !preview, run: () => setPreview(null) },
        ...previews.map(p => ({ label: p.name, checked: preview === p.id, run: () => setPreview(p.id) }))
      ] }] : []),
      sep,
      { label: 'Theme', submenu: (['system', 'light', 'dark'] as const).map(th => ({
        label: { system: 'Same as Windows', light: 'Light', dark: 'Dark' }[th], checked: settings?.theme === th, run: () => saveSettings({ theme: th })
      })) }
    ]
    const tools: MenuItem[] = [
      ...(formatters.length ? [{ label: 'Format document', shortcut: 'Ctrl+Shift+F', run: () => runFormatter() },
        ...(formatters.length > 1 ? [{ label: 'Format with', submenu: formatters.map(f => ({ label: f.name, run: () => runFormatter(f.id) })) }] : [])] : []),
      ...ed('Tools'),
      sep,
      { label: 'Agent instructions…', run: () => setDialog('instructions') },
      { label: 'Connect an agent…', run: () => setDialog('agent') },
      { label: 'Settings…', run: () => setDialog('settings') }
    ]
    const pluginMenu: MenuItem[] = [
      { label: 'Marketplace…', run: () => setDialog('plugins') },
      { label: 'Reload plugins', run: () => reloadPlugins().then(() => say('Plugins reloaded')) },
      ...(commands.length ? [sep, ...commands.map(c => ({ label: c.title, run: async () => {
        try { await c.run({ editor: editorAccess(), toast: say }) } catch (e) { say(`${c.title}: ${(e as Error).message}`) }
      } }))] : [])
    ]
    const help: MenuItem[] = [
      { label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', run: () => setDialog('shortcuts') },
      { label: 'Agents and the gdocs CLI', run: () => setDialog('agent') },
      { label: 'Set up gauzzaDocs (default app, AI agents)', run: () => setWelcome(true) },
      { label: '', sep: true },
      { label: 'Set up your writing voice (Empirical)', run: () => api.openUrl(EMPIRICAL_VOICE) },
      { label: 'Submit a plugin', run: () => api.openUrl(SUBMIT_PLUGIN) },
      { label: 'gauzzaDocs on GitHub', run: () => api.openUrl(REPO) },
      ...(DONATE ? [{ label: 'Support gauzzaDocs ♥', run: () => api.openUrl(DONATE) }] : [])
    ]
    return [
      { name: 'File', items: file }, { name: 'Edit', items: edit }, { name: 'View', items: view },
      { name: 'Insert', items: [...ed('Insert'), ...(ed('Insert').length ? [sep] : []), { label: 'Comment', shortcut: 'Ctrl+Alt+M', run: addComment }] }, { name: 'Format', items: ed('Format') }, { name: 'Tools', items: tools },
      { name: 'Plugins', items: pluginMenu }, { name: 'Help', items: help }
    ]
  }, [cur, h, plugins, preview, settings, tabs, explorer])

  if (!settings) return <div className="boot" />

  const agentNow = cur?.agent && cur.agent.until > Date.now() ? cur.agent : null
  const status = !cur ? '' : cur.error ? 'Not saved: ' + cur.error : cur.saving ? 'Saving…' : cur.dirty
    ? settings.autosave && !isLossy(cur) ? 'Saving…' : 'Unsaved changes'
    : cur.saved ? 'Saved to this PC' : ''
  const previewDef = previews.find(p => p.id === preview)

  return (
    <div className="app">
      {/* tab strip: also the window's drag handle */}
      <div className="tabstrip">
        <button className={`tab home-tab${active === HOME ? ' on' : ''}`} onClick={() => setActive(HOME)} title="Home">
          <Logo size={22} />
        </button>
        <div className="tabs">
          {tabs.map(t => (
            <div
              key={t.id}
              className={`tab${t.id === active ? ' on' : ''}`}
              onMouseDown={e => e.button === 1 && (e.preventDefault(), close(t.id))}
              onClick={() => setActive(t.id)}
              onContextMenu={e => (e.preventDefault(), setTabMenu({ id: t.id, x: e.clientX, y: e.clientY }))}
              draggable
              onDragStart={() => (dragTab.current = t.id)}
              onDragOver={e => {
                e.preventDefault()
                const from = dragTab.current
                if (from == null || from === t.id) return
                setTabs(ts => {
                  const a = ts.findIndex(x => x.id === from)
                  const b = ts.findIndex(x => x.id === t.id)
                  if (a < 0 || b < 0) return ts
                  const next = [...ts]
                  next.splice(b, 0, ...next.splice(a, 1))
                  return next
                })
              }}
              onDragEnd={() => (dragTab.current = null)}
              title={t.path}
            >
              <KindIcon kind={t.kind} size={16} />
              <span className="tab-name">{baseName(t.path)}</span>
              {needsYouIn(t.path) && <span className="tab-ask" title="An agent asked you something in this file" />}
              {t.agent && t.agent.until > Date.now() && <span className="tab-agent" style={{ background: t.agent.color }} title={`${t.agent.name} is editing`} />}
              <button className={`tab-close${t.dirty ? ' dirty' : ''}`} onClick={e => (e.stopPropagation(), close(t.id))} title="Close (Ctrl+W)">
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <button className="tab-new" title="New document (Ctrl+N)" onClick={() => newFile('doc')}>
            <Icon name="plus" size={18} />
          </button>
        </div>
        {/* always some empty strip to grab the window by, however many tabs are open */}
        <div className="tab-drag" />
        <div className="strip-actions">
          {update && (
            <button className="strip-btn update" title={`gauzzaDocs ${update} is ready: restart to update`} onClick={async () => {
              for (const t of tabsRef.current.filter(x => x.dirty)) await save(t.id, { explicit: true })
              api.installUpdate()
            }}>
              <Icon name="download" size={18} />
            </button>
          )}
          {DONATE && (
            <button className="strip-btn heart" title="Support gauzzaDocs" onClick={() => setDialog('donate')}>
              <Icon name="heart" size={17} />
            </button>
          )}
        </div>
      </div>

      {active === HOME || !cur ? (
        <>
          <div className="home-bar">
            <Logo />
            <span className="home-brand">gauzza<b>Docs</b></span>
            <span className="grow" />
            <button className="icon-btn" title="Connect an agent" onClick={() => setDialog('agent')}><Icon name="terminal" /></button>
            <button className="icon-btn" title="Plugins" onClick={() => setDialog('plugins')}><Icon name="puzzle" /></button>
            <button className="icon-btn" title="Settings" onClick={() => setDialog('settings')}><Icon name="settings" /></button>
          </div>
          <Home settings={settings} home={homeDir} onOpen={open} onNew={newFile} onOpenDialog={openDialog} refreshKey={homeKey + (active === HOME ? 1 : 0)} say={say} />
        </>
      ) : (
        <div className="file-head">
          <button className="file-kind" title="Home" onClick={() => setActive(HOME)}>
            <KindIcon kind={cur.kind} size={38} />
          </button>
          <div className="file-titles">
            <div className="title-row">
              <TitleInput key={cur.path} value={stem(cur.path)} onCommit={v => rename(cur, v)} />
              <span className="ext">.{extOf(cur.path)}</span>
              <button className="icon-btn sm" title={`In ${dirOf(cur.path)} — show in folder`} onClick={() => api.reveal(cur.path)}>
                <Icon name="folder" size={18} />
              </button>
              <span className={`save-status${cur.error ? ' error' : ''}`} title={cur.path}>
                {status === 'Saved to this PC' && <Icon name="cloudDone" size={16} />}
                {status}
              </span>
            </div>
            <MenuBar menus={menus} />
          </div>
          <div className="file-actions-right">
            {listensTo(cur.path).filter(l => !l.virtual).length > 0 && (
              <button className="listening" title="Agents connected to this file: click to see them or disconnect one" onClick={() => setConnOpen(!connOpen)}>
                <span className="cm-live" /> {[...new Set(listensTo(cur.path).filter(l => !l.virtual).map(l => l.agent))].join(', ')} is listening
              </button>
            )}
            <Participants path={cur.path} say={say} />
            <button className={`icon-btn history-btn${historyOpen ? ' on' : ''}`} title="Version history (Ctrl+Alt+Shift+H)" onClick={() => showHistory(!historyOpen)}>
              <Icon name="history" />
            </button>
            <button className={`icon-btn comments-btn${commentsOpen ? ' on' : ''}${asking.size ? ' asking' : ''}`} title={asking.size ? `An agent asked you something here (${asking.size}). Comments (Ctrl+Alt+M comments on the selection)` : 'Comments (Ctrl+Alt+M comments on the selection)'} onClick={() => setCommentsOpen(!commentsOpen)}>
              <Icon name="comment" />
              {asking.size > 0 && <span className="needs-dot" />}
              {commentCount > 0 && <span className="badge">{commentCount}</span>}
            </button>
            {agentNow && (
              <span className="presence" style={{ color: agentNow.color }} title={`${agentNow.name} is ${agentNow.reading ? 'reading' : 'editing'} this file`}>
                <span className="presence-dot" style={{ background: agentNow.color || 'var(--agent)', boxShadow: `0 0 0 2px var(--bg), 0 0 0 4px ${agentNow.color || 'var(--agent)'}` }}>{agentNow.name.slice(0, 1).toUpperCase()}</span>
                {agentNow.name} is {agentNow.reading ? 'reading' : 'editing'}
              </span>
            )}
            {hasInstructions && (
              <button className="chip-ins" onClick={() => setDialog('instructions')} title="This file has standing instructions for agents">
                <Icon name="edit" size={14} /> Instructions
              </button>
            )}
            <button className="pill accent" onClick={() => setDialog('agent')} title="Let an agent edit this file live">
              <Icon name="sparkle" size={18} /> Agent
            </button>
          </div>
        </div>
      )}

      {cur?.external && active === cur.id && (
        <div className="banner">
          This file was changed outside gauzzaDocs while you had unsaved changes.
          <button className="btn sm" onClick={() => reloadFromDisk(cur.id)}>Load their version</button>
          <button className="btn sm" onClick={() => save(cur.id, { explicit: true })}>Keep mine and save</button>
        </div>
      )}

      <div className="workspace" style={{ display: active === HOME ? 'none' : undefined }}>
        {explorer && active !== HOME && <Explorer activePath={cur?.path || null} onOpen={open} onClose={() => setExplorer(false)} say={say} />}
        <div className="editors">
          {tabs.map(t => {
            if (!t.payload)
              return t.id === active ? (t.error ? <div key={`${t.id}:sleep`} className="editor-placeholder">{t.error}</div> : <EditorSkeleton key={`${t.id}:sleep`} kind={t.large ? 'large' : t.kind} />) : null
            const E = t.large ? LargeViewer : EDITORS[t.kind]
            return (
              <div key={`${t.id}:${t.version}`} className="editor-host" data-tab={t.id} style={{ display: t.id === active ? undefined : 'none' }}>
                <TabBoundary onError={e => patch(t.id, { error: e.message })} onReload={() => reloadFromDisk(t.id)}>
                  <Suspense fallback={<EditorSkeleton kind={t.large ? 'large' : t.kind} />}>
                    <E path={t.path} payload={t.payload} settings={settings} active={t.id === active} onChange={changeFor(t.id)} setHandle={handleSetter(t)} />
                  </Suspense>
                </TabBoundary>
              </div>
            )
          })}
        </div>
        {cur && commentsOpen && active !== HOME && (
          <CommentsPanel key={cur.path} path={cur.path} listeners={listeners} draftQuote={draftQuote} draftAnchor={draftAnchor} draftText={draftText} focusDraft={focusDraft}
            focusThread={focusedThread} onClose={() => setCommentsOpen(false)} onCount={setCommentCount}
            onPick={t => t.anchor && handles.current.get(cur.id)?.showAnchor?.(t.anchor)} />
        )}
        {cur && historyOpen && active !== HOME && (
          <HistoryPanel key={cur.path} path={cur.path} dirty={cur.dirty} refreshKey={cur.mtime} onClose={() => setHistoryOpen(false)}
            onRestore={(n, o) => restoreInTab(cur.id, n, o)} onOpen={open} say={say} />
        )}
        {cur && previewDef && h?.getText && <PreviewPane key={`${cur.id}:${previewDef.id}`} def={previewDef} handle={h} path={cur.path} tick={cur.dirty ? Date.now() : cur.saved} onClose={() => setPreview(null)} />}
      </div>

      {tabMenu && (() => {
        const t = tabs.find(x => x.id === tabMenu.id)
        if (!t) return null
        const idx = tabs.indexOf(t)
        const closeMany = async (ids: number[]) => { for (const id of ids) if (!(await close(id))) break }
        const items: MenuItem[] = [
          { label: 'Close', shortcut: 'Ctrl+W', run: () => close(t.id) },
          { label: 'Close others', run: () => closeMany(tabs.filter(x => x.id !== t.id).map(x => x.id)) },
          { label: 'Close to the right', run: () => closeMany(tabs.slice(idx + 1).map(x => x.id)) },
          { label: 'Close saved', run: () => closeMany(tabs.filter(x => !x.dirty).map(x => x.id)) },
          { label: 'Close all', run: () => closeMany(tabs.map(x => x.id)) },
          { label: '', sep: true },
          { label: 'Save', run: () => save(t.id, { explicit: true }) },
          { label: 'Copy path', run: () => navigator.clipboard.writeText(t.path) },
          { label: 'Copy name', run: () => navigator.clipboard.writeText(baseName(t.path)) },
          { label: 'Show in folder', run: () => api.reveal(t.path) },
          { label: 'Reload from disk', run: () => reloadFromDisk(t.id) }
        ]
        return (
          <div className="ctx-scrim" onMouseDown={() => setTabMenu(null)} onContextMenu={e => (e.preventDefault(), setTabMenu(null))}>
            <div style={{ position: 'fixed', left: tabMenu.x, top: tabMenu.y }} onMouseDown={e => e.stopPropagation()}>
              <MenuList items={items} close={() => setTabMenu(null)} />
            </div>
          </div>
        )
      })()}
      {cur && active !== HOME && (
        <StatusBar path={cur.path} lossy={isLossy(cur)} payload={cur.payload} handle={h} mtime={cur.mtime} saved={cur.saved} dirty={cur.dirty} settings={settings} />
      )}

      <SelectionBubble enabled={!!cur && active !== HOME && !cur.large && (cur.kind === 'doc' || cur.kind === 'text') && !dialog} onComment={addComment} />
      {welcome && <Onboarding onClose={() => setWelcome(false)} />}
      <ToolbarOverflow />
      {connOpen && cur && active !== HOME && <Connections path={cur.path} listeners={listeners} onClose={() => setConnOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
      {dialog === 'plugins' && <PluginsDialog onClose={() => setDialog(null)} onReload={reloadPlugins} />}
      {dialog === 'settings' && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onSave={saveSettings} />}
      {dialog === 'agent' && <AgentDialog onClose={() => setDialog(null)} onInstructions={() => setDialog('instructions')} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'donate' && <DonateDialog onClose={() => setDialog(null)} />}
      {dialog === 'instructions' && (
        <InstructionsDialog
          path={active === HOME ? null : cur?.path || null}
          onClose={() => setDialog(null)}
          onSaved={(mtime, has) => {
            if (cur && active !== HOME) {
              if (mtime) patch(cur.id, { mtime })
              setHasInstructions(has)
            }
            say('Agent instructions saved')
          }}
        />
      )}
      {confirm && <Confirm {...confirm} onClose={() => confirm.buttons[0].run()} />}
    </div>
  )
}

function TitleInput({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input
      className="title-input"
      value={v}
      size={Math.max(4, v.length)}
      spellCheck={false}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') (setV(value), (e.target as HTMLInputElement).blur())
      }}
    />
  )
}

/** A plugin preview beside the editor, re-rendered shortly after each change. */
function PreviewPane({ def, handle, path, tick, onClose }: {
  def: { id: string; name: string; render(text: string, el: HTMLElement, ctx: { language: string; path: string }): void | Promise<void> }
  handle: EditorHandle
  path: string
  tick: number
  onClose(): void
}) {
  const [width, resizeHandle] = usePanelSize('preview', 480, { min: 280, max: 1200, edge: 'left' })
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    const t = window.setTimeout(async () => {
      if (!ref.current) return
      try {
        await def.render(handle.getText?.() || '', ref.current, { language: handle.language || 'text', path })
        setErr('')
      } catch (e) {
        setErr((e as Error).message)
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [tick, def])
  return (
    <aside className="preview-pane" style={{ width }}>
      {resizeHandle}
      <header>
        <Icon name="preview" size={18} /> <b className="grow">{def.name}</b>
        <button className="icon-btn sm" onClick={onClose} title="Close preview"><Icon name="close" size={16} /></button>
      </header>
      {err && <p className="error small">{err}</p>}
      <div className="preview-body" ref={ref} />
    </aside>
  )
}
