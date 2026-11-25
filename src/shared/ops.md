# Agent operations

Every op is `{ "op": name, ...params }`. They run live in the open editor when the file is open in the app,
or on the file on disk when it is not (same results either way). All kinds support `read`, `write`, `info`.

## text (code and plain text)
See src/shared/ops/text.ts.

## doc
- `read { format?: "md" | "html" | "text" }` (default md) -> `{ content }`
- `write { content, format?: "md" | "html" | "text" }` replaces the whole document
- `append` / `prepend { content, format? }`
- `insert { after?: string, before?: string, content, format? }` inserts new blocks after/before the first block whose text contains the string
- `replace { find, with, all?, regex?, ignoreCase? }` text replace, keeps formatting around the match -> `{ count }`
- `find { query, ignoreCase? }` -> `{ matches: [{ block, text }] }`
- `outline` -> `{ headings: [{ level, text }] }`
- `info` -> `{ words, chars, blocks, headings }`

## sheet
Addresses are A1 style; `sheet` picks a sheet by name or 0-based index (default: active / first).
- `read { range?, sheet?, format?: "json" | "csv" | "values" | "formulas" }` -> `{ range, values }` (2D) or `{ content }` for csv
- `get { range, sheet? }` -> `{ cells: { A1: { v, f?, s? } } }`
- `set { cells: { "A1": value | "=FORMULA" | { v, f, s } }, sheet? }`
- `setRange { start: "A1", values: any[][], sheet? }` (strings starting with "=" are formulas)
- `write { content, format?: "csv" | "json" }` replaces the sheet's cells
- `append { values: any[][] }` adds rows under the last used row
- `clear { range, sheet? }`, `format { range, style: CellStyle }`
- `insertRows { at, count? }`, `deleteRows { at, count? }`, `insertCols`, `deleteCols` (1-based row numbers / column letters or 1-based numbers)
- `sheets` -> names, `addSheet { name }`, `renameSheet { sheet, name }`, `deleteSheet { sheet }`
- `info` -> `{ sheets: [{ name, rows, cols }] }`
- `merge { range, mode?: "all" | "horizontal" | "vertical" }`, `unmerge { range }`, `merges`
- `rules`, `addRule { range, rule }`, `updateRule { index, rule }`, `deleteRule { index }` conditional formatting
  (greater/less/between/equal/contains/empty/custom formula with style, or a two-color scale)
- `charts`, `addChart { range, type: "column" | "bar" | "line" | "pie" | "scatter", title? }`, `updateChart { id, ... }`, `deleteChart { id }`

## comments (any kind; through `gdocs comments | comment | reply | resolve | listen`, not `gdocs op`)
Threads are `{ id, author, by: "user" | "agent", text, quote?, resolved?, replies: [...] }`. `gdocs listen <file>` streams
the person's events as JSON lines with `--json`: `comment`, `reply`, `resolved`, `deleted`, and `edit` (`{ line, removed[], added[] }`).

## pdf
Pages are 1-based. Coordinates in points from the top-left of the page.
- `info` -> `{ pages, sizes: [{ w, h }] }`
- `read { pages?: "1-3", format?: "text" | "json" }` -> `{ content }` page texts
- `annotate { edits: PdfEdit[] }` applies PdfEdits (text, highlight, rect, ink, image)
- `rotate { pages, degrees }`, `deletePages { pages }`, `movePage { page, to }`
- `merge { files: string[] }` appends other PDFs (offline / CLI)
- `write` is not supported for PDFs
