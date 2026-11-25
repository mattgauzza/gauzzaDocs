/** @mentions in comment text: one word of letters, digits, _ or -, the same rule agent names follow. */
const MENTION = /@([\p{L}\p{N}_-]+)/gu

export const mentionedNames = (text: unknown): string[] =>
  typeof text === 'string' ? [...text.matchAll(MENTION)].map(m => m[1].toLowerCase()) : []

export const mentionsName = (text: unknown, name: string): boolean => !!name && mentionedNames(text).includes(name.toLowerCase())

interface Message {
  id: string
  by: 'user' | 'agent'
  author: string
  text: string
}

/**
 * The agent messages in a thread that ask `name` something they haven't answered: messages after `name`'s own last
 * message in the thread that @mention them. Resolved threads ask nothing.
 */
export function askingYou(t: Message & { resolved?: boolean; replies: Message[] }, name: string): string[] {
  if (t.resolved || !name) return []
  const msgs = [t, ...t.replies]
  const me = name.toLowerCase()
  let mine = -1
  msgs.forEach((m, i) => m.by === 'user' && m.author.toLowerCase() === me && (mine = i))
  return msgs.slice(mine + 1).filter(m => m.by === 'agent' && mentionsName(m.text, name)).map(m => m.id)
}
