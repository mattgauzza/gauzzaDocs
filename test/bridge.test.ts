import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-br-home-'))
process.env.GAUZZADOCS_HOME = home

test('bridge: the person can disconnect a listening agent, and it stays off that file until allowed', async () => {
  const { startBridge } = await import('../src/main/server')
  const { readServer } = await import('../src/core/paths')
  const bridge = await startBridge(async () => null, () => {})
  try {
    const s = readServer()!
    const file = path.join(home, 'Plan.md')
    const url = `http://127.0.0.1:${s.port}/events?path=${encodeURIComponent(file)}&agent=Codex`
    const headers = { authorization: `Bearer ${s.token}` }

    const res = await fetch(url, { headers })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const listener = bridge.listeners().find(l => l.agent === 'Codex')
    assert.ok(listener, 'listed while connected')

    assert.equal(bridge.disconnect(listener.id), true)
    let text = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    assert.match(text, /"type":"disconnected"/)
    assert.equal(bridge.listeners().length, 0)
    assert.deepEqual(bridge.blocked().map(b => b.agent), ['Codex'])

    const again = await fetch(url, { headers })
    assert.equal(again.status, 403)
    assert.match(((await again.json()) as { error: string }).error, /disconnected Codex/)

    // Another agent, or the same one on another file, is not affected.
    const other = await fetch(url.replace('agent=Codex', 'agent=Claude'), { headers })
    assert.equal(other.status, 200)
    await other.body!.cancel()

    bridge.unblock('Codex', file)
    const back = await fetch(url, { headers })
    assert.equal(back.status, 200)
    await back.body!.cancel()
  } finally {
    bridge.close()
  }
})
