import { useEffect, useRef, useState } from 'react'
import { AGENT_COLORS } from '../../../shared/agentColors'
import { type AgentStatus, type Listener, api } from '../lib'
import { docId } from '../../../shared/docId'
import { Modal } from './Dialogs'
import { Icon } from './icons'

const COLORS: Record<AgentStatus['agent'], string> = AGENT_COLORS as Record<AgentStatus['agent'], string>
const LABELS: Record<AgentStatus['agent'], string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI' }
const DEFAULT_NAMES: Record<AgentStatus['agent'], string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' }
const STATE_TEXT: Record<AgentStatus['state'], string> = { idle: 'idle', working: 'working', waiting: 'waiting for a turn', paused: 'paused', error: 'last run failed' }
/** What the role means, said to the agent itself (the pasted prompt). */
const ROLE_FOR_AGENT: Record<AgentStatus['role'], string> = {
  writer: 'You are the writer: you write and own the content, and act on review comments.',
  reviewer: 'You are a reviewer: read what others write and leave comments that quote the exact words. Fix only small things yourself.',
  editor: 'You are the editor: improve clarity and flow with small edits.',
  custom: ''
}

/** The prompt to paste into an agent that's already open (Claude Code, Codex...) so it joins this document. */
export function joinPrompt(path: string, name: string, role: AgentStatus['role'], brief: string) {
  const id = docId(path)
  const who = name.trim() || 'Agent'
  return [
    `Work on this document with me in gauzzaDocs: "${path}" (${id}).`,
    `Use the gdocs command line tool and sign your work as ${who}: add --agent ${who} to every gdocs command.`,
    '',
    `1. Run \`gdocs instructions ${id}\` and follow what it says.`,
    `2. Read it with \`gdocs read ${id}\` and see open comments with \`gdocs comments ${id}\`.`,
    `3. ${[ROLE_FOR_AGENT[role], brief.trim()].filter(Boolean).join(' ') || 'Do what my comments ask.'}`,
    `4. Then loop: run \`gdocs listen ${id} --once --agent ${who}\` (it waits for my next comment or edit), do what it asks with small edits, answer in the comment thread with \`gdocs reply ${id} <id> "what you did" --resolve\`, and listen again. Keep going until I say stop.`,
    '',
    `After big changes, check how it looks with \`gdocs look ${id}\`. If I disconnect you, stop and don't reconnect.`
  ].join('\n')
}

const ROLE_HINT: Record<AgentStatus['role'], string> = {
  writer: 'Writes and owns the content, and acts on review comments.',
  reviewer: 'Reads what others write and leaves comments. Fixes only small things.',
  editor: 'Improves clarity and flow with small edits.',
  custom: 'Does what the brief says.'
}

/**
 * The agents subscribed to this document, as avatars in the file header. gauzzaDocs wakes them in the background when
 * someone comments, @mentions them, replies to them or (reviewers and editors) edits the doc.
 */
export function Participants({ path, say }: { path: string; say(msg: string): void }) {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [menu, setMenu] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [log, setLog] = useState<{ name: string; text: string } | null>(null)
  const [briefFor, setBriefFor] = useState<AgentStatus | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mine = (list: AgentStatus[]) => list.filter(a => a.path.toLowerCase() === path.toLowerCase())
    api.agentsOn(path).then(l => setAgents(mine(l)), () => {})
    return window.gd.on('agents-state', (l: AgentStatus[]) => setAgents(mine(l)))
  }, [path])
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(null)
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [menu])

  const act = (fn: () => Promise<unknown>) => () => (setMenu(null), fn().catch(e => say((e as Error).message)))

  return (
    <div className="participants" ref={ref}>
      {agents.map(a => (
        <div key={a.id} className="pt-wrap">
          <button
            className={`pt-avatar ${a.state}`}
            style={{ ['--pt' as string]: COLORS[a.agent] }}
            title={`${a.name}: ${LABELS[a.agent]}, ${a.role}, ${STATE_TEXT[a.state]}${a.pausedReason ? `\n${a.pausedReason}` : ''}${a.error ? `\n${a.error}` : ''}`}
            onClick={() => setMenu(menu === a.id ? null : a.id)}
          >
            {initials(a.name, a.agent)}
            {a.state !== 'idle' && <span className={`pt-dot ${a.state}`} />}
          </button>
          {menu === a.id && (
            <div className="menu pt-menu">
              <div className="pt-head">
                <b>{a.name}</b> <span className="muted small">{LABELS[a.agent]} · {a.role}{a.access === 'full' ? ' · Full access' : ''}</span>
                <div className="muted small">{a.pausedReason || a.error || STATE_TEXT[a.state]}</div>
              </div>
              <div className="menu-sep" />
              <button className="menu-item" onClick={act(() => api.agentWake(a.id))}><span className="menu-check" /><span className="menu-label">Take a turn now</span></button>
              <button className="menu-item" onClick={act(() => api.agentUpdate(a.id, { paused: a.state !== 'paused' }))}>
                <span className="menu-check" /><span className="menu-label">{a.state === 'paused' ? 'Resume' : 'Pause'}</span>
              </button>
              <button className="menu-item" onClick={act(async () => setLog({ name: a.name, text: await api.agentLog(a.id) }))}>
                <span className="menu-check" /><span className="menu-label">View last run</span>
              </button>
              <button className="menu-item" onClick={() => (setMenu(null), setBriefFor(a))}><span className="menu-check" /><span className="menu-label">Edit brief</span></button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={act(() => api.agentRemove(a.id))}><span className="menu-check" /><span className="menu-label">Remove from this document</span></button>
            </div>
          )}
        </div>
      ))}
      <button className="pt-add" title="Add an agent to this document" onClick={() => setAdding(true)}>
        <Icon name="plus" size={16} />
        {!agents.length && <span>Add agent</span>}
      </button>

      {adding && <AddAgent path={path} taken={agents.map(a => a.name.toLowerCase())} onClose={() => setAdding(false)} say={say} />}
      {log && (
        <Modal title={`${log.name}: last run`} onClose={() => setLog(null)} wide>
          <pre className="code pt-log">{log.text}</pre>
        </Modal>
      )}
      {briefFor && <EditBrief agent={briefFor} onClose={() => setBriefFor(null)} say={say} />}
    </div>
  )
}

function AddAgent({ path, taken, onClose, say }: { path: string; taken: string[]; onClose(): void; say(m: string): void }) {
  const [found, setFound] = useState<{ id: string; label: string; detected: boolean }[] | null>(null)
  const [agent, setAgent] = useState<AgentStatus['agent'] | ''>('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<AgentStatus['role']>('writer')
  const [brief, setBrief] = useState('')
  const [start, setStart] = useState(true)
  const [busy, setBusy] = useState(false)
  // 'run': gauzzaDocs runs the agent in the background. 'paste': a prompt for an agent you already have open.
  const [mode, setMode] = useState<'run' | 'paste'>('run')
  const [copied, setCopied] = useState(false)
  const [joined, setJoined] = useState(false)
  const prompt = joinPrompt(path, name, role, brief)
  const copy = () => navigator.clipboard.writeText(prompt).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))
  // Tell the person when the pasted agent shows up (it starts listening under the name in the prompt).
  useEffect(() => {
    if (mode !== 'paste') return
    setJoined(false)
    const want = name.trim().toLowerCase()
    const check = (ls: Listener[]) =>
      setJoined(ls.some(l => !l.virtual && l.agent.toLowerCase() === want && (!l.path || l.path.toLowerCase() === path.toLowerCase())))
    api.listeners().then(check, () => {})
    return window.gd.on('listeners', check)
  }, [mode, name, path])
  useEffect(() => {
    api.agentsDetect().then(list => {
      setFound(list)
      const first = list.find(a => a.detected)
      if (first) pick(first.id as AgentStatus['agent'])
    }, () => setFound([]))
  }, [])
  const pick = (id: AgentStatus['agent']) => {
    setAgent(id)
    let n = DEFAULT_NAMES[id]
    for (let i = 2; taken.includes(n.toLowerCase()); i++) n = `${DEFAULT_NAMES[id]}${i}`
    setName(n)
  }
  const add = async () => {
    if (!agent) return
    setBusy(true)
    try {
      await api.agentSubscribe(path, { agent, name, role, brief, start })
      onClose()
    } catch (e) {
      say((e as Error).message)
      setBusy(false)
    }
  }
  const detected = found?.filter(a => a.detected) || []
  return (
    <Modal title="Add an agent to this document" onClose={onClose} footer={mode === 'run' ? <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!agent || !name.trim() || busy} onClick={add}>{busy ? 'Adding...' : 'Add agent'}</button>
    </> : <>
      <button className="btn" onClick={onClose}>Done</button>
      <button className="btn primary" disabled={!name.trim()} onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
    </>}>
      <div className="seg pt-mode" role="tablist">
        <button role="tab" aria-selected={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={() => setMode('run')}>gauzzaDocs runs it</button>
        <button role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>Paste into my agent</button>
      </div>
      {mode === 'run' ? (
        <p className="muted small">
          gauzzaDocs runs the agent in the background with its own login when there is something for it to do: a comment, an
          @mention, a reply to it or, for reviewers and editors, new edits. Its edits and comments show up live under its name.
        </p>
      ) : (
        <p className="muted small">
          For an agent you already have open, like Claude Code or Codex in a terminal. Copy the prompt below and paste it in.
          It joins under the name you pick and hears your comments and edits as you make them.
        </p>
      )}
      {mode === 'run' && found && !detected.length && <p className="error small">No agents found on this PC. Install Claude Code, Codex, Gemini CLI or Copilot CLI first.</p>}
      <div className="form">
        <div className="pt-agents">
          {detected.map(a => (
            <button key={a.id} className={`pt-choice${agent === a.id ? ' on' : ''}`} onClick={() => pick(a.id as AgentStatus['agent'])}>
              <span className="pt-avatar" style={{ ['--pt' as string]: COLORS[a.id as AgentStatus['agent']] }}>{a.label.slice(0, 1)}</span>
              {a.label}
            </button>
          ))}
        </div>
        <label>Name (others @mention it)<input value={name} onChange={e => setName(e.target.value.replace(/\s+/g, ''))} /></label>
        <label>Role
          <select value={role} onChange={e => setRole(e.target.value as AgentStatus['role'])}>
            <option value="writer">Writer</option>
            <option value="reviewer">Reviewer</option>
            <option value="editor">Editor</option>
            <option value="custom">Custom (brief only)</option>
          </select>
        </label>
        <p className="muted small" style={{ margin: '-6px 0 0' }}>{ROLE_HINT[role]}</p>
        <label>Brief
          <textarea className="instructions" rows={mode === 'paste' ? 2 : 4} value={brief} onChange={e => setBrief(e.target.value)}
            placeholder={role === 'reviewer' ? 'e.g. Review for clarity and accuracy. Leave at most three comments per turn.' : 'e.g. Write a one page plan for moving our docs to gauzzaDocs. Use headings and a short summary at the top.'} />
        </label>
        {mode === 'run' && <label className="row"><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} /> Start now</label>}
        {mode === 'run' && agent === 'gemini' && <p className="muted small">Gemini CLI runs with Full access (it approves its own commands), because it has no narrow allow list.</p>}
        {mode === 'paste' && (
          <>
            <label>Prompt to paste
              <textarea className="instructions pt-prompt" rows={9} readOnly value={prompt} onFocus={e => e.currentTarget.select()} />
            </label>
            <p className={`small ${joined ? 'pt-joined' : 'muted'}`}>
              {joined ? `${name.trim()} joined and is listening.` : `Waiting for ${name.trim() || 'the agent'} to join...`}
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

function EditBrief({ agent, onClose, say }: { agent: AgentStatus; onClose(): void; say(m: string): void }) {
  const [brief, setBrief] = useState(agent.brief)
  const [role, setRole] = useState(agent.role)
  return (
    <Modal title={`${agent.name}'s brief`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => api.agentUpdate(agent.id, { brief, role }).then(onClose, e => say((e as Error).message))}>Save</button>
    </>}>
      <div className="form">
        <label>Role
          <select value={role} onChange={e => setRole(e.target.value as AgentStatus['role'])}>
            <option value="writer">Writer</option><option value="reviewer">Reviewer</option><option value="editor">Editor</option><option value="custom">Custom (brief only)</option>
          </select>
        </label>
        <label>Brief<textarea className="instructions" rows={6} value={brief} onChange={e => setBrief(e.target.value)} /></label>
      </div>
    </Modal>
  )
}

/** Two letters per agent so Claude and Codex (both "C") are told apart at a glance; a custom name uses its own letters. */
const ABBR: Record<string, string> = { claude: 'Cl', codex: 'Cx', gemini: 'Ge', copilot: 'Cp' }
function initials(name: string, agent: string) {
  const n = name.trim()
  if (!n || n.toLowerCase().startsWith(agent.toLowerCase().slice(0, 4))) return ABBR[agent] || n.slice(0, 2)
  const words = n.split(/\s+/)
  return (words.length > 1 ? words[0][0] + words[1][0] : n.slice(0, 2)).replace(/^./, c => c.toUpperCase())
}
