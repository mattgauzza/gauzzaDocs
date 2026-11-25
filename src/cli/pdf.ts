import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { mergePdfs } from '../core/ops/pdf'
import type { PdfEdit } from '../shared/types'
import { type Ctx, liveOptions } from './common'

const number = (v: string) => {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`)
  return n
}

/** gdocs pdf ...: read, mark up and rearrange PDFs. Edits land live in the app when the file is open there. */
export function registerPdfCommands(program: Command, ctx: Ctx) {
  const pdf = program
    .command('pdf')
    .description('Read, edit and mark up PDFs: edit existing text, fill forms, highlights, whiteout, page rotate/delete/move, merge.\nCoordinates are points (1/72 in) from the top-left of the page; pages are 1-based.')

  const done = (r: unknown) => {
    const res = r as { applied?: number; pages?: number } | undefined
    ctx.out(r, () => (res?.pages != null ? `Done. ${res.pages} pages.` : 'Done.'))
  }

  pdf
    .command('info <file>')
    .description('page count, page sizes in points and rotation')
    .action(async file => {
      const r = (await ctx.run(file, { op: 'info' })) as { pages: number; sizes: { w: number; h: number; rotation: number }[]; title?: string; pendingEdits?: number }
      ctx.out(r, () =>
        [
          `${r.pages} page${r.pages === 1 ? '' : 's'}${r.title ? `  "${r.title}"` : ''}${r.pendingEdits ? `  (${r.pendingEdits} unsaved edits in the app)` : ''}`,
          ...r.sizes.map((s, i) => `  ${i + 1}: ${Math.round(s.w)} x ${Math.round(s.h)} pt${s.rotation ? `, rotated ${s.rotation}°` : ''}`)
        ].join('\n')
      )
    })

  pdf
    .command('text <file>')
    .description('extract text, page by page')
    .option('-p, --pages <range>', 'pages, e.g. 1-3,5')
    .action(async (file, o) => {
      const r = (await ctx.run(file, { op: 'read', pages: o.pages, format: ctx.json() ? 'json' : 'text' })) as { content?: string }
      ctx.out(r, () => r.content || '')
    })

  liveOptions(
    pdf
      .command('add-text <file>')
      .description('place text on a page')
      .requiredOption('--page <n>', 'page number', number)
      .requiredOption('--x <pt>', 'left, in points', number)
      .requiredOption('--y <pt>', 'top, in points', number)
      .requiredOption('--text <text>', 'the text ("-" reads standard input, @file reads a file)')
      .option('--size <pt>', 'font size', number, 12)
      .option('--color <hex>', 'text color', '#000000')
  ).action(async (file, o) => {
    const edit: PdfEdit = { type: 'text', page: o.page, x: o.x, y: o.y, text: ctx.input(o.text), size: o.size, color: o.color }
    done(await ctx.run(file, { op: 'annotate', edits: [edit] }, o))
  })

  const rectCommand = (name: string, desc: string, make: (o: Record<string, any>) => PdfEdit) =>
    liveOptions(
      pdf
        .command(`${name} <file>`)
        .description(desc)
        .requiredOption('--page <n>', 'page number', number)
        .requiredOption('--x <pt>', 'left', number)
        .requiredOption('--y <pt>', 'top', number)
        .requiredOption('--w <pt>', 'width', number)
        .requiredOption('--h <pt>', 'height', number)
        .option('--color <hex>', 'color')
    ).action(async (file, o) => done(await ctx.run(file, { op: 'annotate', edits: [make(o)] }, o)))

  rectCommand('highlight', 'translucent highlight over an area (default yellow)', o => ({ type: 'highlight', page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, color: o.color }))
  rectCommand('whiteout', 'cover an area with white (or --color) to hide what is under it', o => ({ type: 'rect', page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, fill: o.color || '#ffffff' }))
  rectCommand('rect', 'draw a rectangle outline (default red)', o => ({ type: 'rect', page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, color: o.color }))

  liveOptions(
    pdf
      .command('annotate <file> [edits]')
      .description('apply a JSON array of edits (argument, "-" for stdin, or @file). Types: text, highlight, rect, ink, image, rotate, delete, move')
  ).action(async (file, edits, o) => {
    const text = ctx.input(edits ?? '-')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('edits must be JSON, e.g. [{"type":"highlight","page":1,"x":72,"y":100,"w":200,"h":14}]')
    }
    done(await ctx.run(file, { op: 'annotate', edits: Array.isArray(parsed) ? parsed : [parsed] }, o))
  })

  liveOptions(
    pdf
      .command('rotate <file>')
      .description('rotate pages clockwise')
      .option('-p, --pages <range>', 'pages (default all)')
      .option('-d, --degrees <n>', 'multiple of 90', number, 90)
  ).action(async (file, o) => done(await ctx.run(file, { op: 'rotate', pages: o.pages, degrees: o.degrees }, o)))

  liveOptions(pdf.command('delete-pages <file> <range>').description('remove pages, e.g. 2 or 3-5,8')).action(async (file, range, o) =>
    done(await ctx.run(file, { op: 'deletePages', pages: range }, o))
  )

  liveOptions(pdf.command('move-page <file> <page> <to>').description('move a page to a new position')).action(async (file, page, to, o) =>
    done(await ctx.run(file, { op: 'movePage', page: number(page), to: number(to) }, o))
  )

  // ---------- editing text that is already in the PDF ----------
  pdf
    .command('lines <file>')
    .description('lines of text with their boxes (what replace-text and the Edit text tool work on)')
    .option('-p, --page <n>', 'one page (default all)', number)
    .action(async (file, o) => {
      const r = (await ctx.run(file, { op: 'textLines', page: o.page })) as { lines: { id: string; x: number; y: number; w: number; h: number; size: number; font: string; bold: boolean; italic: boolean; text: string }[] }
      ctx.out(r, () =>
        r.lines
          .map(l => `${l.id.padEnd(7)} ${`${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.w)}x${Math.round(l.h)}`.padEnd(16)} ${`${Math.round(l.size)}pt ${l.font}${l.bold ? ' bold' : ''}${l.italic ? ' italic' : ''}`.padEnd(20)} ${l.text}`)
          .join('\n') || '(no editable text: scanned pages have no text layer)'
      )
    })

  liveOptions(
    pdf
      .command('replace-text <file> <find> <with>')
      .description('change words that are already in the PDF: the old text is removed and the new text drawn in a matching font. Matches must sit inside one line')
      .option('-p, --page <n>', 'only this page', number)
      .option('--all', 'every match (default: the first)')
  ).action(async (file, find, withText, o) => {
    const r = (await ctx.run(file, { op: 'replaceText', page: o.page, find, with: ctx.input(withText), all: !!o.all }, o)) as { replaced: number; pending?: boolean }
    ctx.out(r, () => `Replaced ${r.replaced}${r.pending ? ' (shown in the app; written into the file on save)' : ''}.`)
  })

  // ---------- forms ----------
  pdf
    .command('fields <file>')
    .description('form fields: name, type, current value and options')
    .action(async file => {
      const r = (await ctx.run(file, { op: 'formFields' })) as { fields: { name: string; type: string; value: unknown; options?: string[]; readOnly?: boolean }[] }
      ctx.out(r, () =>
        r.fields
          .map(f => `${f.name.padEnd(28)} ${f.type.padEnd(10)} ${JSON.stringify(f.value)}${f.options ? `  options: ${f.options.join(' | ')}` : ''}${f.readOnly ? '  (read-only)' : ''}`)
          .join('\n') || '(this PDF has no form fields)'
      )
    })

  liveOptions(
    pdf
      .command('fill <file> [pairs...]')
      .description('fill form fields: name=value pairs (checkboxes take true/false), or --values with a JSON map')
      .option('--values <json>', 'JSON object of field name to value ("-" for stdin, @file)')
      .option('--flatten', 'bake the values into the page and remove the fields')
  ).action(async (file, pairs: string[], o) => {
    const fields: Record<string, unknown> = o.values ? JSON.parse(ctx.input(o.values)) : {}
    for (const p of pairs) {
      const i = p.indexOf('=')
      if (i < 1) throw new Error(`"${p}" should be name=value`)
      fields[p.slice(0, i)] = p.slice(i + 1)
    }
    if (!Object.keys(fields).length && !o.flatten) throw new Error('Nothing to fill. Use name=value pairs or --values')
    const r = (await ctx.run(file, { op: 'fillForm', fields, flatten: !!o.flatten }, o)) as { filled: number; pending?: boolean }
    ctx.out(r, () => `Filled ${r.filled} field${r.filled === 1 ? '' : 's'}${o.flatten ? ' and flattened the form' : ''}${r.pending ? ' (shown in the app; written into the file on save)' : ''}.`)
  })

  pdf
    .command('merge <out> <inputs...>')
    .description('combine PDFs, in order, into <out> (written on disk)')
    .option('-f, --force', 'overwrite <out> if it exists')
    .action(async (out, inputs: string[], o) => {
      const dest = path.resolve(out)
      if (fs.existsSync(dest) && !o.force) throw new Error(`${dest} exists; add --force to overwrite`)
      const [first, ...rest] = inputs.map(f => new Uint8Array(fs.readFileSync(path.resolve(f))))
      const bytes = await mergePdfs(first, rest)
      fs.writeFileSync(dest, bytes)
      const { PDFDocument } = await import('pdf-lib')
      const pages = (await PDFDocument.load(bytes)).getPageCount()
      ctx.out({ path: dest, pages }, () => `Wrote ${dest} (${pages} pages)`)
    })
}
