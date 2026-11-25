import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { diffLines } from '../src/renderer/src/shell/diff'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-cm-home-'))
process.env.GAUZZADOCS_HOME = home

test('comment threads: add, reply, resolve, reopen on reply, rename, delete', async () => {
  const c = await import('../src/core/comments')
  const file = path.join(home, 'Plan.md')
  const t = c.add(file, { text: 'Make this friendlier', quote: 'We ship in Q4.', author: 'Matt', by: 'user' })
  assert.equal(c.list(file).length, 1)
  const r = c.reply(file, t.id, { text: 'Rewrote it, have a look', author: 'Claude', by: 'agent' })
  assert.equal(r.thread.replies[0].by, 'agent')
  c.resolve(file, t.id)
  assert.equal(c.list(file).length, 0)
  assert.equal(c.list(file, { all: true }).length, 1)
  c.reply(file, r.reply.id, { text: 'One more tweak', author: 'Matt', by: 'user' }) // replying by reply id works too
  assert.equal(c.list(file).length, 1, 'a reply reopens the thread')
  const moved = path.join(home, 'Plan v2.md')
  c.renameComments(file, moved)
  assert.equal(c.list(moved)[0].replies.length, 2)
  assert.equal(c.list(file).length, 0)
  c.remove(moved, t.id)
  assert.equal(c.list(moved, { all: true }).length, 0)
  assert.throws(() => c.add(moved, { text: '  ', author: 'x', by: 'user' }))
})

test('edit diffs: changed lines only, capped', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), { line: 2, removed: ['b'], added: ['B'] })
  assert.deepEqual(diffLines('a\nc', 'a\nb\nc'), { line: 2, removed: [], added: ['b'] })
  const big = diffLines('x', Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 10)
  assert.equal(big.added.length, 10)
  assert.equal(big.truncated, true)
  assert.equal(big.addedCount, 100)
})
