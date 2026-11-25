import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HOME, norm, samePath } from './paths'

/**
 * Agents subscribed to a document. The app (src/main/agents.ts) wakes a subscribed agent's own CLI in the background
 * when there is something for it to do, so several agents (and the person) can work on one doc together.
 * Everything here is pure or plain file IO so it can be tested without the app: the store, who wakes for which event,
 * rate limits, loop protection and the prompt each run gets.
 */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'copilot'
export type Role = 'writer' | 'reviewer' | 'editor' | 'custom'

export interface Subscription {
  id: string
  path: string
  agent: AgentKind
  name: string // display name and GDOCS_AGENT, e.g. "Claude"
  role: Role
  brief: string
  paused: boolean
  pausedReason?: string
  created: number
}

/** An event from the bridge (see src/main/server.ts): comment, reply, resolved, deleted, edit, ... */
export interface DocEvent {
  type: string
  path?: string
  by?: 'user' | 'agent'
  author?: string
  at?: number
  [k: string]: unknown
}

export const AGENT_LABELS: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI' }
export const DEFAULT_NAMES: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' }

// ---------- store ----------

const FILE = () => path.join(HOME, 'subscriptions.json')

export function listSubscriptions(file?: string): Subscription[] {
  let all: Subscription[] = []
  try {
    all = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
  } catch { /* none yet */ }
  return file ? all.filter(s => samePath(s.path, file)) : all
}

function save(all: Subscription[]) {
  fs.mkdirSync(HOME, { recursive: true })
  const tmp = `${FILE()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
  fs.renameSync(tmp, FILE())
}

/** Names are what agents @mention, so keep them one word. */
export const cleanName = (s: string) => s.trim().replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 24)

export function subscribe(file: string, s: { agent: AgentKind; name?: string; role?: Role; brief?: string }): Subscription {
  if (!AGENT_LABELS[s.agent]) throw new Error(`Unknown agent "${s.agent}". Use claude, codex, gemini or copilot.`)
  const all = listSubscriptions()
  const name = cleanName(s.name || DEFAULT_NAMES[s.agent])
  if (!name) throw new Error('The agent needs a name (one word)')
  if (all.some(x => samePath(x.path, file) && x.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`${name} is already on this document. Pick another name with --name.`)
  const sub: Subscription = {
    id: crypto.randomBytes(4).toString('hex'),
    path: norm(file),
    agent: s.agent,
    name,
    role: s.role || 'custom',
    brief: (s.brief || '').trim(),
    paused: false,
    created: Date.now()
  }
  save([...all, sub])
  return sub
}

export function findSubscription(file: string, nameOrId: string): Subscription | undefined {
  const k = nameOrId.toLowerCase()
  return listSubscriptions(file).find(s => s.id === nameOrId || s.name.toLowerCase() === k)
}

export function updateSubscription(id: string, patch: Partial<Omit<Subscription, 'id' | 'path' | 'created'>>): Subscription {
  const all = listSubscriptions()
  const i = all.findIndex(s => s.id === id)
  if (i < 0) throw new Error('No such agent on this document')
  all[i] = { ...all[i], ...patch, ...(patch.name ? { name: cleanName(patch.name) } : {}) }
  if (patch.paused === false) delete all[i].pausedReason
  save(all)
  return all[i]
}

export function unsubscribe(id: string) {
  save(listSubscriptions().filter(s => s.id !== id))
}

export function renameSubscriptions(from: string, to: string) {
  const all = listSubscriptions()
  if (!all.some(s => samePath(s.path, from))) return
  save(all.map(s => (samePath(s.path, from) ? { ...s, path: norm(to) } : s)))
}

// ---------- who wakes for an event ----------

const mentions = (text: unknown): string[] => (typeof text === 'string' ? [...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map(m => m[1].toLowerCase()) : [])

/** Text of a comment or reply event, and who started its thread. */
function threadInfo(ev: DocEvent) {
  const t = ev.thread as { by?: string; author?: string; text?: string } | undefined
  const r = ev.reply as { text?: string } | undefined
  return { text: r?.text ?? t?.text ?? '', starter: t?.author, starterBy: t?.by }
}

/** Does this event concern a particular agent directly (mention, reply in its thread)? Used for listen's forYou too. */
export function isForAgent(ev: DocEvent, name: string): boolean {
  const n = name.toLowerCase()
  if (ev.type !== 'comment' && ev.type !== 'reply') return false
  const { text, starter, starterBy } = threadInfo(ev)
  if (mentions(text).includes(n)) return true
  return ev.type === 'reply' && starterBy === 'agent' && starter?.toLowerCase() === n
}

export type Wake = { id: string; settle: boolean } // settle: wait for a quiet spell (edit bursts)

const ROLE_ORDER: Role[] = ['writer', 'editor', 'custom', 'reviewer']

/**
 * Which subscriptions an event wakes. Rules:
 *  - an agent never wakes for its own actions, and paused agents never wake
 *  - anyone @mentioned, or the agent whose thread got a reply, wakes
 *  - a person's comment that mentions nobody goes to one agent: the writer (or editor, custom, reviewer, in that order)
 *  - an agent's new comment that mentions nobody goes to the writers and editors (review notes are for them)
 *  - edits (the person's or another agent's) wake reviewers and editors once the edits settle
 */
export function routeEvent(subs: Subscription[], ev: DocEvent): Wake[] {
  if (!ev.by) return []
  const live = subs.filter(s => !s.paused && !(ev.by === 'agent' && ev.author?.toLowerCase() === s.name.toLowerCase()))
  if (!live.length) return []
  if (ev.type === 'edit') return live.filter(s => s.role === 'reviewer' || s.role === 'editor').map(s => ({ id: s.id, settle: true }))
  if (ev.type !== 'comment' && ev.type !== 'reply') return []
  const direct = live.filter(s => isForAgent(ev, s.name))
  if (direct.length) return direct.map(s => ({ id: s.id, settle: false }))
  if (mentions(threadInfo(ev).text).length) return [] // addressed to someone not on this doc (or the person)
  if (ev.type === 'reply') {
    // A reply in a thread an agent started already woke that agent above; replies elsewhere go to the writer.
    if (ev.by === 'agent') return []
  }
  if (ev.by === 'user') {
    const pick = ROLE_ORDER.map(r => live.find(s => s.role === r)).find(Boolean)
    return pick ? [{ id: pick.id, settle: false }] : []
  }
  return live.filter(s => s.role === 'writer' || s.role === 'editor').map(s => ({ id: s.id, settle: false }))
}

// ---------- loop protection ----------

export const RATE = { max: 6, windowMs: 10 * 60_000 }

/** At most RATE.max runs per agent in any RATE.windowMs; otherwise when the next one may start. */
export function rateCheck(runStarts: number[], now: number, rate = RATE): { ok: boolean; retryAt?: number } {
  const recent = runStarts.filter(t => now - t < rate.windowMs).sort((a, b) => a - b)
  if (recent.length < rate.max) return { ok: true }
  return { ok: false, retryAt: recent[recent.length - rate.max] + rate.windowMs }
}

export const PING_PONG_LIMIT = 8

/** Counts agent runs in a row that nothing from the person prompted. At the limit, every agent on the doc pauses. */
export function chainStep(chain: number, personInvolved: boolean, limit = PING_PONG_LIMIT): { chain: number; pause: boolean } {
  const next = personInvolved ? 0 : chain + 1
  return { chain: next, pause: next >= limit }
}

// ---------- the prompt each run gets ----------

const ROLE_TEXT: Record<Role, string> = {
  writer: 'You are the writer. You own the content: draft it, improve it, and act on review comments by editing and replying.',
  reviewer:
    'You are the reviewer. Read what others write and leave specific comments that quote the text they are about. Fix only small things yourself, like typos. Do not rewrite their sections.',
  editor: 'You are the editor. Improve clarity, structure and flow with small edits. Keep the author\'s meaning and voice.',
  custom: 'Follow the brief below.'
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '...' : s)

/** One line (or a few) per event, for the prompt. */
export function describeEvent(ev: DocEvent): string {
  const who = ev.by === 'user' ? `${ev.author || 'The person'} (the person)` : `${ev.author || 'An agent'} (agent)`
  const t = ev.thread as { id?: string; quote?: string; text?: string } | undefined
  const r = ev.reply as { text?: string } | undefined
  switch (ev.type) {
    case 'comment':
      return `- ${who} commented [thread ${t?.id}]${t?.quote ? ` on "${clip(t.quote, 120)}"` : ''}: ${clip(t?.text || '', 600)}`
    case 'reply':
      return `- ${who} replied in thread ${t?.id}${t?.quote ? ` (about "${clip(t.quote, 80)}")` : ''}: ${clip(r?.text || '', 600)}`
    case 'resolved':
      return `- ${who} ${ev.resolved ? 'resolved' : 'reopened'} thread ${t?.id}`
    case 'edit': {
      if (ev.summary) return `- ${who} edited the file: ${ev.summary}`
      const rem = ((ev.removed as string[]) || []).map(l => `    - ${clip(l, 200)}`)
      const add = ((ev.added as string[]) || []).map(l => `    + ${clip(l, 200)}`)
      return [`- ${who} edited near line ${ev.line}:`, ...rem.slice(0, 12), ...add.slice(0, 12), ...(ev.truncated || rem.length > 12 || add.length > 12 ? ['    (more changed; read the file)'] : [])].join('\n')
    }
    case 'wake':
      return `- ${ev.note ? `Note from the person: ${ev.note}` : 'The person asked you to take a turn.'}`
    default:
      return `- ${ev.type}`
  }
}

export function buildPrompt(sub: Subscription, others: Subscription[], events: DocEvent[], first: boolean): string {
  const file = sub.path
  const q = `"${file}"`
  const team = others.filter(o => o.id !== sub.id)
  const activity = first && !events.length ? 'This is your first turn. Nothing has happened yet.' : events.length ? events.map(describeEvent).join('\n') : 'Nothing new.'
  return `You are ${sub.name}, an AI agent working with a person${team.length ? ' and other agents' : ''} on this document:
${file}

${ROLE_TEXT[sub.role]}
${sub.brief ? `\nBrief from the person:\n${sub.brief}\n` : ''}
${team.length ? `Others working on it: ${team.map(o => `${o.name} (${o.role})`).join(', ')}. Mention one with @Name in a comment to ask them something.\n` : ''}
What happened since your last turn:
${activity}

How to work:
1. Run: gdocs instructions ${q}  and follow what it says (it may ask you to look up the person's writing voice).
2. Read the document: gdocs read ${q}  and open threads: gdocs comments ${q}
3. Change the document only with gdocs, in small steps so others can follow:
   gdocs replace ${q} "old text" "new text"
   gdocs doc insert ${q} --after "Heading or text" --md "New paragraph"
   gdocs append ${q} "## Heading" (Markdown; use - to read longer content from stdin)
   Write the first draft with gdocs write ${q} - --format md only if the document is empty.
4. Answer comments in their thread: gdocs reply ${q} <thread id> "what you did" --resolve
   Start a thread: gdocs comment ${q} "your note" --quote "the exact text it is about"
5. Do not rewrite text another participant wrote unless they or the person asked. Comment instead.
6. If nothing needs doing, stop without changing anything. Keep your final message to one short line.
Your edits and comments are signed as ${sub.name} automatically.`
}
