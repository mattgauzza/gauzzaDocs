import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Kind, extOf, kindOf } from '../../../shared/kinds'
import type { MenuItem } from '../editor'
import { type Entry, type Project, api, when } from '../lib'
import { Confirm, Modal } from './Dialogs'
import { Icon, KindIcon } from './icons'
import { MenuList } from './Menus'
import { useFolderChanges, useWatchFolder } from './folderWatch'
import { fileSize } from './StatusBar'

/** Files gauzzaDocs doesn't edit open in their usual app instead (pictures, archives, media, programs, old Office). */
const SYSTEM = new Set(('png jpg jpeg gif bmp webp ico tif tiff heic svgz mp3 wav flac ogg m4a mp4 mov avi mkv webm zip 7z rar gz tgz tar ' +
  'exe msi dll bin iso dmg doc xls ppt pptx odt ods odp psd ai fig sketch blend stl obj fbx woff woff2 ttf otf').split(' '))
export const opensInApp = (p: string) => !SYSTEM.has(extOf(p))

export function openEntry(p: string, onOpen: (p: string) => void) {
  if (opensInApp(p)) onOpen(p)
  else api.openWithSystem(p)
}

/** A right-click menu at the mouse, built from the same MenuList as the menu bar. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  useEffect(() => {
    // Keep the menu on screen near the right and bottom edges.
    const r = ref.current?.firstElementChild?.getBoundingClientRect()
    if (r) setPos({ x: Math.min(at.x, window.innerWidth - r.width - 8), y: Math.min(at.y, window.innerHeight - r.height - 8) })
  }, [at])
  return (
    <div className="ctx-scrim" onMouseDown={onClose} onContextMenu={e => (e.preventDefault(), onClose())}>
      <div ref={ref} style={{ position: 'fixed', left: pos.x, top: pos.y }} onMouseDown={e => e.stopPropagation()}>
        <MenuList items={items} close={onClose} />
      </div>
    </div>
  )
}

/** A small "type a name" dialog (rename a file, folder or project). */
export function NameDialog(props: { title: string; value: string; selectStem?: boolean; onSave(v: string): Promise<unknown> | void; onClose(): void }) {
  const [v, setV] = useState(props.value)
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    const dot = props.selectStem ? props.value.lastIndexOf('.') : -1
    el.setSelectionRange(0, dot > 0 ? dot : props.value.length)
  }, [])
  const save = async () => {
    try {
      await props.onSave(v)
      props.onClose()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <Modal title={props.title} onClose={props.onClose} footer={<>
      <button className="btn" onClick={props.onClose}>Cancel</button>
      <button className="btn primary" onClick={save}>Save</button>
    </>}>
      <div className="form">
        <input ref={input} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
        {err && <p className="error small">{err}</p>}
      </div>
    </Modal>
  )
}

// ---------- the rail on the left of the home screen ----------

export function ProjectRail(props: {
  projects: Project[]
  selected: string // 'recent' or a project path
  onSelect(sel: string): void
  onChanged(): void
  say(msg: string): void
}) {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; p: Project } | null>(null)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const add = async () => {
    const dir = await api.pickFolder()
    if (!dir) return
    const p = await api.projectsAdd(dir)
    props.onChanged()
    props.onSelect(p.path)
  }
  const items = (p: Project): MenuItem[] => [
    { label: 'Open', run: () => props.onSelect(p.path) },
    { label: 'Rename', run: () => setRenaming(p) },
    { label: 'Show in folder', disabled: p.missing, run: () => api.openWithSystem(p.path) },
    { label: '', sep: true },
    { label: 'Remove from list', run: async () => {
      await api.projectsRemove(p.path)
      if (props.selected === p.path) props.onSelect('recent')
      props.onChanged()
      props.say(`Removed ${p.name} from the list. The folder wasn't touched.`)
    } }
  ]
  return (
    <nav className="rail">
      <button className={`rail-item${props.selected === 'recent' ? ' on' : ''}`} onClick={() => props.onSelect('recent')}>
        <Icon name="home" size={18} /> <span className="grow ellipsis">Recent</span>
      </button>
      <div className="rail-head">
        <span className="grow">Projects</span>
        <button className="icon-btn sm" title="Add a folder" onClick={add}><Icon name="plus" size={18} /></button>
      </div>
      {props.projects.map(p => (
        <div
          key={p.path}
          role="button"
          tabIndex={0}
          className={`rail-item${props.selected === p.path ? ' on' : ''}${p.missing ? ' missing' : ''}`}
          title={p.missing ? `${p.path} (folder not found)` : p.path}
          onClick={() => props.onSelect(p.path)}
          onKeyDown={e => e.key === 'Enter' && props.onSelect(p.path)}
          onContextMenu={e => (e.preventDefault(), setMenu({ at: { x: e.clientX, y: e.clientY }, p }))}
        >
          <Icon name="folder" size={18} />
          <span className="grow ellipsis">{p.name}</span>
          <button className="icon-btn sm rail-more" title="More" onClick={e => (e.stopPropagation(), setMenu({ at: { x: e.clientX, y: e.clientY }, p }))}>
            <Icon name="more" size={16} />
          </button>
        </div>
      ))}
      {!props.projects.length && (
        <button className="rail-add" onClick={add}><Icon name="plus" size={16} /> Add a folder</button>
      )}
      {menu && <ContextMenu at={menu.at} items={items(menu.p)} onClose={() => setMenu(null)} />}
      {renaming && (
        <NameDialog title="Rename project" value={renaming.name} onClose={() => setRenaming(null)}
          onSave={async v => (await api.projectsRename(renaming.path, v), props.onChanged())} />
      )}
    </nav>
  )
}

// ---------- the folder browser (a project selected on the home screen) ----------

const sep = (p: string) => (p.includes('\\') ? '\\' : '/')
const join = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + sep(dir) + name
const parent = (p: string) => p.replace(/[\\/][^\\/]+[\\/]?$/, '')

export function FolderBrowser(props: {
  project: Project
  view: 'list' | 'grid'
  onView(v: 'list' | 'grid'): void
  onOpen(p: string): void
  onNew(kind: Kind, ext: string | undefined, dir: string): void
  onChanged(): void
  say(msg: string): void
}) {
  const root = props.project.path
  const [dir, setDir] = useState(root)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | Kind>('all')
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ results: Entry[]; truncated: boolean } | null>(null)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)

  useEffect(() => {
    setDir(root)
    setQ('')
    api.projectsTouch(root)
  }, [root])

  const load = useCallback(() => {
    setErr('')
    api.listFolder(dir).then(setEntries, e => (setEntries([]), setErr((e as Error).message)))
  }, [dir])
  useEffect(() => {
    setEntries(null)
    load()
  }, [load])

  // Live updates: watch this project while it's on screen; reload the listing (or the search) when it changes.
  useWatchFolder(props.project.missing ? null : root)
  const qRef = useRef(q)
  qRef.current = q
  useFolderChanges(root, useCallback((changed: string) => {
    if (qRef.current.trim()) runSearch(qRef.current)
    else if (changed.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase()) load()
  }, [dir, load]))

  // Search the whole project on the worker thread, a moment after typing stops.
  const searchTimer = useRef(0)
  const runSearch = (text: string) => api.searchFolder(root, text).then(r => qRef.current === text && setFound(r), () => setFound({ results: [], truncated: false }))
  useEffect(() => {
    window.clearTimeout(searchTimer.current)
    if (!q.trim()) return setFound(null)
    searchTimer.current = window.setTimeout(() => runSearch(q), 200)
  }, [q, root])

  const shown = useMemo(() => {
    const list = found ? found.results : entries || []
    return list.filter(e => e.dir || filter === 'all' || kindOf(e.path) === filter)
  }, [entries, found, filter])

  const activate = (e: Entry) => {
    if (e.dir) {
      setQ('')
      setDir(e.path)
    } else openEntry(e.path, props.onOpen)
  }
  const entryMenu = (e: Entry): MenuItem[] => [
    { label: e.dir ? 'Open folder' : opensInApp(e.path) ? 'Open' : 'Open with its app', run: () => activate(e) },
    ...(!e.dir && opensInApp(e.path) ? [{ label: 'Open with its usual app', run: () => api.openWithSystem(e.path) }] : []),
    { label: 'Rename', run: () => setRenaming(e) },
    { label: 'Show in folder', run: () => api.reveal(e.path) },
    { label: 'Copy path', run: () => navigator.clipboard.writeText(e.path) },
    ...(e.dir ? [{ label: 'Add as its own project', run: async () => (await api.projectsAdd(e.path), props.onChanged(), props.say(`Added ${e.name} to Projects`)) }] : []),
    { label: '', sep: true },
    { label: 'Delete', run: () => setDeleting(e) }
  ]
  const newItems: MenuItem[] = [
    { label: 'Document', run: () => props.onNew('doc', undefined, dir) },
    { label: 'Spreadsheet', run: () => props.onNew('sheet', undefined, dir) },
    { label: 'Markdown document', run: () => props.onNew('doc', 'md', dir) },
    { label: 'Text file', run: () => props.onNew('text', undefined, dir) }
  ]

  // Breadcrumb from the project root down to the folder on screen.
  const crumbs: { name: string; path: string }[] = [{ name: props.project.name, path: root }]
  if (dir.length > root.length) {
    let acc = root
    for (const part of dir.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      acc = join(acc, part)
      crumbs.push({ name: part, path: acc })
    }
  }

  return (
    <div className="browser">
      <div className="browser-head">
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">&gt;</span>}
              <button className={`crumb${i === crumbs.length - 1 ? ' on' : ''}`} onClick={() => (setQ(''), setDir(c.path))}>{c.name}</button>
            </span>
          ))}
        </div>
        <span className="grow" />
        <button className="pill" onClick={e => setMenu({ at: { x: e.clientX, y: e.clientY + 12 }, items: newItems })}>
          <Icon name="plus" size={18} /> New
        </button>
      </div>
      <div className="home-files-head">
        <div className="chips">
          {(['all', 'doc', 'sheet', 'pdf', 'text'] as const).map(k => (
            <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
              {{ all: 'All', doc: 'Documents', sheet: 'Spreadsheets', pdf: 'PDFs', text: 'Text & code' }[k]}
            </button>
          ))}
        </div>
        <label className="home-search">
          <Icon name="search" size={20} />
          <input placeholder={`Search ${props.project.name}`} value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <button className="icon-btn" title={props.view === 'list' ? 'Grid view' : 'List view'} onClick={() => props.onView(props.view === 'list' ? 'grid' : 'list')}>
          <Icon name={props.view === 'list' ? 'grid' : 'list'} />
        </button>
      </div>

      {props.project.missing && <p className="error">This folder can't be found. It may be on a drive that isn't connected.</p>}
      {err && !props.project.missing && <p className="error">{err}</p>}
      {entries === null && !found && <p className="muted">Loading...</p>}
      {found && <p className="muted small">{found.results.length ? `${found.results.length}${found.truncated ? '+' : ''} ${found.results.length === 1 && !found.truncated ? 'match' : 'matches'} in ${props.project.name}` : 'No matches.'}</p>}
      {entries && !found && !shown.length && !err && <div className="empty"><p>This folder is empty.</p></div>}

      {props.view === 'grid' ? (
        <div className="file-grid">
          {shown.map(e => (
            <button key={e.path} className="file-card" title={e.path} onDoubleClick={() => activate(e)} onClick={() => e.dir && activate(e)}
              onContextMenu={ev => (ev.preventDefault(), setMenu({ at: { x: ev.clientX, y: ev.clientY }, items: entryMenu(e) }))}>
              <div className={`file-card-art ${e.dir ? 'folder' : kindOf(e.path)}`}>
                {e.dir ? <Icon name="folder" size={48} /> : <KindIcon kind={kindOf(e.path)} size={48} />}
              </div>
              <div className="file-card-meta"><span className="grow ellipsis">{e.name}</span></div>
              <small className="muted">{e.dir ? 'Folder' : `${when(e.mtime)} · ${fileSize(e.size)}`}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="file-list">
          {shown.map(e => (
            <div key={e.path} className="file-row browser-row" role="button" tabIndex={0} title={e.path}
              onDoubleClick={() => activate(e)} onClick={() => e.dir && activate(e)} onKeyDown={ev => ev.key === 'Enter' && activate(e)}
              onContextMenu={ev => (ev.preventDefault(), setMenu({ at: { x: ev.clientX, y: ev.clientY }, items: entryMenu(e) }))}>
              {e.dir ? <span className="folder-ic"><Icon name="folder" size={22} /></span> : <KindIcon kind={kindOf(e.path)} size={22} />}
              <span className="file-name ellipsis">{e.name}</span>
              <span className="file-dir ellipsis muted">{found ? e.path.slice(root.length + 1, e.path.length - e.name.length - 1) : ''}</span>
              <span className="file-time muted">{when(e.mtime)}</span>
              <span className="file-size muted">{e.dir ? '' : fileSize(e.size)}</span>
            </div>
          ))}
        </div>
      )}

      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {renaming && (
        <NameDialog title={renaming.dir ? 'Rename folder' : 'Rename file'} value={renaming.name} selectStem={!renaming.dir} onClose={() => setRenaming(null)}
          onSave={async v => (await api.renameEntry(renaming.path, v), load())} />
      )}
      {deleting && (
        <Confirm
          title={`Delete ${deleting.dir ? 'folder' : 'file'}?`}
          text={`${deleting.name} goes to the Recycle Bin. You can restore it from there.`}
          onClose={() => setDeleting(null)}
          buttons={[
            { label: 'Cancel', run: () => setDeleting(null) },
            { label: 'Delete', primary: true, run: async () => {
              const e = deleting
              setDeleting(null)
              try {
                await api.trash(e.path)
                load()
              } catch (x) {
                props.say(`Couldn't delete ${e.name}: ${(x as Error).message}`)
              }
            } }
          ]}
        />
      )}
    </div>
  )
}

export { parent as parentDir }
