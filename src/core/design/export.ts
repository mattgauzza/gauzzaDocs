// Exporting a design's artboards as SVG or PNG files. The drawing always comes from the design op `export`
// (shared/ops/design.ts), run through whatever runs ops on the file: in the open editor when the app has it open, so
// unsaved changes are in it, and on disk otherwise. This module takes it from there: one artboard or each in turn, the
// cleaning, the file names, what the format can't hold and the writing. SVG works anywhere; a PNG needs a window to
// draw it in (the app's), which `rasterize` stands for.
import fs from 'node:fs'
import path from 'node:path'
import type { Downgrade } from '../../shared/design/render'
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
  /** A file, a folder or "-" for the SVG back as `content`. Left out, files go beside the design. */
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
  artboards: { id: string; name: string }[]
  svgLayers?: number
  leftOut?: Downgrade[]
}

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
 * Exports a design's artboards: the one `artboard` names, else every artboard. Files are named after the design, and
 * after the artboard when there are several or one was named: `<stem>.<ext>`, or `<stem> <artboard>.<ext>` (made safe
 * for a file name, by id when nothing is left of the name or two names come out the same). They go beside the design,
 * into `out` when it's a folder, or to `out` itself for one artboard; a file or "-" with several artboards is refused
 * before anything is drawn. Every SVG is cleaned before it's written, with room for the svg layers it inlines
 * (exportLimits). A PNG is drawn as the editor draws it, by `rasterize`. Returns the files, what the format can't hold
 * and the layers the drawing left out.
 */
export async function exportDesign(file: string, o: ExportOptions, deps: ExportDeps): Promise<ExportResult> {
  const p = path.resolve(file)
  const format = o.format
  if (format !== 'svg' && format !== 'png') throw new Error('The format must be svg or png.')
  if (format === 'png' && !deps.rasterize) throw new Error(RENDER_NEEDS_APP)
  if (format === 'png' && o.out === '-') throw new Error(PNG_TO_STDOUT)
  const folder = o.out !== undefined && o.out !== '-' && isFolder(o.out)
  const oneFile = o.artboard === undefined && o.out !== undefined && !folder
  if (oneFile) {
    const { artboards } = (await deps.run({ op: 'info' })) as { artboards: number }
    if (artboards > 1) throw new Error(several(artboards))
  }
  const draw = async (artboard: string | undefined): Promise<Drawn> =>
    (await deps.run({ op: 'export', format, artboard, width: o.width, scale: format === 'png' ? o.scale : undefined })) as Drawn
  const first = await draw(o.artboard)
  const boards = o.artboard === undefined ? first.artboards : [first.artboard]
  // the design may have changed since info (an edit in the app)
  if (oneFile && boards.length > 1) throw new Error(several(boards.length))

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
    return folder ? path.join(path.resolve(o.out), name) : path.resolve(o.out)
  }

  const out: ExportResult = { files: [], downgrades: [], leftOut: [] }
  const notes = new Set<string>()
  for (const a of boards) {
    const r = a.id === first.artboard.id ? first : await draw(a.id)
    for (const l of r.leftOut ?? []) out.leftOut.push({ artboard: r.artboard.name, ...l })
    let data: string | Uint8Array
    if (format === 'svg') {
      const clean = cleanSvg(r.svg, exportLimits(r.svgLayers ?? 0))
      for (const n of svgNotes(clean.svg)) notes.add(n)
      if (clean.removed.length) notes.add(`Cleaning removed ${list(clean.removed)}.`)
      data = clean.svg
    } else data = await deps.rasterize!(r.svg, r.width, r.height)
    if (o.out === '-') {
      out.content = data as string
      break
    }
    const to = target(r.artboard)
    await fs.promises.writeFile(to, data)
    out.files.push(to)
  }
  out.downgrades = [...notes]
  return out
}
