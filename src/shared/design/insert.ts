// A design going into a document (Insert > Design in the doc editor): which image format suits the document. The
// drawing itself comes from designImage (core/design/export.ts), the same code an export runs.
import { extOf } from '../kinds'

export type InsertFormat = 'svg' | 'png'

/** The scale a design is drawn at when it goes into a document as a PNG, so it stays sharp on screen and in print. */
export const INSERT_SCALE = 2

/** Markdown and HTML documents, which keep an SVG image as it is. */
const KEEPS_SVG = ['md', 'markdown', 'html', 'htm']

/**
 * The format a design goes into a document as, by default: SVG for Markdown and HTML, which stays sharp at any size;
 * PNG for Word, which can't hold SVG, and for anything else.
 */
export function insertFormat(docPath: string): InsertFormat {
  return KEEPS_SVG.includes(extOf(docPath)) ? 'svg' : 'png'
}

/** The formats a document can take a design in, its default first: SVG or PNG for Markdown and HTML, else PNG only. */
export function insertFormats(docPath: string): InsertFormat[] {
  return insertFormat(docPath) === 'svg' ? ['svg', 'png'] : ['png']
}
