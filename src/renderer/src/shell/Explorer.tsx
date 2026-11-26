import { useCallback, useEffect, useRef, useState } from 'react'
import { kindOf } from '../../../shared/kinds'
import type { MenuItem } from '../editor'
import { type Entry, type Project, api, dirOf } from '../lib'
import { Icon, KindIcon } from './icons'
import { ContextMenu, openEntry, opensInApp } from './Projects'
import { samePath, useFolderChanges, useWatchFolder } from './folderWatch'
import { RowSkeleton } from './Skeleton'

/**
 * The explorer beside the editor (View > Explorer, Ctrl+Shift+E), like VS Code's: the tree of the project that holds
 * the file in focus (or the last project used). Folders load when opened; the file in focus is highlighted and revealed.
 */
const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch { /* storage off */ }
}

export function Explorer(props: { activePath: string | null; onOpen(p: string): void; onClose(): void; say(msg: string): void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [root, setRoot] = useState<Project | null>(null)
  const [children, setChildren] = useState<Record<string, Entry[]>>({}) // loaded folders, by path
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState(() => Number(lsGet('explorerWidth', '260')) || 260)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  const loadProjects = useCallback(() => api.projectsList().then(setProjects, () => setProjects([])), [])
  useEffect(() => void loadProjects(), [])

  // Pick the project that holds the active file, else the last one used here.
  useEffect(() => {
    let live = true
    ;(async () => {
      const byFile = props.activePath ? await api.projectFor(props.activePath).catch(() => null) : null
      const last = projects.find(p => p.path === lsGet('explorerProject', '')) || projects[0] || null
      const next = byFile || last
      if (live && next && next.path !== root?.path) setRoot(next)
    })()
    return () => void (live = false)
  }, [props.activePath, projects])

  useEffect(() => {
    if (!root) return
    lsSet('explorerProject', root.path)
    setChildren({})
    let saved: string[] = []
    try { saved = JSON.parse(lsGet(`explorerOpen:${root.path}`, '[]')) } catch { /* none */ }
    setOpen(new Set([root.path, ...saved]))
  }, [root?.path])

  const load = useCallback((dir: string) => api.listFolder(dir).then(list => setChildren(c => ({ ...c, [dir]: list })), () => setChildren(c => ({ ...c, [dir]: [] }))), [])
  // Load every open folder that isn't loaded yet.
  useEffect(() => {
    for (const d of open) if (!children[d]) load(d)
  }, [open, children, load])
  useEffect(() => {
    if (root) lsSet(`explorerOpen:${root.path}`, JSON.stringify([...open].filter(p => p !== root.path)))
  }, [open, root?.path])

  // Reveal the active file: open its parent folders, then scroll it into view.
  useEffect(() => {
    if (!root || !props.activePath) return
    const rootPath = root.path.replace(/[\\/]+$/, '')
    if (!props.activePath.toLowerCase().startsWith(rootPath.toLowerCase())) return
    const dirs: string[] = []
    for (let d = dirOf(props.activePath); d.length >= rootPath.length && d !== dirOf(d); d = dirOf(d)) dirs.push(d)
    setOpen(o => (dirs.every(d => o.has(d)) ? o : new Set([...o, ...dirs])))
    const t = setTimeout(() => activeRef.current?.scrollIntoView({ block: 'nearest' }), 150)
    return () => clearTimeout(t)
  }, [props.activePath, root?.path])

  useWatchFolder(root && !root.missing ? root.path : null)
  useFolderChanges(root?.path, useCallback((dir: string) => {
    setChildren(c => {
      const hit = Object.keys(c).find(k => samePath(k, dir))
      if (hit) load(hit)
      return c
    })
  }, [load]))

  const toggle = (p: string) => setOpen(o => {
    const n = new Set(o)
    n.has(p) ? n.delete(p) : n.add(p)
    return n
  })

  const fileMenu = (e: Entry): MenuItem[] => [
    ...(e.dir ? [] : [{ label: opensInApp(e.path) ? 'Open' : 'Open with its app', run: () => openEntry(e.path, props.onOpen) }]),
    { label: 'Show in folder', run: () => api.reveal(e.path) },
    { label: 'Copy path', run: () => navigator.clipboard.writeText(e.path) }
  ]

  const render = (dir: string, depth: number): React.ReactNode => {
    const list = children[dir]
    if (!list) return <div style={{ paddingLeft: depth * 14 }}><RowSkeleton rows={depth ? 2 : 5} /></div>
    if (!list.length && depth > 0) return <div className="ex-row muted" style={{ paddingLeft: 12 + depth * 14 }}>Empty</div>
    return list.map(e => {
      const isOpen = e.dir && open.has(e.path)
      const active = !e.dir && !!props.activePath && samePath(e.path, props.activePath)
      return (
        <div key={e.path}>
          <div
            ref={active ? activeRef : undefined}
            className={`ex-row${active ? ' on' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={e.path}
            onClick={() => (e.dir ? toggle(e.path) : openEntry(e.path, props.onOpen))}
            onContextMenu={ev => (ev.preventDefault(), setMenu({ at: { x: ev.clientX, y: ev.clientY }, items: fileMenu(e) }))}
          >
            <span className={`ex-caret${e.dir ? '' : ' none'}${isOpen ? ' open' : ''}`}>{e.dir ? '›' : ''}</span>
            {e.dir ? <span className="ex-folder"><Icon name={isOpen ? 'folderOpen' : 'folder'} size={16} /></span> : <KindIcon kind={kindOf(e.path)} size={16} />}
            <span className="ellipsis">{e.name}</span>
          </div>
          {isOpen && render(e.path, depth + 1)}
        </div>
      )
    })
  }

  // Drag the right edge to resize.
  const drag = (e: React.MouseEvent) => {
    e.preventDefault()
    const start = e.clientX
    const w0 = width
    const move = (m: MouseEvent) => setWidth(Math.max(180, Math.min(600, w0 + m.clientX - start)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setWidth(w => (lsSet('explorerWidth', String(w)), w))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const addHere = async () => {
    if (!props.activePath) return
    const p = await api.projectsAdd(dirOf(props.activePath))
    await loadProjects()
    setRoot(p)
    props.say(`Added ${p.name} to Projects`)
  }

  return (
    <aside className="explorer" style={{ width }}>
      <header>
        {projects.length > 0 ? (
          <select className="ex-pick" value={root?.path || ''} onChange={e => setRoot(projects.find(p => p.path === e.target.value) || null)} title="Project">
            {projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
        ) : <b className="grow">Explorer</b>}
        <button className="icon-btn sm" title="Collapse all" onClick={() => root && setOpen(new Set([root.path]))}><Icon name="list" size={16} /></button>
        <button className="icon-btn sm" title="Close (Ctrl+Shift+E)" onClick={props.onClose}><Icon name="close" size={16} /></button>
      </header>
      <div className="ex-tree">
        {root ? (root.missing ? <p className="muted small ex-note">This folder can't be found.</p> : render(root.path, 0)) : (
          <div className="ex-note">
            <p className="muted small">Add a folder as a project to browse it here.</p>
            {props.activePath && <button className="btn sm" onClick={addHere}>Add this file's folder</button>}
          </div>
        )}
      </div>
      <div className="ex-resize" onMouseDown={drag} />
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  )
}
