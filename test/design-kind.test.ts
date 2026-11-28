import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Always a fresh home, never inherited; set before the modules load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-dk-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-dk-work-'))
const p = (name: string) => path.join(work, name)
after(async () => {
  await flushHistory()
  for (const dir of [work, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const { createFile, loadFile, saveFile } = await import('../src/core/files')
const { runOffline, offlineHooks } = await import('../src/core/ops/index')
const { withDesignLock } = await import('../src/core/design/lock')
const { versionText } = await import('../src/core/history/compare')
const { flushHistory } = await import('../src/core/history/index')
const { designZipBytes, readDesignZip } = await import('../src/core/formats/design')
const { newDesign } = await import('../src/shared/design/model')
const { kindOf } = await import('../src/shared/kinds')
const { applyDesignOp } = await import('../src/shared/ops/design')
type DesignFile = import('../src/shared/design/types').DesignFile

const agent = { authors: [{ name: 'Claude', by: 'agent' as const }] }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const CHANGED = 'Changed by someone else; reload to see it'
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** The layer lines `read` gives for the first artboard, straight from the file on disk. */
const layersOf = async (file: string): Promise<string[]> => ((await runOffline(file, { op: 'read' }, agent)) as { layers: string[] }).layers

test('kindOf: .gdesign is a design, whatever its case', () => {
  assert.equal(kindOf('a.GDESIGN'), 'design')
  assert.equal(kindOf('C:/Work/Post.gdesign'), 'design')
})

test('createFile with a preset, then loadFile gives a design payload of that size', async () => {
  await createFile(p('x.gdesign'), agent, 'story')
  const f = await loadFile(p('x.gdesign'))
  assert.equal(f.kind, 'design')
  assert.equal(f.payload.kind, 'design')
  if (f.payload.kind !== 'design') return
  const boards = f.payload.file.design.artboards
  assert.equal(boards.length, 1)
  assert.equal(boards[0].width, 1080)
  assert.equal(boards[0].height, 1920)
  assert.equal(fs.existsSync(p('x.gdesign.lock')), false, 'the lock is gone once the file is written')
})

test('runOffline add then read sees the layer, and the save marks the thumbnail stale', async () => {
  const file = p('a.gdesign')
  await createFile(file, agent, 'instagram')
  const added = (await runOffline(file, { op: 'add', type: 'rect', props: { name: 'Box', x: 10, y: 20, width: 30, height: 40 } }, agent)) as {
    ids: string[]
  }
  const layers = await layersOf(file)
  assert.equal(layers.length, 1)
  assert.equal(layers[0], `${added.ids[0]}  Box  rect  10,20 30x40`)
  const back = await readDesignZip(fs.readFileSync(file))
  assert.equal(back.design.thumbnailStale, true)
  assert.equal(fs.existsSync(file + '.lock'), false)
})

test('two concurrent runOffline adds both land', async () => {
  const file = p('c.gdesign')
  await createFile(file, agent, 'instagram')
  await Promise.all([
    runOffline(file, { op: 'add', type: 'rect', props: { name: 'One' } }, agent),
    runOffline(file, { op: 'add', type: 'ellipse', props: { name: 'Two' } }, agent)
  ])
  const layers = await layersOf(file)
  assert.equal(layers.length, 2)
  assert.deepEqual(layers.map(l => l.split('  ')[1]).sort(), ['One', 'Two'])
})

test('a save whose file changed after it was loaded stops, and the other writer keeps its file', async () => {
  const file = p('h.gdesign')
  await createFile(file, agent, 'instagram')
  const theirs = await designZipBytes({ design: newDesign('logo'), assets: {} })
  offlineHooks.beforeSave = f => fs.writeFileSync(f, theirs)
  try {
    await assert.rejects(runOffline(file, { op: 'add', type: 'rect' }, agent), (e: Error) => e.message === CHANGED)
  } finally {
    offlineHooks.beforeSave = undefined
  }
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), new Uint8Array(theirs))
  assert.equal(fs.existsSync(file + '.lock'), false, 'the lock is released after a refusal')
})

test('a lock file older than 60 s is taken over', async () => {
  const file = p('s.gdesign')
  await createFile(file, agent, 'instagram')
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 999_999, at: Date.now() - 61_000 }))
  const t0 = Date.now()
  await runOffline(file, { op: 'add', type: 'rect' }, agent)
  assert.ok(Date.now() - t0 < 5_000, 'taken over at once, not waited out')
  assert.equal((await layersOf(file)).length, 1)
  assert.equal(fs.existsSync(file + '.lock'), false)
})

test('withDesignLock writes { pid, at }, makes a second writer wait and lets go after a failure', async () => {
  const file = p('l.gdesign')
  const order: string[] = []
  let release!: () => void
  const first = withDesignLock(file, async () => {
    const lock = JSON.parse(fs.readFileSync(file + '.lock', 'utf8'))
    assert.equal(lock.pid, process.pid)
    assert.ok(Math.abs(lock.at - Date.now()) < 5_000)
    order.push('first in')
    await new Promise<void>(r => (release = r))
    order.push('first out')
  })
  await sleep(20)
  const second = withDesignLock(file, async () => void order.push('second'))
  await sleep(200)
  assert.deepEqual(order, ['first in'], 'the second writer waits while the lock is held')
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first in', 'first out', 'second'])
  await assert.rejects(withDesignLock(file, async () => { throw new Error('boom') }), /boom/)
  assert.equal(fs.existsSync(file + '.lock'), false)
})

test('a partial save sends only new assets: the rest come from the file on disk', async () => {
  const file = p('img.gdesign')
  await createFile(file, agent, 'instagram')
  await runOffline(file, { op: 'add', type: 'image', props: { data: `data:image/png;base64,${PNG_1x1}` } }, agent)
  const f = await loadFile(file)
  if (f.payload.kind !== 'design') throw new Error('not a design')
  const [asset] = Object.keys(f.payload.file.assets)
  assert.ok(asset, 'the image is stored as an asset')
  await saveFile(file, { kind: 'design', file: { design: f.payload.file.design, assets: {} }, partial: true }, agent)
  const back = await readDesignZip(fs.readFileSync(file))
  assert.deepEqual(back.assets[asset], f.payload.file.assets[asset])
})

test('a partial save that fails because the file was replaced from outside is made again in full', async () => {
  const { DesignSaves } = await import('../src/renderer/src/design/saves')
  const { savePayload } = await import('../src/renderer/src/shell/savePayload')
  const file = p('swap.gdesign')
  await createFile(file, agent, 'instagram')
  await runOffline(file, { op: 'add', type: 'image', props: { data: `data:image/png;base64,${PNG_1x1}` } }, agent)
  const opened = await loadFile(file)
  if (opened.payload.kind !== 'design') throw new Error('not a design')
  const [asset] = Object.keys(opened.payload.file.assets)
  const saves = new DesignSaves(opened.payload.file.assets)
  // a sync tool puts a different, valid design there, without the image
  fs.writeFileSync(file, await designZipBytes({ design: newDesign('logo'), assets: {} }))
  // the person keeps editing what they have open, then it saves
  const edited = (await applyDesignOp(opened.payload.file, { op: 'add', type: 'rect', props: { name: 'Mine' } })).file!
  const editor = { getPayload: () => saves.partial(edited), peekPayload: () => saves.full(edited) }
  await assert.rejects(saveFile(file, saves.partial(edited), agent), /Asset assets\/[0-9a-f]{64}\.png is missing\./)
  const r = await savePayload(editor, payload => saveFile(file, payload, agent))
  saves.saved(r.payload)
  assert.equal(r.payload.kind === 'design' && r.payload.partial, undefined, 'the save that landed sent everything')
  const back = await readDesignZip(fs.readFileSync(file))
  assert.deepEqual(back.assets[asset], opened.payload.file.assets[asset])
  assert.deepEqual(back.design.artboards[0].layers.map(l => l.name), ['Image 1', 'Mine'], 'the editor kept its design')
  assert.deepEqual(saves.disk(), Object.keys(back.assets).sort(), 'the editor knows what the file holds now')
  // so the next save is partial again, with nothing to send
  const next = await savePayload(editor, payload => saveFile(file, payload, agent))
  assert.ok(next.payload.kind === 'design' && next.payload.partial)
  assert.deepEqual(next.payload.kind === 'design' && Object.keys(next.payload.file.assets), [])
  assert.deepEqual((await readDesignZip(fs.readFileSync(file))).assets[asset], opened.payload.file.assets[asset])
})

test('offline read, move and delete on a design with text never list the installed fonts; measuring text does', async () => {
  const { fontListing } = await import('../src/core/systemFonts')
  const { fontsFor } = await import('../src/shared/design/fonts')
  const liberation = new Uint8Array(fs.readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
  // the text goes in in memory: adding it offline measures it, which lists the fonts
  let f: DesignFile = { design: newDesign('instagram'), assets: {} }
  const fonts = await fontsFor(f.design, {}, async () => liberation, liberation)
  for (const op of [{ op: 'add', type: 'text', props: { name: 'Title', text: 'Hello' } }, { op: 'add', type: 'rect', props: { name: 'Box' } }]) {
    f = (await applyDesignOp(f, op, { fonts })).file!
  }
  const file = p('text.gdesign')
  fs.writeFileSync(file, await designZipBytes(f))
  const before = fontListing.calls
  assert.match((await layersOf(file)).join('\n'), /Title {2}text/)
  await runOffline(file, { op: 'move', layer: 'Title', to: 'front' }, agent)
  await runOffline(file, { op: 'delete', layer: 'Box' }, agent)
  assert.equal(fontListing.calls, before, 'nothing asked for the installed fonts')
  assert.deepEqual((await layersOf(file)).map(l => l.split('  ')[1]), ['Title'])
  // an op that measures text still gets the installed fonts
  await runOffline(file, { op: 'set', layer: 'Title', props: { text: 'Hello again' } }, agent)
  assert.ok(fontListing.calls > before, 'set text asked for the installed fonts')
})

test('versionText of a design lists its layers', async () => {
  const file = p('v.gdesign')
  await createFile(file, agent, 'instagram')
  await runOffline(file, { op: 'add', type: 'rect', props: { name: 'Hero box' } }, agent)
  await runOffline(file, { op: 'add', type: 'ellipse', props: { name: 'Sun' } }, agent)
  await flushHistory()
  const text = await versionText(file, new Uint8Array(fs.readFileSync(file)))
  assert.match(text, /^Artboards:/)
  assert.match(text, /Layers on Instagram post:/)
  assert.match(text, /Hero box {2}rect/)
  assert.match(text, /Sun {2}ellipse/)
})

test('restoring a design waits for its lock, then writes the version back', async () => {
  const { historyJobs } = await import('../src/main/historyJobs')
  const file = p('r.gdesign')
  // two authors, so the two saves stay two versions (one author's quick saves fold into one)
  await createFile(file, { authors: [{ name: 'Matt', by: 'person' }] }, 'instagram')
  await runOffline(file, { op: 'add', type: 'rect', props: { name: 'Later' } }, agent)
  await flushHistory()
  let release!: () => void
  const held = withDesignLock(file, () => new Promise<void>(r => (release = r)))
  await sleep(20)
  let done = false
  const restore = Promise.resolve(historyJobs.historyRestore([file, 1, { authors: agent.authors }])).then(() => (done = true))
  await sleep(200)
  assert.equal(done, false, 'the restore waits while another writer holds the lock')
  release()
  await Promise.all([held, restore])
  assert.equal((await layersOf(file)).length, 0, 'version 1 is back: no layers')
  assert.equal(fs.existsSync(file + '.lock'), false)
})

test('the CLI refuses an offline op on a design open in the app, and runs it when the app is closed', async () => {
  const { startBridge } = await import('../src/main/server')
  const { runOp } = await import('../src/cli/common')
  const file = p('open.gdesign')
  await createFile(file, agent, 'instagram')
  const asked: string[] = []
  const bridge = await startBridge(async (method, params) => {
    asked.push(method)
    if (method === 'isOpen') return { open: path.resolve(String(params.path)).toLowerCase() === file.toLowerCase() }
    throw new Error(`unexpected ${method}`)
  }, () => {})
  try {
    await assert.rejects(
      runOp(file, { op: 'add', type: 'rect' }, { offline: true }),
      (e: Error) => e.message === 'This design is open in gauzzaDocs. Edit it there, or close it first.'
    )
    assert.deepEqual(asked, ['isOpen'])
    assert.equal((await layersOf(file)).length, 0, 'nothing was written')
  } finally {
    bridge.close()
  }
  const r = await runOp(file, { op: 'add', type: 'rect' }, { offline: true })
  assert.equal(r.live, false)
  assert.equal((await layersOf(file)).length, 1)
})
