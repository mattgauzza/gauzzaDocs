import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDoc = pdfjs.PDFDocumentProxy
export type PdfPageProxy = pdfjs.PDFPageProxy
export { pdfjs }

/**
 * Opens a PDF from bytes, or from a gdfile: URL. With a URL, pdf.js fetches only the byte ranges the pages on
 * screen need, so a 500 MB scan opens without reading the whole file into memory.
 * pdf.js takes ownership of a buffer it is given, so bytes always go in as a copy.
 */
export function openPdf(src: Uint8Array | string) {
  if (typeof src === 'string')
    return pdfjs.getDocument({ url: src, disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024, useSystemFonts: true, fontExtraProperties: true, verbosity: 0 })
  return pdfjs.getDocument({ data: src.slice(), useSystemFonts: true, fontExtraProperties: true, verbosity: 0 })
}

/** The whole file, fetched only when something needs every byte (saving, page changes). */
export async function fetchAll(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not read the PDF (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}
