import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Kind, baseName, kindOf } from '../../../shared/kinds'
import { isScratchFile } from '../../../shared/scratchFiles'
import type { RecentFile, Settings } from '../../../shared/types'
import { type Project, api, shortDir, when } from '../lib'
import { ContextMenu, FolderBrowser, ProjectRail } from './Projects'
import { Icon, KindIcon } from './icons'
import { designSizeItems } from '../design/presets'

/**
 * The start page, like Drive: a rail on the left with Recent and the person's projects (folders), and the main area
 * showing either recent files under the new-file templates or the selected project's folder browser.
 */
export function Home(props: {
  settings: Settings
  home: string
  onOpen(path: string): void
  /** preset: a new design's size (a PRESETS name). */
  onNew(kind: Kind, ext?: string, dir?: string, preset?: string): void
  onOpenDialog(): void
  refreshKey: number
  say(msg: string): void
}) {
  const [projects, setProjects] = useState<Project[] | null>(null) // null until the first load finishes
  const [sel, setSelState] = useState<string>(() => {
    try {
      return localStorage.getItem('homeView') || 'recent'
    } catch {
      return 'recent'
    }
  })
  const select = (v: string) => {
    setSelState(v)
    try { localStorage.setItem('homeView', v) } catch { /* storage off */ }
  }
  const loadProjects = useCallback(() => api.projectsList().then(setProjects, () => setProjects([])), [])
  useEffect(() => void loadProjects(), [props.refreshKey])
  const project = projects?.find(p => p.path === sel)
  const [view, setView] = useState<'list' | 'grid'>('list')

  // Dropping a folder adds it as a project; dropping files opens them.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.gd.pathFor(f)
      if (await api.isFolder(p)) {
        const proj = await api.projectsAdd(p)
        await loadProjects()
        select(proj.path)
        props.say(`Added ${proj.name} to Projects`)
      } else props.onOpen(p)
    }
  }

  return (
    <div className="home-shell" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <ProjectRail projects={projects ?? []} loading={projects === null} selected={project ? sel : 'recent'} onSelect={select} onChanged={loadProjects} say={props.say} />
      <div className="home-main">
        {project ? (
          <div className="home-inner home-files">
            <FolderBrowser key={project.path} project={project} view={view} onView={setView} onOpen={props.onOpen}
              onNew={(k, ext, dir) => props.onNew(k, ext, dir)} onChanged={loadProjects} say={props.say} />
          </div>
        ) : (
          <RecentView {...props} view={view} onView={setView} />
        )}
      </div>
    </div>
  )
}

function RecentView(props: {
  settings: Settings
  home: string
  onOpen(path: string): void
  onNew(kind: Kind, ext?: string, dir?: string, preset?: string): void
  onOpenDialog(): void
  refreshKey: number
  view: 'list' | 'grid'
  onView(v: 'list' | 'grid'): void
}) {
  const view = props.view
  const setView = props.onView
  const [recent, setRecent] = useState<RecentFile[]>([])
  const [filter, setFilter] = useState<'all' | Kind>('all')
  const [q, setQ] = useState('')
  const [folder, setFolder] = useState<{ name: string; path: string; dir: boolean; mtime: number }[]>([])
  const [sizes, setSizes] = useState<{ x: number; y: number } | null>(null) // the size picker a new design starts with

  useEffect(() => {
    api.recent().then(setRecent)
    api.listDir(props.settings.docsDir).then(setFolder).catch(() => setFolder([]))
  }, [props.refreshKey, props.settings.docsDir])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return recent.filter(r => (filter === 'all' || r.kind === filter) && (!needle || r.path.toLowerCase().includes(needle)))
  }, [recent, filter, q])
  const inFolder = folder
    // a design's lock and an export's temp file are there only while they're being written
    .filter(f => !f.dir && !isScratchFile(f.name) && !recent.some(r => r.path.toLowerCase() === f.path.toLowerCase()))
    .filter(f => (filter === 'all' || kindOf(f.path) === filter) && (!q || f.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.mtime - a.mtime)

  const templates: { kind: Kind; ext?: string; label: string; art: React.JSX.Element }[] = [
    { kind: 'doc', label: 'Blank document', art: <div className="tpl-art doc"><span className="plus"><Icon name="plus" size={56} /></span></div> },
    { kind: 'sheet', label: 'Blank spreadsheet', art: <div className="tpl-art sheet"><span className="plus"><Icon name="plus" size={56} /></span></div> },
    { kind: 'slides', label: 'Blank presentation', art: <div className="tpl-art slides"><span className="plus" style={{ color: '#f4b400' }}><Icon name="plus" size={56} /></span></div> },
    { kind: 'design', label: 'Blank design', art: <div className="tpl-art design"><span className="plus" style={{ color: '#7b5cf0' }}><Icon name="plus" size={56} /></span></div> },
    { kind: 'doc', ext: 'md', label: 'Markdown doc', art: <div className="tpl-art md"><b>M↓</b></div> },
    { kind: 'doc', ext: 'docx', label: 'Word document', art: <div className="tpl-art docx"><b>W</b></div> },
    { kind: 'text', label: 'Text or code', art: <div className="tpl-art code"><b>{'{ }'}</b></div> }
  ]

  return (
    <div className="home">
      <section className="home-new">
        <div className="home-inner">
          <div className="home-new-head">
            <h2>Start something new</h2>
            <button className="pill" onClick={props.onOpenDialog}>
              <Icon name="folderOpen" size={18} /> Open a file
            </button>
          </div>
          <div className="templates">
            {templates.map(t => (
              <button
                key={t.label}
                className="tpl"
                onClick={e => {
                  if (t.kind !== 'design') return props.onNew(t.kind, t.ext)
                  // a design starts at a size: pick one under the tile
                  const r = e.currentTarget.getBoundingClientRect()
                  setSizes({ x: r.left, y: r.bottom + 4 })
                }}
              >
                {t.art}
                <span>{t.label}</span>
              </button>
            ))}
            <button className="tpl" onClick={props.onOpenDialog}>
              <div className="tpl-art pdf"><b>PDF</b></div>
              <span>Open a PDF</span>
            </button>
          </div>
        </div>
      </section>
      {sizes && <ContextMenu at={sizes} items={designSizeItems(preset => props.onNew('design', undefined, undefined, preset))} onClose={() => setSizes(null)} />}

      <section className="home-inner home-files">
        <div className="home-files-head">
          <div className="chips">
            {(['all', 'doc', 'sheet', 'slides', 'design', 'pdf', 'text'] as const).map(k => (
              <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
                {{ all: 'All', doc: 'Documents', sheet: 'Spreadsheets', slides: 'Presentations', design: 'Designs', pdf: 'PDFs', text: 'Text & code' }[k]}
              </button>
            ))}
          </div>
          <label className="home-search">
            <Icon name="search" size={20} />
            <input placeholder="Search recent files" value={q} onChange={e => setQ(e.target.value)} />
          </label>
          <button className="icon-btn" title={view === 'list' ? 'Grid view' : 'List view'} onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
            <Icon name={view === 'list' ? 'grid' : 'list'} />
          </button>
        </div>

        {shown.length === 0 && inFolder.length === 0 && (
          <div className="empty">
            <p>No files yet. Start a new one above, open a file, or drop files or folders here.</p>
          </div>
        )}

        {shown.length > 0 && <h3>Recent</h3>}
        <FileList view={view} items={shown.map(r => ({ path: r.path, kind: r.kind, time: r.opened }))} home={props.home} onOpen={props.onOpen}
          onForget={p => api.removeRecent(p).then(() => api.recent().then(setRecent))} timeLabel="Opened" />

        {inFolder.length > 0 && <h3>In {shortDir(props.settings.docsDir + '\\x', props.home)}</h3>}
        <FileList view={view} items={inFolder.map(f => ({ path: f.path, kind: kindOf(f.path), time: f.mtime }))} home={props.home} onOpen={props.onOpen} timeLabel="Modified" />
      </section>
    </div>
  )
}

/** A design's card art: the thumbnail its file holds, or the kind's icon when it has none or it's stale. */
function DesignArt(props: { path: string; time: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    api.designThumbnail(props.path).then(
      url => !gone && setSrc(url),
      () => !gone && setSrc(null)
    )
    return () => void (gone = true)
  }, [props.path, props.time])
  if (!src) return <KindIcon kind="design" size={48} />
  return <img className="file-card-thumb" src={src} alt="" draggable={false} onError={() => setSrc(null)} />
}

function FileList(props: {
  view: 'list' | 'grid'
  items: { path: string; kind: Kind; time: number }[]
  home: string
  timeLabel: string
  onOpen(p: string): void
  onForget?(p: string): void
}) {
  if (!props.items.length) return null
  if (props.view === 'grid')
    return (
      <div className="file-grid">
        {props.items.map(it => (
          <button key={it.path} className="file-card" onClick={() => props.onOpen(it.path)} title={it.path}>
            <div className={`file-card-art ${it.kind}`}>{it.kind === 'design' ? <DesignArt path={it.path} time={it.time} /> : <KindIcon kind={it.kind} size={48} />}</div>
            <div className="file-card-meta">
              <KindIcon kind={it.kind} size={18} />
              <span className="grow ellipsis">{baseName(it.path)}</span>
            </div>
            <small className="muted">{props.timeLabel} {when(it.time)}</small>
          </button>
        ))}
      </div>
    )
  return (
    <div className="file-list">
      {props.items.map(it => (
        <div key={it.path} className="file-row" onClick={() => props.onOpen(it.path)} title={it.path} role="button">
          <KindIcon kind={it.kind} size={22} />
          <span className="file-name ellipsis">{baseName(it.path)}</span>
          <span className="file-dir ellipsis muted">{shortDir(it.path, props.home)}</span>
          <span className="file-time muted">{when(it.time)}</span>
          <span className="file-actions">
            <button className="icon-btn sm" title="Show in folder" onClick={e => (e.stopPropagation(), api.reveal(it.path))}>
              <Icon name="folder" size={18} />
            </button>
            {props.onForget && (
              <button className="icon-btn sm" title="Remove from recent" onClick={e => (e.stopPropagation(), props.onForget!(it.path))}>
                <Icon name="close" size={18} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
