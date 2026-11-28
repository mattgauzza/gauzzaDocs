import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CommentAnchor } from '../shared/types'
import { HOME, norm, samePath } from './paths'

/**
 * Comment threads on files, shared by the person (in the window) and agents (through gdocs).
 * Kept in ~/.gauzzadocs/comments.json, keyed by file path; threads follow renames made in the app.
 * While the app runs, main is the only writer (the CLI goes through the bridge), so writes never race.
 */
export interface Reply {
  id: string
  author: string
  by: 'user' | 'agent'
  text: string
  created: number
}
export interface Thread extends Reply {
  quote?: string // the text the comment is about, when something was selected
  anchor?: CommentAnchor // where, when the editor knows (a design's artboard and layer, say)
  resolved?: boolean
  replies: Reply[]
}

const FILE = path.join(HOME, 'comments.json')
type Store = Record<string, Thread[]>

const read = (): Store => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}
const write = (s: Store) => {
  fs.mkdirSync(HOME, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, FILE)
}
const keyOf = (s: Store, file: string) => Object.keys(s).find(k => samePath(k, file)) || norm(file)
const newId = () => crypto.randomBytes(4).toString('hex')

export function list(file: string, opts: { all?: boolean } = {}): Thread[] {
  const s = read()
  return (s[keyOf(s, file)] || []).filter(t => opts.all || !t.resolved)
}

export function add(file: string, c: { text: string; author: string; by: 'user' | 'agent'; quote?: string; anchor?: Thread['anchor'] }): Thread {
  if (!c.text?.trim()) throw new Error('A comment needs text')
  const s = read()
  const k = keyOf(s, file)
  const t: Thread = { id: newId(), author: c.author, by: c.by, text: c.text.trim(), created: Date.now(), replies: [] }
  if (c.quote?.trim()) t.quote = c.quote.trim().slice(0, 2000)
  if (c.anchor) t.anchor = c.anchor
  s[k] = [...(s[k] || []), t]
  write(s)
  return t
}

function find(s: Store, file: string, id: string) {
  const t = (s[keyOf(s, file)] || []).find(x => x.id === id || x.replies.some(r => r.id === id))
  if (!t) throw new Error(`No comment ${id} on ${path.basename(file)}`)
  return t
}

export function reply(file: string, id: string, r: { text: string; author: string; by: 'user' | 'agent' }): { thread: Thread; reply: Reply } {
  if (!r.text?.trim()) throw new Error('A reply needs text')
  const s = read()
  const t = find(s, file, id)
  const rep: Reply = { id: newId(), author: r.author, by: r.by, text: r.text.trim(), created: Date.now() }
  t.replies.push(rep)
  t.resolved = false // a reply reopens a resolved thread, like Docs
  write(s)
  return { thread: t, reply: rep }
}

export function resolve(file: string, id: string, resolved = true): Thread {
  const s = read()
  const t = find(s, file, id)
  t.resolved = resolved
  write(s)
  return t
}

export function remove(file: string, id: string) {
  const s = read()
  const k = keyOf(s, file)
  s[k] = (s[k] || []).filter(t => t.id !== id)
  write(s)
}

export function renameComments(from: string, to: string) {
  const s = read()
  const k = Object.keys(s).find(x => samePath(x, from))
  if (!k) return
  s[norm(to)] = s[k]
  delete s[k]
  write(s)
}
