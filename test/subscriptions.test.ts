import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Set the data folder BEFORE anything that reads it is loaded: every app module below is imported dynamically,
// because a static import would fix HOME to the real ~/.gauzzadocs at load time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-subs-home-'))
process.env.GAUZZADOCS_HOME = home

const doc = path.join(home, 'Plan.md')

test('subscriptions: store, names, update, rename, remove', async () => {
  const s = await import('../src/core/subscriptions')
  const codex = s.subscribe(doc, { agent: 'codex', role: 'writer', brief: 'Write it' })
  const claude = s.subscribe(doc, { agent: 'claude', role: 'reviewer' })
  assert.equal(codex.name, 'Codex')
  assert.throws(() => s.subscribe(doc, { agent: 'claude' }), /already on this document/)
  const claude2 = s.subscribe(doc, { agent: 'claude', name: 'Claude 2!' })
  assert.equal(claude2.name, 'Claude2', 'names are one word so they can be @mentioned')
  assert.throws(() => s.subscribe(doc, { agent: 'nope' as never }), /Unknown agent/)
  assert.equal(s.listSubscriptions(doc).length, 3)
  assert.equal(s.findSubscription(doc, 'claude')?.id, claude.id)
  s.updateSubscription(claude.id, { paused: true, pausedReason: 'x' })
  assert.equal(s.findSubscription(doc, 'Claude')?.paused, true)
  s.updateSubscription(claude.id, { paused: false })
  assert.equal(s.findSubscription(doc, 'Claude')?.pausedReason, undefined)
  const moved = path.join(home, 'Plan v2.md')
  s.renameSubscriptions(doc, moved)
  assert.equal(s.listSubscriptions(moved).length, 3)
  s.unsubscribe(claude2.id)
  assert.equal(s.listSubscriptions(moved).length, 2)
  s.renameSubscriptions(moved, doc)
})

test('who wakes for which event', async () => {
  const s = await import('../src/core/subscriptions')
  const subs = s.listSubscriptions(doc)
  const id = (n: string) => subs.find(x => x.name === n)!.id
  const thread = (author: string, by: 'user' | 'agent', text: string) => ({ id: 't1', author, by, text, replies: [] })

  // The person's comment with no mention goes to one agent: the writer.
  assert.deepEqual(s.routeEvent(subs, { type: 'comment', by: 'user', author: 'Matt', path: doc, thread: thread('Matt', 'user', 'Tighten the intro') }), [{ id: id('Codex'), settle: false }])
  // A mention goes to that agent only.
  assert.deepEqual(s.routeEvent(subs, { type: 'comment', by: 'user', author: 'Matt', thread: thread('Matt', 'user', '@claude check the numbers') }), [{ id: id('Claude'), settle: false }])
  // Mentioning someone not on the doc wakes nobody.
  assert.deepEqual(s.routeEvent(subs, { type: 'comment', by: 'user', author: 'Matt', thread: thread('Matt', 'user', '@gemini hi') }), [])
  // A reviewer's note goes to the writer, never back to the reviewer itself.
  assert.deepEqual(s.routeEvent(subs, { type: 'comment', by: 'agent', author: 'Claude', thread: thread('Claude', 'agent', 'This claim needs a source') }), [{ id: id('Codex'), settle: false }])
  // A reply in Claude's thread wakes Claude.
  assert.deepEqual(
    s.routeEvent(subs, { type: 'reply', by: 'agent', author: 'Codex', thread: thread('Claude', 'agent', 'needs a source'), reply: { text: 'Added one' } }),
    [{ id: id('Claude'), settle: false }]
  )
  // Edits wake reviewers and editors once they settle, never their author.
  assert.deepEqual(s.routeEvent(subs, { type: 'edit', by: 'agent', author: 'Codex', line: 3, added: ['x'], removed: [] }), [{ id: id('Claude'), settle: true }])
  assert.deepEqual(s.routeEvent(subs, { type: 'edit', by: 'agent', author: 'Claude', line: 3 }), [])
  // Housekeeping events and paused agents never wake anyone.
  assert.deepEqual(s.routeEvent(subs, { type: 'saved' }), [])
  const paused = subs.map(x => (x.name === 'Codex' ? { ...x, paused: true } : x))
  assert.deepEqual(s.routeEvent(paused, { type: 'comment', by: 'user', author: 'Matt', thread: thread('Matt', 'user', 'hi') }), [{ id: id('Claude'), settle: false }])
  assert.equal(s.isForAgent({ type: 'reply', by: 'user', thread: thread('Claude', 'agent', 'x'), reply: { text: 'ok' } }, 'claude'), true)
})

test('rate limit and ping-pong protection', async () => {
  const s = await import('../src/core/subscriptions')
  const now = 1_000_000_000
  const starts = [0, 1, 2, 3, 4, 5].map(m => now - (9 - m) * 60_000)
  assert.equal(s.rateCheck(starts.slice(0, 5), now).ok, true)
  const r = s.rateCheck(starts, now)
  assert.equal(r.ok, false)
  assert.equal(r.retryAt, starts[0] + 10 * 60_000)
  let chain = 0
  let paused = false
  for (let i = 0; i < 8; i++) ({ chain, pause: paused } = s.chainStep(chain, false))
  assert.equal(paused, true, 'eight agent-only wake-ups in a row pause the doc')
  assert.deepEqual(s.chainStep(7, true), { chain: 0, pause: false }, 'anything from the person resets it')
})

test('prompt: identity, role, brief, team, activity and the gdocs rules', async () => {
  const s = await import('../src/core/subscriptions')
  const subs = s.listSubscriptions(doc)
  const claude = subs.find(x => x.name === 'Claude')!
  const p = s.buildPrompt(claude, subs, [
    { type: 'edit', by: 'agent', author: 'Codex', line: 2, removed: [], added: ['Local-first means your files stay yours.'] },
    { type: 'comment', by: 'user', author: 'Matt', thread: { id: 'ab12', text: 'Make it punchier', quote: 'Local-first' } }
  ], false)
  assert.match(p, /^You are Claude, an AI agent working with a person and other agents/)
  assert.match(p, /You are the reviewer/)
  assert.match(p, /Others working on it: Codex \(writer\)/)
  assert.match(p, /Codex \(agent\) edited near line 2:\n {4}\+ Local-first means your files stay yours\./)
  assert.match(p, /Matt \(the person\) commented \[thread ab12\] on "Local-first": Make it punchier/)
  assert.match(p, /gdocs instructions ".*Plan\.md"/)
  assert.match(p, /If nothing needs doing, stop without changing anything/)
  assert.match(s.buildPrompt(subs[0], subs, [], true), /This is your first turn/)
})

test('listen: which threads an agent still owes an answer', async () => {
  const { waitingFor } = await import('../src/cli/comments')
  const t = (by: 'user' | 'agent', author: string, text: string, replies: { by: 'user' | 'agent'; author: string; text: string }[] = []) =>
    ({ id: 'x', by, author, text, created: 0, replies: replies.map((r, i) => ({ ...r, id: String(i), created: 0 })) })
  assert.equal(waitingFor(t('user', 'Matt', 'fix this'), 'Claude'), true)
  assert.equal(waitingFor(t('user', 'Matt', 'fix this', [{ by: 'agent', author: 'Claude', text: 'done' }]), 'Claude'), false)
  assert.equal(waitingFor(t('agent', 'Codex', '@Claude can you check?'), 'Claude'), true)
  assert.equal(waitingFor(t('agent', 'Codex', 'note to self'), 'Claude'), false)
  assert.equal(waitingFor(t('agent', 'Claude', 'needs a source', [{ by: 'agent', author: 'Codex', text: 'added' }]), 'Claude'), true)
})
