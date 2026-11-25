import fs from 'node:fs'
import type { Command } from 'commander'
import { type Ctx, liveOptions } from './common'

/** Content from --md / --html / --text (each may be "-" for stdin or "@file"), else standard input as markdown. */
function content(ctx: Ctx, o: { md?: string; html?: string; text?: string }) {
  if (o.html !== undefined) return { content: ctx.input(o.html), format: 'html' }
  if (o.text !== undefined) return { content: ctx.input(o.text), format: 'text' }
  if (o.md !== undefined) return { content: ctx.input(o.md), format: 'md' }
  if (process.stdin.isTTY) throw new Error('Give the content with --md, --html or --text, or pipe markdown on standard input')
  return { content: fs.readFileSync(0, 'utf8'), format: 'md' }
}

/** gdocs doc ...: commands that only make sense for documents (.html .md .docx). */
export function registerDocCommands(program: Command, ctx: Ctx) {
  const doc = program.command('doc').description('document commands (.html .md .docx): outline, insert, find')

  liveOptions(
    doc.command('outline <file>').description('list the headings of a document')
  ).action(async (file: string, o) => {
    const r = (await ctx.run(file, { op: 'outline' }, o)) as { headings: { level: number; text: string }[] }
    ctx.out(r, () => (r.headings.length ? r.headings.map(h => `${'  '.repeat(h.level - 1)}${h.text}`).join('\n') : '(no headings)'))
  })

  liveOptions(
    doc
      .command('insert <file>')
      .description('insert content after or before the first block (paragraph, heading, ...) containing some text')
      .option('--after <text>', 'insert after the block containing this text')
      .option('--before <text>', 'insert before the block containing this text')
      .option('--md <markdown>', 'content as markdown ("-" = stdin, "@file" = file)')
      .option('--html <html>', 'content as HTML')
      .option('--text <text>', 'content as plain text')
      .option('--page-break', 'a page break (start what follows on a new page)')
  ).action(async (file: string, o) => {
    if (!o.after && !o.before) throw new Error('Use --after <text> or --before <text>')
    if (o.pageBreak) o.html = '<div class="page-break" style="page-break-after: always"></div>'
    const r = await ctx.run(file, { op: 'insert', after: o.after, before: o.before, ...content(ctx, o) }, o)
    ctx.out(r, () => 'Inserted.')
  })

  liveOptions(
    doc
      .command('find <file> <query>')
      .description('list the blocks that contain some text')
      .option('-i, --ignore-case', 'ignore case')
  ).action(async (file: string, query: string, o) => {
    const r = (await ctx.run(file, { op: 'find', query, ignoreCase: !!o.ignoreCase }, o)) as { matches: { block: number; text: string }[] }
    ctx.out(r, () => (r.matches.length ? r.matches.map(m => `${String(m.block).padStart(4)}  ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') : 'No matches.'))
  })
}
