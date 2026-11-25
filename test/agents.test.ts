import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('agent skills: install where each agent looks, update in place, remove only our files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-agents-'))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const a = await import('../src/core/agentSkills')
    fs.mkdirSync(path.join(home, '.claude'))
    // Someone else's skill beside ours must survive a remove.
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'other'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'other', 'SKILL.md'), 'not ours')

    const r = a.installSkills(['claude', 'codex', 'gemini'], '0.1.0')
    assert.deepEqual(r.map(x => [x.id, x.installed]), [['claude', true], ['codex', true], ['gemini', true]])
    const skill = fs.readFileSync(path.join(home, '.claude', 'skills', 'gauzzadocs', 'SKILL.md'), 'utf8')
    assert.match(skill, /^---\nname: gauzzadocs\ndescription: Use when/)
    assert.match(skill, /gdocs listen <file> --once/)
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'gauzzadocs', 'SKILL.md')))
    const ext = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'extensions', 'gauzzadocs', 'gemini-extension.json'), 'utf8'))
    assert.equal(ext.contextFileName, 'GEMINI.md')

    a.refreshInstalledSkills('0.2.0')
    assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'gauzzadocs', 'SKILL.md'), 'utf8'), /gauzzaDocs 0\.2\.0/)
    assert.ok(!fs.existsSync(path.join(home, '.copilot', 'skills', 'gauzzadocs')), 'refresh never installs new ones')

    a.removeSkills('all')
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'gauzzadocs')))
    assert.ok(!fs.existsSync(path.join(home, '.gemini', 'extensions', 'gauzzadocs', 'GEMINI.md')))
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8'), 'not ours')
  } finally {
    process.env.HOME = saved.HOME
    process.env.USERPROFILE = saved.USERPROFILE
    fs.rmSync(home, { recursive: true, force: true })
  }
})
