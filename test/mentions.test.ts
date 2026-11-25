import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askingYou, mentionedNames, mentionsName } from '../src/shared/mentions'

const msg = (id: string, by: 'user' | 'agent', author: string, text: string) => ({ id, by, author, text })

test('mentions match whole @words, ignoring case', () => {
  assert.deepEqual(mentionedNames('@Codex can you check? cc @matt.'), ['codex', 'matt'])
  assert.equal(mentionsName('Over to you @MATT', 'Matt'), true)
  assert.equal(mentionsName('@Matthew said so', 'Matt'), false)
  assert.equal(mentionsName('Matt, does this read well?', 'Matt'), false) // no @, no glow
  assert.equal(mentionsName('@Matt', ''), false)
})

test('an agent question to the person is waiting until they answer in the thread', () => {
  const t = { ...msg('t1', 'user', 'Matt', 'Tighten the opener'), resolved: false, replies: [msg('r1', 'agent', 'Codex', 'Done. @Matt keep the second line?')] }
  assert.deepEqual(askingYou(t, 'Matt'), ['r1'])
  t.replies.push(msg('r2', 'user', 'Matt', 'Yes'))
  assert.deepEqual(askingYou(t, 'Matt'), [])
  t.replies.push(msg('r3', 'agent', 'Claude', '@Matt one more: drop the list?'))
  assert.deepEqual(askingYou(t, 'Matt'), ['r3'])
})

test('agent to agent talk, resolved threads and other people never wait on you', () => {
  const t = { ...msg('t1', 'agent', 'Codex', '@Claude does this read clearly?'), resolved: false, replies: [msg('r1', 'agent', 'Claude', '@Codex yes')] }
  assert.deepEqual(askingYou(t, 'Matt'), [])
  const asked = { ...msg('t2', 'agent', 'Codex', '@Matt which date?'), resolved: true, replies: [] }
  assert.deepEqual(askingYou(asked, 'Matt'), [])
  const sam = { ...msg('t3', 'agent', 'Codex', '@Sam which date?'), resolved: false, replies: [] }
  assert.deepEqual(askingYou(sam, 'Matt'), [])
  assert.deepEqual(askingYou(sam, 'Sam'), ['t3'])
})
