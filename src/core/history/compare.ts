import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { loadFile } from '../files'
import { pdfText } from '../ops/pdf'
import { type Hunk, lineDiff } from '../../shared/diff'
import { extOf } from '../../shared/kinds'
import { htmlToMarkdown } from '../../shared/convert'
import { parseAddr } from '../../shared/sheet/address'
import { deckToMarkdown } from '../../shared/slides/markdown'
import type { Sheet } from '../../shared/types'

/** Comparisons only happen when both versions are under this size. */
export const COMPARE_MAX_BYTES = 8 * 1024 * 1024

const BINARY = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'zip']

/** One line per non-empty cell, `Sheet!A1: value`, row by row. A formula cell shows its formula as stored. */
function sheetLines(sheet: Sheet): string[] {
  return Object.entries(sheet.cells)
    .map(([a, cell]) => ({ a, pos: parseAddr(a), text: cell.f !== undefined ? `=${cell.f}` : cell.v }))
    .filter(c => c.pos && c.text !== undefined && c.text !== null && c.text !== '')
    .sort((x, y) => x.pos!.r - y.pos!.r || x.pos!.c - y.pos!.c)
    .map(c => `${sheet.name}!${c.a}: ${c.text}`)
}

/** The text of one stored version of `file`, for comparing. Throws for a kind that has no text. */
export async function versionText(file: string, bytes: Uint8Array): Promise<string> {
  const ext = extOf(file)
  if (BINARY.includes(ext)) throw new Error(`Cannot compare .${ext} files as text`)
  if (ext === 'pdf') return (await pdfText(bytes)).map(p => p.text).join('\n\n')
  const tmp = path.join(os.tmpdir(), `gd-compare-${process.pid}-${threadId}-${crypto.randomBytes(6).toString('hex')}${ext ? `.${ext}` : ''}`)
  try {
    fs.writeFileSync(tmp, bytes)
    const { payload } = await loadFile(tmp, { full: true })
    switch (payload.kind) {
      case 'doc':
        return htmlToMarkdown(payload.html)
      case 'slides':
        return deckToMarkdown(payload.deck)
      case 'sheet':
        return payload.workbook.sheets.flatMap(sheetLines).join('\n')
      case 'text':
        return payload.text
      default:
        throw new Error(`Cannot compare .${ext} files as text`)
    }
  } finally {
    // A held temp file (antivirus, indexer) must not fail the comparison; leaving it behind is fine.
    try {
      fs.rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  }
}

export async function compareVersions(file: string, a: Uint8Array, b: Uint8Array): Promise<{ hunks: Hunk[] } | { tooLarge: true }> {
  if (a.byteLength > COMPARE_MAX_BYTES || b.byteLength > COMPARE_MAX_BYTES) return { tooLarge: true }
  return { hunks: lineDiff(await versionText(file, a), await versionText(file, b)) }
}
