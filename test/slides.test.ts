import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { deckToPptx, loadSlides, pptxLoss, pptxToDeck, saveSlides } from '../src/core/formats/slides'
import { runOffline } from '../src/core/ops'
import { applySlidesOp } from '../src/shared/ops/slides'
import { deckToMarkdown, markdownToDeck, slideFromMarkdown } from '../src/shared/slides/markdown'
import { DEFAULT_THEME, makeSlide, newDeck } from '../src/shared/slides/model'
import type { Deck } from '../src/shared/types'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A deck that uses every feature the model has. */
function richDeck(): Deck {
  const t = DEFAULT_THEME
  const s1 = makeSlide('title', { title: 'Quarterly plan', subtitle: 'Draft for review', notes: 'Open with the numbers.\nThen the risks.' }, t)
  const s2 = makeSlide('titleBody', { title: 'What we ship', bullets: ['Docs', '  Comments', 'Sheets'] }, t)
  s2.elements.push(
    { id: 'shape1', type: 'shape', shape: 'roundRect', x: 9, y: 5, w: 3, h: 1.5, fill: '#fde293', stroke: '#b06000', strokeWidth: 2, rotation: 12,
      paras: [{ runs: [{ text: 'Callout ', b: true, size: 16, color: '#202124' }, { text: 'note', i: true, u: true, size: 16, color: '#c5221f', font: 'Georgia' }], align: 'center' }], valign: 'middle' },
    { id: 'line1', type: 'shape', shape: 'arrow', x: 1, y: 6.5, w: 4, h: 0, stroke: '#1a73e8', strokeWidth: 3 },
    { id: 'oval1', type: 'shape', shape: 'ellipse', x: 6, y: 5.5, w: 1, h: 1, fill: '#34a853' },
    { id: 'img1', type: 'image', x: 10, y: 1.6, w: 2, h: 2, src: PNG },
    { id: 'tb1', type: 'text', x: 1, y: 5, w: 4, h: 1, valign: 'top', paras: [
      { runs: [{ text: 'First', size: 18, color: '#202124' }], bullet: 'number', level: 0 },
      { runs: [{ text: 'Second', size: 18, color: '#202124' }], bullet: 'number', level: 0 },
      { runs: [{ text: '', size: 18, color: '#202124' }] },
      { runs: [{ text: 'Right aligned', size: 12, color: '#5f6368' }], align: 'right' }
    ] }
  )
  const s3 = makeSlide('twoColumn', { title: 'Pros and cons', bullets: ['Fast'], right: ['New'] }, t)
  s3.background = '#e8f0fe'
  const s4 = makeSlide('section', { title: 'Next steps' }, t)
  const s5 = makeSlide('blank', {}, t)
  return { size: { w: 13.333, h: 7.5 }, theme: { ...t }, slides: [s1, s2, s3, s4, s5] }
}

test('pptx round trip: a deck made here reads back exactly', async () => {
  const deck = richDeck()
  const buf = await deckToPptx(deck)
  const { deck: back, reasons } = await pptxToDeck(buf)
  assert.deepEqual(reasons, [])
  assert.deepEqual(back, deck)
  // And again: writing what we read changes nothing.
  const again = await pptxToDeck(await deckToPptx(back))
  assert.deepEqual(again.deck, deck)
})

test('pptx files: save, load, lossy detection and the .original backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-slides-test-'))
  try {
    const file = path.join(dir, 'Deck.pptx')
    await saveSlides(file, richDeck())
    const loaded = await loadSlides(file)
    assert.equal(loaded.lossy, false)
    assert.equal(loaded.deck.slides.length, 5)

    // A pptx with a chart part (as PowerPoint writes one) is lossy, and the first save keeps the original.
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(fs.readFileSync(file))
    zip.file('ppt/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')
    const withChart = path.join(dir, 'Charted.pptx')
    fs.writeFileSync(withChart, await zip.generateAsync({ type: 'nodebuffer' }))
    assert.deepEqual(await pptxLoss(zip), ['charts'])
    const charted = await loadSlides(withChart)
    assert.equal(charted.lossy, true)
    assert.deepEqual(charted.lossyReasons, ['charts'])
    await saveSlides(withChart, charted.deck)
    assert.ok(fs.existsSync(path.join(dir, 'Charted.original.pptx')))
    const before = fs.statSync(path.join(dir, 'Charted.original.pptx')).mtimeMs
    await saveSlides(withChart, charted.deck)
    assert.equal(fs.statSync(path.join(dir, 'Charted.original.pptx')).mtimeMs, before, 'the backup is made once')
    assert.ok(!fs.existsSync(path.join(dir, 'Deck.original.pptx')), 'no backup for a file with nothing to lose')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('markdown <-> deck', () => {
  const md = `# Launch plan
A short subtitle

---

# Why now
- Customers asked
  - Twice
- **Costs** dropped
1. First
2. Second

Notes: Mention the survey.
It had 40 answers.

---

<!-- layout: twoColumn -->
# Pros and cons
- Fast
<!-- column -->
- New

---

# Section break
`
  const deck = markdownToDeck(md)
  assert.deepEqual(deck.slides.map(s => s.layout), ['title', 'titleBody', 'twoColumn', 'section'])
  const body = deck.slides[1].elements.find(e => e.role === 'body')!
  assert.deepEqual(body.paras!.map(p => [p.bullet, p.level, p.runs.map(r => r.text + (r.b ? '(b)' : '')).join('')]), [
    ['bullet', 0, 'Customers asked'], ['bullet', 1, 'Twice'], ['bullet', 0, 'Costs(b) dropped'], ['number', 0, 'First'], ['number', 0, 'Second']
  ])
  assert.equal(deck.slides[1].notes, 'Mention the survey.\nIt had 40 answers.')
  const back = deckToMarkdown(deck)
  assert.match(back, /^# Launch plan\nA short subtitle/m)
  assert.match(back, /- \*\*Costs\*\* dropped/)
  assert.match(back, /<!-- column -->\n- New/)
  // Markdown -> deck -> Markdown is stable.
  assert.equal(deckToMarkdown(markdownToDeck(back)), back)
  // snake_case stays plain text.
  assert.equal(slideFromMarkdown('# t\n- use file_name_here', DEFAULT_THEME, 1).elements[1].paras![0].runs.length, 1)
})

test('slide ops', () => {
  let deck = newDeck()
  const step = (op: Record<string, unknown>) => {
    const r = applySlidesOp(deck, op as never)
    if (r.deck) deck = r.deck
    return r.result as Record<string, unknown>
  }
  step({ op: 'updateSlide', slide: 1, title: 'Hello', subtitle: 'World' })
  assert.equal(step({ op: 'addSlide', title: 'Agenda', bullets: ['One', 'Two'] }).slide, 2)
  assert.equal(step({ op: 'addSlide', at: 2, md: '# Inserted\n- x' }).slide, 2)
  assert.deepEqual((step({ op: 'outline' }).slides as { title: string }[]).map(s => s.title), ['Hello', 'Inserted', 'Agenda'])
  step({ op: 'moveSlide', slide: 3, to: 2 })
  step({ op: 'setNotes', slide: 'last', notes: 'Say hi' })
  assert.equal(step({ op: 'replace', find: 'Agenda', with: 'Plan', all: true }).count, 1)
  step({ op: 'duplicateSlide', slide: 1 })
  step({ op: 'deleteSlide', slide: 2 })
  const info = step({ op: 'info' }) as { slides: number; outline: { title: string }[] }
  assert.deepEqual(info.outline.map(s => s.title), ['Hello', 'Plan', 'Inserted'])
  assert.equal(deck.slides[2].notes, 'Say hi')
  assert.match(String(step({ op: 'read' }).content), /# Plan\n- One\n- Two/)
  step({ op: 'append', content: '# Thanks' })
  assert.equal(deck.slides.length, 4)
  assert.throws(() => step({ op: 'deleteSlide', slide: 9 }), /slide must be/)
  step({ op: 'setTheme', name: 'Simple dark' })
  assert.equal(deck.theme.name, 'Simple dark')
  assert.equal(deck.slides[0].elements[0].paras![0].runs[0].color, '#f1f3f4')
})

test('gdocs slides commands on a file on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-slides-cli-'))
  // The bundle lives inside the project so its bare imports resolve from our node_modules.
  const cliDir = fs.mkdtempSync(path.resolve('test', '.cli-'))
  try {
    // Bundle the real CLI and run it with its own home, so it can never reach a running app and works on disk.
    const { build } = await import('esbuild')
    const cli = path.join(cliDir, 'gdocs.mjs')
    await build({ entryPoints: ['src/cli/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: cli, logLevel: 'silent' })
    const { execFileSync } = await import('node:child_process')
    const home = path.join(dir, 'home')
    const gdocs = (...args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, GAUZZADOCS_HOME: home }, encoding: 'utf8', cwd: dir })
    const file = path.join(dir, 'Pitch.pptx')
    await saveSlides(file, newDeck())
    fs.writeFileSync(path.join(dir, 'outline.md'), '# Pitch\nFor the team\n\n---\n\n# Problem\n- Slow\n- Costly\n\nNotes: Start with a story.')
    assert.match(gdocs('slides', 'from-md', file, '--md', '@outline.md'), /2 slides/)
    gdocs('slides', 'add', file, '--title', 'Plan', '--bullets', 'One|  Detail|Two')
    gdocs('slides', 'move', file, '3', '2')
    gdocs('slides', 'notes', file, '2', 'Keep it short.')
    assert.equal(gdocs('slides', 'notes', file, '2').trim(), 'Keep it short.')
    const outline = gdocs('slides', 'outline', file)
    assert.deepEqual(outline.trim().split('\n').map(l => l.trim().split(/\s+/).slice(-1)[0]), ['Pitch', 'Plan', 'Problem'])
    const r = JSON.parse(gdocs('--json', 'read', file)) as { content: string }
    assert.match(r.content, /# Plan\n- One\n  - Detail\n- Two\n\nNotes: Keep it short\./)
    gdocs('slides', 'delete', file, '3')
    const back = await loadSlides(file)
    assert.equal(back.lossy, false)
    assert.deepEqual(back.deck.slides.map(s => s.layout), ['title', 'titleBody'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(cliDir, { recursive: true, force: true })
  }
})

test('offline ops on a .pptx file (gdocs on a closed file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-slides-off-'))
  try {
    const file = path.join(dir, 'Talk.pptx')
    await saveSlides(file, newDeck())
    await runOffline(file, { op: 'write', content: '# Talk\nBy me\n\n---\n\n# Point one\n- a\n- b' })
    await runOffline(file, { op: 'addSlide', title: 'Point two', bullets: 'c\nd' })
    const r = (await runOffline(file, { op: 'read' })) as { content: string; slides: number }
    assert.equal(r.slides, 3)
    assert.match(r.content, /# Point two\n- c\n- d/)
    const info = (await runOffline(file, { op: 'info' })) as { slides: number }
    assert.equal(info.slides, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
