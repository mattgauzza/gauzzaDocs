import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { analyse } from '../plugins/writing-tools/index.js'
import { summarise } from '../plugins/log-insights/index.js'
import { decodeJwt, unixToIso } from '../plugins/dev-utils/index.js'
import { toCsv, toMarkdownTable } from '../plugins/markdown-tables/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-pl-home-'))
process.env.GAUZZADOCS_HOME = home
const MARKET = path.resolve('plugins')

test('marketplace.json is current and every plugin installs with verified checksums', async () => {
  execFileSync(process.execPath, ['scripts/build-marketplace.mjs', '--check'])
  const { setSettings } = await import('../src/core/paths')
  const plugins = await import('../src/core/plugins')
  setSettings({ registry: MARKET })
  const lib = await plugins.library()
  assert.ok(lib.plugins.length >= 13)
  assert.ok(lib.plugins.every(p => p.files?.every(f => /^[0-9a-f]{64}$/.test(f.sha256))))
  for (const p of lib.plugins) await plugins.install(p.id)
  assert.equal(plugins.installed().length, lib.plugins.length)

  // A file that does not match its checksum is refused and nothing half-installed is left behind.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-pl-bad-'))
  fs.cpSync(MARKET, bad, { recursive: true })
  fs.appendFileSync(path.join(bad, 'sql-format', 'index.js'), '\n// tampered\n')
  plugins.remove('sql-format')
  setSettings({ registry: bad })
  await assert.rejects(plugins.install('sql-format'), /checksum/)
  assert.ok(!plugins.installed().some(p => p.id === 'sql-format'))
  assert.ok(!fs.existsSync(path.join(home, 'plugins', 'sql-format.installing')))

  // Updates: a newer version in the marketplace is offered and installed by updateAll.
  const newer = JSON.parse(fs.readFileSync(path.join(bad, 'marketplace.json'), 'utf8'))
  setSettings({ registry: MARKET })
  await plugins.install('sql-format')
  const jt = newer.plugins.find((p: { id: string }) => p.id === 'json-tools')
  jt.version = '9.0.0'
  fs.writeFileSync(path.join(bad, 'marketplace.json'), JSON.stringify(newer))
  setSettings({ registry: bad })
  const listed = await plugins.library()
  assert.equal(listed.plugins.find(p => p.id === 'json-tools')!.update, true)
  assert.equal(plugins.compareVersions('1.10.0', '1.9.3'), 1)
  fs.rmSync(bad, { recursive: true, force: true })
})

test('plugin formatters work in Node (gdocs format)', async () => {
  const { setSettings } = await import('../src/core/paths')
  setSettings({ registry: MARKET })
  const plugins = await import('../src/core/plugins')
  for (const p of (await plugins.library()).plugins) if (!plugins.installed().some(i => i.id === p.id)) await plugins.install(p.id)
  const f = Object.fromEntries((await plugins.nodeFormatters()).map(x => [x.id, x]))
  const run = (id: string, text: string, language = 'text') => f[id].format(text, { language })

  assert.equal(await run('json-tools.pretty', '{"b":1,"a":[1,2]}'), '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n')
  assert.equal(await run('json-tools.sort', '{"b":1,"a":2}'), '{\n  "a": 2,\n  "b": 1\n}\n')

  const sql = await run('sql-format.pretty', "select a.id, b.name from users a left join teams b on a.team_id = b.id where a.active = 1 and b.name like 'x%' order by b.name;")
  assert.match(sql, /^SELECT a\.id, b\.name\nFROM users a\n  LEFT JOIN teams b ON a\.team_id = b\.id\nWHERE a\.active = 1\n  AND b\.name LIKE 'x%'\nORDER BY b\.name;/)
  assert.equal(await run('sql-format.minify', 'SELECT a\n  FROM t -- c\n WHERE x = 1'), 'SELECT a FROM t WHERE x=1')

  const css = await run('css-tools.pretty', 'a{color:red;margin:0 auto}b,i{x:"a;b"}')
  assert.equal(css, 'a {\n  color: red;\n  margin: 0 auto;\n}\n\nb, i {\n  x: "a;b";\n}\n')
  assert.equal(await run('css-tools.minify', 'a {\n  color : red ;\n}\n/* c */'), 'a{color:red}')
  assert.match(await run('css-tools.sorted', 'a{z:1;b:2}'), /b: 2;\n  z: 1;/)

  const yaml = await run('yaml-tools.json2yaml', JSON.stringify({ name: 'app', port: 8080, tags: ['a', 'b c'], db: { host: 'x', ssl: true }, empty: [], note: 'yes' }))
  assert.equal(yaml, 'name: app\nport: 8080\ntags:\n- a\n- b c\ndb:\n  host: x\n  ssl: true\nempty: []\nnote: "yes"\n')
  const back = JSON.parse(await run('yaml-tools.yaml2json', yaml))
  assert.deepEqual(back, { name: 'app', port: 8080, tags: ['a', 'b c'], db: { host: 'x', ssl: true }, empty: [], note: 'yes' })
  const cfg = JSON.parse(await run('yaml-tools.yaml2json', '# config\nservices:\n  - name: web # front\n    ports: [80, 443]\n  - name: db\nscript: |\n  echo hi\n  echo there\n'))
  assert.deepEqual(cfg, { services: [{ name: 'web', ports: [80, 443] }, { name: 'db' }], script: 'echo hi\necho there\n' })

  assert.match(await run('xml-tools.pretty', '<a><b>x</b><c/></a>'), /<a>\n  <b>x<\/b>\n  <c\/>\n<\/a>/)
  assert.match(await run('markdown-preview.tables', '|a|bb|\n|-|-|\n|1|2|\n'), /\| a   \| bb  \|/)
})

test('plugin helpers: writing review, log insights, dev utils, tables', () => {
  const w = analyse('The report was written by the team. It is really very good. This sentence is fine.')
  assert.equal(w.passive.length, 1)
  assert.ok(w.weak.length >= 2)
  assert.ok(w.flesch > 0)

  const s = summarise('2026-01-01T10:00:00Z ERROR db timeout after 30s id=4411\n2026-01-01T10:00:05Z ERROR db timeout after 31s id=9921\n2026-01-01T10:01:00Z INFO ok\nWARN slow')
  assert.deepEqual(s.levels, { ERROR: 2, INFO: 1, WARN: 1 })
  assert.equal(s.top[0].count, 2, 'numbers are folded so the two timeouts group together')
  assert.equal(s.first, '2026-01-01T10:00:00Z')

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ sub: 'u1', exp: 1767225600 })).toString('base64url') + '.sig'
  const decoded = decodeJwt(jwt)
  assert.match(decoded, /"sub": "u1"/)
  assert.match(decoded, /2026-01-01T00:00:00\.000Z/)
  assert.equal(unixToIso('at 1767225600'), 'at 2026-01-01T00:00:00.000Z')

  const md = toMarkdownTable('Item,Cost\nLaptop,1200\n"Desk, oak",300')
  assert.equal(md, '| Item      | Cost |\n| --------- | ---: |\n| Laptop    | 1200 |\n| Desk, oak |  300 |\n')
  assert.equal(toCsv(md), 'Item,Cost\nLaptop,1200\n"Desk, oak",300\n')
})
