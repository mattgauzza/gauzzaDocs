import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-proj-home-'))
process.env.GAUZZADOCS_HOME = home

test('projects: add, rename, touch, find, missing folders stay listed, remove never deletes', async () => {
  const p = await import('../src/core/projects')
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-proj-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-proj-b-'))
  fs.writeFileSync(path.join(a, 'keep.md'), '# keep')

  const pa = p.addProject(a, 'Alpha')
  p.addProject(b)
  assert.equal(p.addProject(a).path, pa.path, 'adding twice keeps one entry')
  assert.equal(p.listProjects().length, 2)
  assert.throws(() => p.addProject(path.join(a, 'keep.md')), /not a folder/)

  p.renameProject(a, 'Alpha 2')
  assert.equal(p.findProject('alpha 2')?.path, pa.path)
  assert.equal(p.findProject(a.toUpperCase())?.name, 'Alpha 2', 'paths match case-insensitively on Windows')
  assert.equal(p.projectFor(path.join(a, 'keep.md'))?.name, 'Alpha 2')

  p.touchProject(b)
  assert.equal(p.listProjects()[0].path, path.resolve(b), 'most recently opened first')

  fs.rmSync(b, { recursive: true, force: true })
  const gone = p.listProjects().find(x => x.path === path.resolve(b))
  assert.equal(gone?.missing, true, 'a missing folder stays on the list, marked missing')

  p.removeProject('Alpha 2')
  assert.ok(fs.existsSync(path.join(a, 'keep.md')), 'removing a project never touches its files')
  assert.equal(p.listProjects().length, 1)
  fs.rmSync(a, { recursive: true, force: true })
})

test('folder listing and search: folders first, hidden and build folders skipped, results capped', async () => {
  const p = await import('../src/core/projects')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-proj-s-'))
  const mk = (rel: string, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  mk('Budget 2026.xlsx')
  mk('notes/budget-notes.md')
  mk('notes/deep/more budget.txt')
  mk('node_modules/budget-lib/index.js')
  mk('.git/budget')
  mk('dist/budget.js')
  mk('.hidden.md')
  for (let i = 0; i < 30; i++) mk(`many/budget ${i}.md`)

  const top = await p.listFolder(root)
  assert.deepEqual(top.slice(0, 4).map(e => e.dir), [true, true, true, true], 'folders first')
  assert.ok(!top.some(e => e.name.startsWith('.')), 'dot files are hidden')
  assert.ok(top.some(e => e.name === 'Budget 2026.xlsx' && e.size === 1))

  const r = await p.searchFolder(root, 'budget', { limit: 100 })
  const rel = r.results.map(e => path.relative(root, e.path).replace(/\\/g, '/'))
  assert.ok(rel.includes('Budget 2026.xlsx') && rel.includes('notes/budget-notes.md') && rel.includes('notes/deep/more budget.txt'))
  assert.ok(!rel.some(x => x.startsWith('node_modules') || x.startsWith('.git') || x.startsWith('dist')), 'ignored folders are skipped')

  const multi = await p.searchFolder(root, 'notes deep')
  assert.deepEqual(multi.results.map(e => e.name).sort(), ['deep', 'more budget.txt'], 'every word must match the relative path (folders count)')

  const capped = await p.searchFolder(root, 'budget', { limit: 10 })
  assert.equal(capped.results.length, 10)
  assert.equal(capped.truncated, true)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})
