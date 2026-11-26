import { useEffect, useMemo, useState } from 'react'
import type { Author, HistoryVersion } from '../../../shared/types'
import { baseName, extOf, kindOf } from '../../../shared/kinds'
import { agentColor } from '../../../shared/agentColors'
import { type HistoryDiff, type HistoryEvent, api } from '../lib'
import { Confirm } from './Dialogs'
import { Icon } from './icons'
import { usePanelSize } from './resize'
import { atText, diffRows, diffStats, errorText, eventLine, groupByDay, statsText, timeOf, whoIs } from './historyView'

type Ask = { title: string; text: string; buttons: { label: string; primary?: boolean; danger?: boolean; run(): void }[] }
type DiffState = HistoryDiff | { error: string } | { first: true } | null

/** The restore error the history store gives when the file on disk is over the size limit (src/core/history/manage.ts). */
const OVER_LIMIT = /over 32 MB/

/**
 * Version history beside the file, like Google Docs (File > Version history, Ctrl+Alt+Shift+H). Versions are grouped
 * by day with who made them; selecting one shows what it changed (or how it differs from now) with Restore, Name and
 * Open as a copy. Work history is the file's timeline: saves, agent edits, comments, restores.
 */
export function HistoryPanel(props: {
  path: string
  dirty: boolean
  /** Bumps when the file is saved or reloaded, so the lists catch up. */
  refreshKey: number
  onClose(): void
  /** Restores version n into the open tab (unsaved edits are kept as a version first) and reloads it from disk. */
  onRestore(n: number, opts: { discardCurrent?: boolean }): Promise<HistoryVersion>
  onOpen(path: string): void
  say(msg: string): void
}) {
  const { path, say } = props
  const [width, resizeHandle] = usePanelSize('history', 380, { min: 300, max: 760, edge: 'left' })
  const [tab, setTab] = useState<'versions' | 'work'>('versions')
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null)
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [person, setPerson] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const name = baseName(path)

  const loadVersions = () => api.historyList(path).then(v => (setVersions(v), setError('')), e => setError(errorText(e)))
  const loadEvents = () => api.historyLog(path).then(setEvents, e => setError(errorText(e)))
  useEffect(() => void api.userName().then(setPerson, () => {}), [])
  useEffect(() => {
    loadVersions()
    if (tab === 'work') loadEvents()
  }, [path, props.refreshKey, tab])
  // History that changes without a save: work history events main kept (agent edits, comments, agents connecting)
  // and outside versions the 2-second check recorded (App.tsx sends 'gd-history-changed').
  useEffect(() => {
    const hit = (f: string) => {
      if (typeof f !== 'string' || f.toLowerCase() !== path.toLowerCase()) return
      loadVersions()
      if (tab === 'work') loadEvents()
    }
    const off = window.gd.on('history-changed', hit)
    const local = (e: Event) => hit((e as CustomEvent<string>).detail)
    window.addEventListener('gd-history-changed', local)
    return () => {
      off()
      window.removeEventListener('gd-history-changed', local)
    }
  }, [path, tab])

  // The list shrinks to make room for the selected version: keep that row in view.
  useEffect(() => {
    if (selected !== null) document.querySelector('.history .hv-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [selected, versions])

  const newest = useMemo(() => [...(versions || [])].reverse(), [versions])
  const latest = versions?.[versions.length - 1]
  const sel = versions?.find(v => v.n === selected) || null
  const prev = sel && versions ? versions[versions.indexOf(sel) - 1] : undefined

  const restore = async (v: HistoryVersion, discardCurrent = false) => {
    setAsk(null)
    setBusy(true)
    try {
      const now = await props.onRestore(v.n, { discardCurrent })
      await loadVersions()
      setSelected(now.n)
      say(`Restored v${v.n}`)
    } catch (e) {
      const m = errorText(e)
      if (!discardCurrent && OVER_LIMIT.test(m))
        setAsk({
          title: 'Restore without keeping the current file?',
          text: `${name} is over 32 MB, so gauzzaDocs can't keep what it holds now as a version. Restoring v${v.n} replaces it for good.`,
          buttons: [
            { label: 'Cancel', run: () => setAsk(null) },
            { label: 'Restore anyway', primary: true, run: () => restore(v, true) },
          ],
        })
      else say(`Could not restore v${v.n}: ${m}`)
    } finally {
      setBusy(false)
    }
  }
  const askRestore = (v: HistoryVersion) =>
    setAsk({
      title: 'Restore this version?',
      text: props.dirty
        ? `${name} goes back to v${v.n} from ${atText(v.at)}. What it holds now and your unsaved changes are kept as versions, so you can undo this by restoring them.`
        : `${name} goes back to v${v.n} from ${atText(v.at)}. What it holds now is kept as a version, so you can undo this by restoring that one.`,
      buttons: [
        { label: 'Cancel', run: () => setAsk(null) },
        { label: 'Restore', primary: true, run: () => restore(v) },
      ],
    })
  const nameVersion = async (v: HistoryVersion, text: string) => {
    const t = text.trim()
    if (t === (v.name || '')) return
    try {
      await api.historyName(path, v.n, t)
      await loadVersions()
      say(t ? `Named v${v.n} "${t}"` : `Cleared the name of v${v.n}`)
    } catch (e) {
      say(`Could not name v${v.n}: ${errorText(e)}`)
    }
  }
  const openCopy = async (v: HistoryVersion) => {
    try {
      const p = await api.historyOpenCopy(path, v.n)
      props.onOpen(p)
      say(`Opened v${v.n} as ${baseName(p)}`)
    } catch (e) {
      say(`Could not open v${v.n}: ${errorText(e)}`)
    }
  }
  const askForget = () =>
    setAsk({
      title: 'Delete history for this file?',
      text: `Every version and the work history of ${name} are deleted. The file itself stays as it is. This can't be undone.`,
      buttons: [
        { label: 'Cancel', run: () => setAsk(null) },
        {
          label: 'Delete history',
          danger: true,
          run: async () => {
            setAsk(null)
            try {
              await api.historyForget(path)
              setSelected(null)
              await Promise.all([loadVersions(), tab === 'work' ? loadEvents() : null])
              say(`Deleted the history of ${name}`)
            } catch (e) {
              say(`Could not delete the history: ${errorText(e)}`)
            }
          },
        },
      ],
    })

  return (
    <aside className="history" style={{ width }}>
      {resizeHandle}
      <header>
        <Icon name="history" size={18} />
        <b className="grow">Version history</b>
        <button className="icon-btn sm" onClick={props.onClose} title="Close version history (Ctrl+Alt+Shift+H)"><Icon name="close" size={16} /></button>
      </header>
      <div className="hv-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'versions'} className={`hv-tab${tab === 'versions' ? ' on' : ''}`} onClick={() => setTab('versions')}>Versions</button>
        <button role="tab" aria-selected={tab === 'work'} className={`hv-tab${tab === 'work' ? ' on' : ''}`} onClick={() => setTab('work')}>Work history</button>
      </div>

      {error && <p className="error small hv-error">{error}</p>}

      {tab === 'versions' ? (
        <div className="hv-body">
          <div className={`hv-list${sel ? ' split' : ''}`}>
            {versions && !versions.length && !error && (
              <div className="hv-empty">
                <p>No versions yet. Each save keeps one.</p>
                <p className="muted small">Files that match a secret file pattern in Settings never keep versions.</p>
              </div>
            )}
            {!versions && !error && <p className="muted small hv-empty">Loading...</p>}
            {groupByDay(newest, v => v.at).map(g => (
              <section key={g.key}>
                <div className="hv-day">{g.label}</div>
                {g.items.map(v => (
                  <VersionRow key={v.n} v={v} current={v === latest} on={v.n === selected} onClick={() => setSelected(v.n === selected ? null : v.n)} />
                ))}
              </section>
            ))}
          </div>
          {sel && (
            <VersionDetail
              key={sel.n}
              path={path}
              v={sel}
              prev={prev}
              current={sel === latest}
              dirty={props.dirty}
              refreshKey={props.refreshKey}
              busy={busy}
              onRestore={() => askRestore(sel)}
              onName={t => nameVersion(sel, t)}
              onCopy={() => openCopy(sel)}
            />
          )}
        </div>
      ) : (
        <div className="hv-body">
          <div className="hv-list">
            {events && !events.length && !error && (
              <p className="hv-empty">Nothing here yet. Saves, agent edits, comments and restores show up here.</p>
            )}
            {!events && !error && <p className="muted small hv-empty">Loading...</p>}
            {groupByDay(events || [], e => e.at).map(g => (
              <section key={g.key}>
                <div className="hv-day">{g.label}</div>
                {g.items.map((e, i) => <EventRow key={`${e.at}:${i}`} e={e} person={person} kind={kindOf(path)} />)}
              </section>
            ))}
          </div>
        </div>
      )}

      {!!versions?.length && (
        <div className="hv-foot">
          <button className="hv-forget" onClick={askForget}>Delete history for this file</button>
        </div>
      )}
      {ask && <Confirm {...ask} onClose={() => ask.buttons[0].run()} />}
    </aside>
  )
}

function Avatar({ a }: { a: Author }) {
  if (a.by === 'outside')
    return (
      <span className="cm-avatar hv-avatar outside" title="Changed outside gauzzaDocs">
        <Icon name="outside" size={12} />
      </span>
    )
  return (
    <span className={`cm-avatar hv-avatar ${a.by === 'agent' ? 'agent' : 'user'}`} style={a.by === 'agent' ? { background: agentColor(a.name) } : undefined} title={a.by === 'agent' ? `${a.name} (agent)` : a.name}>
      {(a.name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

function Authors({ authors }: { authors: Author[] }) {
  return (
    <div className="hv-authors">
      {authors.map(a => (
        <span key={`${a.by}:${a.name}`} className="hv-author">
          <Avatar a={a} />
          {a.name}
        </span>
      ))}
    </div>
  )
}

function VersionRow({ v, current, on, onClick }: { v: HistoryVersion; current: boolean; on: boolean; onClick(): void }) {
  return (
    <div className={`hv-row${on ? ' on' : ''}`} role="button" tabIndex={0} aria-pressed={on} onClick={onClick} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
      <div className="hv-top">
        <span className="hv-time">{timeOf(v.at)}</span>
        {current && <span className="hv-current">Current version</span>}
        {v.beforeRestore && <span className="hv-tag">Before a restore</span>}
        <span className="hv-n">v{v.n}</span>
      </div>
      {v.name && <div className="hv-name">{v.name}</div>}
      <div className="hv-summary">{v.summary}</div>
      <Authors authors={v.authors} />
    </div>
  )
}

function EventRow({ e, person, kind }: { e: HistoryEvent; person: string; kind: string }) {
  const l = eventLine(e, kind)
  return (
    <div className="hv-event">
      <div className="hv-avatars">
        {l.names.map(n => <Avatar key={n} a={{ name: n, by: whoIs(n, person) }} />)}
      </div>
      <div className="grow">
        <div className="hv-event-text">
          {l.named ? <><b>{l.names.join(', ')}</b> {l.text}</> : l.text}
        </div>
        <div className="muted small">{timeOf(e.at)}</div>
      </div>
    </div>
  )
}

/** The selected version: its actions, and what it changed (from the version before it) or how it differs from now. */
function VersionDetail(props: {
  path: string
  v: HistoryVersion
  prev?: HistoryVersion
  current: boolean
  dirty: boolean
  refreshKey: number
  busy: boolean
  onRestore(): void
  onName(name: string): void
  onCopy(): void
}) {
  const { path, v, prev } = props
  const [mode, setMode] = useState<'changes' | 'now'>('changes')
  const [diff, setDiff] = useState<DiffState>(null)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState(v.name || '')
  const mono = kindOf(path) === 'text' || kindOf(path) === 'sheet' || ['csv', 'tsv'].includes(extOf(path))
  // A comparison runs on the worker's one thread, which also does every save, and a big one can take a while. So it
  // only runs again when the versions compared change (or the person asks), never on each autosave: a save since
  // only marks the result as out of date. A result for an earlier selection is dropped.
  const [again, setAgain] = useState(0)
  const inputs = `${v.hash}:${mode === 'now' ? props.refreshKey : 0}`
  const [ranOn, setRanOn] = useState(inputs)

  useEffect(() => {
    let alive = true
    setDiff(null)
    setRanOn(inputs)
    const run = mode === 'now' ? api.historyDiff(path, v.n) : prev ? api.historyDiff(path, prev.n, v.n) : null
    if (!run) setDiff({ first: true })
    else run.then(d => alive && setDiff(d), e => alive && setDiff({ error: errorText(e) }))
    return () => {
      alive = false
    }
  }, [path, v.n, prev?.n, mode, again])
  const outdated = !!diff && !('first' in diff) && ranOn !== inputs

  const restoreTitle = props.current && !props.dirty ? 'This is the current version' : undefined
  const finishName = () => {
    setNaming(false)
    props.onName(draft)
  }

  return (
    <div className="hv-detail">
      <div className="hv-detail-head">
        <div className="hv-detail-title">{v.name || `Version ${v.n}`}</div>
        <div className="muted small">{v.name ? `v${v.n}, ${atText(v.at)}` : atText(v.at).replace(/^./, c => c.toUpperCase())}</div>
      </div>
      {naming ? (
        <div className="hv-name-edit">
          <input
            autoFocus
            value={draft}
            maxLength={120}
            placeholder="Name this version"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') finishName()
              if (e.key === 'Escape') (setDraft(v.name || ''), setNaming(false))
            }}
          />
          <button className="btn sm primary" onClick={finishName}>Save</button>
          <button className="btn sm" onClick={() => (setDraft(v.name || ''), setNaming(false))}>Cancel</button>
        </div>
      ) : (
        <div className="hv-actions">
          <button className="btn sm primary" disabled={props.busy || !!restoreTitle} title={restoreTitle} onClick={props.onRestore}>
            {props.busy ? 'Restoring...' : 'Restore this version'}
          </button>
          <button className="btn sm" onClick={() => (setDraft(v.name || ''), setNaming(true))}>Name this version</button>
          <button className="btn sm" onClick={props.onCopy}>Open as a copy</button>
        </div>
      )}

      <div className="hv-modes" role="tablist">
        <button role="tab" aria-selected={mode === 'changes'} className={mode === 'changes' ? 'on' : ''} onClick={() => setMode('changes')}>Changes in v{v.n}</button>
        <button role="tab" aria-selected={mode === 'now'} className={mode === 'now' ? 'on' : ''} onClick={() => setMode('now')}>Compared with now</button>
      </div>
      {mode === 'changes' && prev && prev.n !== v.n - 1 && <p className="muted small hv-note">Compared with v{prev.n}, the version before it that is still kept.</p>}
      {mode === 'now' && props.dirty && <p className="muted small hv-note">Unsaved changes in the editor are not included.</p>}
      {outdated && (
        <div className="hv-large">
          <span className="grow">The file changed since this comparison.</span>
          <button className="btn sm" onClick={() => setAgain(n => n + 1)}>Compare again</button>
        </div>
      )}
      <DiffView diff={diff} mode={mode} v={v} mono={mono} onCopy={props.onCopy} />
    </div>
  )
}

function DiffView({ diff, mode, v, mono, onCopy }: { diff: DiffState; mode: 'changes' | 'now'; v: HistoryVersion; mono: boolean; onCopy(): void }) {
  const shown = useMemo(() => (diff && 'hunks' in diff ? diffRows(diff.hunks) : null), [diff])
  if (!diff) return <p className="muted small hv-note">Comparing...</p>
  if ('error' in diff) return <p className="muted small hv-note">{diff.error}</p>
  if ('first' in diff)
    return <p className="muted small hv-note">{v.baseline ? 'The file as it was before gauzzaDocs first changed it.' : 'The first version kept for this file.'}</p>
  if ('tooLarge' in diff || 'tooMany' in diff)
    return (
      <div className="hv-large">
        <span className="grow">{'tooMany' in diff ? 'Too many changes to compare here' : 'Too large to compare here'}</span>
        <button className="btn sm" onClick={onCopy}>Open as a copy</button>
      </div>
    )
  if (!diff.hunks.length || !shown)
    return <p className="muted small hv-note">{mode === 'now' ? 'No differences: the file is the same as this version.' : 'No text changes in this version.'}</p>
  const stats = statsText(diffStats(diff.hunks))
  return (
    <>
      {stats && <p className="muted small hv-note">{stats} {mode === 'now' ? 'since this version' : 'in this version'}</p>}
      <div className={`hv-diff${mono ? ' mono' : ''}`}>
        {shown.rows.map((r, i) =>
          r.kind === 'gap' ? (
            <div key={i} className="hv-gap" title="Unchanged lines left out">...</div>
          ) : (
            <div key={i} className={`hv-line ${r.kind}`}>
              <span className="hv-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ''}</span>
              <span className="hv-text">{r.text || ' '}</span>
            </div>
          ),
        )}
      </div>
      {shown.cut && <p className="muted small hv-note">Showing the first 3000 lines.</p>}
    </>
  )
}
