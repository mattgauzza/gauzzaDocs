import { useEffect, useRef, useState } from 'react'
import { agentColor } from '../../../shared/agentColors'
import { type Listener, api } from '../lib'
import { Icon } from './icons'

/**
 * Who is connected to this file: agents running `gdocs listen` (live connections) and agents subscribed to it (woken
 * by gauzzaDocs). Live ones can be disconnected: the agent is told the person cut it off, and that name can't listen
 * to this file again until the person allows it (or the app restarts). Subscribed ones can be paused or removed.
 */
type Sub = Awaited<ReturnType<typeof api.agentsOn>>[number]

const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}
const sameFile = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function Connections({ path, listeners, onClose }: { path: string; listeners: Listener[]; onClose(): void }) {
  const [subs, setSubs] = useState<Sub[]>([])
  const [blocked, setBlocked] = useState<{ agent: string; path?: string; since: number }[]>([])
  const [busy, setBusy] = useState<string>('')
  const ref = useRef<HTMLDivElement>(null)

  const refresh = () => {
    api.agentsOn(path).then(setSubs, () => setSubs([]))
    api.listenersBlocked().then(b => setBlocked(b.filter(x => !x.path || sameFile(x.path, path))), () => {})
  }
  useEffect(refresh, [path, listeners])
  useEffect(() => {
    // Clicks on the chip or Manage link toggle the list themselves, so they don't count as clicking outside.
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('.listening, .cm-manage')) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => (window.removeEventListener('mousedown', down), window.removeEventListener('keydown', key))
  }, [])

  const live = listeners.filter(l => !l.virtual && (!l.path || sameFile(l.path, path)))
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy('')
      refresh()
    }
  }

  return (
    <div className="conn" ref={ref} role="dialog" aria-label="Connected agents">
      <header>
        <b>Connected agents</b>
        <button className="icon-btn sm" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
      </header>

      {!live.length && !subs.length && !blocked.length && <p className="muted small conn-empty">No agents are connected to this file.</p>}

      {live.map(l => (
        <div key={`l${l.id}`} className="conn-row">
          <span className="cm-avatar agent" style={{ background: agentColor(l.agent) }}>{l.agent.slice(0, 1).toUpperCase()}</span>
          <div className="grow">
            <b>{l.agent}</b>
            {l.agent === 'Agent' && <span className="muted small"> (no name set)</span>}
            <div className="muted small">
              Listening with gdocs listen to {l.path ? 'this file' : 'every file'} for {ago(l.since)}
              {l.agent === 'Agent' && <>. Set GDOCS_AGENT=Claude to give it a name.</>}
            </div>
          </div>
          <button className="btn sm" disabled={busy === `l${l.id}`} onClick={() => act(`l${l.id}`, () => api.listenerDisconnect(l.id))}>
            {busy === `l${l.id}` ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
      ))}

      {subs.map(s => (
        <div key={`s${s.id}`} className="conn-row">
          <span className="cm-avatar agent" style={{ background: agentColor(s.name, s.agent) }}>{s.name.slice(0, 1).toUpperCase()}</span>
          <div className="grow">
            <b>{s.name}</b> <span className="muted small">{s.role}</span>
            <div className="muted small">Subscribed: gauzzaDocs wakes it when there's something for it{s.state === 'paused' ? ' (paused)' : ''}</div>
          </div>
          <button className="btn sm" disabled={busy === `p${s.id}`} onClick={() => act(`p${s.id}`, () => api.agentUpdate(s.id, { paused: s.state !== 'paused' }))}>
            {s.state === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button className="btn sm" disabled={busy === `r${s.id}`} onClick={() => act(`r${s.id}`, () => api.agentRemove(s.id))}>Remove</button>
        </div>
      ))}

      {blocked.length > 0 && (
        <>
          <div className="conn-sep">Disconnected</div>
          {blocked.map(b => (
            <div key={`b${b.agent}${b.path}`} className="conn-row dim">
              <span className="cm-avatar agent" style={{ background: agentColor(b.agent) }}>{b.agent.slice(0, 1).toUpperCase()}</span>
              <div className="grow">
                <b>{b.agent}</b>
                <div className="muted small">Can't listen to {b.path ? 'this file' : 'any file'} again until you allow it or restart the app</div>
              </div>
              <button className="btn sm" onClick={() => act(`u${b.agent}`, () => api.listenerUnblock(b.agent, b.path) as Promise<unknown>)}>Allow again</button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
