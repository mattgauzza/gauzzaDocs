import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { HOME } from '../core/paths'

/**
 * Registers gauzzaDocs with Windows as a proper default-app candidate, the way browsers do:
 *  - one ProgID per file type (gauzzaDocs.md, gauzzaDocs.docx, ...) so nothing clashes with other apps' names
 *  - each extension lists it under OpenWithProgids (it appears in Open with)
 *  - Software\gauzzaDocs\Capabilities + RegisteredApplications, so Settings has a gauzzaDocs page listing every type
 * Windows does not let any app make itself the default silently; openDefaultsPage() opens that page directly, where
 * each type is one click. All per user (HKCU), no administrator. Runs off the UI thread and only when something changed.
 */
const run = promisify(execFile)
export const APP_NAME = 'gauzzaDocs'
export const TYPES: [string, string][] = [
  ['docx', 'Word document'], ['md', 'Markdown document'], ['markdown', 'Markdown document'], ['xlsx', 'Excel workbook'],
  ['csv', 'CSV file'], ['tsv', 'TSV file'], ['pdf', 'PDF document'], ['txt', 'Text file'], ['log', 'Log file'],
  ['json', 'JSON file'], ['yaml', 'YAML file'], ['yml', 'YAML file']
]

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function regFile(exe: string) {
  const lines = ['Windows Registry Editor Version 5.00', '']
  const key = (k: string, values: [string, string][]) => {
    lines.push(`[HKEY_CURRENT_USER\\${k}]`)
    for (const [n, v] of values) lines.push(`${n === '@' ? '@' : `"${q(n)}"`}="${q(v)}"`)
    lines.push('')
  }
  for (const [ext, name] of TYPES) {
    const progId = `${APP_NAME}.${ext}`
    key(`Software\\Classes\\${progId}`, [['@', `${name} (gauzzaDocs)`], ['FriendlyTypeName', name]])
    key(`Software\\Classes\\${progId}\\DefaultIcon`, [['@', `"${exe}",0`]])
    key(`Software\\Classes\\${progId}\\shell\\open\\command`, [['@', `"${exe}" "%1"`]])
    key(`Software\\Classes\\.${ext}\\OpenWithProgids`, [[progId, '']])
  }
  key('Software\\gauzzaDocs\\Capabilities', [
    ['ApplicationName', APP_NAME],
    ['ApplicationDescription', 'Documents, spreadsheets, PDFs and code, with a live connection to your AI agents'],
    ['ApplicationIcon', `"${exe}",0`]
  ])
  key('Software\\gauzzaDocs\\Capabilities\\FileAssociations', TYPES.map(([ext]) => [`.${ext}`, `${APP_NAME}.${ext}`]))
  key('Software\\RegisteredApplications', [[APP_NAME, 'Software\\gauzzaDocs\\Capabilities']])
  return lines.join('\r\n') + '\r\n'
}

/** Earlier builds registered generic ProgIDs ("Markdown document", ...). Remove the ones that point at us. */
async function removeOldGenericProgIds(exe: string) {
  for (const name of [...new Set(TYPES.map(([, n]) => n)), 'Text file', 'JSON file', 'YAML file', 'TSV file', 'CSV file']) {
    try {
      const { stdout } = await run('reg', ['query', `HKCU\\Software\\Classes\\${name}\\shell\\open\\command`, '/ve'], { windowsHide: true })
      if (!stdout.toLowerCase().includes(exe.toLowerCase())) continue
      await run('reg', ['delete', `HKCU\\Software\\Classes\\${name}`, '/f'], { windowsHide: true })
      for (const [ext] of TYPES) {
        await run('reg', ['delete', `HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, '/v', name, '/f'], { windowsHide: true }).catch(() => {})
        // That installer also pointed the extension's default at the generic name; undo it so Windows falls back cleanly.
        const def = await run('reg', ['query', `HKCU\\Software\\Classes\\.${ext}`, '/ve'], { windowsHide: true }).catch(() => null)
        if (def && def.stdout.includes(name)) await run('reg', ['delete', `HKCU\\Software\\Classes\\.${ext}`, '/ve', '/f'], { windowsHide: true }).catch(() => {})
      }
    } catch { /* not there */ }
  }
}

export async function registerWithWindows(exe: string) {
  if (process.platform !== 'win32') return
  const text = regFile(exe)
  const stamp = path.join(HOME, 'win-assoc.sha')
  const sha = crypto.createHash('sha256').update(text).digest('hex')
  try {
    if (fs.readFileSync(stamp, 'utf8') === sha) return
  } catch { /* first run */ }
  const tmp = path.join(os.tmpdir(), `gauzzadocs-assoc-${process.pid}.reg`)
  fs.writeFileSync(tmp, '﻿' + text, 'utf16le')
  try {
    await run('reg', ['import', tmp], { windowsHide: true })
    await removeOldGenericProgIds(exe)
    fs.mkdirSync(HOME, { recursive: true })
    fs.writeFileSync(stamp, sha)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Settings opened on gauzzaDocs' own page (Windows 11), or the general Default apps page on older Windows. */
export const defaultsPageUrl = () => `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_NAME)}`

/** Which file types the person has made gauzzaDocs the default for (Windows records their pick as UserChoice). */
export async function defaultsStatus(): Promise<{ ext: string; name: string; ours: boolean }[]> {
  if (process.platform !== 'win32') return []
  const seen = new Map<string, string>()
  for (const [ext, name] of TYPES) if (!seen.has(ext)) seen.set(ext, name)
  return Promise.all(
    [...seen].map(async ([ext, name]) => {
      const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${ext}\\UserChoice`
      const r = await run('reg', ['query', key, '/v', 'ProgId'], { windowsHide: true }).catch(() => null)
      return { ext, name, ours: !!r && /ProgId\s+REG_SZ\s+gauzzaDocs\./i.test(r.stdout) }
    })
  )
}

/** An already-open Settings window only comes to the front and ignores the link, so close it first. */
export const closeSettings = () => run('taskkill', ['/IM', 'SystemSettings.exe'], { windowsHide: true }).then(() => new Promise(r => setTimeout(r, 800)), () => {})
