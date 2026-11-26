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

## design (.gdesign)
Every op takes `artboard`: an id or a name only one artboard has (default: the first). Layers are named by `layer` (or
`layers`, a list or names separated by commas): an id, a Group/Child path or a name only one layer on the artboard has.
A name that matches nothing fails and lists the artboard's layers. Coordinates are px from the artboard's top left.
Paints are `"#rrggbb"`, `"style:<name>"` (a color style), `"none"` or a paint object (`{ type: "color", color }`, or
`{ type: "linear" | "radial", stops: [{ offset, color }], angle? }`). Each edit, or a whole `apply` batch, is one undo step.
- `read { format?: "text", allArtboards? }` -> `{ artboard, artboards, layers, styles, components }` with one line per
  layer (`id  name  type  x,y wxh  "text"  flags`, indented by depth), or `{ content }` as plain lines with format "text"
- `info` -> `{ artboards, layers }`
- `export { format?: "svg" | "png", width?, scale? }` -> `{ svg, artboard, width, height, artboards, svgLayers, leftOut? }`:
  the artboard as an SVG file, fonts not embedded; `width` sizes the root and keeps the view box. With "png" it's drawn
  as the editor draws it, sized to the PNG's pixels (`width` or the artboard's, times `scale` 1 or 2, at most 16,384 px
  a side), for the app to turn into a PNG (`gdocs design export --format png` does that)
- `add { type, props?, parent?, index? }` -> `{ ids }`. Types: rect, ellipse, line, path, text, image, group, instance,
  connector. Props on every layer: name, x, y, width (w), height (h), rotation, scaleX, scaleY, opacity, blend, visible,
  locked, fill, stroke, strokeWidth, dash, shadow `{ x, y, blur, color }`, blur, timing `{ start?, end? }`. Then by type:
  radius (rect); d (path, SVG path data); text, runs, font, size, weight, italic, color, align, valign, mode (box or
  point), letterSpacing, lineHeight, outlines (text); data (a data URL or base64), asset, fit (image); clip (group);
  component, overrides (instance); from, to, label, route, arrow, points (connector)
- `set { layer, props, part?, allArtboards? }` -> `{ ids, note? }`; `part` names a layer inside an instance's component
  and sets its text, fill, stroke, visible or image for that instance only
- `delete { layer, allArtboards? }` -> `{ ids }` (connectors left joining nothing go too)
- `move { layer, to: "front" | "back" | "forward" | "backward" | { parent, index? }, allArtboards? }` -> `{ ids }`
  (`parent` "" is the top of the artboard; `index` 0 is the back)
- `group { layers, name? }` -> `{ id }`, `ungroup { layer }` -> `{ ids, note? }`
- `align { layers, edge: "left" | "center" | "right" | "top" | "middle" | "bottom", to?: "selection" | "artboard" }` -> `{ ids }`
- `distribute { layers, axis: "x" | "y" }` -> `{ ids }` (3 or more layers, equal gaps)
- `duplicate { layer, dx?, dy? }` -> `{ ids }`
- `artboard { action: "add" | "resize" | "rename" | "delete", name?, size? }` -> `{ id }`; size is `"<w>x<h>"` or a
  preset (instagram, portrait, story, linkedin, x, youtube, logo, letter), at most 8192 px per side
- `style { color?: "Name=#hex" | { name, color }, text?: { name, run: { font, size } }, remove?: name }` -> `{ colors, text }`
- `svg { svg, name?, parent?, index?, x?, y? }` -> `{ id, removed, kept }` imports SVG as a group after cleaning it
  (`removed` says what went); `svg { get: layer | true }` -> `{ svg }`
- `diagram { name?, spec | text }` -> `{ id, nodes, links, containers, note? }` lays a diagram out for you. `text` has one
  item per line: `node <id>: <label> [in <box>]`, `box <id>: <label> [in <box>]`, `<from> -> <to> [: <label>]`,
  `diagram <name>` and `direction right|down|left|up`. `spec` is `{ name, direction?, spacing?, nodes: [{ id, label,
  in? }], links: [{ from, to, label? }], containers?: [{ id, label, in? }] }`. `nodes` and `containers` map spec ids to
  layer ids. The same name again redraws that diagram
- `tidy { diagram?, unpin? }` -> the same: lays a diagram out again around nodes moved by hand (`unpin` moves them too)
- `apply { ops }` -> `{ results }`: up to 1,000 ops in order as one step; the first failure stops it with
  "op <n>: <message>" and changes nothing

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
