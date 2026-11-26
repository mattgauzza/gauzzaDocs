import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// A home of its own, set before the module reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-settings-home-'))
process.env.GAUZZADOCS_HOME = home
const { DEFAULT_EXCLUDE, DEFAULT_SETTINGS, getSettings, setSettings } = await import('../src/core/paths')

test('setSettings saves only what was set, so untouched settings follow the defaults', () => {
  const next = setSettings({ registry: 'https://example.com/m.json' })
  assert.equal(next.registry, 'https://example.com/m.json')
  assert.deepEqual(next.historyExclude, DEFAULT_EXCLUDE)
  const file = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(file), ['registry'])
  setSettings({ historyCapMB: 50 })
  const again = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
  assert.deepEqual(again, { registry: 'https://example.com/m.json', historyCapMB: 50 })
  assert.equal(getSettings().historyCapMB, 50)
  assert.equal(getSettings().autosave, DEFAULT_SETTINGS.autosave)
})
