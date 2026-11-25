import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { type Ctx, liveOptions } from './common'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }

/** Pictures given as local paths go in as data URLs, so the open editor can show them (it cannot read your disk). */
function inlineImages(text: string, baseDir: string) {
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt: string, src: string) => {
    if (/^(data:|https?:|embedded:)/i.test(src)) return all
    const file = path.resolve(baseDir, decodeURI(src.replace(/^file:\/\/\/?/i, '')))
    const mime = MIME[path.extname(file).slice(1).toLowerCase()]
    if (!mime || !fs.existsSync(file)) return all
    return `![${alt}](data:${mime};base64,${fs.readFileSync(file).toString('base64')})`
  })
}

/** Markdown from --md ("-" = stdin, "@file" = file), else standard input when it is piped. */
function md(ctx: Ctx, v: string | undefined, required = true): string | undefined {
  let text: string | undefined
  if (v !== undefined) text = ctx.input(v)
  else if (!required) return undefined
  else if (process.stdin.isTTY) throw new Error('Give the slides with --md, or pipe Markdown on standard input')
  else text = fs.readFileSync(0, 'utf8')
  // Relative picture paths are relative to the Markdown file when it came from @file, else to the current folder.
  const base = v?.startsWith('@') ? path.dirname(path.resolve(v.slice(1))) : process.cwd()
  return inlineImages(text, base)
}

/** Accepts "a|b|c" or newline separated items for --bullets and --right. */
const items = (v: string | undefined) => (v === undefined ? undefined : v.includes('\n') ? v : v.split('|').join('\n'))

const ref = (v: string) => (/^\d+$/.test(v) ? Number(v) : v)

interface Outline { slides: { slide: number; layout: string; title: string; id: string }[] }

/** gdocs slides ...: commands for presentations (.pptx). */
export function registerSlidesCommands(program: Command, ctx: Ctx) {
  const slides = program
    .command('slides')
    .description('presentation commands (.pptx): outline, add, update, delete, move, notes, from-md. Slides are numbered from 1')

  liveOptions(slides.command('outline <file>').description('list the slides: number, layout and title')).action(async (file: string, o) => {
    const r = (await ctx.run(file, { op: 'outline' }, o)) as Outline
    ctx.out(r, () => r.slides.map(s => `${String(s.slide).padStart(3)}  ${s.layout.padEnd(10)} ${s.title || '(untitled)'}`).join('\n'))
  })

  liveOptions(
    slides
      .command('add <file>')
      .description('add a slide (at the end, or --at <n>). Give --md for a whole slide in Markdown, or --title and --bullets')
      .option('--at <n>', 'position for the new slide (1 = first)')
      .option('--layout <layout>', 'title | titleBody | twoColumn | section | blank')
      .option('--title <text>', 'title')
      .option('--subtitle <text>', 'subtitle (title layout)')
      .option('--bullets <items>', 'bullet points, separated by | or newlines; indent with two spaces')
      .option('--right <items>', 'right column bullets (twoColumn)')
      .option('--notes <text>', 'speaker notes')
      .option('--md <markdown>', 'the slide as Markdown ("-" = stdin, "@file" = file)')
  ).action(async (file: string, o) => {
    const r = (await ctx.run(
      file,
      {
        op: 'addSlide',
        at: o.at ? Number(o.at) : undefined,
        layout: o.layout,
        title: o.title,
        subtitle: o.subtitle,
        bullets: items(o.bullets),
        right: items(o.right),
        notes: o.notes,
        md: md(ctx, o.md, false)
      },
      o
    )) as { slide: number }
    ctx.out(r, () => `Added slide ${r.slide}.`)
  })

  liveOptions(
    slides
      .command('update <file> <slide>')
      .description('change a slide: its title, subtitle, bullets or notes, or all of it with --md')
      .option('--title <text>', 'title')
      .option('--subtitle <text>', 'subtitle')
      .option('--bullets <items>', 'bullet points, separated by | or newlines')
      .option('--right <items>', 'right column bullets')
      .option('--notes <text>', 'speaker notes')
      .option('--md <markdown>', 'the whole slide as Markdown ("-" = stdin, "@file" = file)')
  ).action(async (file: string, slide: string, o) => {
    const r = await ctx.run(
      file,
      { op: 'updateSlide', slide: ref(slide), title: o.title, subtitle: o.subtitle, bullets: items(o.bullets), right: items(o.right), notes: o.notes, md: md(ctx, o.md, false) },
      o
    )
    ctx.out(r, () => `Updated slide ${slide}.`)
  })

  liveOptions(slides.command('delete <file> <slide>').description('delete a slide')).action(async (file: string, slide: string, o) => {
    ctx.out(await ctx.run(file, { op: 'deleteSlide', slide: ref(slide) }, o), () => `Deleted slide ${slide}.`)
  })

  liveOptions(slides.command('move <file> <slide> <to>').description('move a slide to a new position')).action(async (file: string, slide: string, to: string, o) => {
    ctx.out(await ctx.run(file, { op: 'moveSlide', slide: ref(slide), to: ref(to) }, o), () => `Moved slide ${slide} to ${to}.`)
  })

  liveOptions(
    slides
      .command('notes <file> <slide> [text]')
      .description('print a slide\'s speaker notes, or set them (text, or --text "-" for stdin)')
      .option('--text <text>', 'notes ("-" = stdin, "@file" = file)')
  ).action(async (file: string, slide: string, text: string | undefined, o) => {
    const notes = text ?? (o.text !== undefined ? ctx.input(o.text) : undefined)
    if (notes === undefined) {
      const r = (await ctx.run(file, { op: 'slide', slide: ref(slide) }, o)) as { notes: string }
      return ctx.out(r, () => r.notes || '(no notes)')
    }
    ctx.out(await ctx.run(file, { op: 'setNotes', slide: ref(slide), notes }, o), () => `Notes set on slide ${slide}.`)
  })

  liveOptions(
    slides
      .command('from-md <file>')
      .description('replace every slide with Markdown: --- between slides, # title, - bullets, Notes: for speaker notes')
      .option('--md <markdown>', 'the deck as Markdown ("-" = stdin, "@file" = file); default: standard input')
      .option('--append', 'add the slides at the end instead of replacing the deck')
  ).action(async (file: string, o) => {
    const content = md(ctx, o.md)!
    const r = (await ctx.run(file, { op: o.append ? 'append' : 'write', content }, o)) as { slides: number }
    ctx.out(r, () => `${r.slides} slide${r.slides === 1 ? '' : 's'}.`)
  })
}
