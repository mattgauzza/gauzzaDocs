import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

async function walk(dir: string, depth: number, out: string[]) {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out)
    else if (/\.(ttf|otf)$/i.test(e.name)) out.push(p)
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
