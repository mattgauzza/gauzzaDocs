// CI: checks every plugin in plugins/ (and every external submission in plugins/external.json, fetched at its pinned
// commit) with the same rules as `gdocs plugins validate`. Exits non-zero on any problem.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPlugin } from './plugin-check.mjs'
import { fetchExternal } from './external-plugins.mjs'

const ROOT = path.resolve('plugins')
let bad = 0
const report = (label, r) => {
  if (r.problems.length) {
    bad++
    console.error(`✗ ${label}\n${r.problems.map(p => `    - ${p}`).join('\n')}`)
  } else console.log(`✓ ${label}  (${r.registered.join(', ')})`)
}

for (const d of fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
  if (!fs.existsSync(path.join(ROOT, d, 'plugin.json'))) continue
  report(d, await checkPlugin(path.join(ROOT, d)))
}

for (const ext of await fetchExternal(ROOT, os.tmpdir())) {
  if (ext.error) {
    bad++
    console.error(`✗ external ${ext.source}\n    - ${ext.error}`)
  } else report(`${ext.manifest.id} (external, ${ext.source})`, await checkPlugin(ext.dir, { requireFolderMatch: false }))
}

if (bad) {
  console.error(`\n${bad} plugin(s) need fixing. See plugins/README.md.`)
  process.exit(1)
}
