import fs from 'node:fs'
import path from 'node:path'
import type { Kind } from '../../shared/kinds'
import { textOps } from '../../shared/ops/text'
import { designOps } from '../../shared/ops/design'
import type { OpHandler, OpResult, OpServices } from '../../shared/ops/types'
import { fontsFor, newFonts } from '../../shared/design/fonts'
import type { AgentOp, FilePayload } from '../../shared/types'
import { kindOf } from '../../shared/kinds'
import { designPayload, loadFile, saveFile } from '../files'
import { readDesignZip } from '../formats/design'
import { withDesignLock } from '../design/lock'
import { layoutDiagram } from '../design/layout'
import { fallbackFontBytes } from '../design/fallbackFont'
import { fontFaceBytes } from '../systemFonts'
import type { WriteContext } from '../history'
import { findInFile, indexFile, isLarge, readLines } from '../large'
import { docOps } from './doc'
import { pdfOps } from './pdf'
import { sheetOps } from './sheet'
import { slidesOps } from './slides'

export const HANDLERS: Record<Kind, OpHandler> = { text: textOps, doc: docOps, sheet: sheetOps, pdf: pdfOps, slides: slidesOps, design: designOps }

/** Applies an op straight to a file on disk (used when the file is not open in the app). Read-only ops never write. */
export async function runOffline(file: string, op: AgentOp, ctx?: WriteContext): Promise<unknown> {
  // Huge files: reads and searches stream from disk; edits still load the file once (no way around it for a rewrite).
  if (isLarge(file) && ['read', 'find', 'info'].includes(op.op) && kindOf(file) === 'text') {
    const idx = await indexFile(file)
    if (op.op === 'info') return { lines: idx.lines, bytes: idx.size, large: true }
    if (op.op === 'find') return findInFile(file, String(op.query ?? ''), { regex: !!op.regex, ignoreCase: !!op.ignoreCase })
    const [a, b] = String(op.lines || '1-200').split('-').map(Number)
    const lines = await readLines(file, a - 1, (b || a) - a + 1)
    return { content: lines.join('\n'), from: a, to: a + lines.length - 1, lines: idx.lines, note: op.lines ? undefined : 'large file: first 200 lines; pass lines: "from-to"' }
  }
  if (kindOf(file) === 'design') return runDesignOffline(file, op, ctx)
  const f = await loadFile(file, { full: true })
  const r = await HANDLERS[f.kind](f.payload, op, { path: f.path })
  if (r.payload && !op.dryRun) await saveFile(f.path, r.payload, ctx)
  return r.result
}

/** Tests step in here: `beforeSave` runs after an offline design op is applied and before the file is checked and written. */
export const offlineHooks: { beforeSave?: (file: string) => void | Promise<void> } = {}

export const CHANGED_ON_DISK = 'Changed by someone else; reload to see it'

/** A file's bytes with the size and modified time they were read at (one open file, so the three agree). */
async function readStamped(file: string): Promise<{ bytes: Uint8Array; size: number; mtime: number }> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const st = await fh.stat()
    return { bytes: new Uint8Array(await fh.readFile()), size: st.size, mtime: st.mtimeMs }
  } finally {
    await fh.close()
  }
}

/** What the design ops get on disk: fonts measured with the installed faces (or the fallback) and ELK for diagrams. */
async function servicesFor(payload: FilePayload & { kind: 'design' }): Promise<OpServices> {
  const { design, assets } = payload.file
  return { fonts: await fontsFor(design, assets, fontFaceBytes, await fallbackFontBytes()), layout: layoutDiagram }
}

/**
 * An op on a design that isn't open in the app. Everything but `read` holds the file's lock from loading to saving, so
 * two writers take turns instead of losing an op, and the save stops with "Changed by someone else; reload to see it"
 * when the file's size or modified time moved since it was loaded (a writer that doesn't take the lock). An op that
 * brings in a font the file didn't use runs again with that font loaded, so its text is measured in it. The save keeps
 * the old thumbnail and marks it stale: only the app draws thumbnails.
 */
async function runDesignOffline(file: string, op: AgentOp, ctx?: WriteContext): Promise<unknown> {
  const p = path.resolve(file)
  const go = async (): Promise<unknown> => {
    const loaded = await readStamped(p)
    const payload = designPayload(await readDesignZip(loaded.bytes))
    let services = await servicesFor(payload)
    let r: OpResult = await designOps(payload, op, { path: p, services })
    if (r.payload?.kind === 'design' && newFonts(payload.file.design, r.payload.file.design)) {
      services = { ...services, fonts: (await servicesFor(r.payload)).fonts }
      r = await designOps(payload, op, { path: p, services })
    }
    if (!r.payload || r.payload.kind !== 'design' || op.dryRun) return r.result
    await offlineHooks.beforeSave?.(p)
    const now = await fs.promises.stat(p)
    if (now.size !== loaded.size || now.mtimeMs !== loaded.mtime) throw new Error(CHANGED_ON_DISK)
    const { notes: _notes, ...out } = r.payload
    await saveFile(p, { ...out, file: { ...out.file, design: { ...out.file.design, thumbnailStale: true } } }, ctx, { locked: true })
    return r.result
  }
  return op.op === 'read' ? go() : withDesignLock(p, go)
}

// Ops on presentations that are not open in the app: the same pure ops the slides editor applies live.
export { slidesOps } from '../../shared/ops/slides'
