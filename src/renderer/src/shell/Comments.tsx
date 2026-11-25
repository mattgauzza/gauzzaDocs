import { useEffect, useRef, useState } from 'react'
import { type Listener, type Thread, api, when } from '../lib'
import { Icon } from './icons'
import { usePanelSize } from './resize'
import { JoinChip } from './JoinChip'
import { agentColor } from '../../../shared/agentColors'

/** Open threads that quote some text, for highlighting in the editor. Reloads whenever the file's threads change. */
export function useQuotedThreads(path: string) {
  const [threads, setThreads] = useState<{ id: string; quote: string; color?: string }[]>([])
  useEffect(() => {
    let alive = true
    const load = () =>
      api.commentsList(path).then(
        ts => alive && setThreads(ts.filter(t => !t.resolved && t.quote?.trim()).slice(0, 100).map(t => ({ id: t.id, quote: t.quote!.trim(), color: t.by === 'agent' ? agentColor(t.author) : undefined }))),
        () => {}
      )
    load()
    const off = window.gd.on('comments-changed', (file: string) => file.toLowerCase() === path.toLowerCase() && load())
    return () => {
      alive = false
      off()
    }
  }, [path])
  return threads
}

/** Asks the shell to open the comments panel on one thread (clicking a highlight in the editor). */
export const focusThread = (path: string, id: string) => window.dispatchEvent(new CustomEvent('gd-focus-thread', { detail: { path, id } }))

/**
 * Comment threads beside the file, like Google Docs. Comments, replies and resolves made here are streamed to any
 * agent listening on the file (`gdocs listen`), and the agent's replies appear here as they arrive.
 */
export function CommentsPanel(props: {
  path: string
  listeners: Listener[]
  draftQuote: string // the selection when "Add comment" was used
  draftText?: string // text to start the new comment with (e.g. "@agent: ")
  onClose(): void
  onCount(n: number): void
  focusDraft: number // bumped to focus the new-comment box
  focusThread?: { id: string; n: number } // bumped to scroll to and flash one thread
}) {
  const [width, resizeHandle] = usePanelSize('comments', 340, { min: 260, max: 720, edge: 'left' })
  const [threads, setThreads] = useState<Thread[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState(props.draftQuote)
  const box = useRef<HTMLTextAreaElement>(null)
  const fresh = useRef(new Set<string>()) // threads/replies that just arrived from an agent, highlighted briefly

  const load = () =>
    api.commentsList(props.path, true).then(ts => {
      setThreads(prev => {
        const seen = new Set(prev.flatMap(t => [t.id, ...t.replies.map(r => r.id)]))
        for (const t of ts) for (const x of [t, ...t.replies]) if (prev.length && !seen.has(x.id) && x.by === 'agent') fresh.current.add(x.id)
        return ts
      })
      props.onCount(ts.filter(t => !t.resolved).length)
    })
  useEffect(() => {
    load()
    const off = window.gd.on('comments-changed', (file: string) => file.toLowerCase() === props.path.toLowerCase() && load())
    return off
  }, [props.path])
  useEffect(() => {
    setQuote(props.draftQuote)
    if (props.draftText) setDraft(props.draftText)
    if (props.focusDraft)
      setTimeout(() => {
        const b = box.current
        if (!b) return
        b.focus()
        b.setSelectionRange(b.value.length, b.value.length)
      }, 0)
  }, [props.focusDraft])
  // Clicking a highlight in the editor brings its thread into view.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = props.focusThread?.id
    if (!id) return
    if (threads.find(t => t.id === id)?.resolved) setShowResolved(true)
    const t = setTimeout(() => {
      const el = listRef.current?.querySelector(`[data-thread="${id}"]`) as HTMLElement | null
      if (!el) return
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el.classList.remove('focused')
      void el.offsetWidth
      el.classList.add('focused')
    }, 60)
    return () => clearTimeout(t)
  }, [props.focusThread?.n, threads.length])

  const listening = props.listeners.filter(l => !l.path || l.path.toLowerCase() === props.path.toLowerCase())
  const add = async () => {
    if (!draft.trim()) return
    await api.commentAdd(props.path, { text: draft, quote: quote || undefined })
    setDraft('')
    setQuote('')
    load()
  }
  const shown = threads.filter(t => showResolved || !t.resolved)

  return (
    <aside className="comments" style={{ width }}>
      {resizeHandle}
      <header>
        <b className="grow">Comments</b>
        <label className="small muted cm-toggle">
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Resolved
        </label>
        <button className="icon-btn sm" onClick={props.onClose} title="Close comments"><Icon name="close" size={16} /></button>
      </header>

      <div className={`cm-listen${listening.length ? ' on' : ''}`}>
        {listening.length ? (
          <>
            <span className="cm-live" />
            <span><b>{[...new Set(listening.map(l => l.agent))].join(', ')}</b> {listening.length > 1 ? 'are' : 'is'} listening: your comments and edits go straight to {listening.length > 1 ? 'them' : 'it'}.{' '}
              <button className="cm-manage" onClick={() => window.dispatchEvent(new Event('gd-show-connections'))}>Manage</button>
            </span>
          </>
        ) : (
          <span>
            No agent is listening. Use Add agent above, or have your agent run{' '}
            <JoinChip path={props.path} />{' '}
            to hear your comments and edits.
          </span>
        )}
      </div>

      <div className="cm-new">
        {quote && (
          <blockquote className="cm-quote">
            {quote.length > 240 ? quote.slice(0, 240) + '…' : quote}
            <button className="icon-btn sm" title="Comment on the whole file instead" onClick={() => setQuote('')}><Icon name="close" size={14} /></button>
          </blockquote>
        )}
        <textarea
          ref={box}
          rows={2}
          value={draft}
          placeholder={quote ? 'Comment on the selection… (Ctrl+Enter)' : 'Comment, or ask the agent for a change… (Ctrl+Enter)'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && add()}
        />
        {draft.trim() && (
          <div className="cm-actions">
            <button className="btn sm" onClick={() => (setDraft(''), setQuote(''))}>Cancel</button>
            <button className="btn sm primary" onClick={add}>Comment</button>
          </div>
        )}
      </div>

      <div className="cm-list" ref={listRef}>
        {!shown.length && <p className="muted small cm-empty">No comments yet. Select something and press Ctrl+Alt+M, or write above.</p>}
        {[...shown].reverse().map(t => (
          <ThreadCard key={t.id} t={t} path={props.path} fresh={fresh.current} onChange={load} />
        ))}
      </div>
    </aside>
  )
}

function Avatar({ name, by }: { name: string; by: 'user' | 'agent' }) {
  return (
    <span className={`cm-avatar ${by}`} style={by === 'agent' ? { background: agentColor(name) } : undefined} title={by === 'agent' ? `${name} (agent)` : name}>
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

function ThreadCard({ t, path, fresh, onChange }: { t: Thread; path: string; fresh: Set<string>; onChange(): void }) {
  const [reply, setReply] = useState('')
  const [open, setOpen] = useState(false)
  const send = async () => {
    if (!reply.trim()) return
    await api.commentReply(path, t.id, reply)
    setReply('')
    onChange()
  }
  const isFresh = (id: string) => {
    if (!fresh.has(id)) return false
    setTimeout(() => fresh.delete(id), 4000)
    return true
  }
  return (
    <div data-thread={t.id} style={t.by === 'agent' ? { ['--agent' as string]: agentColor(t.author), borderLeft: `3px solid ${agentColor(t.author)}` } : undefined} className={`cm-thread${t.resolved ? ' resolved' : ''}${isFresh(t.id) ? ' fresh' : ''}`} onClick={() => setOpen(true)}>
      <div className="cm-head">
        <Avatar name={t.author} by={t.by} />
        <div className="grow">
          <b>{t.author}</b>{t.by === 'agent' && <span className="cm-badge">agent</span>}
          <div className="muted small">{when(t.created)}{t.resolved ? ' · resolved' : ''}</div>
        </div>
        <button className="icon-btn sm" title={t.resolved ? 'Reopen' : 'Resolve'} onClick={e => (e.stopPropagation(), api.commentResolve(path, t.id, !t.resolved).then(onChange))}>
          <Icon name={t.resolved ? 'sync' : 'check'} size={18} />
        </button>
        {t.by === 'user' && (
          <button className="icon-btn sm" title="Delete thread" onClick={e => (e.stopPropagation(), api.commentDelete(path, t.id).then(onChange))}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {t.quote && <blockquote className="cm-quote">{t.quote.length > 240 ? t.quote.slice(0, 240) + '…' : t.quote}</blockquote>}
      <p className="cm-text">{t.text}</p>
      {t.replies.map(r => (
        <div key={r.id} style={r.by === 'agent' ? { ['--agent' as string]: agentColor(r.author) } : undefined} className={`cm-reply${isFresh(r.id) ? ' fresh' : ''}`}>
          <div className="cm-head">
            <Avatar name={r.author} by={r.by} />
            <div className="grow"><b>{r.author}</b>{r.by === 'agent' && <span className="cm-badge">agent</span>} <span className="muted small">{when(r.created)}</span></div>
          </div>
          <p className="cm-text">{r.text}</p>
        </div>
      ))}
      {(open || t.replies.length > 0) && !t.resolved && (
        <div className="cm-reply-box" onClick={e => e.stopPropagation()}>
          <textarea rows={1} placeholder="Reply… (Ctrl+Enter)" value={reply} onChange={e => setReply(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send()} />
          {reply.trim() && <button className="btn sm primary" onClick={send}>Reply</button>}
        </div>
      )}
    </div>
  )
}
