// Bundles each test/*.test.ts with esbuild (sources use extensionless imports) and runs them with node --test.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const only = process.argv.slice(2)
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.ts') && (!only.length || only.some(o => f.includes(o))))
// Inside the project so the bundles' bare imports resolve from our node_modules (ESM ignores NODE_PATH).
const out = path.resolve('test/.build')
fs.rmSync(out, { recursive: true, force: true })
await build({
  entryPoints: files.map(f => path.join('test', f)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning'
})
const r = spawnSync(process.execPath, ['--test', ...fs.readdirSync(out).map(f => path.join(out, f))], {
  stdio: 'inherit'
})
fs.rmSync(out, { recursive: true, force: true })
process.exit(r.status ?? 1)
