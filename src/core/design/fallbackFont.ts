import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The font designs fall back to when a text's own font can't be found: Liberation Sans Regular (metric twin of Arial),
// shipped in resources/fonts with its license. The same bytes everywhere (worker, CLI, tests), so a design measures and
// draws the same with no system fonts at all.

export const FALLBACK_FONT_FILE = 'LiberationSans-Regular.ttf'

/** Folders this code may be running from: out/main (the worker), dist (the CLI), test/.build (tests) or src. */
function here(): string[] {
  const out: string[] = []
  if (typeof __dirname === 'string') out.push(__dirname)
  try {
    out.push(path.dirname(fileURLToPath(import.meta.url)))
  } catch {
    // not an ES module here
  }
  return out
}

/** Where the fallback font is: resources/fonts in the app (or the repo), else the copy pdf.js ships. */
export function fallbackFontPath(): string {
  const roots: string[] = []
  // only where this code is (never the working folder, which a CLI run can be anywhere)
  for (const d of here()) roots.push(path.resolve(d, '..'), path.resolve(d, '..', '..'), path.resolve(d, '..', '..', '..'))
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources) roots.push(path.join(resources, 'app'))
  const tries = [
    ...roots.map(r => path.join(r, 'resources', 'fonts', FALLBACK_FONT_FILE)),
    ...roots.map(r => path.join(r, 'node_modules', 'pdfjs-dist', 'standard_fonts', FALLBACK_FONT_FILE))
  ]
  const found = tries.find(f => fs.existsSync(f))
  if (!found) throw new Error(`The fallback font (${FALLBACK_FONT_FILE}) is missing. Reinstall gauzzaDocs.`)
  return found
}

let bytes: Promise<Uint8Array> | null = null

/** The fallback font's bytes, read once. */
export function fallbackFontBytes(): Promise<Uint8Array> {
  if (bytes) return bytes
  const read = Promise.resolve().then(async () => new Uint8Array(await fs.promises.readFile(fallbackFontPath())))
  bytes = read
  read.catch(() => {
    if (bytes === read) bytes = null // a failed read is tried again next time
  })
  return read
}
