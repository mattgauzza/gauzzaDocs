# Design editor: layered images, diagrams and animated text

Date: 2026-11-25. Status: approach chosen by Matt (option 2: gauzzaDocs' own design file, with SVG export that keeps
the layers); review questions answered; this document is for his approval.

## Intent

Matt wants agents to build real, layered, high quality images instead of flat AI generated pictures: things a person
can open, select a layer, move it, restyle it, hide it, and keep working on. His uses, in his words: "logos", "things
like this proposal doc I'm working on has a workflow / schema layout", "kinetic word gifs for social posts", "or just a
social post in general". He also asked for paint alongside vector and layers. Someone else may open the work, so it has
to export to SVG with the layers intact.

## Goals

- A new kind of file, a design, that holds one or more artboards (sizes) with layers.
- Layers: vector shapes and paths, text in real fonts, images, painted (raster) layers, and groups. Each can be named,
  hidden, locked, reordered, faded (opacity) and blended (blend mode).
- Diagrams that stay tidy: boxes and connectors that stay attached when things move, and automatic layout so an agent
  (or Matt) can describe the steps and links and get a clean arrangement.
- Animated text and layers for social posts: a timeline with keyframes and ready-made text effects (word by word, letter
  by letter), exported as GIF and MP4.
- Exports: SVG with layers kept (one file per artboard), PNG at any scale, PDF (vector, for proposals), GIF and MP4 for
  animations. Insert a design into a document as an image from the doc editor.
- Agents can do everything through `gdocs`, live in the open editor or on disk, and check their work with `gdocs look`.
- Polished, Figma-like editing for Matt: select, move, resize, rotate, snap and align, layers panel, properties panel.

## Non-goals

- Photo retouching tools (curves, healing, filters beyond blur and shadow).
- Opening PSD, AI or Figma files. (SVG import is in.)
- A live link from a document to a design that updates itself (insert is a one-time export; re-insert to update).
- Generating images with AI. Agents may place an image they already have as its own layer.

## Anti-goals

- Agents producing one flat layer. The format and the ops should make the layered way the easy way.
- Designs that only look right on Matt's PC: fonts must travel with the file and with exports.
- Memory blowups from big painted layers or long animations; the editor loads only when a design is open, like the other
  editors.

## Constraints from the app as it is

- Editors are lazy-loaded per kind (src/renderer/src/editors.ts) and implement the EditorProps / EditorHandle contract
  (src/renderer/src/editor.ts): getPayload, peekPayload, agent(op), status, menus, zoomBy and the rest.
- A kind is added in src/shared/kinds.ts (Kind union, kindOf, OPEN_FILTERS), with a reader and writer in
  src/core/formats (run in the worker thread), payload type in src/shared/types.ts (FilePayload union), creation in
  src/core/files.ts (createFile), agent ops shared by the live editor and the CLI in src/shared/ops, and CLI commands in
  src/cli (like src/cli/slides.ts). Windows file association lists live in src/main/winAssoc.ts.
- `gdocs look` (src/main/look.ts and src/renderer/src/look/Look.tsx) renders a kind in a hidden window and captures
  units; designs should capture one image per artboard, like slides.
- Installed fonts are already found by src/core/systemFonts.ts and loaded in the window as FontFace
  (src/renderer/src/pdf/sysfont.ts); the design editor reuses that.
- Agent colors, live edit flashes, comments and the subscribed-agent runner already work per file and should just work
  for designs too.
- Memory-frugal and async: file IO and exports that don't need a browser run in the worker; rendering exports that do
  need one (fonts, filters) uses the hidden window like `gdocs look`.

## Approaches considered (Matt picked 2)

1. **SVG as the file.** Opens everywhere and Inkscape keeps the layers, but several sizes, components and animation
   would live in metadata that other tools may drop.
2. **gauzzaDocs' own design file, exporting SVG with layers (chosen).** Room for several artboards, reusable pieces,
   animation and diagram settings in one file. Other people get exports: SVG with named layers, PNG, PDF, GIF, MP4.
3. **Grow the slides editor.** Fastest to build, but .pptx can't hold layered vector art or word-by-word animation well.

## Design

### The file

- Extension `.gdesign`. A zip (JSZip is already used for .pptx) holding:
  - `design.json`: the document (below).
  - `assets/`: images placed as layers, painted layers as PNG, and the font files the design uses (so it renders the
    same on another PC).
  - `thumbnail.png`: the first artboard, small, for the home screen and file pickers.
- `design.json`:
  - `artboards`: each with id, name, width, height (px), background (color, gradient or transparent) and its layer tree.
  - Layer types: `rect`, `ellipse`, `line`, `path` (SVG path data), `text`, `image`, `paint` (a PNG in assets), `group`,
    `connector` (between two layers' anchor points, straight, elbow or curved, with arrowheads), `svg` (a raw SVG
    fragment an agent wrote, kept as one vector layer).
  - Every layer: id, name, visible, locked, opacity, blend mode, transform (x, y, rotation, scale), and style (fill and
    stroke as color or gradient, stroke width and dash, corner radius, shadow, blur).
  - Text: content with runs (font, size, weight, italic, color, letter spacing, line height), box or point text,
    alignment, and an option to export as outlines.
  - `components`: reusable groups (a logo lockup, a diagram node style) placed by reference; editing the component
    updates every placement.
  - `styles`: named colors and text styles, so a brand palette is set once.
  - `animation` per artboard: duration, frame rate, loop, and per-layer keyframe tracks (position, scale, rotation,
    opacity, fill color) with easing, plus text effects (reveal by word, letter or line; typewriter, fade, rise, pop)
    with stagger.
  - `diagram` settings per artboard when it's a diagram: direction (left to right, top to bottom), spacing, and which
    layers are nodes and connectors, so automatic layout can run again after edits.

### The editor

- Canvas with zoom (Ctrl+scroll, like the other editors) and pan, artboards side by side.
- Tools: select (move, resize, rotate, multi-select, marquee), rectangle, ellipse, line, pen (paths with handles), text,
  image, connector, brush and eraser for painted layers, eyedropper, hand.
- Snapping to edges, centers and other layers, with guides; align and distribute.
- Left panel: artboards and the layer tree (drag to reorder, rename, eye and lock toggles, group and ungroup).
- Right panel: properties of the selection (position, size, fill, stroke, text, effects), components and styles.
- Bottom: the timeline when the artboard has animation (play, scrub, keyframes per layer, text effect presets).
- Diagram mode: add nodes and connectors, "Tidy up" runs automatic layout; moving a node keeps its connectors attached.
- New design picks a size: Instagram post (1080x1080), portrait (1080x1350), story (1080x1920), LinkedIn (1200x627),
  X (1600x900), YouTube thumbnail (1280x720), logo (1000x1000, transparent), letter page (diagram for documents), or
  custom.
- Painted layers keep their pixels at the artboard's resolution; the editor holds only visible layers' bitmaps in memory.

### Exports

- SVG, one file per artboard: each layer a `<g>` with its name as `id` and `inkscape:label`, top-level layers marked as
  Inkscape layers, painted layers and images embedded as PNG, fonts embedded (or text as outlines when chosen).
- PNG at 1x, 2x or a set width; transparent background when the artboard has none.
- PDF, vector, one page per artboard (for proposals and print).
- GIF and MP4 for animated artboards, rendered frame by frame.
- From a document (doc editor): Insert > Design picks a design and artboard and inserts it as an image (PNG for .docx,
  SVG or PNG for .md and .html).

### For agents

- `gdocs new design <name> --size instagram` (and the other presets) creates one.
- `gdocs read file.gdesign`: the artboards and layer tree as an outline with ids, names, types, positions and text.
- `gdocs design` commands, each a shared op (live in the editor or on disk):
  - `add` a layer (`--type rect|ellipse|text|image|path|svg|group|connector`, with properties as flags or JSON),
    `set` properties of a layer, `delete`, `move` (reorder, into or out of a group), `group`, `align`, `duplicate`.
  - `svg` writes or reads one layer's raw SVG fragment, so an agent can draw a logo mark as SVG and still keep it as its
    own layer.
  - `diagram` takes nodes and links (`--nodes "Intake,Review,Approve" --links "Intake>Review,Review>Approve"` or JSON)
    and builds a laid out diagram as layers.
  - `animate` adds keyframes or a text effect to a layer.
  - `export` to svg, png, pdf, gif or mp4.
  - `artboard` add, resize, rename, delete.
- `gdocs look file.gdesign` shows each artboard (and, for animated ones, a few frames), with layout notes such as text
  overflowing its box or layers outside the artboard.
- The agent skill (src/core/agentSkills.ts) teaches the layered way: build with named layers and groups, use styles for
  brand colors, check with `gdocs look`.

## Decisions after review

A builder read this document and raised nine questions. Two were answered by Matt, one from his own proposal, and six
are the author's calls he can change.

- **What the diagrams look like (settled from the proposal).** The workflow in Matt's Dave and Partners proposal is an
  architecture sketch: one shared, tested agent, and a separate space per client, each with "Client A's job -> A's
  forecast and deck". So diagram nodes are boxes with text (and an optional icon), connectors can carry a label, and
  containers group nodes (a client's space, a cloud account) and are laid out with their contents. Decision diamonds and
  swim lanes come with the same node model. Database tables with per-field links are not needed.
- **SVG export for other people (author's call).** Text stays live by default, with the font named (Inkscape,
  Illustrator and Figma use the fonts installed there); "Text as outlines" is an export option for logos and anything
  going to someone without the fonts. Tested against browsers and Inkscape; Illustrator and Figma are best effort.
- **Fonts (author's call).** Designs use installed fonts. A font file is packed into a .gdesign or an export only when
  the font's own embedding permission allows it (the OS/2 fsType flags); otherwise the file keeps the font's name and
  exports fall back to outlines. PDFs embed subsets, as PDFs normally do. A font picker needs a list of installed
  families and weights, which src/core/systemFonts.ts doesn't have yet, and .ttc collections need support.
- **SVG from agents and imported SVG (author's call).** Converted into native layers (rect, ellipse, path, text,
  group, image) wherever the elements allow, so a logo an agent draws can be recolored and reshaped. Anything the
  converter can't map stays as one `svg` layer. File > Import SVG and `gdocs design import` do the same.
- **Logo tools (author's call).** Boolean shape operations (union, subtract, intersect, exclude) and clipping masks are
  in, since logos need them.
- **Painting (author's call).** Round brush and eraser with pen pressure, opacity and size; painted layers stored at
  twice the artboard's size so 2x exports stay sharp. No textured brushes, smudge or selections in this version.
- **Animation and sound (author's call).** Every layer has a start and end time on the timeline, with entrance and exit
  effects, so "one big word at a time" works. No audio track: music gets added in the social app.
- **Thumbnails (author's call).** Shown in gauzzaDocs' own home screen and pickers. No Windows Explorer preview handler.

Answered by Matt:

- **Order of releases ("ok fine").** (1) Vector, text, layers, diagrams, boolean operations and masks, SVG, PNG and
  PDF export, agent commands: the proposal diagram and logos. (2) The animation timeline with GIF and MP4: kinetic
  social posts. (3) Painting.
- **Brand kit: both, inside a project ("it would be nice if either could work, inside a project").**
  - Every design keeps its own styles and components, as above.
  - A project (a folder pinned on the home screen, src/core/projects.ts) can also have a brand kit: one design in the
    project marked as the kit (File > Use as this project's brand kit, or `gdocs design kit <file>`). The mark lives in
    gauzzaDocs' project list, not in Matt's folder. The kit's styles (colors, text styles) and components (logo
    lockups, diagram node styles) show up in every design in that project, next to the design's own.
  - Designs link to kit items rather than copying them, so changing the kit updates every design that uses it: right
    away for designs that are open, and when opened for the rest. Exports and inserts bake the linked items in, so
    they never depend on the kit file.
  - "Detach" copies a kit item into the design, for a one-off change. A design moved out of the project keeps working:
    its linked items are copied in the next time it's opened without the kit.
  - Agents see the kit in `gdocs read` (its styles and components by name) and use them by name in `gdocs design`
    commands, so posts stay on brand without restating colors.
  - Release (1) ships per-design styles and components; the project brand kit ships with release (2), before most
    social posts get made. The file format leaves room for links from the start.

## Left to the builder

- Libraries: automatic layout (ELK or dagre), GIF encoding (gifenc or similar), MP4 encoding (WebCodecs plus a small
  muxer), as long as they load lazily and only when used.
- Exact easing curves and the text effect list beyond the ones named.
- Panel layout details, icons, keyboard shortcuts (follow common design tools where they exist).
- How many undo steps painting keeps, within the memory constraint.
- Whether exports that need fonts and filters render in the hidden window or an offscreen canvas.
