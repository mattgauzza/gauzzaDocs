import type { Kind } from '../../shared/kinds'
import { textOps } from '../../shared/ops/text'
import type { OpHandler } from '../../shared/ops/types'
import type { AgentOp } from '../../shared/types'
import { kindOf } from '../../shared/kinds'
import { loadFile, saveFile } from '../files'
import { findInFile, indexFile, isLarge, readLines } from '../large'
import { docOps } from './doc'
import { pdfOps } from './pdf'
import { sheetOps } from './sheet'
import { slidesOps } from './slides'

export const HANDLERS: Record<Kind, OpHandler> = { text: textOps, doc: docOps, sheet: sheetOps, pdf: pdfOps, slides: slidesOps }

/** Applies an op straight to a file on disk (used when the file is not open in the app). Read-only ops never write. */
export async function runOffline(file: string, op: AgentOp): Promise<unknown> {
  // Huge files: reads and searches stream from disk; edits still load the file once (no way around it for a rewrite).
  if (isLarge(file) && ['read', 'find', 'info'].includes(op.op) && kindOf(file) === 'text') {
    const idx = await indexFile(file)
    if (op.op === 'info') return { lines: idx.lines, bytes: idx.size, large: true }
    if (op.op === 'find') return findInFile(file, String(op.query ?? ''), { regex: !!op.regex, ignoreCase: !!op.ignoreCase })
    const [a, b] = String(op.lines || '1-200').split('-').map(Number)
    const lines = await readLines(file, a - 1, (b || a) - a + 1)
    return { content: lines.join('\n'), from: a, to: a + lines.length - 1, lines: idx.lines, note: op.lines ? undefined : 'large file: first 200 lines; pass lines: "from-to"' }
  }
  const f = await loadFile(file, { full: true })
  const r = await HANDLERS[f.kind](f.payload, op, { path: f.path })
  if (r.payload && !op.dryRun) await saveFile(f.path, r.payload)
  return r.result
}
