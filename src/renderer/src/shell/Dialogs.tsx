import { useEffect, useState } from 'react'
import type { InstalledPlugin, Settings } from '../../../shared/types'
import { type Market, type MarketPlugin, api } from '../lib'
import { Icon } from './icons'
import { DONATE } from '../../../shared/links'

export function Modal(props: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className={`dialog${props.wide ? ' wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  )
}

export function Confirm(props: { title: string; text: string; buttons: { label: string; primary?: boolean; run(): void }[]; onClose(): void }) {
  return (
    <Modal title={props.title} onClose={props.onClose} footer={props.buttons.map(b => (
      <button key={b.label} className={b.primary ? 'btn primary' : 'btn'} onClick={b.run} autoFocus={b.primary}>{b.label}</button>
    ))}>
      <p>{props.text}</p>
    </Modal>
  )
}

/** The heart button: a note from Matt before anything opens in the browser. */
export function DonateDialog({ onClose }: { onClose(): void }) {
  return (
    <Modal
      title="Support gauzzaDocs"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Not now</button>
          <button className="btn primary" autoFocus onClick={() => (api.openUrl(DONATE), onClose())}>
            <Icon name="heart" size={16} /> Donate on Ko-fi
          </button>
        </>
      }
    >
      <div className="donate">
        <p>I made gauzzaDocs for free. There's no subscription, no account and no ads.</p>
        <p>If it's useful to you, a donation on Ko-fi helps me keep building it.</p>
        <p className="muted small">Ko-fi opens in your browser.</p>
        <p className="donate-sign">Thanks, Matt</p>
      </div>
    </Modal>
  )
}

// ---------- plugin marketplace ----------
type View = 'all' | 'installed' | 'updates' | string // string = a category

export function PluginsDialog({ onClose, onReload }: { onClose(): void; onReload(): void }) {
  const [market, setMarket] = useState<Market | null>(null)
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [view, setView] = useState<View>('all')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const refresh = () => {
    api.pluginsInstalled().then(setInstalled)
    api.pluginsLibrary().then(setMarket, e => setErr((e as Error).message))
  }
  useEffect(refresh, [])
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    setErr('')
    try {
      await fn()
      refresh()
      onReload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const enabled = new Map(installed.map(p => [p.id, p.enabled]))
  // Plugins installed from a folder (not in the marketplace) still show under Installed.
  const local = installed.filter(p => !market?.plugins.some(m => m.id === p.id)).map(p => ({ ...p, installed: p.version, category: 'Installed from a folder' }) as MarketPlugin)
  const all: MarketPlugin[] = [...(market?.plugins || []), ...local]
  const updates = all.filter(p => p.update)
  const needle = q.trim().toLowerCase()
  const shown = all.filter(p =>
    (view === 'all' || (view === 'installed' ? !!p.installed : view === 'updates' ? p.update : p.category === view)) &&
    (!needle || `${p.id} ${p.name} ${p.description} ${(p.tags || []).join(' ')} ${(p.languages || []).join(' ')}`.toLowerCase().includes(needle)))
  const size = (n?: number) => (n ? (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`) : '')
  const nav = (v: View, label: string, n?: number) => (
    <button key={v} className={`mk-nav${view === v ? ' on' : ''}`} onClick={() => setView(v)}>
      <span className="grow">{label}</span>{n ? <span className="mk-count">{n}</span> : null}
    </button>
  )
  return (
    <Modal title="Plugin marketplace" onClose={onClose} wide>
      <div className="mk">
        <nav className="mk-side">
          {nav('all', 'All plugins', all.length)}
          {nav('installed', 'Installed', installed.length)}
          {nav('updates', 'Updates', updates.length)}
          <div className="mk-sep" />
          {market?.categories.map(c => nav(c, c, all.filter(p => p.category === c).length))}
        </nav>
        <div className="mk-main">
          <div className="mk-top">
            <label className="home-search sm grow"><Icon name="search" size={18} /><input autoFocus placeholder="Search plugins, tags, languages" value={q} onChange={e => setQ(e.target.value)} /></label>
            {updates.length > 0 && (
              <button className="btn primary sm" disabled={!!busy} onClick={() => act('*', () => api.pluginsUpdateAll())}>
                {busy === '*' ? 'Updating…' : `Update all (${updates.length})`}
              </button>
            )}
          </div>
          {err && <p className="error small">{err}</p>}
          {market?.offline && <p className="muted small">The online marketplace could not be reached ({market.offline}); showing the copy bundled with the app.</p>}
          {!market && !err && <p className="muted">Loading the marketplace…</p>}
          <div className="mk-grid">
            {shown.map(p => (
              <div key={p.id} className={`mk-card${p.installed ? ' installed' : ''}`}>
                <div className="mk-head">
                  <div className="mk-icon">{p.icon || <Icon name="puzzle" />}</div>
                  <div className="grow">
                    <b>{p.name}</b>
                    <div className="muted small">{p.version}{p.author ? ` · ${p.author}` : ''}{p.size ? ` · ${size(p.size)}` : ''}</div>
                  </div>
                  {p.installed && enabled.has(p.id) && (
                    <label className="switch" title={enabled.get(p.id) ? 'On' : 'Off'}>
                      <input type="checkbox" checked={!!enabled.get(p.id)} onChange={e => act(p.id, () => api.pluginsSetEnabled(p.id, e.target.checked))} />
                      <span />
                    </label>
                  )}
                </div>
                <p className="mk-desc">{p.description}</p>
                <div className="mk-tags">{(p.tags || []).slice(0, 4).map(t => <span key={t}>{t}</span>)}</div>
                <div className="mk-actions">
                  {p.compatible === false ? (
                    <span className="muted small">Needs a newer gauzzaDocs</span>
                  ) : !p.installed ? (
                    <button className="btn primary sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.pluginsInstall(p.id))}>{busy === p.id ? 'Installing…' : 'Install'}</button>
                  ) : (
                    <>
                      {p.update && <button className="btn primary sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.pluginsInstall(p.id))}>{busy === p.id ? 'Updating…' : `Update to ${p.version}`}</button>}
                      {!p.update && <span className="muted small"><Icon name="check" size={14} /> Installed {p.installed}</span>}
                      <button className="btn sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.pluginsRemove(p.id))}>Remove</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {market && !shown.length && <p className="muted">{view === 'updates' ? 'Everything is up to date.' : 'No plugins match.'}</p>}
          </div>
          <p className="muted small mk-foot">
            From {market?.source || '…'}. Every download is checked against the SHA-256 in the marketplace file. Plugins run with the
            app's access, like Notepad++ plugins, so install ones you trust. To publish one, see plugins/README.md.
          </p>
        </div>
      </div>
    </Modal>
  )
}

// ---------- settings ----------
export function SettingsDialog({ settings, onClose, onSave }: { settings: Settings; onClose(): void; onSave(s: Partial<Settings>): void }) {
  const [s, setS] = useState(settings)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v })
  return (
    <Modal title="Settings" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => (onSave(s), onClose())}>Save</button>
    </>}>
      <div className="form">
        <label>New files go in<input value={s.docsDir} onChange={e => set('docsDir', e.target.value)} /></label>
        <label>New documents are
          <select value={s.newDocFormat} onChange={e => set('newDocFormat', e.target.value as Settings['newDocFormat'])}>
            <option value="html">Web pages (.html): keeps every format, opens anywhere</option>
            <option value="md">Markdown (.md): plain text, best for agents and git</option>
            <option value="docx">Word (.docx)</option>
          </select>
        </label>
        <label className="row"><input type="checkbox" checked={s.autosave} onChange={e => set('autosave', e.target.checked)} />
          Save changes automatically (not for Word and PDF files, whose save can drop things the app does not support)</label>
        <label>Theme
          <select value={s.theme} onChange={e => set('theme', e.target.value as Settings['theme'])}>
            <option value="system">Same as Windows</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <label className="row"><input type="checkbox" checked={s.textWrap} onChange={e => set('textWrap', e.target.checked)} /> Wrap long lines in the text editor</label>
        <label>Text editor font size<input type="number" min={9} max={32} value={s.fontSize} onChange={e => set('fontSize', Number(e.target.value))} /></label>
        <div className="row-setting">
          <span className="grow">Open Word, Markdown, Excel, CSV, PDF and text files with gauzzaDocs when you double-click them.</span>
          <button type="button" className="btn sm" onClick={() => api.openDefaultApps()}>Make gauzzaDocs the default</button>
        </div>
        <label>Plugin library (marketplace.json URL or a local folder)<input value={s.registry} onChange={e => set('registry', e.target.value)} /></label>
      </div>
    </Modal>
  )
}

// ---------- agents / CLI ----------
const PROMPTS = [
  ['Work on a doc with me', 'Use the gdocs CLI to work on report.md with me. First run `gdocs instructions report.md` and follow them. Then loop: run `gdocs listen report.md --once` (it waits for my next comment or edit), do what I asked with small edits (`gdocs replace`, `gdocs doc insert`, --live so I can watch), answer in the thread with `gdocs reply report.md <id> "…" --resolve`, and listen again. Keep going until I say stop.'],
  ['Draft into an open doc', 'Use the gdocs CLI. Run `gdocs status` to see what I have open in gauzzaDocs, then append a one-page project summary (in markdown) to the open document with `gdocs append <file> -` so I can watch it appear.'],
  ['Fill a spreadsheet', 'Use the gdocs CLI. Read budget.xlsx with `gdocs read budget.xlsx`, add a "Total" row under the last row with SUM formulas for each numeric column using `gdocs sheet set`, and bold it with `gdocs sheet format`. Use --live so I can watch.'],
  ['Clean up a document', 'Use the gdocs CLI. Read my doc with `gdocs read <file>`, then fix spelling and tighten wording with `gdocs replace` (one change at a time) instead of rewriting the whole file, so the formatting is kept.'],
  ['Mark up a PDF', 'Use the gdocs CLI. Extract the text of contract.pdf with `gdocs pdf text`, then highlight every clause that mentions termination with `gdocs pdf highlight`, and add a note at the top of page 1 summarising them.']
]

export function AgentDialog({ onClose, onInstructions }: { onClose(): void; onInstructions?(): void }) {
  const [info, setInfo] = useState<{ port?: number; cli: string } | null>(null)
  const [copied, setCopied] = useState('')
  useEffect(() => void api.cliInfo().then(setInfo), [])
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => (setCopied(t), setTimeout(() => setCopied(''), 1500)))
  return (
    <Modal title="Connect an agent" onClose={onClose} wide>
      <p>
        Agents (Claude Code, Codex, scripts) edit your files with the <code>gdocs</code> command. While a file is open here, their edits land in
        the open editor as you watch, with their name shown at the top, and every change can be undone with Ctrl+Z. Files that are not open are
        edited on disk.
      </p>
      <pre className="code">{`gdocs instructions report.md         # standing instructions: run this first
gdocs listen report.md --once        # wait for your next comment or edit (two-way)
gdocs reply report.md <id> "Done"    # answer in the comment thread
gdocs status                         # what is open
gdocs read report.md                 # docs as markdown, sheets as CSV, PDFs as text
gdocs append report.md "## Next steps" --live
gdocs replace report.md "Q3" "Q4" --all
gdocs sheet set budget.xlsx B7 "=SUM(B2:B6)"
gdocs pdf highlight contract.pdf --page 2 --x 72 --y 140 --w 300 --h 14
gdocs format data.json --with json-tools.pretty
gdocs --help                         # everything, every command takes --json`}</pre>
      <p className="muted small">
        Bridge: 127.0.0.1:{info?.port ?? '…'} (token in ~/.gauzzadocs/server.json). Installed copies put <code>gdocs</code> on your PATH; from source run{' '}
        <code>node {info?.cli}</code>.
      </p>
      <p className="small">
        Give agents standing instructions (your writing voice, house style, what not to touch), for every file or just this one:{' '}
        {onInstructions && <button className="btn sm" onClick={onInstructions}>Write instructions…</button>}
      </p>
      <h3>Things to ask an agent</h3>
      <div className="prompts">
        {PROMPTS.map(([title, text]) => (
          <div key={title} className="prompt">
            <b>{title}</b>
            <p>{text}</p>
            <button className="btn sm" onClick={() => copy(text)}><Icon name="copy" size={16} /> {copied === text ? 'Copied' : 'Copy'}</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ---------- standing instructions for agents ----------
export function InstructionsDialog({ path, onClose, onSaved }: { path: string | null; onClose(): void; onSaved(mtime: number, hasFile: boolean): void }) {
  const [g, setG] = useState<string | null>(null)
  const [f, setF] = useState('')
  const [stored, setStored] = useState<string | undefined>()
  const [err, setErr] = useState('')
  useEffect(() => {
    api.instructions(path || undefined).then(r => (setG(r.global), setF(r.file), setStored(r.stored)), e => setErr((e as Error).message))
  }, [])
  const name = path ? path.split(/[\\/]/).pop() : ''
  const save = async () => {
    try {
      await api.setInstructions(null, g || '')
      const mtime = path ? await api.setInstructions(path, f) : 0
      onSaved(mtime, !!f.trim())
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <Modal title="Agent instructions" onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={g === null}>Save</button>
    </>}>
      <p className="muted small">
        Standing instructions agents get when they work on your files. They run <code>gdocs instructions &lt;file&gt;</code> before editing,
        and every <code>gdocs read --json</code> includes them. They never appear in the document itself.
      </p>
      {err && <p className="error">{err}</p>}
      <div className="form">
        {path && (
          <label>
            For {name} only {stored && <span className="muted">(saved {stored === 'in the file' ? 'invisibly inside the file, so they travel with it' : 'in app data, linked to this file'})</span>}
            <textarea className="instructions" rows={6} value={f} onChange={e => setF(e.target.value)}
              placeholder={'e.g. This is the board update. Keep it under one page, plain language, no jargon.\nNever change the numbers in the Financials section.'} />
          </label>
        )}
        <label>
          For every file
          <textarea className="instructions" rows={6} value={g ?? ''} onChange={e => setG(e.target.value)}
            placeholder={'e.g. Before writing anything in my name, look up my writing voice:\nempirical memory query --match "how this person writes" --tags writing-voice --top-k 50'} />
        </label>
      </div>
    </Modal>
  )
}

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const keys: [string, string][] = [
    ['Ctrl+N', 'New document'], ['Ctrl+O', 'Open a file'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+P', 'Print'],
    ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'], ['Ctrl+Shift+Tab', 'Previous tab'], ['Ctrl+F', 'Find'], ['Ctrl+H', 'Find and replace'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+B / I / U', 'Bold / italic / underline'], ['Ctrl+K', 'Insert link'],
    ['Ctrl+Alt+1..3', 'Heading 1-3'], ['Ctrl+Shift+F', 'Format document (plugins)'], ['Ctrl+/', 'Keyboard shortcuts']
  ]
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="keys">{keys.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </Modal>
  )
}
