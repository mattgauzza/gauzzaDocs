# Design editor 1a: agents build layered designs (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `.gdesign` file kind that agents build layer by layer through `gdocs design`, with auto-laid-out diagrams,
SVG import, SVG and PNG export, insert into documents and an editor where Matt sees, selects, moves and restyles layers.

**Architecture:** A design is a zip (`design.json` plus content-hashed assets). One pure function, `designToSvg`, draws
every artboard everywhere (editor, `gdocs look`, thumbnails, exports), measuring text with fontkit so line breaks match.
Agent ops are shared between the live editor and the CLI (like slides); diagram layout runs ELK in node (the worker or the
CLI), never in the window. Rasterizing (PNG, thumbnails, look) happens in the app's hidden window.

**Tech Stack:** TypeScript, React 19, Electron 45, JSZip 3.10 (made a direct dependency), `@pdf-lib/fontkit` (already a
dependency), `@xmldom/xmldom` (already), `elkjs` (new), node:test.

**Spec:** docs/superpowers/specs/2026-11-25-design-editor-design.md. This plan is release 1 part a. Part b (hand editing
like Figma: drawing tools (rectangle, ellipse, line, pen, text, image), rotate, snapping and guides, text editing on
the canvas, the full properties panel, styles and components UI, boolean operations and masks, File > Import SVG, PDF
export) is a separate plan. Releases 2 and 3 come after. In this part, layers are added by agents (or by Matt through
`gdocs`), and Matt selects, moves, resizes, hides, locks, renames and restyles them in the app.

**Starts from:** main after the version history branch is merged. `saveFile(file, payload, ctx?: WriteContext)`,
`payloadBytes`, `guardedWrite`, `src/shared/history/describe.ts` and `src/core/history/compare.ts` exist then.

## Global Constraints

- Extension `.gdesign`: a zip holding only `design.json`, `assets/<sha256>.<ext>` and `thumbnail.png`. Reading ignores
  every other entry and refuses archives over 1 GB uncompressed or with more than 10,000 entries. Image and paint layers
  may point only into `assets/`. Assets are immutable and named by content hash.
- Assets are stored in the zip uncompressed (STORE); `design.json` and `thumbnail.png` use DEFLATE.
- Artboards at most 8192 px per side. Placed images refused above 50 megapixels, checked from the image header before
  decoding.
- One renderer: `designToSvg` is the only code that turns a design into SVG. The editor, `gdocs look`, thumbnails and
  every export use it.
- SVG from outside is parsed with `@xmldom/xmldom` and passed through an allowlist before it's stored. Removed: script,
  foreignObject, every `on*` attribute, animation of `href`, and every reference outside the fragment (`http:`, `https:`,
  `file:`, other documents, CSS `@import`, `url()` to anything but the fragment's own ids). External images are dropped
  and listed in the reply. `<use>` expands to a depth of 8. Fragments over 5 MB or 50,000 elements are refused.
- An `svg` layer is drawn as an image (`<image href="data:image/svg+xml;base64,...">`), never as inline markup.
- Every write to a `.gdesign` from the CLI or the worker holds `<file>.lock` (exclusive `wx`, content `{ pid, at }`,
  stale after 60 s). An offline op loads, applies and saves under that lock and stops with "Changed by someone else;
  reload to see it" if the file's size or mtime changed since it was loaded.
- While a design is open in the app, every op goes to the editor and the CLI refuses `--offline` for it with
  "This design is open in gauzzaDocs. Edit it there, or close it first."
- Each agent op, or each `apply` batch, is one undo step named `<agent>: <summary>` (for example "Claude: added 3 layers").
- Fonts are named by family, weight, style and PostScript name, never by a Windows registry name. A font file is packed
  into a design only when its OS/2 fsType is 0 or 8. Packed fonts register under the family `gd-<first 12 hex of the
  asset hash>`. SVG export never embeds fonts.
- Layers are addressed with `--layer <id|name|path>`. A name works only when it's unique on the artboard; otherwise the
  command fails with "<n> layers are named "<name>": <ids>".
- New design presets (CLI `--size` names): `instagram` 1080x1080, `portrait` 1080x1350, `story` 1080x1920, `linkedin`
  1200x627, `x` 1600x900, `youtube` 1280x720, `logo` 1000x1000 transparent, `letter` 816x1056 (a letter page at 96
  dpi, for diagrams in documents), or `<w>x<h>`.
- PNG export, `gdocs look` and thumbnails need the app. Without it they fail with "Start gauzzaDocs to render designs.
  Editing and SVG export work without it." A save made without the app keeps the old thumbnail and sets
  `design.thumbnailStale = true`; the app redraws it on the next save.
- Copy in UI, CLI and README: plain, sentence case, ASCII only, no em dashes, no dashes as punctuation, no Oxford
  commas. The README speaks as Matt in the first person.
- Tests run on Linux in CI (ubuntu-latest). Tests that need Windows fonts skip when the file is missing. The test font is
  `node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf` (and its Bold, Italic files).

## Review Focus

- A design made with a font that isn't installed on another PC: text still draws (packed font, or stored glyph outlines
  when the license forbids packing) and the layer reports "font not installed". Test in Task 3.
- A hostile or broken .gdesign: zip bomb sizes, 10,001 entries, entry names like `../../x` or `assets/../../x`, a layer
  pointing at `../secret.png`. Each is refused or ignored; nothing is read from or written outside the zip. Test in
  Task 1.
- An agent sends SVG with `<script>`, `onload`, `<foreignObject>`, `href="https://..."` or `url(file:...)`. The stored
  layer and every export contain none of it, and the reply lists what was removed. Test in Tasks 4 and 10.
- Two writers: `--offline` while the design is open in the app, and two CLI processes editing at once. The first is
  refused; the second serializes with no lost op. Test in Task 7.
- Two layers named "Title" and an agent runs `set --layer Title`: the command fails and lists both ids instead of
  editing one. Test in Task 5.

---

### Task 1: The design model and the .gdesign file

**Files:**
- Create: `src/shared/design/types.ts`, `src/shared/design/model.ts`, `src/core/formats/design.ts`
- Modify: `package.json` (add `"jszip": "^3.10.1"` to dependencies; it's already installed as a transitive dependency)
- Test: `test/design-format.test.ts`

**Interfaces:**
- Produces, in `src/shared/design/types.ts` (the full format, including fields later releases use, so files never need
  converting):

```ts
export type Paint =
  | { type: 'color'; color: string }                       // #rrggbb or #rrggbbaa
  | { type: 'linear' | 'radial'; stops: { offset: number; color: string }[]; angle?: number }
  | { type: 'style'; ref: string }                         // a named color in styles, or kit/<name> (release 2)
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'
export interface FontRef { family: string; weight: number; style: 'normal' | 'italic'; postscript?: string; asset?: string }
export interface TextRun { text: string; font: FontRef; size: number; color?: Paint; letterSpacing?: number; lineHeight?: number }
export interface Shadow { x: number; y: number; blur: number; color: string }
export interface Timing { start?: number; end?: number; in?: string; out?: string; tracks?: unknown[]; text?: unknown }
interface Base {
  id: string; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode
  x: number; y: number; width: number; height: number; rotation: number; scaleX: number; scaleY: number
  fill?: Paint | null; stroke?: Paint | null; strokeWidth?: number; dash?: number[]; radius?: number
  shadow?: Shadow; blur?: number; timing?: Timing
}
export type Layer =
  | Base & { type: 'rect' | 'ellipse' | 'line' }
  | Base & { type: 'path'; d: string }                     // path data in the layer box's coordinates
  | Base & { type: 'text'; runs: TextRun[]; mode: 'box' | 'point'; align: 'left' | 'center' | 'right' | 'justify';
      valign: 'top' | 'middle' | 'bottom'; outlines?: boolean; glyphs?: string; missingFont?: boolean }
  | Base & { type: 'image' | 'paint'; asset: string; fit?: 'fill' | 'contain' | 'cover' }
  | Base & { type: 'group'; children: Layer[]; clip?: boolean }          // clip: the first child masks the rest
  | Base & { type: 'instance'; component: string; overrides: Record<string, Override> }
  | Base & { type: 'connector'; from: End; to: End; label?: string; route: 'straight' | 'orthogonal';
      points?: [number, number][]; arrow: 'end' | 'both' | 'none' }
  | Base & { type: 'svg'; svg: string }                    // cleaned SVG the converter couldn't map
export interface End { layer: string; side?: 'auto' | 'top' | 'right' | 'bottom' | 'left' }
export interface Override { text?: string; fill?: Paint; stroke?: Paint; visible?: boolean; asset?: string }
export interface Component { id: string; name: string; root: Layer & { type: 'group' } }
export interface Styles { colors: { name: string; color: string }[]; text: { name: string; run: Omit<TextRun, 'text'> }[] }
export interface Diagram {
  name: string; direction: 'right' | 'down' | 'left' | 'up'; spacing: number; nodeComponent: string
  nodes: { id: string; layer: string; container?: string; pinned?: boolean; icon?: string }[]
  links: { from: string; to: string; layer: string; label?: string }[]
  containers: { id: string; layer: string; in?: string }[]
}
export interface Artboard { id: string; name: string; width: number; height: number; background: Paint | null;
  layers: Layer[]; animation?: { duration: number; fps: number; loop: boolean }; diagrams?: Diagram[] }
export interface Design { format: 1; id: string; artboards: Artboard[]; components: Component[]; styles: Styles;
  kit?: { kitId: string; items: { itemId: string; name: string; copy: unknown }[] }; thumbnailStale?: boolean }
export interface DesignFile { design: Design; assets: Record<string, Uint8Array>; thumbnail?: Uint8Array }
export type TextLayer = Extract<Layer, { type: 'text' }>
export interface ElkGraph { id: string; layoutOptions?: Record<string, string>; x?: number; y?: number; width?: number;
  height?: number; children?: ElkGraph[]; edges?: { id: string; sources: string[]; targets: string[];
  sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[] }[] }
```

  Layer boxes are in artboard coordinates, groups included (moving a group moves its children's x and y). Rotation is
  degrees about the box center; resizing changes width and height, never scale.
- Produces, in `src/shared/design/model.ts`:
  - `PRESETS: Record<string, { width: number; height: number; transparent?: boolean; label: string }>` with the sizes in
    Global Constraints.
  - `newDesign(preset: string): Design`, which parses `<w>x<h>` too and throws `Unknown size "<s>". Use one of: ...`.
  - `newId(): string`, eight base36 characters, unique within the design.
  - `walk(layers: Layer[], fn: (l: Layer, parent: Layer | null, path: string[]) => void): void`.
  - `findLayers(design: Design, artboardId: string, ref: string): Layer[]`, which matches by id, then by name, then by a
    `Group/Child` path.
  - `resolveLayer(design, artboardId, ref): Layer`, which throws the ambiguous-name error from Global Constraints, or
    `No layer "<ref>" on <artboard name>`.
  - `artboardOf(design, ref?: string): Artboard`: the first artboard by default, otherwise by id or name.
- Produces, in `src/core/formats/design.ts`:
  - `readDesignZip(bytes: Uint8Array): Promise<DesignFile>`.
  - `designZipBytes(f: DesignFile, base?: Uint8Array): Promise<Uint8Array>`. When `base` is the file as it is on disk,
    assets the design references but `f.assets` lacks are copied from it, and assets nothing references are dropped.
    That way autosave sends only `design.json` and new assets.
  - `assetName(bytes: Uint8Array, ext: string): string`, which returns `assets/<sha256>.<ext>`.

- [ ] **Step 1: Write the failing tests** in `test/design-format.test.ts`:
  - `newDesign('instagram')` has one 1080x1080 artboard. `newDesign('logo')` has `background: null`.
    `newDesign('640x480')` works. `newDesign('poster')` throws the unknown-size message.
  - Round trip: a design with a rect, a text layer, a group with two children and one image asset survives
    `designZipBytes` then `readDesignZip` deep-equal. The asset entry uses STORE, which JSZip reports as
    `_data.compression.magic === '\x00\x00'`, or check `options.compression`.
  - Hostile zips, each built with JSZip in the test:
    - 10,001 entries rejects with "too many entries".
    - A `design.json` whose declared uncompressed size is over 1 GB rejects with "too large".
    - An entry `../../x.txt` and an entry `assets/../../x` are ignored.
    - A layer with `asset: '../secret.png'` makes `readDesignZip` throw "Layer <id> points outside assets/".
  - `resolveLayer` with two layers named "Title" throws a message containing both ids.
- [ ] **Step 2: Run `npm test -- design-format`.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three files. Check the limits from JSZip's central directory (`zip.files`, the
  `_data.uncompressedSize` of each entry) before inflating anything.
- [ ] **Step 4: Run `npm test -- design-format`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): design model and .gdesign zip format`

### Task 2: Fonts for designs

**Files:**
- Modify: `src/core/systemFonts.ts`
- Create: `src/shared/design/fonts.ts`
- Test: `test/design-fonts.test.ts`

**Interfaces:**
- Consumes: `FontRef` and `Design` (Task 1).
- Produces, in `src/core/systemFonts.ts`:
  - `listFontFaces(): Promise<FontFace[]>`, where `FontFace = { family: string; weight: number; style: 'normal' | 'italic';
    postscript: string; file: string; index: number }`. `index` is the face index inside a .ttc, and a variable font
    lists its named instances.
  - `fontFaceBytes(ref: FontRef): Promise<Uint8Array | null>`, which returns the closest face: same family, nearest
    weight, same style. A .ttc returns the bytes of the whole collection, and `fontsFor` picks the face by `postscript`.
  - Existing exports are unchanged.
  - The face list is built lazily and cached, reading names with `@pdf-lib/fontkit` (`familyName`, `subfamilyName`,
    `postscriptName`, `'OS/2'.usWeightClass`, `italicAngle`).
- Produces, in `src/shared/design/fonts.ts`:
  - `type LoadedFont = { font: any; family: string; packedFamily?: string; missing?: boolean }`.
  - `interface FontSource { get(ref: FontRef): LoadedFont; fallback: LoadedFont }`.
  - `fontsFor(design: Design, assets: Record<string, Uint8Array>, fetch: (ref: FontRef) => Promise<Uint8Array | null>,
    fallbackBytes: Uint8Array): Promise<FontSource>`. It loads every font the design names: a packed asset first, then
    `fetch`. A font it can't find resolves to the fallback with `missing: true`.
  - `canPack(bytes: Uint8Array): boolean`, true when OS/2 fsType is 0 or 8.
  - `packedFamily(assetName: string): string`, which returns `gd-<first 12 hex of the hash>`.
- Fallback font: Liberation Sans Regular (copied by Task 7 into `resources/fonts/`, path passed in), so designs render
  the same with no system fonts at all.

- [ ] **Step 1: Write the failing tests:**
  - `fontsFor` with a packed Liberation Sans asset resolves it with `packedFamily` set.
  - A family no `fetch` can find resolves to the fallback with `missing: true`.
  - `canPack` is true for Liberation Sans. It's false for a copy whose OS/2 `fsType` bytes the test patches to 2.
  - On Windows only (skip when `C:/Windows/Fonts/cambria.ttc` is missing), `listFontFaces()` includes a Cambria face
    from the .ttc with `index` 0 and a Cambria Math face with `index` 1.
- [ ] **Step 2: Run `npm test -- design-fonts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-fonts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): font faces, packing rules and font loading`

### Task 3: Text layout and the one renderer

**Files:**
- Create: `src/shared/design/text.ts`, `src/shared/design/render.ts`
- Test: `test/design-render.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces, in `text.ts`:
  - `layoutText(layer: TextLayer, fonts: FontSource, overrideText?: string): TextLayout`, where `TextLayout = { lines: {
    x: number; y: number; width: number; spans: { text: string; run: number; x: number; width: number }[] }[];
    height: number; overflow: boolean }`.
  - Measures with fontkit's `layout(text).glyphs` advances. Box text wraps at the box width on spaces (a single word
    wider than the box breaks by letter). Point text never wraps.
  - `lineHeight` defaults to 1.2.
- Produces, in `render.ts`:
  - `designToSvg(design: Design, artboardId: string, opts: RenderOptions): string`, where `RenderOptions = { fonts:
    FontSource; assets: Record<string, Uint8Array>; mode: 'raster' | 'export'; outlines?: boolean; seconds?: number }`.
  - `layerToSvg(design, layer, opts): string`.
  - `connectorPath(design, artboard, layer): [number, number][]` (shared with Task 6).
- Rules the renderer follows:
  - The root `<svg>` has the artboard's width, height and viewBox, plus the background when there is one.
  - Each layer is `<g id="l-<layer id>" data-name="<name>" inkscape:label="<name>">`. Top-level layers also get
    `inkscape:groupmode="layer"`.
  - Names and text are XML-escaped.
  - Hidden layers are skipped in `raster` mode and get `display="none"` in `export` mode.
  - Opacity is set as `opacity`. Non-normal blend modes become `style="mix-blend-mode:<mode>"`.
  - Rotation becomes `transform="rotate(r cx cy)"`, and scale is applied about the box center.
  - Shadows and blurs use SVG 1.1 filters with ids prefixed by the layer id.
  - Paints become fills. Gradients go into `<defs>` with ids `g-<layer id>-<n>`. A `style` paint resolves through
    `design.styles.colors`; an unknown style draws `#000000`.
  - Text:
    - In `raster` mode, and in `export` mode with `outlines`, text becomes `<path>` glyph outlines from fontkit.
    - In `export` mode without outlines, it becomes `<text>` with one `<tspan>` per line at the computed x and y, and
      `font-family` set to the run's family.
    - A layer with `glyphs` and a missing font draws the stored outlines.
  - Images and paint layers become `<image href="data:<mime>;base64,...">`.
  - An instance draws its component's root with overrides applied by inner layer id.
  - A connector draws a polyline (its `points`, or a straight or elbow route between the two layers' box sides) with an
    arrow marker, and its label at the midpoint.
  - An `svg` layer becomes `<image href="data:image/svg+xml;base64,...">` sized to its box.

- [ ] **Step 1: Write the failing tests** (Liberation Sans as the only font):
  - A 300 px wide box with "The quick brown fox jumps over the lazy dog" at 32 px wraps to 3 lines.
  - The same text as point text is 1 line.
  - A 40 px tall box makes `overflow` true.
  - `designToSvg` output:
    - parses as XML (xmldom)
    - has `<g id="l-<id>"` and `inkscape:label` for each layer
    - escapes a name `<Logo & "Mark">`
    - draws text as `<path` in raster mode and `<text` with `<tspan>` per line in export mode
    - resolves a style paint to its color
    - applies an instance override's text in place of the component's text
    - turns an `svg` layer into `<image` and never into inline markup
  - A text layer whose font is missing renders through the fallback, and the layer's report (`missingFont`) is true.
- [ ] **Step 2: Run `npm test -- design-render`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-render`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): text layout and the shared SVG renderer`

### Task 4: Safe SVG in and out

**Files:**
- Create: `src/shared/design/svgClean.ts`, `src/shared/design/svgImport.ts`
- Test: `test/design-svg.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces:
  - `cleanSvg(svg: string): { svg: string; removed: string[] }` applies the allowlist from Global Constraints and
    throws over 5 MB or 50,000 elements. `removed` lists what went, in plain words, for example "a script",
    "an onload attribute" or "an external image (https://...)".
  - `importSvg(svg: string, name: string): { group: Layer & { type: 'group' }; removed: string[]; kept: string[] }`.
  - It converts after cleaning:
    - `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` and `path` become `path` layers. Transforms are baked
      into the path data, and arcs become cubic curves when a transform isn't a plain translate or uniform scale.
    - `g` becomes a group.
    - `<defs>` linear and radial gradients become gradient paints.
    - A `clipPath` becomes a clipped group.
    - `<use>` expands to depth 8.
    - Simple `<style>` rules (element, class and id selectors) apply as attributes.
    - `<image>` keeps only `data:` images, which become assets.
  - Naming: a child is named from `id`, `inkscape:label` or `data-name`, otherwise `Path 1`, `Path 2`, and so on.
  - Anything else (filters, masks, patterns, text with complex layout) stays as a cleaned `svg` layer, listed in `kept`
    with the reason.
  - The group's box is the union of its children's boxes, and the viewBox maps to px.
  - `layerAsSvg(design, layer, opts)` returns one layer as a standalone, clean SVG in its own coordinates. It's used by
    `svg --get`.
  - A path math helper lives in `svgImport.ts` (parse, transform, bounds), with no new dependency.

- [ ] **Step 1: Write the failing tests:**
  - Each of `<script>`, `onload=`, `<foreignObject>`, `<a href="https://x">`, `<image href="https://x/a.png">`,
    `style="fill:url(file:///c:/x)"`, `<animate attributeName="href">` and `@import url(https://x)` is gone from
    `cleanSvg` output and named in `removed`.
  - A 6 MB string throws. 50,001 `<rect/>` throws. `<use>` chained 9 deep stops at 8.
  - `importSvg` on a two-path logo with `id="mark"` and `inkscape:label="Word"` names the children "mark" and "Word".
  - A `transform="translate(10 20) scale(2)"` path's bounds come out doubled and offset.
  - A linear gradient becomes a `linear` paint with two stops.
  - A `<filter>` element's target stays as an `svg` layer listed in `kept`.
- [ ] **Step 2: Run `npm test -- design-svg`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-svg`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): SVG cleaning and import into native layers`

### Task 5: Design ops

**Files:**
- Create: `src/shared/ops/design.ts`
- Modify: `src/shared/ops/types.ts` (an optional `services` on the op context), `src/shared/history/describe.ts`
  (phrases for the design ops)
- Test: `test/design-ops.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  - `ctx` gains `services?: { fonts?: FontSource; layout?: (graph: ElkGraph) => Promise<ElkGraph> }`, with `ElkGraph`
    from `types.ts` (Task 1). Ops that measure text need `fonts`.
  - `applyDesignOp(file: DesignFile, op: AgentOp, services): Promise<{ result: unknown; file?: DesignFile; summary:
    string }>`.
  - `designOps: OpHandler`.
  - `summary` is the undo step's text, such as "added 3 layers".
- Ops, each taking `artboard?` (default: the first artboard) and returning ids:
  - `read`:
    - `{ artboards, layers }` as one line per layer: `id  name  type  x,y wxh  text`, indented by depth.
    - Styles and components.
    - The plain lines when `format: 'text'`.
  - `add` (`type`, `props`, `parent?`, `index?`): returns `{ ids }`. Defaults: visible, unlocked, opacity 1, blend normal,
    rotation 0, scale 1, and a name like "Rectangle 2".
  - `set` (`layer`, `props`, `part?`): `part` writes the instance override for that inner layer.
  - `delete` (`layer`).
  - `move` (`layer`, `to: 'front' | 'back' | 'forward' | 'backward' | { parent, index }`).
  - `group` (`layers[]`, `name?`): returns `{ id }`. `ungroup` (`layer`).
  - `align` (`layers[]`, `edge: left|center|right|top|middle|bottom`, `to: 'selection' | 'artboard'`).
  - `distribute` (`layers[]`, `axis: x|y`).
  - `duplicate` (`layer`, `dx?`, `dy?`): returns `{ ids }`.
  - `artboard` (`action: add|resize|rename|delete`, `name?`, `size?`).
  - `style` (`color?: { name, color }`, `text?: { name, run }`, `remove?: name`): named colors and text styles in
    `design.styles`. A fill or stroke can then be `{ type: 'style', ref: name }`. On the CLI the shorthand
    `--fill style:<name>` does the same.
  - `svg`: `svg` (import, returns `{ id, removed, kept }`) or `get` (returns `{ svg }`).
  - `apply` (`ops[]`): runs them in order on one copy. It is one result and one summary, and all or nothing: the first
    failure stops it with the op number and error.
- Rules:
  - `allArtboards: true` on `set`, `delete` and `move` matches by name across artboards.
  - Image `props.data` (a data URL or base64) becomes an asset. Its width and height are read from the PNG, JPEG, GIF or
    WebP header, and over 50 megapixels it's refused with "Images over 50 megapixels can't be placed."
  - Artboard sizes over 8192 are refused.

- [ ] **Step 1: Write the failing tests:**
  - `add` a rect and a text, then `read`, lists both with their ids.
  - `set --layer Title` with two layers named "Title" fails, listing both ids.
  - `set` with `part` on an instance writes `overrides[innerId].text`.
  - `group` then `move` into the group then `ungroup` keeps the boxes.
  - `align left to artboard` puts x at 0.
  - `apply` with a bad third op leaves the design unchanged and reports "op 3: ...".
  - Adding a 9000x9000 PNG (just a header built in the test) is refused.
  - `artboard resize 9000x10` is refused.
  - `describeOps(['add'], 'design')` reads "Added layers".
  - `style` with color `Brand=#1a73e8`, then a rect with fill `{ type: 'style', ref: 'Brand' }`, renders `#1a73e8`.
    Changing the style later changes the rect.
- [ ] **Step 2: Run `npm test -- design-ops`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-ops`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): shared design ops for agents and the editor`

### Task 6: Diagrams that lay themselves out

**Files:**
- Create: `src/shared/design/diagram.ts`, `src/core/design/layout.ts`
- Modify: `package.json` (add `"elkjs"` to dependencies at the current 0.10.x), `src/shared/ops/design.ts` (the
  `diagram` op), `src/shared/design/render.ts` (connector routes, if needed)
- Test: `test/design-diagram.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 and 5.
- Produces:
  - `type DiagramSpec = { name: string; direction?: 'right' | 'down' | 'left' | 'up'; nodes: { id: string; label: string;
    in?: string; icon?: string }[]; links: { from: string; to: string; label?: string }[]; containers?: { id: string;
    label: string; in?: string }[] }`.
  - `parseDiagramText(text: string): DiagramSpec` reads one item per line: `node <id>: <label> [in <container>]`,
    `box <id>: <label> [in <container>]`, `<from> -> <to> [: <label>]`.
  - `diagramGraph(spec, sizes): ElkGraph` and `applyLayout(design, artboard, spec, laidOut): Design`.
  - `ElkGraph` is in `types.ts` (Task 1).
  - `layoutDiagram(graph: ElkGraph): Promise<ElkGraph>` in `src/core/design/layout.ts` (node only) imports
    `elkjs/lib/elk.bundled.js` lazily and runs the layered algorithm with `elk.hierarchyHandling: INCLUDE_CHILDREN` and
    spacing from the spec.
  - ELK never loads in the window, which has no `unsafe-eval` in its CSP. Task 7 wires the worker job and the window
    API.
  - The `diagram` op takes `spec` (JSON) or `text`. It returns `{ id, nodes: Record<string, string>, links: string[] }`,
    mapping spec ids to layer ids. Behaviour:
    - Node sizes come from measuring labels with `layoutText` (16 px padding, minimum 120x48).
    - Nodes are instances of a `Diagram node` component created on first use (rounded rect plus centered text), with
      the label as the text override.
    - Containers are groups with a labeled frame.
    - Links are connectors with `points` from ELK's edge sections.
    - Running again with the same `name` updates by node id: new nodes are added, missing ones removed, and labels
      changed. Pinned nodes keep their position, passed to ELK as fixed positions.
  - `set` or `move` on a node layer clears `points` on its connectors, so they re-route straight or elbowed and stay
    attached, and marks the node `pinned`.
  - `tidy` (`diagram`, `name`) lays out again around pinned nodes.

- [ ] **Step 1: Write the failing tests** (they call `layoutDiagram` directly):
  - Matt's proposal shape is a container "Shared agent" with node "agent", and containers "Client A" and "Client B",
    each holding "job" and "forecast and deck" nodes with links job -> forecast. It produces 5 nodes, 3 containers and
    the links, with no two node boxes overlapping. Every node sits inside its container's box.
  - The same spec run again with one label changed keeps every layer id and changes only that label.
  - Moving a node with `set` clears its connectors' points and pins it. `tidy` then keeps its x and y.
  - `parseDiagramText` reads the line format.
- [ ] **Step 2: Run `npm test -- design-diagram`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-diagram`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): diagrams with automatic layout`

### Task 7: Designs open, save and take ops in the app and on disk

**Files:**
- Create: `src/core/design/lock.ts`, `src/renderer/src/design/DesignEditor.tsx` (a first version: artboards drawn with
  `designToSvg` side by side, zoom, live agent ops with undo), `src/renderer/src/design/design.css`,
  `resources/fonts/LiberationSans-Regular.ttf` (copied from pdfjs-dist, with its license)
- Modify:
  - `src/shared/kinds.ts` (`Kind` gains `'design'`, `kindOf`, `OPEN_FILTERS` "Designs")
  - `src/shared/types.ts` (`FilePayload` gains `{ kind: 'design'; file: DesignFile; partial?: boolean }`). With
    `partial`, `file.assets` holds only assets added since the last save, and `payloadBytes` passes the file on disk
    as `base` to `designZipBytes`. The editor sends `partial` saves.
  - `src/core/files.ts` (`loadFile`, `payloadBytes`, `createFile` with a preset; a design's `createFile(file, ctx,
    preset?)`)
  - `src/core/ops/index.ts` (`HANDLERS.design`; for design files, `runOffline` holds the lock across load, apply and save,
    and checks size and mtime before writing)
  - `src/main/worker.ts`: the job `designLayout: [graph]`, calling `layoutDiagram`. `runOffline` passes
    `layoutDiagram` directly as `services.layout`.
  - `src/renderer/src/lib.ts`: `api.designLayout(graph)`.
  - `src/main/index.ts`:
    - the api `designLayout`
    - the rpc method `isOpen` (`{ path }` gives `{ open: boolean }`)
    - `newFilePath` maps: design defaults to `gdesign` and "Untitled design"
    - `saveAsDialog` choices
    - `READ_ONLY_OPS` gains nothing new (`read` is already there)
    - the rpc `op` case refuses `--offline` designs that are open, by answering an `isOpen` rpc the CLI asks first
  - `src/cli/common.ts` (before an offline design op, ask the app `isOpen` and refuse with the Global Constraints
    message)
  - `src/cli/index.ts` (`gdocs new design <name> --size <preset>`)
  - `src/renderer/src/editors.ts`, `src/renderer/src/shell/icons.tsx` (`KIND_COLOR.design = '#7b5cf0'` and a
    layered-squares glyph), `src/renderer/src/shell/Home.tsx` (a "Blank design" tile that asks for a size from
    `PRESETS`, and a "Designs" filter chip)
  - `src/renderer/src/App.tsx` (`exportsFor.design`, `textOf` for designs via the `read` op)
  - `src/core/history/store.ts` (`STORED_AS_IS` gains `gdesign`), `src/core/history/compare.ts` (`versionText` for a
    design is its `read` text)
  - `src/main/winAssoc.ts` (`['gdesign', 'gauzzaDocs design']`)
  - `package.json` (`build.mac` and `build.linux` `fileAssociations` gain gdesign)
- Test: `test/design-kind.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces:
  - `withDesignLock<T>(file: string, fn: () => Promise<T>): Promise<T>` (Global Constraints values).
  - The `design` kind through every `Record<Kind, ...>`.
  - The DesignEditor handle:
    - `getPayload` and `peekPayload`
    - `agent(op, agent)`, which applies through `applyDesignOp` with `services.fonts` from the open file and
      `services.layout = api.designLayout`. It pushes one undo step named `<agent>: <summary>`, calls `onChange` and
      flashes the touched layers.
    - `zoomBy`
    - `status`
  - Undo and redo keep 100 design snapshots.

- [ ] **Step 1: Write the failing tests:**
  - `createFile('x.gdesign', ctx, 'story')` then `loadFile` gives a design payload with a 1080x1920 artboard.
  - `runOffline` `add` then `read` sees the layer.
  - Two concurrent `runOffline` adds (`Promise.all`) both land, so `read` shows 2 layers.
  - A save whose file changed after load (the test rewrites the file between load and save through a hook) throws
    "Changed by someone else; reload to see it".
  - A lock file older than 60 s is taken over.
  - `versionText` of a design lists its layers.
  - `kindOf('a.GDESIGN')` is `'design'`.
- [ ] **Step 2: Run `npm test -- design-kind`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, `npx tsc --noEmit` and `npm run build`.** Expected: all pass.
- [ ] **Step 5: Manual check** in an isolated instance (temp `GAUZZADOCS_HOME`, its own `--user-data-dir` and
  `--remote-debugging-port`, the CDP helper in the session scratchpad; never touch the installed app).
  - `gdocs new design Post --size instagram`, then three `gdocs design add` calls while it's open: they land live, and
    Ctrl+Z undoes "Agent: added layers" as one step.
  - `gdocs design add --offline` on the open file is refused.
  - Take a screenshot.
- [ ] **Step 6: Commit** `feat(design): the design kind in the app, on disk and in history`

### Task 8: gdocs design commands and the agent skill

**Files:**
- Create: `src/cli/design.ts`
- Modify: `src/cli/index.ts` (register; `gdocs read` on a design prints the `read` lines), `src/core/agentSkills.ts`
  (a "Designs" section), `src/shared/ops.md` (the design ops)
- Test: `test/design-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 5 to 7. Commands go through `ctx.run(file, op, o)` with `liveOptions`, like `src/cli/slides.ts`.
- Produces these commands, all with `--json`, `--artboard <ref>`, and ids printed in the replies:
  - `gdocs design add <file> --type <t>` with `--name --x --y --w --h --fill --stroke --text --font --size --radius
    --parent`, plus `--props <json>`
  - `gdocs design set <file> --layer <ref>`, with the same flags, `--part <inner>` and `--all-artboards`
  - `delete`, `move --to <front|back|forward|backward|group>`, `group --layers a,b,c --name`, `ungroup`
  - `align --layers ... --edge ... [--to-artboard]`, `distribute`, `duplicate`
  - `artboard <add|resize|rename|delete>`
  - `style <file> --color <name>=<#hex>`, `style <file> --text <name> --font --size --weight` and
    `style <file> --remove <name>`
  - `apply <file> -` (a JSON array on stdin)
  - `svg <file> --name <n> -` (import from stdin or `@file.svg`) and `svg <file> --get <layer>`
  - `diagram <file> -` (JSON or lines on stdin) with `--name`, and `diagram tidy <file> --name`
  - `export <file> --format svg|png [--scale 1|2] [--width <px>] [--out <path>]`. svg works offline; png is Task 10.
- Skill text (`agentSkills.ts`, plain style): build in layers with names; group related layers; use styles for brand
  colors; send batches with `apply`; draw diagrams with `diagram`, not by hand; import logos with `svg`; check the result
  with `gdocs look`. Include a short example of each.

- [ ] **Step 1: Write the failing tests** (build the CLI, then run it offline against a temp `GAUZZADOCS_HOME`):
  - `new design --size logo`, then `add --type text --text "Gauzza"`, then `read` shows it.
  - `apply -` with 3 ops reports 3 ids.
  - `svg --name Mark -` with a script inside reports "removed a script".
  - `diagram -` with the line format prints node ids.
  - `export --format svg --out x.svg` writes a file with `inkscape:label`.
  - `export --format png` offline fails with the Global Constraints message.
  - A bad `--layer` lists choices.
- [ ] **Step 2: Run `npm test -- design-cli`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -- design-cli` and `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): gdocs design commands and skill text`

### Task 9: The editor: layers, selection and properties

**Files:**
- Create: `src/renderer/src/design/Layers.tsx`, `src/renderer/src/design/Props.tsx`,
  `src/renderer/src/design/Canvas.tsx`, `src/renderer/src/design/selection.ts` (pure hit-testing and handle math, with
  tests)
- Modify: `src/renderer/src/design/DesignEditor.tsx`, `src/renderer/src/design/design.css`,
  `src/core/comments.ts` and `src/shared/types.ts` (comment anchors gain `{ artboard?: string; layer?: string; x?:
  number; y?: number }`), `src/main/worker.ts` (job `fontFaces: []` calling `listFontFaces`), `src/main/index.ts` and
  `src/renderer/src/lib.ts` (`api.fontFaces()`)
- Test: `test/design-selection.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 5 and 7. Every change Matt makes goes through `applyDesignOp`, so undo and the agent diff work
  the same for both.
- Produces:
  - **Canvas:** artboards side by side on a neutral canvas, each drawn from `designToSvg` (raster mode) as inline SVG.
    - Click selects the topmost visible, unlocked layer under the pointer, using the box and rotation from
      `selection.ts`.
    - Shift-click adds to the selection. Dragging empty canvas draws a marquee.
    - Dragging moves. Eight handles resize, and Shift keeps the aspect ratio.
    - Arrow keys nudge 1 px (10 with Shift). Delete removes.
    - Ctrl+G groups, Ctrl+Shift+G ungroups, Ctrl+D duplicates.
    - Ctrl+scroll zooms through `zoomBy`. Space-drag or middle-drag pans.
    - Double-click enters a group.
  - **Layers panel** (left): the tree for the current artboard. It has drag to reorder and into or out of groups,
    double-click to rename, an eye and a lock per row, and selection synced with the canvas.
  - **Properties panel** (right):
    - Name, x, y, w, h, opacity and blend for any layer.
    - Fill and stroke color, stroke width and corner radius for shapes.
    - Text content, font family (a picker from `listFontFaces` via a new `api.fontFaces()`), size and color for text.
    - For an instance, its overrides and "Reset overrides".
  - **Comments** on a design anchor to `{ artboard, layer }`. Clicking a comment selects the layer.
  - **Live agent edits** flash the touched layers in the agent's color, like the other editors.

- [ ] **Step 1: Write the failing tests** for `selection.ts`:
  - The hit test respects rotation: a point inside the rotated box hits, and a point inside the unrotated box corner
    does not.
  - The topmost layer wins. Hidden and locked layers are skipped.
  - Resize from the left handle keeps the right edge fixed. Shift-resize keeps the ratio.
  - Marquee selects layers whose boxes intersect it.
- [ ] **Step 2: Run `npm test -- design-selection`.** Expected: FAIL.
- [ ] **Step 3: Implement** the selection math, then the panels and canvas.
- [ ] **Step 4: Run `npm test`, `npx tsc --noEmit` and `npm run build`.** Expected: pass.
- [ ] **Step 5: Manual check** in an isolated instance with screenshots in light and dark:
  - Select, move and resize a layer.
  - Hide and lock from the layers panel.
  - Change a fill.
  - Undo each.
  - Watch an agent `set` arrive and flash.
- [ ] **Step 6: Commit** `feat(design): layers panel, selection, move and resize, properties`

### Task 10: Look, PNG export and thumbnails

**Files:**
- Create: `src/renderer/src/design/raster.ts` (in the window: SVG string to PNG bytes via an `Image` and a canvas)
- Modify:
  - `src/renderer/src/look/Look.tsx` (a design branch: one unit per artboard, drawn with `designToSvg` raster mode;
    notes for text overflowing its box and layers outside the artboard)
  - `src/main/look.ts` (unit `'artboard'`, sized to each artboard up to 1600 px on the long side)
  - `src/preload/index.ts` and `src/renderer/src/env.d.ts` (a `'design-raster'` serve channel)
  - `src/main/index.ts` (rpc `designExport` for png: it asks the hidden look window over `design-raster`, writes the
    file, and refuses when no window can render)
  - `src/renderer/src/design/DesignEditor.tsx` (on save, render the first artboard to a 512 px thumbnail and clear
    `thumbnailStale`)
  - `src/cli/design.ts` (`export --format png`)
- Test: `test/design-export.test.ts` (pure parts: export-mode SVG for the file round trip, the scale and size limits)

**Interfaces:**
- Consumes: Tasks 3, 7 and 8, and the look window from `src/main/look.ts`.
- Produces:
  - `rasterize(svg: string, width: number, height: number): Promise<Uint8Array>` in the window.
  - `exportDesign(file, { format: 'svg' | 'png'; artboard?; scale?; width?; out? }): Promise<{ files: string[];
    downgrades: string[] }>`.
  - SVG writes one file per artboard (`<stem>-<artboard name>.svg` when there are several). SVG works offline. PNG
    caps at 16384 px per side and 268 million pixels, and refuses beyond that.
  - `downgrades` names what a format can't hold, for example "Blend modes may be flattened by tools other than
    browsers and Inkscape."
  - Every export passes through `cleanSvg` before writing.
- `gdocs look x.gdesign` gives one image per artboard, with notes.

- [ ] **Step 1: Write the failing tests:**
  - An export-mode SVG of a design with an imported `svg` layer contains no `<script`, no `on*=` and no `http`.
  - `--scale 2` of an 8192 artboard passes. `--width 20000` is refused with the limit.
  - The downgrade list for a design using `multiply` blend includes the blend note.
- [ ] **Step 2: Run `npm test -- design-export`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, `npx tsc --noEmit` and `npm run build`.** Expected: pass.
- [ ] **Step 5: Manual check** in an isolated instance:
  - `gdocs look` on the diagram from Task 6's test spec: screenshot it and read the notes.
  - `gdocs design export --format png --scale 2` opens as a correct PNG at 2x.
  - The home screen card shows the thumbnail.
- [ ] **Step 6: Commit** `feat(design): look, PNG export and thumbnails`

### Task 11: Insert a design into a document, and the README

**Files:**
- Modify: `src/renderer/src/doc/DocEditor.tsx` (Insert > Design: a dialog that picks a .gdesign from recent files or
  Browse, then an artboard, then inserts it), `README.md` (a "Designs" section)
- Test: manual, plus a unit test for the format choice in `test/design-export.test.ts`

**Interfaces:**
- Consumes: Task 10 (`rasterize`, export-mode `designToSvg`).
- Produces: `insertFormat(docPath: string): 'png' | 'svg'`, which gives png for .docx and svg for .md and .html. The
  dialog offers "PNG" for .md and .html too. The image goes in as a data URL like Insert > Image, at 2x for PNG. Its alt
  text is the artboard name.
- README "Designs" section, in Matt's voice and the copy rules:
  - what a design is
  - layers the agent builds
  - diagrams from a list of steps
  - SVG that keeps layers, plus PNG
  - insert into a doc
  - that rendering needs the app
  - the main commands in a short block
  - Don't mention part b features as if they exist.

- [ ] **Step 1: Write the failing test** for `insertFormat`.
- [ ] **Step 2: Run `npm test -- design-export`.** Expected: FAIL.
- [ ] **Step 3: Implement** the dialog and the README section.
- [ ] **Step 4: Run `npm test`, `npx tsc --noEmit` and `npm run build`.** Expected: pass.
- [ ] **Step 5: Manual check:** insert the Task 6 diagram into a .docx and a .md, save both, reopen them and screenshot.
- [ ] **Step 6: Commit** `feat(design): insert designs into documents, README`
