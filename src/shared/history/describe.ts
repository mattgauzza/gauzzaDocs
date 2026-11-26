/**
 * Agent ops in plain words, for version summaries and the work history ("Replaced text and changed cells"). Stored
 * summaries keep these words for good and `gdocs history` prints them, so op names never show through.
 * Op names: src/shared/ops.md and src/shared/ops/*.ts (plus the PDF ops in src/core/ops/pdf.ts).
 */

/** A phrase, or [one, several] when the count changes the words. */
type Phrase = string | [string, string]

const PHRASES: Record<string, Phrase> = {
  // every kind
  write: 'Rewrote the file',
  append: 'Added text at the end',
  prepend: 'Added text at the start',
  insert: 'Inserted text',
  replace: 'Replaced text',
  // text and code
  replaceLines: 'Replaced lines',
  deleteLines: 'Deleted lines',
  // sheets
  set: 'Changed cells',
  setRange: 'Changed cells',
  clear: 'Cleared cells',
  format: 'Formatted',
  insertRows: 'Inserted rows',
  deleteRows: 'Deleted rows',
  insertCols: 'Inserted columns',
  deleteCols: 'Deleted columns',
  merge: 'Merged',
  unmerge: 'Unmerged cells',
  addRule: 'Added conditional formatting',
  updateRule: 'Changed conditional formatting',
  deleteRule: 'Removed conditional formatting',
  addChart: ['Added a chart', 'Added charts'],
  updateChart: ['Changed a chart', 'Changed charts'],
  deleteChart: ['Deleted a chart', 'Deleted charts'],
  addSheet: ['Added a sheet', 'Added sheets'],
  renameSheet: ['Renamed a sheet', 'Renamed sheets'],
  deleteSheet: ['Deleted a sheet', 'Deleted sheets'],
  // slides
  addSlide: ['Added a slide', 'Added slides'],
  updateSlide: ['Changed a slide', 'Changed slides'],
  deleteSlide: ['Deleted a slide', 'Deleted slides'],
  duplicateSlide: ['Duplicated a slide', 'Duplicated slides'],
  moveSlide: ['Moved a slide', 'Moved slides'],
  setNotes: 'Changed speaker notes',
  setTheme: 'Changed the theme',
  // PDFs
  annotate: 'Marked up pages',
  replaceText: 'Replaced text',
  rotate: 'Rotated pages',
  deletePages: 'Deleted pages',
  movePage: ['Moved a page', 'Moved pages'],
  fillForm: 'Filled in the form',
}

/** Where the same op means something else for one kind. */
const BY_KIND: Record<string, Record<string, Phrase>> = {
  sheet: { append: 'Added rows at the end', prepend: 'Added rows at the start', write: 'Rewrote the sheet', merge: 'Merged cells' },
  slides: { append: 'Added slides at the end', prepend: 'Added slides at the start' },
  pdf: { merge: 'Added pages from other PDFs' },
}

/** An op name as words: "replaceText" becomes "Replace text". */
const words = (op: string) => {
  const w = op
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase()
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** One op in plain words. `kind` (doc, sheet, slides, pdf, text) picks the right meaning where ops share a name. */
export function describeOp(op: string, kind?: string, count = 1): string {
  const p = (kind && BY_KIND[kind]?.[op]) || PHRASES[op]
  if (!p) return words(op)
  return typeof p === 'string' ? p : count > 1 ? p[1] : p[0]
}

/**
 * What a run of agent ops did, in the order they first happened, each once: "Replaced text, changed cells and
 * formatted". More than `most` different things end with "and N more". Empty for no ops.
 */
export function describeOps(ops: string[], kind?: string, most = 4): string {
  const counts = new Map<string, number>()
  for (const op of ops) if (op) counts.set(op, (counts.get(op) || 0) + 1)
  const phrases: string[] = []
  for (const [op, n] of counts) {
    const p = describeOp(op, kind, n)
    if (!phrases.includes(p)) phrases.push(p)
  }
  if (!phrases.length) return ''
  const lower = phrases.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)))
  const shown = lower.length > most ? [...lower.slice(0, most), `${lower.length - most} more`] : lower
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}
