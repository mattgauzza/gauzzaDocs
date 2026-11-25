import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-man-home-'))
process.env.GAUZZADOCS_HOME = home
process.env.GAUZZADOCS_LARGE_MB = '1'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-man-work-'))

const h = await import('../src/core/history/index')
const { guardedWrite, listVersions, flushHistory, writeAtomic, objectPath, historyKey, indexPath, canonicalPath, showVersion, nameVersion, forgetHistory, moveHistory, restoreVersion } = h
const { getDocInstructions, withInstructions } = await import('../src/core/instructions')

type Author = { name: string; by: 'person' | 'agent' | 'outside' }
const agent = (name: string) => ({ authors: [{ name, by: 'agent' as const }] })
const matt = { authors: [{ name: 'Matt', by: 'person' as const }] }
const save = async (f: string, bytes: Uint8Array, ctx: { authors: Author[] } = agent('Claude')) => {
  await guardedWrite(f, ctx, async () => (await writeAtomic(f, bytes), bytes))
  await flushHistory()
}
let seq = 0
const fresh = (name = 'doc.md') => {
  const p = path.join(work, `${++seq}`, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}
const rnd = (n = 200) => crypto.randomBytes(n)
const backdate = (hash: string) => {
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  fs.utimesSync(objectPath(hash), old, old)
}
const logOf =(f: string) => indexPath(historyKey(f)).replace(/\.json$/, '.log.jsonl')

test('restore writes the stored bytes exactly and can be undone', async () => {
  const f = fresh('plan.docx')
  const v1 = rnd()
  const v2 = rnd()
  fs.writeFileSync(f, v1)
  await save(f, v2)
  assert.equal(listVersions(f).length, 2)
  const r = await restoreVersion(f, 1, matt)
  assert.deepEqual(fs.readFileSync(f), v1)
  assert.equal(r.restoredFrom, 1)
  const list = listVersions(f)
  assert.deepEqual(list.map(x => x.n), [1, 2, 3])
  assert.equal(list[1].beforeRestore, true)
  assert.equal(list[2].restoredFrom, 1)
  assert.equal(list[2].authors[0].name, 'Matt')
  // undo: restoring the beforeRestore version brings v2 back
  await restoreVersion(f, 2, matt)
  assert.deepEqual(fs.readFileSync(f), v2)
  assert.equal(listVersions(f).at(-1)!.restoredFrom, 2)
  assert.deepEqual(Buffer.from(await showVersion(f, 1)), v1)
})

test('restore of the latest bytes records nothing new and still succeeds', async () => {
  const f = fresh('same.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd())
  const before = listVersions(f)
  const r = await restoreVersion(f, 2, matt)
  assert.equal(r.n, 2)
  assert.deepEqual(listVersions(f), before)
})

test('restore records what is on disk when it differs from the latest version, as outside', async () => {
  const f = fresh('o.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd())
  const outside = rnd()
  fs.writeFileSync(f, outside)
  await restoreVersion(f, 1, matt)
  const list = listVersions(f)
  assert.equal(list.length, 4)
  assert.equal(list[2].authors[0].by, 'outside')
  assert.equal(list[2].beforeRestore, true)
  assert.equal(list[3].restoredFrom, 1)
})

test('restore keeps unsaved editor content as a version first, without writing it', async () => {
  const f = fresh('u.docx')
  const v1 = rnd()
  fs.writeFileSync(f, v1)
  await save(f, rnd())
  const onDisk = fs.readFileSync(f)
  const unsaved = rnd()
  await restoreVersion(f, 1, { authors: [{ name: 'Matt', by: 'person' }], unsaved })
  const list = listVersions(f)
  assert.deepEqual(list.map(x => x.n), [1, 2, 3, 4])
  assert.equal(crypto.createHash('sha256').update(unsaved).digest('hex'), list[2].hash)
  assert.equal(list[2].beforeRestore, true)
  assert.equal(list[2].authors[0].name, 'Matt')
  assert.deepEqual(fs.readFileSync(f), v1)
  assert.notDeepEqual(onDisk, unsaved)
})

for (const ext of ['md', 'html']) {
  test(`restore keeps the current standing instructions in .${ext}`, async () => {
    const f = fresh(`i.${ext}`)
    fs.writeFileSync(f, withInstructions(f, 'old body\n', 'old rules'))
    await save(f, Buffer.from(withInstructions(f, 'new body\n', 'current rules')))
    await restoreVersion(f, 1, matt)
    const text = fs.readFileSync(f, 'utf8')
    assert.equal(getDocInstructions(f), 'current rules')
    assert.ok(text.includes('old body'))
    assert.ok(!text.includes('old rules'))
  })
}

test('restore recreates a file that was deleted from disk', async () => {
  const f = fresh('gone.docx')
  const v1 = rnd()
  fs.writeFileSync(f, v1)
  await save(f, rnd())
  fs.rmSync(f)
  await restoreVersion(f, 2, matt)
  assert.ok(fs.existsSync(f))
  const list = listVersions(f)
  assert.equal(list.length, 2) // restored bytes equal v2: nothing new
  fs.rmSync(f)
  await restoreVersion(f, 1, matt)
  assert.deepEqual(fs.readFileSync(f), v1)
})

test('restore over a file grown past 32 MB needs discardCurrent', async () => {
  const f = fresh('big.docx')
  const v1 = rnd()
  fs.writeFileSync(f, v1)
  await save(f, rnd())
  const big = Buffer.alloc(1024 * 1024 + 10, 1)
  fs.writeFileSync(f, big)
  await assert.rejects(restoreVersion(f, 1, matt), (e: Error) => e.message === `${f} is over 32 MB, so its current content can't be kept. Restore anyway with discardCurrent.`)
  assert.deepEqual(fs.readFileSync(f), big)
  assert.equal(listVersions(f).length, 2)
  await restoreVersion(f, 1, { ...matt, discardCurrent: true })
  assert.deepEqual(fs.readFileSync(f), v1)
  assert.equal(listVersions(f).at(-1)!.restoredFrom, 1)
})

test('restore with unsaved content over 32 MB needs discardCurrent, and keeps the file as it was', async () => {
  const f = fresh('bigunsaved.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd())
  const onDisk = fs.readFileSync(f)
  const unsaved = Buffer.alloc(1024 * 1024 + 10, 2)
  await assert.rejects(restoreVersion(f, 1, { ...matt, unsaved }), /over 32 MB.*discardCurrent/)
  assert.deepEqual(fs.readFileSync(f), onDisk)
  assert.equal(listVersions(f).length, 2)
  await restoreVersion(f, 1, { ...matt, unsaved, discardCurrent: true })
  assert.equal(listVersions(f).at(-1)!.restoredFrom, 1)
})

for (const ext of ['md', 'html']) {
  test(`restore writes .${ext} bytes exactly when the instructions are unchanged (CRLF, non-UTF-8)`, async () => {
    const f = fresh(`exact.${ext}`)
    const v1 = Buffer.concat([Buffer.from('  first line\r\n'), Buffer.from([0xe9]), Buffer.from('t\xe9\r\nlast  \r\n', 'latin1')])
    fs.writeFileSync(f, v1)
    await save(f, Buffer.from('changed\r\n'))
    await restoreVersion(f, 1, matt)
    assert.deepEqual(fs.readFileSync(f), v1)
    await restoreVersion(f, 2, matt) // undo goes the same way
    assert.deepEqual(fs.readFileSync(f), Buffer.from('changed\r\n'))
  })
}

test('folding never merges into a restore or the state before it', async () => {
  const f = fresh('fold.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd(), matt)
  await restoreVersion(f, 1, matt)
  const before = JSON.parse(JSON.stringify(listVersions(f)))
  await save(f, rnd(), matt) // same author, minutes later: must not fold into the restore
  const list = listVersions(f)
  assert.equal(list.length, 4)
  assert.deepEqual(list.slice(0, 3), before)
  assert.equal(list[3].restoredFrom, undefined)
})

test('nameVersion names and clears a name', async () => {
  const f = fresh('n.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd())
  await nameVersion(f, 2, 'Sent to client', 'Matt')
  assert.equal(listVersions(f)[1].name, 'Sent to client')
  await nameVersion(f, 2, '', 'Matt')
  assert.equal(listVersions(f)[1].name, undefined)
  await assert.rejects(nameVersion(f, 9, 'x', 'Matt'), /9/)
  await assert.rejects(showVersion(f, 9), /9/)
})

test('forget removes index, log and unshared objects', async () => {
  const a = fresh('a.docx')
  const b = fresh('b.docx')
  const shared = rnd()
  fs.writeFileSync(a, rnd())
  await save(a, shared)
  fs.writeFileSync(b, rnd())
  await save(b, shared)
  const va = listVersions(a)
  const vb = listVersions(b)
  fs.writeFileSync(logOf(a), '{"x":1}\n')
  for (const v of [...va, ...vb]) backdate(v.hash) // only the "another index uses it" rule may keep the shared one
  await forgetHistory(a)
  assert.deepEqual(listVersions(a), [])
  for (const f of [indexPath(historyKey(a)), `${indexPath(historyKey(a))}.bak`, logOf(a)]) assert.ok(!fs.existsSync(f), f)
  assert.ok(!fs.existsSync(objectPath(va[0].hash)), 'unshared object removed')
  assert.ok(fs.existsSync(objectPath(va[1].hash)), 'shared object kept')
  assert.equal(va[1].hash, vb[1].hash)
  assert.deepEqual(Buffer.from(await showVersion(b, 2)), shared)
})

test('forget leaves an unshared object touched in the last day, for cleanup to remove later', async () => {
  const a = fresh('ra.docx')
  fs.writeFileSync(a, rnd())
  await save(a, rnd())
  const va = listVersions(a)
  backdate(va[0].hash)
  await forgetHistory(a)
  assert.deepEqual(listVersions(a), [])
  assert.ok(!fs.existsSync(objectPath(va[0].hash)), 'old unreferenced object deleted')
  assert.ok(fs.existsSync(objectPath(va[1].hash)), 'recently touched object survives')
})

test('forget keeps every object when another index cannot be read', async () => {
  const a = fresh('ka.docx')
  const b = fresh('kb.docx')
  fs.writeFileSync(a, rnd())
  await save(a, rnd())
  fs.writeFileSync(b, rnd())
  await save(b, rnd())
  const va = listVersions(a)
  for (const v of [...va, ...listVersions(b)]) backdate(v.hash) // only the unreadable-index rule may keep them
  fs.writeFileSync(indexPath(historyKey(b)), '{ not json')
  await forgetHistory(a)
  assert.deepEqual(listVersions(a), [])
  assert.ok(fs.existsSync(objectPath(va[0].hash)))
  assert.ok(fs.existsSync(objectPath(va[1].hash)))
})

test('moveHistory follows a file rename', async () => {
  const f = fresh('old.docx')
  fs.writeFileSync(f, rnd())
  await save(f, rnd())
  const versions = listVersions(f)
  fs.writeFileSync(logOf(f), '{"x":1}\n')
  const to = path.join(path.dirname(f), 'new.docx')
  fs.renameSync(f, to)
  await moveHistory(f, to)
  assert.deepEqual(listVersions(to), versions)
  assert.deepEqual(listVersions(f), [])
  assert.ok(fs.existsSync(logOf(to)))
  assert.ok(!fs.existsSync(logOf(f)))
})

test('moveHistory follows a folder rename', async () => {
  const dir = fresh('x.docx').replace(/x\.docx$/, '')
  const sub = path.join(dir, 'proj')
  const other = path.join(dir, 'proj2') // a string prefix, not inside the folder
  fs.mkdirSync(path.join(sub, 'deep'), { recursive: true })
  fs.mkdirSync(other)
  const files = [path.join(sub, 'a.docx'), path.join(sub, 'deep', 'b.docx')]
  const o = path.join(other, 'c.docx')
  for (const f of [...files, o]) {
    fs.writeFileSync(f, rnd())
    await save(f, rnd())
  }
  const before = files.map(f => listVersions(f))
  const oBefore = listVersions(o)
  const to = path.join(dir, 'renamed')
  fs.renameSync(sub, to)
  await moveHistory(sub, to)
  assert.deepEqual(listVersions(path.join(to, 'a.docx')), before[0])
  assert.deepEqual(listVersions(path.join(to, 'deep', 'b.docx')), before[1])
  assert.deepEqual(listVersions(files[0]), [])
  assert.deepEqual(listVersions(o), oBefore)
  // the stored path follows
  assert.equal(JSON.parse(fs.readFileSync(indexPath(historyKey(path.join(to, 'a.docx'))), 'utf8')).path, canonicalPath(path.join(to, 'a.docx')))
})

test('moveHistory refuses to overwrite an existing history', async () => {
  const a = fresh('ma.docx')
  const b = fresh('mb.docx')
  for (const f of [a, b]) {
    fs.writeFileSync(f, rnd())
    await save(f, rnd())
  }
  const va = listVersions(a)
  const vb = listVersions(b)
  await assert.rejects(moveHistory(a, b), /already has a history/)
  assert.deepEqual(listVersions(a), va)
  assert.deepEqual(listVersions(b), vb)
})

test('moveHistory clears a missingSince mark', async () => {
  const f = fresh('mark.md')
  fs.writeFileSync(f, 'one')
  await save(f, Buffer.from('two'))
  const key = historyKey(f)
  h.writeIndex(key, { ...h.readIndex(key)!, missingSince: 123 })
  const to = path.join(path.dirname(f), 'moved-mark.md')
  fs.renameSync(f, to)
  await moveHistory(f, to)
  assert.equal(h.readIndex(historyKey(to))!.missingSince, undefined)
})
