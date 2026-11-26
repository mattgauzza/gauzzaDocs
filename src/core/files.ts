import fs from 'node:fs'
import path from 'node:path'
import { kindOf } from '../shared/kinds'
import type { FilePayload, OpenFile } from '../shared/types'
import { backupDocOriginal, docBytes, loadDoc } from './formats/doc'
import { loadPdf } from './formats/pdf'
import { loadSheet, sheetBytes } from './formats/sheet'
import { loadText, textBytes } from './formats/text'
import { backupSlidesOriginal, loadSlides, slidesBytes } from './formats/slides' // slides
import { type WriteContext, guardedWrite, writeAtomic } from './history'
import { newDeck } from '../shared/slides/model' // slides
import { LARGE_BYTES } from './large'
import { extOf } from '../shared/kinds'

/** `full` forces loading everything (offline edits of huge files); the window never asks for that. */
export async function loadFile(file: string, opts: { full?: boolean } = {}): Promise<OpenFile> {
  const p = path.resolve(file)
  const stat = fs.statSync(p)
  if (stat.isDirectory()) throw new Error(`${p} is a folder`)
  const kind = kindOf(p)
  const csv = ['csv', 'tsv'].includes(extOf(p))
  if (!opts.full && stat.size > LARGE_BYTES && (kind === 'text' || csv))
    return { path: p, kind, payload: { kind: 'large', size: stat.size, as: csv ? 'csv' : 'text' }, mtime: stat.mtimeMs }
  const payload: FilePayload =
    kind === 'doc' ? await loadDoc(p) : kind === 'sheet' ? await loadSheet(p) : kind === 'pdf' ? loadPdf(p) : kind === 'slides' ? await loadSlides(p) : loadText(p)
  return { path: p, kind, payload, mtime: stat.mtimeMs }
}

/** The bytes a payload becomes on disk for this file name. Builds in memory; never writes. */
export async function payloadBytes(file: string, payload: FilePayload): Promise<Uint8Array> {
  switch (payload.kind) {
    case 'doc':
      return docBytes(file, payload.html)
    case 'sheet':
      return sheetBytes(file, payload.workbook)
    case 'slides':
      return slidesBytes(file, payload.deck)
    case 'pdf':
      return payload.bytes
    case 'text':
      return textBytes(payload.text, payload.eol)
    default:
      throw new Error('Large files are edited in place, not saved whole')
  }
}

const AGENT: WriteContext = { authors: [{ name: 'Agent', by: 'agent' }] }

/** Writes a payload in the format the file name asks for: built in memory, swapped in atomically, kept as a version. Returns the new modification time. */
export async function saveFile(file: string, payload: FilePayload, ctx: WriteContext = AGENT): Promise<number> {
  const p = path.resolve(file)
  if (payload.kind === 'large') throw new Error('Large files are edited in place, not saved whole')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const st = await guardedWrite(p, ctx, async () => {
    // The one-time copy of the original Word/PowerPoint file, before the first save that could lose something.
    if (payload.kind === 'doc') await backupDocOriginal(p)
    else if (payload.kind === 'slides') await backupSlidesOriginal(p)
    const bytes = await payloadBytes(p, payload)
    await writeAtomic(p, bytes)
    return bytes
  })
  return st.mtime
}

/** A brand-new empty file of the given kind. `ctx` says who created it (its first version's authors). */
export async function createFile(file: string, ctx?: WriteContext) {
  const kind = kindOf(file)
  if (kind === 'doc') await saveFile(file, { kind, html: '<p></p>' }, ctx)
  else if (kind === 'sheet') await saveFile(file, { kind, workbook: { sheets: [{ name: 'Sheet1', cells: {} }] } }, ctx)
  else if (kind === 'slides') await saveFile(file, { kind, deck: newDeck() }, ctx)
  else if (kind === 'pdf') {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    await saveFile(file, { kind, bytes: await doc.save() }, ctx)
  } else await saveFile(file, { kind: 'text', text: '', eol: '\n' }, ctx)
}
