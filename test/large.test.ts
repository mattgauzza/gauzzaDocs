import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { findInFile, indexFile, readLines } from '../src/core/large'

test('large files: index, read windows across checkpoints and chunk edges, find', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-large-'))
  const file = path.join(dir, 'big.log')
  const N = 300_000
  const out = fs.createWriteStream(file)
  for (let i = 0; i < N; i++) out.write(`line ${i} ${'x'.repeat(i % 97)}${i % 50_000 === 7 ? ' NEEDLE' : ''}\r\n`)
  await new Promise(r => out.end(r))

  const t0 = performance.now()
  const idx = await indexFile(file)
  const ms = performance.now() - t0
  assert.equal(idx.lines, N + 1) // trailing newline leaves an empty last line
  assert.ok(idx.crlf)
  assert.ok(idx.checkpoints.length < N / 500, 'index stays sparse')

  for (const from of [0, 1, 1023, 1024, 1025, 123_456, N - 3]) {
    const got = await readLines(file, from, 3)
    got.forEach((l, k) => {
      if (from + k < N) assert.ok(l.startsWith(`line ${from + k} `), `line ${from + k}: ${l.slice(0, 20)}`)
    })
  }
  const many = await readLines(file, 50_000, 5000)
  assert.equal(many.length, 5000)
  assert.ok(many[4999].startsWith('line 54999 '))
  assert.ok(!many.some(l => l.endsWith('\r')))

  const r = await findInFile(file, 'needle', { ignoreCase: true })
  assert.deepEqual(r.matches.map(m => m.line), [8, 50_008, 100_008, 150_008, 200_008, 250_008])
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`indexed ${(idx.size / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`)
})
