import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

// The real CLI, bundled and run as a process against a throwaway app data folder: no app is running there, so every
// command works on the file on disk.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-design-cli-home-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-design-cli-work-'))
// inside the project, so the bundle's bare imports resolve from our node_modules
const cliDir = fs.mkdtempSync(path.resolve('test', '.cli-design-'))
const cli = path.join(cliDir, 'gdocs.mjs')

before(async () => {
  const { build } = await import('esbuild')
  await build({ entryPoints: ['src/cli/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: cli, logLevel: 'silent' })
})
after(() => {
  for (const dir of [work, home, cliDir]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

interface Run { code: number; stdout: string; stderr: string }
function gdocs(args: string[], stdin?: string): Run {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: work,
    input: stdin ?? '',
    encoding: 'utf8',
    env: { ...process.env, GAUZZADOCS_HOME: home, GDOCS_AGENT: '' }
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}
/** Runs a command that must succeed and gives its output. */
function ok(args: string[], stdin?: string): string {
  const r = gdocs(args, stdin)
  assert.equal(r.code, 0, `gdocs ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
/** A new design of this size in the work folder. */
const newDesign = (name: string, size = 'logo'): string => ok(['new', 'design', name, '--size', size, '--dir', work, '--no-open']).trim()
/** The layer lines `design read --json` gives. */
const layerLines = (file: string): string[] => (JSON.parse(ok(['design', 'read', file, '--json'])) as { layers: string[] }).layers
const idOf = (line: string): string => line.trim().split('  ')[0]

test('new design --size logo, add a text layer, then read shows it', () => {
  const file = newDesign('Logo')
  assert.ok(file.endsWith('.gdesign') && fs.existsSync(file), file)
  const added = ok(['design', 'add', file, '--type', 'text', '--text', 'Gauzza', '--name', 'Wordmark', '--size', '96'])
  const lines = layerLines(file)
  assert.equal(lines.length, 1)
  const id = idOf(lines[0])
  assert.match(added, new RegExp(id), 'the reply gives the new id')
  const read = ok(['design', 'read', file])
  assert.match(read, /^Artboards:\n {2}\S+ {2}Logo {2}1000x1000/)
  assert.match(read, new RegExp(`${id} {2}Wordmark {2}text {2}.*"Gauzza"`))
  assert.equal(ok(['read', file]), read, 'gdocs read prints the same lines')
})

test('apply - with 3 ops reports 3 ids', () => {
  const file = newDesign('Batch')
  const ops = [
    { op: 'add', type: 'rect', props: { name: 'Back', width: 1000, height: 1000, fill: '#112233' } },
    { op: 'add', type: 'ellipse', props: { name: 'Sun', x: 300, y: 300, width: 400, height: 400 } },
    { op: 'add', type: 'rect', props: { name: 'Bar', y: 900, width: 1000, height: 100 } }
  ]
  const out = ok(['design', 'apply', file, '-'], JSON.stringify(ops))
  const ids = layerLines(file).map(idOf)
  assert.equal(ids.length, 3)
  for (const id of ids) assert.match(out, new RegExp(id))
  const results = (JSON.parse(ok(['design', 'apply', file, '-', '--json'], JSON.stringify(ops))) as { results: { ids: string[] }[] }).results
  assert.equal(results.flatMap(r => r.ids).length, 3)
})

test('svg --name Mark - with a script inside reports that it removed a script', () => {
  const file = newDesign('Mark')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script><circle cx="50" cy="50" r="40" fill="#336699"/></svg>'
  const out = ok(['design', 'svg', file, '--name', 'Mark', '-'], svg)
  assert.match(out, /removed a script/i)
  const [line] = layerLines(file)
  assert.match(line, /Mark {2}group/)
  assert.match(out, new RegExp(idOf(line)))
  // and back out again, cleaned
  const back = ok(['design', 'svg', file, '--get', 'Mark'])
  assert.match(back, /^<svg /)
  assert.match(back, /#336699/)
  assert.doesNotMatch(back, /script/)
})

test('diagram - with the line format prints the node ids', () => {
  const file = newDesign('Flow', 'letter')
  const text = 'node start: Start\nnode check: Check the order\nnode ship: Ship it\nstart -> check\ncheck -> ship: approved\n'
  const out = ok(['design', 'diagram', file, '--name', 'Orders', '-'], text)
  const ids = new Map(layerLines(file).map(l => [l.trim().split('  ')[1], idOf(l)]))
  for (const [node, label] of [['start', 'Start'], ['check', 'Check the order'], ['ship', 'Ship it']]) {
    const id = [...ids].find(([name]) => name === label)?.[1]
    assert.ok(id, `a layer named ${label}`)
    assert.match(out, new RegExp(`${node}\\s+${id}`), `${node} is printed with its layer id`)
  }
  // tidy lays the same diagram out again
  assert.equal(gdocs(['design', 'diagram', 'tidy', file, '--name', 'Orders']).code, 0)
})

test('export --format svg --out x.svg writes a file with inkscape:label', () => {
  const file = newDesign('Badge')
  ok(['design', 'add', file, '--type', 'rect', '--name', 'Plate', '--w', '400', '--h', '200', '--fill', '#ff6600'])
  const out = ok(['design', 'export', file, '--format', 'svg', '--out', 'x.svg'])
  const written = path.join(work, 'x.svg')
  assert.match(out, /x\.svg/)
  const svg = fs.readFileSync(written, 'utf8')
  assert.match(svg, /^<svg /)
  assert.match(svg, /inkscape:label="Plate"/)
  assert.match(svg, /width="1000" height="1000" viewBox="0 0 1000 1000"/)
  // without --out it goes beside the design; --width sizes the root and keeps the view box
  const beside = ok(['design', 'export', file, '--width', '250']).trim()
  assert.equal(beside, path.join(work, 'Badge.svg'))
  assert.match(fs.readFileSync(beside, 'utf8'), /width="250" height="250" viewBox="0 0 1000 1000"/)
})

test('export --format png fails without the app with the Global Constraints message', () => {
  const file = newDesign('Poster', 'instagram')
  const r = gdocs(['design', 'export', file, '--format', 'png'])
  assert.notEqual(r.code, 0)
  assert.equal(r.stderr.trim(), 'error: Start gauzzaDocs to render designs. Editing and SVG export work without it.')
  assert.equal(fs.existsSync(path.join(work, 'Poster.png')), false)
})

test('a bad --layer lists the choices', () => {
  const file = newDesign('Choices')
  ok(['design', 'add', file, '--type', 'rect', '--name', 'Box'])
  ok(['design', 'add', file, '--type', 'ellipse', '--name', 'Dot'])
  const [box, dot] = layerLines(file).map(idOf)
  const r = gdocs(['design', 'set', file, '--layer', 'Nope', '--x', '5'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /No layer "Nope" on Logo/)
  assert.match(r.stderr, new RegExp(`Box \\(${box}\\)`))
  assert.match(r.stderr, new RegExp(`Dot \\(${dot}\\)`))
  // a name two layers share lists their ids
  ok(['design', 'add', file, '--type', 'rect', '--name', 'Box'])
  const twice = gdocs(['design', 'delete', file, '--layer', 'Box'])
  assert.match(twice.stderr, new RegExp(`2 layers are named "Box": ${box}, \\S+`))
})

test('gdocs info works on a design', () => {
  const file = newDesign('Info')
  ok(['design', 'add', file, '--type', 'rect'])
  ok(['design', 'artboard', 'add', file, '--name', 'Second', '--size', '400x300'])
  const info = JSON.parse(ok(['info', file, '--json'])) as Record<string, unknown>
  assert.equal(info.kind, 'design')
  assert.equal(info.path, file)
  assert.equal(info.artboards, 2)
  assert.equal(info.layers, 1)
})
