// Plugins hosted in their authors' own repositories. plugins/external.json lists each one by a raw URL pinned to a
// commit, e.g. { "source": "https://raw.githubusercontent.com/alice/gdocs-mermaid/3f2c…9a1/" }. The marketplace build
// downloads the files at that commit and records their SHA-256, so what users install is exactly what was reviewed;
// a new version is a pull request that moves the pin.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PINNED = /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/(?:[\w.-]+\/)*$/

export function readExternalList(root) {
  const f = path.join(root, 'external.json')
  if (!fs.existsSync(f)) return []
  const list = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!Array.isArray(list)) throw new Error('plugins/external.json must be an array of { "source": "<raw url pinned to a commit>/" }')
  return list
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Downloads every external plugin into a temp folder. Returns [{ source, dir, manifest, files }] or [{ source, error }]. */
export async function fetchExternal(root, tmpRoot) {
  const out = []
  for (const { source } of readExternalList(root)) {
    try {
      if (!PINNED.test(source || ''))
        throw new Error('source must be https://raw.githubusercontent.com/<owner>/<repo>/<full 40-character commit sha>/<folder>/ (ending in /)')
      const manifestBuf = await get(source + 'plugin.json')
      const manifest = JSON.parse(manifestBuf.toString('utf8'))
      const dir = fs.mkdtempSync(path.join(tmpRoot, `gd-ext-${manifest.id || 'x'}-`))
      const files = []
      for (const f of [...new Set(['plugin.json', manifest.main, ...(manifest.files || [])].filter(Boolean))]) {
        if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) throw new Error(`file "${f}" is outside the plugin folder`)
        const buf = f === 'plugin.json' ? manifestBuf : await get(source + f.split('/').map(encodeURIComponent).join('/'))
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
        fs.writeFileSync(path.join(dir, f), buf)
        files.push({ path: f, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length })
      }
      out.push({ source, dir, manifest, files })
    } catch (e) {
      out.push({ source, error: e.message })
    }
  }
  return out
}
