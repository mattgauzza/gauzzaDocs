import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('tests run with an isolated app data folder, never the real one', () => {
  const home = process.env.GAUZZADOCS_HOME
  assert.ok(home, 'GAUZZADOCS_HOME must be set by scripts/test.mjs')
  assert.notEqual(path.resolve(home).toLowerCase(), path.join(os.homedir(), '.gauzzadocs').toLowerCase())
})
