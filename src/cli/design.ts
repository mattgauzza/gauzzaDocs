import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { kindOf } from '../shared/kinds'
import { DEFAULT_FONT, list, upTo } from '../shared/ops/designLayers'
import type { AgentOp } from '../shared/types'
import { type Ctx, RENDER_NEEDS_APP, appRunning, liveOptions } from './common'

// gdocs design ...: commands for designs (.gdesign). Each runs one design op (src/shared/ops/design.ts) through
// ctx.run, so it lands in the open editor as one undo step when the app has the design open, and on disk otherwise.

type Opts = Record<string, unknown>
interface Ids { ids?: string[]; id?: string; note?: string }
interface DiagramResult { id: string; nodes: Record<string, string>; containers: Record<string, string>; links: string[]; note?: string }

/** The file, refused before anything runs when it isn't a design. */
function design(file: string): string {
  if (kindOf(file) !== 'design') throw new Error(`${path.basename(file)} isn't a design. Designs are .gdesign files (gdocs new design <name>).`)
  return file
}

/** The ids an op's reply names, as a list. */
const idsOf = (r: Ids): string => list(r.ids ?? (r.id ? [r.id] : []))
/** A reply as one line saying what was done to which ids, plus any note the op gave. */
const said = (r: Ids, done: string): string => (r.note ? `${done}\n${r.note}` : done)

const onArtboard = (c: Command) => c.option('--artboard <ref>', 'artboard by id or name (default: the first)')
const layerOption = (c: Command) => c.requiredOption('--layer <ref>', 'the layer: its id, its name (when unique) or a Group/Child path')

/** Flags that write one property, and the property each writes. */
const PROP_FLAGS: [flag: string, prop: string][] = [
  ['name', 'name'], ['x', 'x'], ['y', 'y'], ['w', 'width'], ['h', 'height'], ['fill', 'fill'], ['stroke', 'stroke'], ['text', 'text'],
  ['font', 'font'], ['size', 'size'], ['radius', 'radius']
]
const propOptions = (c: Command) =>
  c
    .option('--name <name>', 'layer name')
    .option('--x <px>', 'left edge')
    .option('--y <px>', 'top edge')
    .option('--w <px>', 'width')
    .option('--h <px>', 'height')
    .option('--fill <paint>', 'fill: #rrggbb, style:<name> or none')
    .option('--stroke <paint>', 'outline: #rrggbb, style:<name> or none')
    .option('--text <text>', 'text (text layers)')
    .option('--font <family>', 'font family (text layers)')
    .option('--size <px>', 'font size (text layers)')
    .option('--radius <px>', 'corner radius (rectangles)')
    .option('--props <json>', 'any other properties as a JSON object ("-" = stdin, "@file"), e.g. {"opacity":0.5}')

/** The properties the flags give: --props first, then each flag over it. */
function propsFrom(ctx: Ctx, o: Opts): Record<string, unknown> {
  let props: Record<string, unknown> = {}
  if (o.props !== undefined) {
    let v: unknown
    try {
      v = JSON.parse(ctx.input(String(o.props)))
    } catch (e) {
      throw new Error(`--props must be a JSON object: ${(e as Error).message}`)
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('--props must be a JSON object, like {"opacity":0.5}')
    props = { ...(v as Record<string, unknown>) }
  }
  for (const [flag, prop] of PROP_FLAGS) if (o[flag] !== undefined) props[prop] = o[flag]
  return props
}

/** Content given as an argument, "-" or "@file", or piped on standard input when left out (never waiting on a terminal). */
function given(ctx: Ctx, v: string | undefined, what: string): string {
  if (v === undefined && process.stdin.isTTY) throw new Error(`Give ${what} as an argument, "-" or "@file", or pipe it on standard input`)
  return ctx.input(v)
}

/** JSON given as given() takes it. */
function jsonInput(ctx: Ctx, v: string | undefined, what: string): unknown {
  const raw = given(ctx, v, what.toLowerCase())
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`${what} must be JSON: ${(e as Error).message}`)
  }
}

function diagramText(r: DiagramResult): string {
  const w = Math.max(0, ...[...Object.keys(r.nodes), ...Object.keys(r.containers)].map(k => k.length))
  const rows = [`Diagram group ${r.id}`]
  for (const [id, layer] of Object.entries(r.nodes)) rows.push(`  node ${id.padEnd(w)}  ${layer}`)
  for (const [id, layer] of Object.entries(r.containers)) rows.push(`  box  ${id.padEnd(w)}  ${layer}`)
  r.links.forEach((layer, i) => rows.push(`  link ${String(i + 1).padEnd(w)}  ${layer}`))
  if (r.note) rows.push(r.note)
  return rows.join('\n')
}

/** gdocs design ...: commands for designs (.gdesign). */
export function registerDesignCommands(program: Command, ctx: Ctx) {
  const d = program
    .command('design')
    .description(
      'design commands (.gdesign): read, add, set, delete, move, group, ungroup, align, distribute, duplicate, artboard, ' +
        'style, apply, svg, diagram, export. Name layers with --layer <id|name|Group/Child path>'
    )

  liveOptions(
    onArtboard(
      d
        .command('read <file>')
        .description('list the artboards, then each layer: id, name, type, x,y wxh, its text and flags')
        .option('--all-artboards', 'the layers on every artboard')
    )
  ).action(async (file: string, o) => {
    const op: AgentOp = { op: 'read', artboard: o.artboard, allArtboards: o.allArtboards ? true : undefined }
    // --json gives the layer lines as a list, with the artboards, styles and components beside them
    if (ctx.json() && !o.allArtboards) return ctx.out(await ctx.run(design(file), op, o), () => '')
    const r = (await ctx.run(design(file), { ...op, format: 'text' }, o)) as { content: string }
    ctx.out(r, () => r.content)
  })

  liveOptions(
    propOptions(
      onArtboard(
        d
          .command('add <file>')
          .description('add a layer and print its id')
          .requiredOption('--type <type>', 'rect | ellipse | line | path | text | image | group | instance | connector')
          .option('--parent <group>', 'a group to put it in (default: the top of the artboard)')
      )
    )
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'add', type: o.type, props: propsFrom(ctx, o), parent: o.parent, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => said(r, `Added ${idsOf(r)}.`))
  })

  liveOptions(
    propOptions(
      layerOption(
        onArtboard(
          d
            .command('set <file>')
            .description("change a layer's properties")
            .option('--part <inner>', "a layer inside an instance's component: sets its text, fill, stroke or visible for this instance only")
            .option('--all-artboards', 'the layer of that name on every artboard that has one')
        )
      )
    )
  ).action(async (file: string, o) => {
    const op: AgentOp = { op: 'set', layer: o.layer, props: propsFrom(ctx, o), part: o.part, allArtboards: o.allArtboards ? true : undefined, artboard: o.artboard }
    const r = (await ctx.run(design(file), op, o)) as Ids
    ctx.out(r, () => said(r, `Changed ${idsOf(r)}.`))
  })

  liveOptions(
    layerOption(onArtboard(d.command('delete <file>').description('delete a layer (and connectors left joining nothing)').option('--all-artboards', 'on every artboard that has it')))
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'delete', layer: o.layer, allArtboards: o.allArtboards ? true : undefined, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Deleted ${idsOf(r)}.`)
  })

  liveOptions(
    layerOption(
      onArtboard(
        d
          .command('move <file>')
          .description('move a layer in front of or behind others, or into a group')
          .requiredOption('--to <where>', 'front | back | forward | backward | group')
          .option('--parent <group>', 'with --to group: the group (leave it out for the top of the artboard)')
          .option('--index <n>', 'with --to group: its place there, 0 at the back (default: the front)')
          .option('--all-artboards', 'on every artboard that has it')
      )
    )
  ).action(async (file: string, o) => {
    if (!['front', 'back', 'forward', 'backward', 'group'].includes(o.to)) throw new Error('--to must be front, back, forward, backward or group')
    if (o.to !== 'group' && (o.parent !== undefined || o.index !== undefined)) throw new Error('--parent and --index go with --to group')
    const to = o.to === 'group' ? { parent: o.parent ?? '', index: o.index } : o.to
    const r = (await ctx.run(design(file), { op: 'move', layer: o.layer, to, allArtboards: o.allArtboards ? true : undefined, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Moved ${idsOf(r)}.`)
  })

  const layersOption = (c: Command) => c.requiredOption('--layers <refs>', 'layers separated by commas: ids, names or paths')

  liveOptions(layersOption(onArtboard(d.command('group <file>').description('put layers in a new group').option('--name <name>', 'group name')))).action(
    async (file: string, o) => {
      const r = (await ctx.run(design(file), { op: 'group', layers: o.layers, name: o.name, artboard: o.artboard }, o)) as Ids
      ctx.out(r, () => `Grouped them as ${r.id}.`)
    }
  )

  liveOptions(layerOption(onArtboard(d.command('ungroup <file>').description('take the layers out of a group and remove it')))).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'ungroup', layer: o.layer, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => said(r, `Ungrouped ${idsOf(r)}.`))
  })

  liveOptions(
    layersOption(
      onArtboard(
        d
          .command('align <file>')
          .description('line layers up along one edge or their middles')
          .requiredOption('--edge <edge>', 'left | center | right | top | middle | bottom')
          .option('--to-artboard', 'align to the artboard (default: to each other, or the artboard for one layer)')
      )
    )
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'align', layers: o.layers, edge: o.edge, to: o.toArtboard ? 'artboard' : undefined, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Aligned ${idsOf(r)}.`)
  })

  liveOptions(
    layersOption(onArtboard(d.command('distribute <file>').description('space 3 or more layers evenly').requiredOption('--axis <axis>', 'x (across) or y (down)')))
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'distribute', layers: o.layers, axis: o.axis, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Spaced ${idsOf(r)} evenly.`)
  })

  liveOptions(
    layerOption(
      onArtboard(
        d
          .command('duplicate <file>')
          .description('copy a layer (and what it holds) just in front of it')
          .option('--dx <px>', 'move the copy across by this much')
          .option('--dy <px>', 'move the copy down by this much')
      )
    )
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'duplicate', layer: o.layer, dx: o.dx, dy: o.dy, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Made copy ${idsOf(r)}.`)
  })

  // ---------- artboards ----------
  const ab = d.command('artboard').description('add, resize, rename or delete artboards')
  const SIZE = '<w>x<h> or a preset: instagram, portrait, story, linkedin, x, youtube, logo, letter'
  liveOptions(
    ab.command('add <file>').description('add an artboard at the end').option('--name <name>', 'its name').option('--size <size>', `${SIZE} (default: the first artboard's)`)
  ).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'artboard', action: 'add', name: o.name, size: o.size }, o)) as Ids
    ctx.out(r, () => `Added artboard ${r.id}.`)
  })
  liveOptions(onArtboard(ab.command('resize <file>').description('change an artboard\'s size').requiredOption('--size <size>', SIZE))).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'artboard', action: 'resize', size: o.size, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Resized artboard ${r.id}.`)
  })
  liveOptions(onArtboard(ab.command('rename <file>').description('rename an artboard').requiredOption('--name <name>', 'its new name'))).action(async (file: string, o) => {
    const r = (await ctx.run(design(file), { op: 'artboard', action: 'rename', name: o.name, artboard: o.artboard }, o)) as Ids
    ctx.out(r, () => `Renamed artboard ${r.id}.`)
  })
  liveOptions(ab.command('delete <file>').description('delete an artboard and its layers').requiredOption('--artboard <ref>', 'the artboard, by id or name')).action(
    async (file: string, o) => {
      const r = (await ctx.run(design(file), { op: 'artboard', action: 'delete', artboard: o.artboard }, o)) as Ids
      ctx.out(r, () => `Deleted artboard ${r.id}.`)
    }
  )

  // ---------- styles ----------
  liveOptions(
    d
      .command('style <file>')
      .description('add, change or remove named styles. Layers paint with a color style as style:<name>')
      .option('--color <name=#hex>', 'a color style, e.g. Brand=#1a73e8')
      .option('--text <name>', 'a text style, with --font, --size and --weight')
      .option('--font <family>', 'with --text: font family')
      .option('--size <px>', 'with --text: font size')
      .option('--weight <n>', 'with --text: font weight, like 400 or 700')
      .option('--remove <name>', 'remove a style no layer uses')
  ).action(async (file: string, o) => {
    if (o.text === undefined && (o.font !== undefined || o.size !== undefined || o.weight !== undefined)) throw new Error('--font, --size and --weight go with --text <name>')
    const font = o.weight !== undefined ? { family: o.font ?? DEFAULT_FONT.family, weight: o.weight } : o.font
    const text = o.text === undefined ? undefined : { name: o.text, run: { font, size: o.size } }
    const r = (await ctx.run(design(file), { op: 'style', color: o.color, text, remove: o.remove }, o)) as { colors: string[]; text: string[] }
    ctx.out(r, () => `Color styles: ${r.colors.join(', ') || '(none)'}\nText styles: ${r.text.join(', ') || '(none)'}`)
  })

  // ---------- batches ----------
  liveOptions(
    onArtboard(
      d
        .command('apply <file> [ops]')
        .description('run a JSON array of ops as one step, all or nothing ("-" = stdin, "@file"; default: stdin). See gdocs ops')
    )
  ).action(async (file: string, ops: string | undefined, o) => {
    design(file)
    const batch = jsonInput(ctx, ops, 'The ops')
    if (!Array.isArray(batch)) throw new Error('The ops must be a JSON array, like [{"op":"add","type":"rect"}]')
    const r = (await ctx.run(file, { op: 'apply', ops: batch, artboard: o.artboard }, o)) as { results: Ids[] }
    ctx.out(r, () => {
      const rows = r.results.map((res, i) => {
        const name = String((batch[i] as AgentOp)?.op ?? '')
        const ids = res && typeof res === 'object' ? idsOf(res) : ''
        return `  ${String(i + 1).padStart(3)}  ${name.padEnd(10)} ${ids || 'done'}`
      })
      return [`Applied ${r.results.length} op${r.results.length === 1 ? '' : 's'} as one step.`, ...rows].join('\n')
    })
  })

  // ---------- SVG ----------
  liveOptions(
    onArtboard(
      d
        .command('svg <file> [svg]')
        .description('import SVG as layers, cleaned first ("-" = stdin, "@logo.svg"; default: stdin), or print a layer as SVG with --get')
        .option('--name <name>', 'name of the group it comes in as')
        .option('--x <px>', 'left edge')
        .option('--y <px>', 'top edge')
        .option('--parent <group>', 'a group to put it in')
        .option('--get [layer]', 'print this layer as SVG (with no layer, the whole artboard)')
    )
  ).action(async (file: string, svg: string | undefined, o) => {
    if (o.get !== undefined) {
      const r = (await ctx.run(design(file), { op: 'svg', get: o.get, artboard: o.artboard }, o)) as { svg: string }
      return ctx.out(r, () => r.svg)
    }
    design(file)
    const op: AgentOp = { op: 'svg', svg: given(ctx, svg, 'the SVG'), name: o.name, x: o.x, y: o.y, parent: o.parent, artboard: o.artboard }
    const r = (await ctx.run(file, op, o)) as { id: string; removed: string[]; kept: string[] }
    ctx.out(r, () => {
      const rows = [`Imported ${o.name ?? 'the SVG'} as group ${r.id}.`]
      if (r.removed.length) rows.push(`Cleaning removed ${list(r.removed)}.`)
      if (r.kept.length) rows.push('Notes:', ...r.kept.slice(0, 10).map(k => `  ${k}`), ...(r.kept.length > 10 ? [`  and ${r.kept.length - 10} more`] : []))
      return rows.join('\n')
    })
  })

  // ---------- diagrams ----------
  // One command, so --name means the same before and after "tidy" (a subcommand would lose it to its parent).
  liveOptions(
    onArtboard(
      d
        .command('diagram <file> [spec]')
        .usage('[options] <file> [spec]\n       gdocs design diagram tidy <file> --name <name> [--unpin]')
        .description(
          'draw a diagram, laid out for you, from lines or JSON ("-" = stdin, "@file"; default: stdin). Lines: ' +
            '"node <id>: <label> [in <box>]", "box <id>: <label>", "<from> -> <to> [: <label>]" and "direction down". ' +
            'The same name again redraws it. "diagram tidy <file>" lays it out again around nodes moved by hand'
        )
        .option('--name <name>', 'the diagram\'s name (or a "diagram <name>" line)')
        .option('--unpin', 'with tidy: lay out the nodes moved by hand too')
    )
  ).action(async (file: string, spec: string | undefined, o) => {
    if (file === 'tidy') {
      if (!spec) throw new Error('Name the design: gdocs design diagram tidy <file> --name <name>')
      const r = (await ctx.run(design(spec), { op: 'tidy', diagram: o.name, unpin: o.unpin ? true : undefined, artboard: o.artboard }, o)) as DiagramResult
      return ctx.out(r, () => diagramText(r))
    }
    if (o.unpin) throw new Error('--unpin goes with diagram tidy')
    design(file)
    const raw = given(ctx, spec, 'the diagram')
    const op: AgentOp = { op: 'diagram', name: o.name, artboard: o.artboard }
    if (raw.trimStart().startsWith('{')) op.spec = raw
    else op.text = raw
    const r = (await ctx.run(file, op, o)) as DiagramResult
    ctx.out(r, () => diagramText(r))
  })

  // ---------- export ----------
  liveOptions(
    onArtboard(
      d
        .command('export <file>')
        .description('save an artboard as SVG (works without the app) or PNG (needs the app). Fonts are not embedded in SVG')
        .option('--format <format>', 'svg or png', 'svg')
        .option('--scale <n>', 'png: 1 or 2')
        .option('--width <px>', 'width of the image, keeping its shape (svg: the size it opens at)')
        .option('--out <path>', 'where to save it, or "-" to print it (default: <name>.<format> beside the design)')
    )
  ).action(async (file: string, o) => {
    const format = String(o.format).toLowerCase()
    if (format !== 'svg' && format !== 'png') throw new Error('--format must be svg or png')
    if (o.scale !== undefined && !['1', '2'].includes(String(o.scale))) throw new Error('--scale must be 1 or 2')
    const p = path.resolve(design(file))
    if (!fs.existsSync(p)) throw new Error(`No such file: ${p}`)
    if (format === 'png') {
      if (!(await appRunning())) throw new Error(RENDER_NEEDS_APP)
      throw new Error("PNG export isn't available yet.")
    }
    const r = (await ctx.run(p, { op: 'export', format: 'svg', width: o.width, artboard: o.artboard }, o)) as {
      svg: string; leftOut?: { layer: string; name: string; reason: string }[]
    }
    if (o.out === '-') return ctx.out(r, () => r.svg)
    const out = path.resolve(o.out ?? path.join(path.dirname(p), `${path.basename(p, path.extname(p))}.svg`))
    fs.writeFileSync(out, r.svg)
    const { svg: _svg, ...rest } = r
    // stdout is the path alone; what the drawing left out goes beside it
    if (!ctx.json() && r.leftOut?.length) {
      process.stderr.write(`Left out ${upTo(r.leftOut.map(l => `${l.name || l.layer} (${l.reason})`), 10)}.\n`)
    }
    ctx.out({ ...rest, path: out }, () => out)
  })
}
