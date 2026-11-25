import { parsePages } from '../pdf/edits'
import type { AgentOp, PdfEdit } from '../types'
import { OpError, num } from './types'

/** Structural PDF ops (rotate / deletePages / movePage) as PdfEdits. Shared by the live editor and the CLI. */
export function structuralEdits(op: AgentOp, count: number): PdfEdit[] {
  const pagesSpec = op.pages as string | number | number[] | undefined
  switch (op.op) {
    case 'rotate': {
      const deg = num(op, 'degrees', 90)!
      if (deg % 90) throw new OpError('degrees must be a multiple of 90')
      return parsePages(pagesSpec, count).map(page => ({ type: 'rotate', page, degrees: deg }))
    }
    case 'deletePages': {
      if (pagesSpec == null || pagesSpec === '') throw new OpError('deletePages needs pages, e.g. "2" or "3-5"')
      const pages = parsePages(pagesSpec, count)
      if (pages.length >= count) throw new OpError('Cannot delete every page')
      return pages.reverse().map(page => ({ type: 'delete', page })) // last first, so earlier numbers stay valid
    }
    case 'movePage': {
      const page = num(op, 'page')
      const to = num(op, 'to')
      if (page == null || to == null) throw new OpError('movePage needs page and to')
      parsePages(page, count)
      return [{ type: 'move', page, to }]
    }
    default:
      throw new OpError(`"${op.op}" is not a page operation`)
  }
}

export const PDF_OPS_HELP = 'info, read, find, textLines, replaceText, annotate, formFields, fillForm, rotate, deletePages, movePage, merge'
