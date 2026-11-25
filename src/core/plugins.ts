import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstalledPlugin, PluginManifest } from '../shared/types'
import { PLUGINS_DIR, getSettings } from './paths'

/**
 * Plugins are folders in ~/.gauzzadocs/plugins/<id> holding plugin.json and an ES module (see plugins/README.md).
 * The marketplace is plugins/marketplace.json in the public GitHub repo (built by scripts/build-marketplace.mjs).
 * Every file it lists carries a SHA-256; installing downloads each file and refuses the plugin if any hash differs,
 * so a tampered or half-uploaded file never gets installed. The setting may also point at a local folder.
 */
export interface MarketFile {
  path: string
  sha256: string
  size: number
}
export interface LibraryEntry {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  category?: string
  tags?: string[]
  icon?: string
  languages?: string[]
  minApi?: number
  size?: number
  path: string // folder of the plugin, relative to the marketplace file
  files?: MarketFile[] // with hashes; absent in old-style registries
  installed?: string // installed version, filled in by library()
  update?: boolean // a newer version than the installed one is on offer
  compatible?: boolean
}

/** Plugin API version this build provides (see renderer/src/shell/plugins.ts). */
export const PLUGIN_API = 1

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const SAFE_FILE = (f: string) => !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..')
const MAX_FILE = 10 * 1024 * 1024

/** -1 / 0 / 1 for x.y.z versions. */
export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1
  return 0
}

function readManifest(dir: string): PluginManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest
    return m.id && m.main ? m : null
  } catch {
    return null
  }
}

export function installed(): InstalledPlugin[] {
  if (!fs.existsSync(PLUGINS_DIR)) return []
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.endsWith('.installing'))
    .flatMap(d => {
      const dir = path.join(PLUGINS_DIR, d.name)
      const m = readManifest(dir)
      return m ? [{ ...m, dir, enabled: !fs.existsSync(path.join(dir, '.disabled')) }] : []
    })
}

export function setEnabled(id: string, enabled: boolean) {
  const p = installed().find(x => x.id === id)
  if (!p) throw new Error(`Plugin "${id}" is not installed`)
  const flag = path.join(p.dir, '.disabled')
  if (enabled) fs.rmSync(flag, { force: true })
  else fs.writeFileSync(flag, '')
}

export function remove(id: string) {
  const p = installed().find(x => x.id === id)
  if (!p) throw new Error(`Plugin "${id}" is not installed`)
  fs.rmSync(p.dir, { recursive: true, force: true })
}

const isUrl = (s: string) => /^https?:\/\//i.test(s)

/** The marketplace location as a base (folder or URL) plus the marketplace file itself. */
function marketLocation(source: string) {
  if (isUrl(source)) return { base: source.replace(/[^/]*$/, ''), file: source }
  const p = path.resolve(source)
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const file = ['marketplace.json', 'registry.json'].map(f => path.join(p, f)).find(f => fs.existsSync(f)) || path.join(p, 'marketplace.json')
    return { base: p, file }
  }
  return { base: path.dirname(p), file: p }
}

async function fetchBytes(where: string): Promise<Buffer> {
  if (!isUrl(where)) return fs.readFileSync(where)
  const res = await fetch(where, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_FILE) throw new Error(`${where} is too large`)
  return Buffer.from(await res.arrayBuffer())
}
const join = (base: string, ...parts: string[]) =>
  isUrl(base) ? base.replace(/\/?$/, '/') + parts.flatMap(p => p.split('/')).map(encodeURIComponent).join('/') : path.join(base, ...parts)

export interface Market {
  source: string
  name?: string
  categories: string[]
  plugins: LibraryEntry[]
  offline?: string // why the online marketplace was not used
}

/** Plugins on offer. Falls back to `fallbackDir` (the copy bundled with the app) when the marketplace cannot be reached. */
export async function library(fallbackDir?: string): Promise<Market> {
  const sources = [getSettings().registry, ...(fallbackDir ? [fallbackDir] : [])]
  let lastErr = ''
  for (const src of sources) {
    try {
      const { file } = marketLocation(src)
      const reg = JSON.parse((await fetchBytes(file)).toString('utf8')) as { name?: string; categories?: string[]; plugins: LibraryEntry[] }
      const have = new Map(installed().map(p => [p.id, p.version]))
      const plugins = (reg.plugins || [])
        .filter(p => SAFE_ID.test(p.id) && SAFE_FILE(p.path || p.id))
        .map(p => {
          const inst = have.get(p.id)
          return { ...p, installed: inst, update: !!inst && compareVersions(inst, p.version) < 0, compatible: (p.minApi || 1) <= PLUGIN_API }
        })
      const categories = reg.categories || [...new Set(plugins.map(p => p.category || 'Other'))].sort()
      return { source: src, name: reg.name, categories, plugins, ...(src !== sources[0] ? { offline: lastErr } : {}) }
    } catch (e) {
      lastErr = (e as Error).message
    }
  }
  throw new Error(`Could not read the plugin marketplace: ${lastErr}`)
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

/** Installs (or updates) a plugin from the marketplace by id, or from a local folder holding plugin.json. */
export async function install(idOrDir: string, fallbackDir?: string): Promise<InstalledPlugin> {
  let srcBase: string
  let expected: MarketFile[] | undefined
  if (fs.existsSync(path.join(idOrDir, 'plugin.json'))) srcBase = path.resolve(idOrDir)
  else {
    const lib = await library(fallbackDir)
    const entry = lib.plugins.find(p => p.id === idOrDir)
    if (!entry) throw new Error(`No plugin "${idOrDir}" in the marketplace (${lib.source})`)
    if (!entry.compatible) throw new Error(`${entry.name} needs a newer gauzzaDocs (plugin API ${entry.minApi}); update the app first`)
    // Community plugins live in their authors' repos; their entry's path is a raw URL pinned to the reviewed commit.
    srcBase = isUrl(entry.path) ? entry.path : join(marketLocation(lib.source).base, entry.path)
    expected = entry.files
  }
  const manifest = JSON.parse((await fetchBytes(join(srcBase, 'plugin.json'))).toString('utf8')) as PluginManifest
  if (!SAFE_ID.test(manifest.id)) throw new Error(`Bad plugin id "${manifest.id}"`)
  const files = expected ? expected.map(f => f.path) : Array.from(new Set(['plugin.json', manifest.main, ...(manifest.files || [])]))
  if (!files.every(SAFE_FILE)) throw new Error('Plugin lists a file outside its folder')
  if (!files.includes(manifest.main)) throw new Error(`The marketplace entry for ${manifest.id} does not include its main file`)

  // Plugins are ES modules; saying so once stops Node guessing (and warning) each time the CLI loads one.
  const pkg = path.join(PLUGINS_DIR, 'package.json')
  if (!fs.existsSync(pkg)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true })
    fs.writeFileSync(pkg, '{ "type": "module", "private": true }\n')
  }
  const dest = path.join(PLUGINS_DIR, manifest.id)
  const tmp = `${dest}.installing`
  fs.rmSync(tmp, { recursive: true, force: true })
  try {
    for (const f of files) {
      const body = await fetchBytes(join(srcBase, ...f.split(/[\\/]/)))
      const want = expected?.find(e => e.path === f)
      if (want && sha256(body) !== want.sha256)
        throw new Error(`${manifest.id}/${f} does not match the marketplace checksum; not installed (the file may have been changed or is still uploading)`)
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true })
      fs.writeFileSync(path.join(tmp, f), body)
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  const wasDisabled = fs.existsSync(path.join(dest, '.disabled'))
  fs.rmSync(dest, { recursive: true, force: true })
  fs.renameSync(tmp, dest)
  if (wasDisabled) fs.writeFileSync(path.join(dest, '.disabled'), '')
  return { ...manifest, dir: dest, enabled: !wasDisabled }
}

/** Installs every available update. Returns what changed. */
export async function updateAll(fallbackDir?: string) {
  const lib = await library(fallbackDir)
  const done: { id: string; from: string; to: string }[] = []
  for (const p of lib.plugins.filter(x => x.update && x.compatible)) {
    await install(p.id, fallbackDir)
    done.push({ id: p.id, from: p.installed!, to: p.version })
  }
  return done
}

// ---------- running plugin formatters outside the window (CLI) ----------

export interface Formatter {
  id: string
  name: string
  languages?: string[]
  format: (text: string, ctx: { language: string; path?: string }) => string | Promise<string>
}

/**
 * Loads enabled plugins in Node and collects their formatters (commands and previews need the window).
 * Plugins get a reduced API here: register calls for previews and UI are accepted and ignored.
 */
export async function nodeFormatters(): Promise<(Formatter & { plugin: string })[]> {
  const out: (Formatter & { plugin: string })[] = []
  const { markdownToHtml, htmlToMarkdown, escapeHtml } = await import('../shared/convert')
  for (const p of installed().filter(x => x.enabled)) {
    try {
      const mod = await import(pathToFileURL(path.join(p.dir, p.main)).href)
      const api = {
        version: PLUGIN_API,
        host: 'cli' as const,
        registerFormatter: (f: Formatter) => out.push({ ...f, id: `${p.id}.${f.id}`, plugin: p.id }),
        registerPreview: () => {},
        registerCommand: () => {},
        markdown: { toHtml: markdownToHtml, fromHtml: htmlToMarkdown },
        escapeHtml,
        ui: { toast: (m: string) => process.stderr.write(`${m}\n`) }
      }
      await mod.activate?.(api)
    } catch (e) {
      process.emitWarning(`Plugin ${p.id} failed to load: ${(e as Error).message}`)
    }
  }
  return out
}
