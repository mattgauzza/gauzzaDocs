import type { Kind } from './kinds'

// ---------- spreadsheet model (shared by the sheet editor, the formula engine, file IO and the CLI) ----------

export interface CellStyle {
  b?: boolean // bold
  i?: boolean // italic
  u?: boolean // underline
  s?: boolean // strikethrough
  color?: string // text color, #rrggbb
  bg?: string // fill, #rrggbb
  align?: 'left' | 'center' | 'right'
  fmt?: string // number format: 'general' | '0.00' | '#,##0' | '0%' | '$#,##0.00' | 'date' ...
  size?: number // font size in pt
  wrap?: boolean
}

/** One cell. `v` is the typed-in value or a formula's last result; `f` is the formula without the leading "=". */
export interface Cell {
  v?: string | number | boolean | null
  f?: string
  s?: CellStyle
}

export interface Sheet {
  name: string
  cells: Record<string, Cell> // keyed by A1 address, e.g. "B12"
  colWidths?: Record<number, number> // px, by 0-based column index
  rowHeights?: Record<number, number> // px, by 0-based row index
  frozen?: { rows: number; cols: number }
  merges?: string[] // merged blocks as A1 ranges, e.g. "A1:C1"
  conditional?: import('./sheet/extras').ConditionalRule[] // conditional formatting, first matching rule wins
  charts?: import('./sheet/extras').SheetChart[]
}

export interface Workbook {
  sheets: Sheet[]
}

// ---------- PDF edits (applied with pdf-lib by the window on save, and by the CLI) ----------

export type PdfEdit =
  | { type: 'text'; page: number; x: number; y: number; text: string; size?: number; color?: string }
  | { type: 'highlight'; page: number; x: number; y: number; w: number; h: number; color?: string }
  | { type: 'rect'; page: number; x: number; y: number; w: number; h: number; color?: string; fill?: string } // fill '#ffffff' = whiteout
  | { type: 'ink'; page: number; points: [number, number][]; color?: string; width?: number }
  | { type: 'image'; page: number; x: number; y: number; w: number; h: number; png: string } // png as data: URL or base64
  // Edit a line that is already in the PDF: the original text inside x/y/w/h is removed (and covered with bg), then
  // `text` is drawn on the same baseline (`base`, display y). dx/dy move the new text after it was placed.
  | {
      type: 'replaceText'
      page: number
      x: number
      y: number
      w: number
      h: number
      base?: number
      text: string
      size: number
      font?: 'sans' | 'serif' | 'mono'
      bold?: boolean
      italic?: boolean
      color?: string
      bg?: string
      dx?: number
      dy?: number
      // A whole paragraph (shared/pdf/wrap.ts): `text` is wrapped to end at wrapRight (display x); lines after the
      // first start at hang; lineHeight is the old baseline-to-baseline spacing. The paragraph's other lines carry
      // their own replaceText edits with empty text, which take their old words out.
      wrapRight?: number
      hang?: number
      // The PDF font's name ("Calibri-Bold"): written in that font when it's installed, else the standard `font`.
      fontName?: string
      lineHeight?: number
      maxLines?: number
    }
  | { type: 'rotate'; page: number; degrees: number } // added to the page's current rotation
  | { type: 'delete'; page: number }
  | { type: 'move'; page: number; to: number }
// Coordinates are PDF points with the origin at the TOP-left of the page (y grows downward), pages are 1-based.

// ---------- file payloads exchanged between main, the window and the CLI ----------

export type FilePayload =
  // lossy: saving back to this file would drop things the editor cannot show (set for .docx files that use
  // headers, footnotes, tracked changes, ...). Such files save only on Ctrl+S, with lossyReasons shown to the person.
  | { kind: 'doc'; html: string; lossy?: boolean; lossyReasons?: string[] }
  | { kind: 'text'; text: string; eol?: '\n' | '\r\n' }
  | { kind: 'sheet'; workbook: Workbook }
  | { kind: 'pdf'; bytes: Uint8Array; url?: string } // url: stream pages from disk instead of holding all bytes
  | { kind: 'large'; size: number; as: 'text' | 'csv' } // too big to load: viewed in pieces straight from disk
  // ---- slides (begin) ----
  | { kind: 'slides'; deck: Deck; lossy?: boolean; lossyReasons?: string[] }
  // ---- slides (end) ----

// ---------- presentations (.pptx), edited by renderer/src/slides; model helpers in shared/slides ----------

/** A run of text with its own formatting. Sizes are points, colors #rrggbb. */
export interface SlideRun {
  text: string
  b?: boolean
  i?: boolean
  u?: boolean
  color?: string
  size?: number
  font?: string
}
export interface SlidePara {
  runs: SlideRun[]
  bullet?: 'bullet' | 'number'
  level?: number // 0 = top level
  align?: 'left' | 'center' | 'right'
}
/** Positions and sizes are inches on a 13.333 x 7.5 in (16:9) slide; rotation is degrees clockwise. */
export interface SlideElement {
  id: string
  type: 'text' | 'image' | 'shape'
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  role?: 'title' | 'subtitle' | 'body' // placeholders created by a layout (agents address these)
  paras?: SlidePara[] // text (text boxes, and text inside shapes)
  valign?: 'top' | 'middle' | 'bottom'
  shape?: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'arrow'
  fill?: string
  stroke?: string
  strokeWidth?: number // points
  src?: string // image data URL
}
export type SlideLayout = 'title' | 'titleBody' | 'twoColumn' | 'section' | 'blank'
export interface Slide {
  id: string
  layout: SlideLayout
  background?: string
  elements: SlideElement[]
  notes: string
}
export interface DeckTheme {
  name: string
  headFont: string
  bodyFont: string
  text: string
  accent: string
  background: string
}
export interface Deck {
  size: { w: number; h: number }
  theme: DeckTheme
  slides: Slide[]
}

export interface OpenFile {
  path: string
  kind: Kind
  payload: FilePayload
  mtime: number
}

// ---------- agent operations (CLI -> app -> editor, or CLI -> file on disk when not open) ----------

/**
 * Every operation is a plain object with an `op` name. Common to all kinds:
 *   { op: 'read', format?: 'text' | 'md' | 'html' | 'json' | 'csv' }   -> { content }
 *   { op: 'write', content, format? }                                 -> { ok }
 *   { op: 'info' }                                                    -> kind specific summary
 * Kind specific ops are documented in src/shared/ops.md and implemented per editor.
 */
export interface AgentOp {
  op: string
  [k: string]: unknown
}

/** Who is editing, shown as an avatar in the window while an agent works on the file. */
export interface AgentInfo {
  name: string
  color?: string
}

export interface RecentFile {
  path: string
  kind: Kind
  opened: number
}

export interface Settings {
  docsDir: string // where new files are created
  newDocFormat: 'html' | 'md' | 'docx'
  autosave: boolean
  theme: 'system' | 'light' | 'dark'
  registry: string // plugin library URL (registry.json) or local folder
  textWrap: boolean
  fontSize: number
  spellcheck?: boolean // check spelling in documents and prose files (default on)
  historyExclude?: string[] // file name patterns (* wildcard) that are never versioned
  historyCapMB?: number // size cap for stored version history
}

export interface Author { name: string; by: 'person' | 'agent' | 'outside' }

export interface HistoryVersion {
  n: number
  firstAt: number
  at: number
  hash: string
  size: number
  mtime: number
  authors: Author[]
  summary: string
  name?: string
  baseline?: boolean
  beforeRestore?: boolean
  restoredFrom?: number
}

export interface HistoryIndex {
  path: string
  versions: HistoryVersion[]
  /** Set by cleanup when it first sees the file absent from a reachable drive; cleared when it is back. */
  missingSince?: number
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  main: string // ESM file, relative to the plugin folder
  files?: string[] // every file to download when installing from the library
  languages?: string[] // languages the plugin cares about (for listing only)
}

export interface InstalledPlugin extends PluginManifest {
  dir: string
  enabled: boolean
}
