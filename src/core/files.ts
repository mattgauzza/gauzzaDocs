import fs from 'node:fs'
import path from 'node:path'
import { kindOf } from '../shared/kinds'
import type { FilePayload, OpenFile } from '../shared/types'
import { loadDoc, saveDoc } from './formats/doc'
import { loadPdf, savePdf } from './formats/pdf'
import { loadSheet, saveSheet } from './formats/sheet'
import { loadText, saveText } from './formats/text'
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
    kind === 'doc' ? await loadDoc(p) : kind === 'sheet' ? await loadSheet(p) : kind === 'pdf' ? loadPdf(p) : loadText(p)
  return { path: p, kind, payload, mtime: stat.mtimeMs }
}

/** Writes a payload in the format the file name asks for. Returns the new modification time. */
export async function saveFile(file: string, payload: FilePayload): Promise<number> {
  const p = path.resolve(file)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.gd-${process.pid}.tmp`
  // Write beside the file, then swap in, so a crash mid-save never leaves half a file.
  if (payload.kind === 'large') throw new Error('Large files are edited in place, not saved whole')
  const target = payload.kind === 'pdf' || payload.kind === 'text' ? tmp : p
  if (payload.kind === 'doc') await saveDoc(p, payload.html)
  else if (payload.kind === 'sheet') await saveSheet(p, payload.workbook)
  else if (payload.kind === 'pdf') savePdf(target, payload.bytes)
  else saveText(target, payload.text, payload.eol)
  if (target === tmp) fs.renameSync(tmp, p)
  return fs.statSync(p).mtimeMs
}

/** A brand-new empty file of the given kind. */
export async function createFile(file: string) {
  const kind = kindOf(file)
  if (kind === 'doc') await saveFile(file, { kind, html: '<p></p>' })
  else if (kind === 'sheet') await saveFile(file, { kind, workbook: { sheets: [{ name: 'Sheet1', cells: {} }] } })
  else if (kind === 'pdf') {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    await saveFile(file, { kind, bytes: await doc.save() })
  } else fs.writeFileSync(file, '')
}
