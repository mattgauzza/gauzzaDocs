# Design editor: layered images, diagrams and animated text

Date: 2026-11-25. Status: approach chosen by Matt (option 2: gauzzaDocs' own design file, with SVG export that keeps
the layers); review questions answered; one hardening pass done; exports with the app closed decided ("ok"). Ready
for Matt's approval.

## Intent

Matt wants agents to build real, layered, high quality images instead of flat AI generated pictures: things a person
can open, select a layer, move it, restyle it, hide it, and keep working on. His uses, in his words: "logos", "things
like this proposal doc I'm working on has a workflow / schema layout", "kinetic word gifs for social posts", "or just a
social post in general". He also asked for paint alongside vector and layers. Someone else may open the work, so it has
to export to SVG with the layers intact.

## Goals

- A new kind of file, a design, that holds one or more artboards (sizes) with layers.
- Layers: vector shapes and paths, text in real fonts, images, painted layers, and groups. Each can be named, hidden,
  locked, reordered, faded (opacity) and blended (blend mode).
- Logo tools: boolean shape operations (union, subtract, intersect, exclude) and clipping masks.
- Diagrams that stay tidy: boxes, labeled connectors and containers that stay attached when things move, and automatic
  layout, so an agent (or Matt) can describe the steps and links and get a clean arrangement.
- Animated text and layers for social posts: a timeline, entrance and exit effects, word-by-word and letter-by-letter
  effects, exported as GIF and MP4.
- Exports: SVG with layers kept (one file per artboard), PNG at any scale, PDF (vector, for proposals), GIF and MP4.
  Insert a design into a document as an image from the doc editor.
- Styles and reusable components per design, plus a brand kit shared by the designs in a project.
- Agents can build and change designs through `gdocs`, live in the open editor or on disk, and check their work with
  `gdocs look`.
- Polished, Figma-like editing for Matt: select, move, resize, rotate, snap and align, layers panel, properties panel.

## Non-goals

- Photo retouching tools (curves, healing, filters beyond blur and shadow).
- Opening PSD, AI or Figma files. (SVG import is in.)
- A live link from a document to a design that updates itself (insert is a one-time export; re-insert to update).
- Generating images with AI. Agents may place an image they already have as its own layer.
- An audio track in MP4 (music gets added in the social app).
- Windows Explorer previews of .gdesign files (thumbnails show inside gauzzaDocs only).

## Anti-goals

- Agents producing one flat layer. The format and the ops should make the layered way the easy way.
- Designs that only look right on Matt's PC.
- Anything in a design, imported SVG included, being able to run code, read local files or call the internet.
- Losing work when the app, the CLI and agents touch the same design.
- Memory blowups from big painted layers, big images or long animations; the editor loads only when a design is open.

## Constraints from the app as it is

- Editors are lazy-loaded per kind (src/renderer/src/editors.ts) and implement the EditorProps / EditorHandle contract
  (src/renderer/src/editor.ts): getPayload, peekPayload, agent(op), status, menus, zoomBy and the rest.
- A kind is added in src/shared/kinds.ts (Kind union, kindOf, OPEN_FILTERS), with a reader and writer in
  src/core/formats (run in the worker thread), payload type in src/shared/types.ts (FilePayload union), creation in
  src/core/files.ts (createFile), agent ops shared by the live editor and the CLI in src/shared/ops, and CLI commands in
  src/cli (like src/cli/slides.ts). Windows file association lists live in src/main/winAssoc.ts.
- `gdocs look` (src/main/look.ts and src/renderer/src/look/Look.tsx) renders a kind in a hidden window and captures it;
  it needs the app running.
- The worker and the CLI have no browser, so anything that rasterizes (PNG, PDF, GIF, MP4, thumbnails) needs the app.
- The app window has no Content-Security-Policy today, and its preload exposes file APIs (src/preload/index.ts), so
  anything that runs script in the window can read and write files.
- Installed fonts are found by src/core/systemFonts.ts by registry name only; it has no family or weight index and skips
  .ttc collections.
- The edit diff for listening agents (textOf in src/renderer/src/App.tsx) covers text, doc, sheet and slides, and
  comment anchors (src/core/comments.ts) are `{line, cell, page}`; designs need both extended.
- The worker runs jobs concurrently, and runOffline (src/core/ops/index.ts) loads, applies and saves with no lock.
  `--offline` edits a file even while it is open in the app (src/cli/common.ts).

## Approaches considered (Matt picked 2)

1. **SVG as the file.** Opens everywhere and Inkscape keeps the layers, but several sizes, components and animation
   would live in metadata that other tools may drop.
2. **gauzzaDocs' own design file, exporting SVG with layers (chosen).** Room for several artboards, reusable pieces,
   animation and diagram settings in one file. Other people get exports: SVG with named layers, PNG, PDF, GIF, MP4.
3. **Grow the slides editor.** Fastest to build, but .pptx can't hold layered vector art or word-by-word animation well.

## Releases (Matt: "ok fine")

1. Vector, text, layers, groups, components with overrides, styles, logo tools, diagrams, SVG import, SVG, PNG and PDF
   export, insert into documents, agent commands. Covers the proposal diagram and logos.
2. The animation timeline with GIF and MP4 (kinetic social posts), and the project brand kit.
3. Painting.

The file format includes everything from all three releases from the start (links, overrides, timing), so files never
need converting.

## Design

### The file

- Extension `.gdesign`. A zip (JSZip, already used for .pptx) holding:
  - `design.json`: the document (below), with a permanent `id` for the design.
  - `assets/<sha256>.<ext>`: images, painted layers as PNG, and packed fonts. Assets are immutable and named by content
    hash.
  - `thumbnail.png`: the first artboard, small, for the home screen and pickers.
- Reading a .gdesign reads only those three kinds of entry, and refuses archives over 1 GB uncompressed or with more
  than 10,000 entries. Image and paint layers may point only into `assets/`.
- `design.json`:
  - `artboards`: each with id, name, width and height in px (at most 8192 per side), background (color, gradient or
    transparent) and its layer tree.
  - Layer types: `rect`, `ellipse`, `line`, `path` (SVG path data), `text`, `image`, `paint`, `group`, `instance` (a
    placed component), `connector`, and `svg` (only for SVG the converter can't map; see below).
  - Every layer has a short id that never changes, plus name, visible, locked, opacity, blend mode, and a box: x, y,
    width and height of the unrotated box in artboard coordinates, rotation in degrees about the box center, and scale
    on top of the box. Resizing changes width and height, never scale. Groups store their children in artboard
    coordinates too, so moving a group moves its children's x and y.
  - Style: fill and stroke as color, gradient or style reference; stroke width and dash; corner radius; shadow; blur.
  - Text: content with runs (font, size, weight, italic, color, letter spacing, line height), box or point text,
    alignment, and "export as outlines". Fonts are named by family, weight, style and PostScript name, never by a
    Windows registry name.
  - `components`: reusable groups. An instance stores overrides keyed by the inner layer's id (text, fill, stroke,
    visibility, image); "Reset overrides" clears them. Diagram nodes are instances of a node-style component with
    their label as a text override.
  - `styles`: named colors and text styles.
  - `kit`: links to a project brand kit (below).
  - `timing` per layer: start and end in seconds, entrance and exit effects, keyframe tracks (position, scale, rotation,
    opacity, fill) with easing, and text effects (reveal by word, letter or line; typewriter, fade, rise, pop;
    word-swap). `animation` per artboard: duration, frame rate (at most 60), loop.
  - `diagram` per artboard when it's a diagram: name, direction, spacing, nodes and links by id, containers, and which
    nodes were moved by hand (pinned).

### One renderer

- Everything draws through one shared function, `designToSvg(design, artboard, seconds)`, which measures text with the
  font files themselves (fontkit, as the PDF editor already does), so line breaks match everywhere. The editor canvas,
  `gdocs look`, thumbnails and every export use it. What `look` shows is what export makes.

### Safety: SVG and other content from outside

- SVG from an agent or an import is parsed (xmldom) and passed through an allowlist before it's stored. Removed:
  script, foreignObject, every event attribute, animation of `href`, and every reference outside the file (http and
  https, `file:`, other documents, CSS `@import` and `url()` to anything but the file's own ids). External images are
  dropped and listed in the reply. `<use>` is expanded to a depth of 8; fragments over 5 MB or 50,000 elements are
  refused.
- An `svg` layer is drawn as an image (an `<img>` of the cleaned SVG), never inserted into the page, so Chromium runs no
  script and loads nothing from it.
- Exports go through the same cleaning, so a design can't pass a script on to someone else.
- The app window and the hidden look window get a Content-Security-Policy with no inline script and no remote script.
  (The app's Markdown reader has the same exposure today; that fix is tracked separately.)

### Saving, and several writers at once

- Every write to a .gdesign, from the app, the CLI or a kit update, holds `<name>.gdesign.lock` (created with the
  exclusive `wx` flag, holding the process id and time, stale after 60 seconds).
- A save writes a temp file and syncs it to disk, checks that the file's size and modified time haven't changed since
  it was loaded (otherwise it stops with "Changed by someone else; reload to see it"), then renames it into place.
  Version history (its own design) keeps the previous state.
- Ops on one file run one at a time, in the editor and on disk. An op that waits for something (layout, fonts) works out
  its result first, then applies it to the latest design in one step.
- While a design is open in the app, every op goes to the editor and the CLI refuses `--offline` for it, so the app
  never reloads a design from under its undo history. Each agent op, or each `apply` batch, is one undo step named for
  the agent ("Claude: add 3 layers").
- Autosave sends `design.json` plus new assets only; the worker copies unchanged zip entries without recompressing.

### Fonts

- src/core/systemFonts.ts gains an index of installed families and faces, covering .ttc collections and variable fonts,
  for the font picker and for resolving family, weight and style.
- A font file is packed into a .gdesign only when its fsType embedding flag is 0 (installable) or 8 (editable).
  Otherwise each text layer also stores its glyph outlines for display, and shows "font not installed" where the font
  is missing.
- Packed fonts register under a per-file family name (`gd-<hash>`), so they never replace an installed font of the same
  name in other tabs.
- SVG export never embeds fonts: text stays live with the family named (Inkscape, Illustrator and Figma use their own
  installed fonts), or becomes outlines when chosen; "Text as outlines" is the default for designs made from the logo
  preset. PDF embeds subsets when fsType allows, and outlines otherwise.

### SVG import and agent SVG

- `gdocs design svg <file> --name Mark -` and File > Import SVG convert the SVG into one group named by `--name` (or
  the file name). Children take their names from `id`, `inkscape:label` or `data-name`, otherwise Path 1, Path 2, and so
  on. The converter handles viewBox, transform, `<defs>` gradients, clipPath, `<use>` and simple `<style>` rules, so an
  agent's logo can be recolored and reshaped layer by layer.
- Anything the converter can't map stays as a raw `svg` layer (drawn as an image), and the reply lists what and why.
- `gdocs design svg <file> --get <layer>` returns any layer as clean SVG in its own coordinates; it may differ from what
  was sent.

### The editor

- Canvas with zoom (Ctrl+scroll, like the other editors) and pan, artboards side by side.
- Tools: select (move, resize, rotate, multi-select, marquee), rectangle, ellipse, line, pen (paths with handles), text,
  image, connector, brush and eraser for painted layers (release 3), eyedropper, hand.
- Snapping to edges, centers and other layers, with guides; align and distribute; boolean operations; clipping masks.
- Left panel: artboards and the layer tree (drag to reorder, rename, eye and lock toggles, group and ungroup).
- Right panel: properties of the selection (position, size, fill, stroke, text, effects), components and styles, and
  overrides on an instance.
- Bottom: the timeline when the artboard has animation (release 2): play, scrub, layer start and end bars, keyframes,
  effect presets.
- New design picks a size: Instagram post (1080x1080), portrait (1080x1350), story (1080x1920), LinkedIn (1200x627),
  X (1600x900), YouTube thumbnail (1280x720), logo (1000x1000, transparent), letter page (diagram for documents), or
  custom.

### Diagrams

- Matt's proposal shows the shape: one shared, tested agent, and a separate space per client, each with "Client A's
  job -> A's forecast and deck". So nodes are boxes with text and an optional icon, connectors carry an optional label,
  and containers group nodes (a client's space, a cloud account) and are laid out with their contents. Decision
  diamonds and swim lanes use the same node model. Database tables with per-field links are not needed.
- Layout uses ELK (elkjs, layered layout with hierarchy handling, loaded only when used), with node sizes from the
  shared text measurement, so a diagram lays out the same live and on disk.
- `gdocs design diagram` takes JSON (`{ name, direction, nodes: [{ id, label, in?, icon? }], links: [{ from, to,
  label? }], containers: [{ id, label, in? }] }`) or one item per line. Running it again with the same name updates that
  diagram by node id instead of adding another.
- A node moved by hand is pinned; Tidy up lays out the rest around pinned nodes. Moving a node keeps its connectors
  attached.

### Painting (release 3)

- Round brush and eraser with pen pressure, opacity and size. No textured brushes, smudge or selections.
- A painted layer is stored at 2x, sized to the area painted, at most 8192 px on its long side, and never resampled
  when the artboard is resized.

### Memory and size limits

- Artboards: at most 8192 px per side. Placed images: refused above 50 megapixels, checked from the image header
  before decoding; shown from a copy at most twice their size on the artboard.
- The editor keeps bitmaps only for layers on screen.
- GIF and MP4 render one frame at a time (seek to the time, render, encode) and stream to the encoder; nothing holds
  all frames at once.

### Exports, and what each format can hold

- **SVG**, one file per artboard: each layer a `<g>` with a unique `id` made from its layer id, its name in
  `inkscape:label` and `data-name`, top-level layers marked as Inkscape layers. Ids inside converted fragments are
  prefixed per layer so gradients never collide. Wrapped text is one `<tspan>` per line at the app's computed positions.
  Shadows and blurs use SVG 1.1 filters. Blend modes export as `mix-blend-mode`, which browsers and Inkscape honor and
  other tools may flatten. Painted layers and images are embedded PNG.
- **PNG** at 1x, 2x or a set width; transparent where the artboard has no background.
- **PDF**: vector, one page per artboard at its own size; blur, shadow and painted layers become 300 dpi images.
- **GIF**: one palette with dithering, on/off transparency over a matte color, at most 50 fps (25 by default).
- **MP4**: flattened onto the artboard background, or white if it has none.
- The export dialog and the CLI say which of these downgrades a design hits.
- **Insert > Design** in the doc editor picks a design and artboard and inserts it as an image (PNG for .docx, SVG or
  PNG for .md and .html).

### Brand kit in a project (Matt: "it would be nice if either could work, inside a project")

- Every design keeps its own styles and components.
- A project (a folder pinned on the home screen, src/core/projects.ts) can also mark one design as its brand kit (File >
  Use as this project's brand kit, or `gdocs design kit <file>`). The project list stores the kit's permanent design id
  and its last path, so a kit renamed or moved inside the project is found again. Nothing is written into Matt's folder.
- A design links to a kit item as `{ kitId, itemId }` plus a copy of the item as last seen. It draws from the live kit
  when the kit is found, otherwise from the copy, with a note "Brand kit not found: using saved copies". Links never
  detach on their own; removing the project or unmarking the kit leaves designs on their copies.
- Changing the kit updates open designs right away and the rest when opened. Refreshing a copy isn't an undo step and
  is written with the next save. Exports and inserts always use the resolved items, never a link.
- "Detach" copies a kit item into the design for a one-off change.
- A design's own style or component wins over a kit item with the same name. Agents refer to kit items as `kit/<name>`,
  and `gdocs read` shows where each comes from.
- Ships in release 2; release 1 files already have room for links.

### For agents

- `gdocs new design <name> --size instagram` (and the other presets) creates one.
- `gdocs read file.gdesign`: artboards and one line per layer (id, name, type, box, text, timing in seconds), styles and
  components with where they come from (`kit/...`).
- Layers are addressed with `--layer <id|name|path>`. A name works only when it's unique on the artboard; otherwise the
  command fails and lists the matching ids. `add`, `duplicate`, `group`, `svg` and `diagram` return the new ids.
  Commands work on one artboard (`--artboard`, default the first) unless `--all-artboards` is given, which matches
  layers by name across sizes.
- `gdocs design` commands, each a shared op (live in the editor or on disk):
  - `add` (`--type rect|ellipse|line|path|text|image|group|connector`, properties as flags or JSON), `set` (with
    `--part <inner layer>` for an instance's overrides), `delete`, `move` (reorder, into or out of a group), `group`,
    `align`, `duplicate`, `boolean`, `mask`.
  - `apply <file> -`: a JSON array of ops on stdin, applied as one undo step and one save. Subscribed agents can only
    run `gdocs`, so stdin is how they send a batch.
  - `svg`: import or get SVG, as above.
  - `diagram`: as above.
  - `animate`: `--start`/`--end` in seconds, `--in`/`--out` effects, keyframes with `--at`, `--effect` (including
    `word-swap`: one word at a time in place, each scaled to fit the box and held for `--hold` seconds).
  - `export`: svg, png, pdf, gif or mp4.
  - `artboard`: add, resize, rename, delete. `kit`: mark or unmark the project's brand kit.
- `gdocs look file.gdesign` shows each artboard; for animated ones `--at 0.5,1.2,3` or `--frames 8`, each image labeled
  with its time. Layout notes flag text overflowing its box, layers outside the artboard, words on screen for under 0.3
  seconds, and text leaving the artboard during an animation.
- Live edits: the design `read` op gives the shell one line per layer to diff, so listening and subscribed agents hear
  about Matt's changes; comment anchors gain `{ artboard, layer, x, y }`.
- **Exports with the app closed (Matt: "ok"):** SVG export, and every edit, works with the app closed. PNG, PDF, GIF and MP4
  exports and thumbnails need the app (they rasterize in the hidden window, like `gdocs look`); with the app closed they
  fail with the same "start gauzzaDocs" message, and a save made without the app marks the thumbnail stale so the app
  redraws it next time. This narrows "agents can do everything on disk" to "edit everything on disk, render with the
  app".
- The agent skill (src/core/agentSkills.ts) teaches the layered way: named layers and groups, styles and kit items for
  brand colors, `apply` for batches, and checking with `gdocs look`.

## Decisions after review

A builder read the first draft and raised nine questions; a hardening review then raised twelve problems. Where each
landed:

- From Matt: the release order, and the brand kit working both ways inside a project.
- From Matt's proposal: what diagrams need (see Diagrams).
- Author's calls Matt can change: SVG export keeps live text by default; fonts packed only when their license flags
  allow; SVG converted to native layers; logo tools in; painting scope; per-layer timing with no audio; thumbnails
  inside gauzzaDocs only.
- Hardening, each fixed in its section above: unsafe SVG and zip content, several writers and undo, kit links that
  break, a single renderer, how layers are addressed and what coordinates mean, the agent SVG contradiction, fonts,
  memory and size limits, export fidelity, component overrides, the diagram library and re-layout, and timeline
  commands and look for animation.

## Left to the builder

- GIF encoding (gifenc or similar) and MP4 encoding (WebCodecs plus a small muxer), loaded only when used.
- Exact easing curves and the text effect list beyond the ones named.
- Panel layout details, icons, keyboard shortcuts (follow common design tools where they exist).
- How many undo steps painting keeps, within the memory limits.
