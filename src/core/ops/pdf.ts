import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { applyPdfEdits, checkEdits, displaySize, parsePages } from '../../shared/pdf/edits'
import { structuralEdits } from '../../shared/ops/pdf'
import { allText, joinPages, type PdfJsDocLike } from '../../shared/pdf/text'
import { OpError, type OpHandler, str } from '../../shared/ops/types'

/** Opens bytes with the pdf.js legacy build (the one meant for Node). */
async function openPdfJs(bytes: Uint8Array): Promise<{ doc: PdfJsDocLike; close(): Promise<void> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true, verbosity: 0 })
  const doc = (await task.promise) as unknown as PdfJsDocLike
  return { doc, close: () => task.destroy() }
}

export async function pdfInfo(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const pages = doc.getPages()
  return {
    pages: pages.length,
    sizes: pages.map(p => ({ ...displaySize(p), rotation: p.getRotation().angle })),
    title: doc.getTitle() || null,
    author: doc.getAuthor() || null
  }
}

export async function pdfText(bytes: Uint8Array, spec?: string) {
  const { doc, close } = await openPdfJs(bytes)
  try {
    return await allText(doc, parsePages(spec, doc.numPages))
  } finally {
    await close()
  }
}

/** Appends whole PDFs after `bytes`. */
export async function mergePdfs(bytes: Uint8Array, others: Uint8Array[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  for (const o of others) {
    const src = await PDFDocument.load(o, { ignoreEncryption: true })
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p)
  }
  return doc.save()
}

const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount()

export const pdfOps: OpHandler = async (payload, op, ctx) => {
  if (payload.kind !== 'pdf') throw new OpError('not a PDF')
  const bytes = payload.bytes
  const changed = (b: Uint8Array) => ({ ...payload, bytes: b })
  switch (op.op) {
    case 'info':
      return { result: await pdfInfo(bytes) }
    case 'read': {
      const pages = await pdfText(bytes, str(op, 'pages') || (typeof op.pages === 'number' ? String(op.pages) : ''))
      return { result: op.format === 'json' ? { pages } : { content: joinPages(pages) } }
    }
    case 'annotate': {
      const edits = checkEdits(op.edits)
      return { result: { ok: true, applied: edits.length }, payload: changed(await applyPdfEdits(bytes, edits)) }
    }
    case 'rotate':
    case 'deletePages':
    case 'movePage': {
      const edits = structuralEdits(op, await pageCount(bytes))
      const out = await applyPdfEdits(bytes, edits)
      return { result: { ok: true, pages: await pageCount(out) }, payload: changed(out) }
    }
    case 'merge': {
      const files = op.files
      if (!Array.isArray(files) || !files.length) throw new OpError('merge needs files: [paths]')
      const base = path.dirname(ctx.path)
      const out = await mergePdfs(bytes, files.map(f => new Uint8Array(fs.readFileSync(path.resolve(base, String(f))))))
      return { result: { ok: true, pages: await pageCount(out) }, payload: changed(out) }
    }
    case 'write':
      throw new OpError('PDFs cannot be rewritten from text. Use annotate, rotate, deletePages, movePage or merge.')
    default:
      throw new OpError(`Unknown op "${op.op}" for PDFs. Try: info, read, annotate, rotate, deletePages, movePage, merge`)
  }
}
