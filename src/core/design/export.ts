// Exporting a design's artboards as SVG or PNG files. The drawing always comes from the design op `export`
// (shared/ops/design.ts), run through whatever runs ops on the file: in the open editor when the app has it open, so
// unsaved changes are in it, and on disk otherwise. This module takes it from there: one artboard or each in turn, the
// cleaning, the file names, what the format can't hold and the writing. designImage makes one artboard the same way
// for a document (Insert > Design) and writes nothing. SVG works anywhere; a PNG needs a window to draw it in (the
// app's), which `rasterize` stands for.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DrawCounts, Downgrade } from '../../shared/design/render'
import { INSERT_SCALE } from '../../shared/design/insert'
import { cleanSvg, exportLimits } from '../../shared/design/svgClean'
import { MAX_PNG_PIXELS, MAX_PNG_SIDE } from '../../shared/ops/design'
import { list } from '../../shared/ops/designLayers'
import type { AgentOp } from '../../shared/types'

export { MAX_PNG_PIXELS, MAX_PNG_SIDE }

/** What drawing a design to pixels (PNG export, gdocs look, thumbnails) says when the app isn't running. */
export const RENDER_NEEDS_APP = 'Start gauzzaDocs to render designs. Editing and SVG export work without it.'
/** What an SVG export can't hold, named in the reply when the drawing uses it. */
export const BLEND_NOTE = 'Blend modes may be flattened by tools other than browsers and Inkscape.'
export const FONTS_NOTE = "Fonts are not embedded, so text may show in another font where its font isn't installed."
const PNG_TO_STDOUT = "A PNG can't be printed here. Give --out a file or a folder."
const several = (n: number): string => `This design has ${n} artboards. Pick one with --artboard, or give --out a folder.`

export interface ExportOptions {
  format: 'svg' | 'png'
  /** One artboard, by id or name. Left out, every artboard is exported, each to its own file. */
  artboard?: string
  /** png: 1 or 2 (svg ignores it). */
  scale?: number | string
  /** The width, keeping the shape: svg, the size it opens at; png, the pixels before scale. */
  width?: number | string
  /**
   * A file, a folder (one ending in a path separator is made if it isn't there) or "-" for the SVG back as `content`.
   * Left out, files go beside the design.
   */
  out?: string
}

export interface ExportDeps {
  /** Runs a design op on the file and gives its result: in its editor when the app has it open, else on disk. */
  run(op: AgentOp): Promise<unknown>
  /** Draws SVG to PNG bytes at a size, in the app's window. Without it, PNG export refuses with RENDER_NEEDS_APP. */
  rasterize?(svg: string, width: number, height: number): Promise<Uint8Array>
}

/** A layer the drawing left out, and the artboard it was on. */
export interface LeftOut extends Downgrade { artboard: string }

export interface ExportResult {
  /** Every file written, in artboard order. */
  files: string[]
  /** What the format can't hold, in plain sentences. */
  downgrades: string[]
  /** Layers the drawing left out, and why. */
  leftOut: LeftOut[]
  /** With out "-": the cleaned SVG, not written anywhere. */
  content?: string
}

/** What the `export` op gives for one artboard. */
interface Drawn {
  svg: string
  artboard: { id: string; name: string }
  width: number
  height: number
  drawn?: DrawCounts
  leftOut?: Downgrade[]
}
/** What the `export` op gives with `plan`: the artboards to export, at their export sizes. */
interface Plan { artboards: { id: string; name: string; width: number; height: number }[] }

/**
 * A name made safe for a file name on any system: no characters Windows refuses (\ / : * ? " < > | and control
 * characters), spaces in their place, no dots or spaces at the end, at most 100 characters.
 */
export const fileNamePart = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .replace(/[\s.]+$/, '')
    .trim()

const isFolder = (p: string): boolean => !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()

/** What an SVG export uses that the format doesn't carry everywhere. */
function svgNotes(svg: string): string[] {
  const out: string[] = []
  if (svg.includes('mix-blend-mode:')) out.push(BLEND_NOTE)
  if (/<text[\s>]/.test(svg)) out.push(FONTS_NOTE)
  return out
}

/**
 * One artboard's drawing (what the `export` op gave) made into the format's bytes, for a file or a document alike.
 * SVG is cleaned, with room for what it draws (exportLimits), and what it can't hold is added to `notes`. A PNG is
 * drawn by `rasterize` as the editor draws it. It isn't cleaned: the window draws it as an image, which runs no script
 * and fetches nothing, and its svg layers (drawn as data URI images, which cleaning would drop) were cleaned on import
 * and again on read.
 */
async function artboardBytes(r: Drawn, format: 'svg' | 'png', deps: ExportDeps, notes: Set<string>): Promise<string | Uint8Array> {
  if (format === 'png') return deps.rasterize!(r.svg, r.width, r.height)
  const clean = cleanSvg(r.svg, exportLimits(r.svg, r.drawn ?? { svg: 0, fragmentElements: 0, paints: 0 }))
  for (const n of svgNotes(clean.svg)) notes.add(n)
  if (clean.removed.length) notes.add(`Cleaning removed ${list(clean.removed)}.`)
  return clean.svg
}

/** One artboard drawn for a document (Insert > Design): nothing is written. */
export interface DesignImage {
  /** The cleaned SVG, or the PNG's bytes. */
  data: string | Uint8Array
  artboard: { id: string; name: string }
  /** The SVG's size, or the PNG's pixels (INSERT_SCALE times the artboard's). */
  width: number
  height: number
  /** What the format can't hold, in plain sentences. */
  downgrades: string[]
  /** Layers the drawing left out, and why. */
  leftOut: LeftOut[]
}

/**
 * One artboard (the one `artboard` names, else the first) as an image for a document, by the same op and the same
 * code as an export, and written nowhere: SVG cleaned as an export file is, or a PNG at INSERT_SCALE times the
 * artboard's size, checked against the PNG limits before it's drawn. Refuses as an export does: PNG without a window to
 * draw in with RENDER_NEEDS_APP, and an artboard that isn't there or a size past the limits in the op's words.
 */
export async function designImage(o: { format: 'svg' | 'png'; artboard?: string }, deps: ExportDeps): Promise<DesignImage> {
  const format = o.format
  if (format !== 'svg' && format !== 'png') throw new Error('The format must be svg or png.')
  if (format === 'png' && !deps.rasterize) throw new Error(RENDER_NEEDS_APP)
  // the op sizes a PNG and refuses one past the limits before it draws anything
  const r = (await deps.run({ op: 'export', format, scale: format === 'png' ? INSERT_SCALE : undefined, artboard: o.artboard })) as Drawn
  const notes = new Set<string>()
  const data = await artboardBytes(r, format, deps, notes)
  return {
    data,
    artboard: { id: r.artboard.id, name: r.artboard.name },
    width: r.width,
    height: r.height,
    downgrades: [...notes],
    leftOut: (r.leftOut ?? []).map(l => ({ artboard: r.artboard.name, ...l }))
  }
}

/**
 * Writes each file whole or not at all: every one goes to a new name beside its target first, and only once all of
 * them are written are they renamed into place, so a failure leaves no file behind and an export already there as it
 * was. `folder`, when given, is made first.
 */
async function writeAll(files: { to: string; data: string | Uint8Array }[], folder: string | null): Promise<void> {
  if (folder) await fs.promises.mkdir(folder, { recursive: true })
  const temps: string[] = []
  try {
    for (const f of files) {
      const temp = path.join(path.dirname(f.to), `.${path.basename(f.to)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      temps.push(temp)
      await fs.promises.writeFile(temp, f.data, { flag: 'wx' })
    }
    for (const [i, f] of files.entries()) await fs.promises.rename(temps[i], f.to)
  } finally {
    for (const t of temps) await fs.promises.rm(t, { force: true })
  }
}

/**
 * Exports a design's artboards: the one `artboard` names, else every artboard. Files are named after the design, and
 * after the artboard when there are several or one was named: `<stem>.<ext>`, or `<stem> <artboard>.<ext>` (made safe
 * for a file name, by id when nothing is left of the name or two names come out the same). They go beside the design
 * unless `out` says where: into it when it's a folder (one ending in a path separator is made), else to it for one
 * artboard; a file or "-" with several artboards is refused. Every artboard's size is checked before any is drawn (a
 * PNG past its limits is refused) and every file is made before any is written. Then they're written whole
 * (writeAll), so a refusal or failure writes nothing. Every SVG is cleaned, with room for what it draws (exportLimits). A PNG is drawn
 * as the editor draws it, by `rasterize`. Returns the files, what the format can't hold and the layers the drawing left
 * out.
 */
export async function exportDesign(file: string, o: ExportOptions, deps: ExportDeps): Promise<ExportResult> {
  const p = path.resolve(file)
  const format = o.format
  if (format !== 'svg' && format !== 'png') throw new Error('The format must be svg or png.')
  if (format === 'png' && !deps.rasterize) throw new Error(RENDER_NEEDS_APP)
  if (format === 'png' && o.out === '-') throw new Error(PNG_TO_STDOUT)
  const toFolder = o.out !== undefined && o.out !== '-' && (/[\\/]$/.test(o.out) || isFolder(o.out))
  const given = { format, width: o.width, scale: format === 'png' ? o.scale : undefined }
  // every artboard and its size, each checked, before anything is drawn
  const { artboards: boards } = (await deps.run({ op: 'export', ...given, artboard: o.artboard, plan: true })) as Plan
  if (o.artboard === undefined && o.out !== undefined && !toFolder && boards.length > 1) throw new Error(several(boards.length))

  const stem = path.basename(p, path.extname(p))
  const used = new Set<string>()
  const nameOf = (a: { id: string; name: string }): string => {
    if (o.artboard === undefined && boards.length === 1) return stem
    const part = fileNamePart(a.name)
    let name = part ? `${stem} ${part}` : `${stem} ${a.id}`
    if (used.has(name.toLowerCase())) name = `${name} ${a.id}`
    used.add(name.toLowerCase())
    return name
  }
  const target = (a: { id: string; name: string }): string => {
    const name = `${nameOf(a)}.${format}`
    if (o.out === undefined) return path.join(path.dirname(p), name)
    return toFolder ? path.join(path.resolve(o.out!), name) : path.resolve(o.out!)
  }

  const out: ExportResult = { files: [], downgrades: [], leftOut: [] }
  const notes = new Set<string>()
  const made: { to: string; data: string | Uint8Array }[] = []
  for (const a of boards) {
    const r = (await deps.run({ op: 'export', ...given, artboard: a.id })) as Drawn
    for (const l of r.leftOut ?? []) out.leftOut.push({ artboard: r.artboard.name, ...l })
    const data = await artboardBytes(r, format, deps, notes)
    if (o.out === '-') out.content = data as string
    else made.push({ to: target(r.artboard), data })
  }
  await writeAll(made, toFolder ? path.resolve(o.out!) : null)
  out.files = made.map(m => m.to)
  out.downgrades = [...notes]
  return out
}
