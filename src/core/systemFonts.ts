import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectionTooBig, isItalic, normWeight, pickStyled, weightOf } from '../shared/design/fonts'
import type { FontRef } from '../shared/design/types'
import { fontKey } from '../shared/pdf/fontNames'

/**
 * Fonts installed on this PC, so text written into a PDF can use the same font the PDF was made with (Calibri, Segoe
 * UI, Arial...) instead of the closest standard PDF font. On Windows the registry lists every installed font and its
 * file; elsewhere font folders are indexed by file name. Collections (.ttc) are skipped: pdf-lib embeds one face from
 * a single font file.
 */
let index: Promise<Map<string, string>> | null = null

const regQuery = (key: string) =>
  new Promise<string>(resolve => execFile('reg', ['query', key], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : out)))

const PDF_EXT = /\.(ttf|otf)$/i
const ALL_EXT = /\.(ttf|otf|ttc)$/i

async function walk(dir: string, depth: number, out: string[], ext = PDF_EXT) {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out, ext)
    else if (ext.test(e.name)) out.push(p)
  }
}

async function build(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (process.platform === 'win32') {
    const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    // Per-user fonts last, so they win over system fonts of the same name (as Windows does).
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
      for (const line of (await regQuery(key)).split(/\r?\n/)) {
        const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/)
        if (!m || !/\.(ttf|otf)$/i.test(m[2])) continue
        map.set(fontKey(m[1]), path.isAbsolute(m[2]) ? m[2] : path.join(fontsDir, m[2]))
      }
    }
    return map
  }
  const home = os.homedir()
  const dirs =
    process.platform === 'darwin'
      ? ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library/Fonts')]
      : ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local/share/fonts')]
  const files: string[] = []
  for (const d of dirs) await walk(d, 3, files)
  for (const f of files) map.set(fontKey(path.basename(f).replace(/\.[^.]+$/, '')), f)
  return map
}

/** The installed font file for a PDF font name, or null when it isn't installed here. */
export async function systemFontFile(pdfFontName: string): Promise<string | null> {
  index ??= build()
  return (await index).get(fontKey(pdfFontName)) || null
}

/** That font's bytes, for embedding. */
export async function systemFontBytes(pdfFontName: string): Promise<Uint8Array | null> {
  const file = await systemFontFile(pdfFontName)
  if (!file) return null
  try {
    return new Uint8Array(await fs.promises.readFile(file))
  } catch {
    return null
  }
}

// ---- Fonts for designs: faces by family, weight, style and PostScript name ----

export type FontFace = { family: string; weight: number; style: 'normal' | 'italic'; postscript: string; file: string; index: number }

let faces: Promise<FontFace[]> | null = null

/** Every installed font file, collections included. */
async function fontFiles(): Promise<string[]> {
  if (process.platform === 'win32') {
    const files = new Set<string>()
    const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
      for (const line of (await regQuery(key)).split(/\r?\n/)) {
        const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/)
        if (!m || !ALL_EXT.test(m[2])) continue
        files.add(path.isAbsolute(m[2]) ? m[2] : path.join(fontsDir, m[2]))
      }
    }
    return [...files]
  }
  const home = os.homedir()
  const dirs =
    process.platform === 'darwin'
      ? ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library/Fonts')]
      : ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local/share/fonts')]
  const found: string[] = []
  for (const d of dirs) await walk(d, 3, found, ALL_EXT)
  return found
}

const MAX_FONT_FILE = 64 << 20
const STD_WEIGHTS: [number, string][] = [[100, 'Thin'], [200, 'ExtraLight'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'SemiBold'], [700, 'Bold'], [800, 'ExtraBold'], [900, 'Black']]

/** The named instances of a variable font as [name without spaces, weight]. Reading them can throw on odd fonts. */
function variableInstances(f: any): [string, number][] {
  try {
    const wght = f.variationAxes?.wght
    if (!wght) return []
    let named: [string, any][] = []
    try {
      named = Object.entries<any>(f.namedVariations || {})
    } catch {
      // some fonts have unreadable instance names: fall back to the standard weights inside the axis range
    }
    const fromNames = named
      .filter(([, axes]) => typeof axes?.wght === 'number')
      .map(([name, axes]): [string, number] => [name.replace(/\s+/g, ''), Math.round(axes.wght)])
    if (fromNames.length) return fromNames
    return STD_WEIGHTS.filter(([w]) => w >= wght.min && w <= wght.max).map(([w, name]): [string, number] => [name, w])
  } catch {
    return []
  }
}

async function buildFaces(): Promise<FontFace[]> {
  const fontkit = (await import('@pdf-lib/fontkit')).default as any
  const out: FontFace[] = []
  let n = 0
  for (const file of await fontFiles()) {
    if (++n % 10 === 0) await new Promise(r => setImmediate(r)) // let the worker handle other jobs during the scan
    try {
      if ((await fs.promises.stat(file)).size > MAX_FONT_FILE) continue
      const bytes = new Uint8Array(await fs.promises.readFile(file))
      if (collectionTooBig(bytes)) continue
      const parsed = fontkit.create(bytes)
      const list: any[] = Array.isArray(parsed.fonts) ? parsed.fonts : [parsed]
      list.forEach((f, index) => {
        if (!f.familyName || !f.postscriptName) return
        const style = isItalic(f) ? 'italic' : 'normal'
        const instances = variableInstances(f)
        if (instances.length) {
          // A variable font lists its named instances (Regular, Bold...), named like Adobe does.
          for (const [name, weight] of instances) {
            out.push({
              family: f.familyName, weight: normWeight(weight), index, file,
              style: /italic|oblique/i.test(name) ? 'italic' : style, postscript: `${f.postscriptName}-${name}`
            })
          }
          return
        }
        out.push({ family: f.familyName, weight: weightOf(f), style, postscript: f.postscriptName, file, index })
      })
    } catch {
      // not a readable font: skip it
    }
  }
  return out
}

/**
 * Every installed face, built once and cached. The first call scans and parses every font file (a few seconds), so call
 * it only from the worker thread or the CLI, never from the main process or the window.
 */
export function listFontFaces(): Promise<FontFace[]> {
  faces ??= buildFaces()
  return faces
}

/**
 * The bytes of the closest face: same family, nearest weight, same style. A collection returns the whole file. Runs the
 * face scan on first use, so it too belongs in the worker thread or the CLI only.
 */
export async function fontFaceBytes(ref: FontRef): Promise<Uint8Array | null> {
  const fam = (await listFontFaces()).filter(f => f.family.toLowerCase() === ref.family.toLowerCase())
  if (!fam.length) return null
  const exact = ref.postscript ? fam.find(f => f.postscript === ref.postscript) : undefined
  const best = exact ?? pickStyled(fam, ref.style, ref.weight, f => f.weight, f => f.style === 'italic')!
  try {
    return new Uint8Array(await fs.promises.readFile(best.file))
  } catch {
    return null
  }
}
