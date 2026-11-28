import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { DEFAULT_DESIGN_PRESET, createFile, loadFile } from '../core/files'
import { PRESETS, newDesign } from '../shared/design/model'
import { HOME, freeName, getRecent, getSettings, readServer } from '../core/paths'
import { DOC_ID, docId } from '../shared/docId'
import { resolveDocId } from './docIds'
import { listProjects } from '../core/projects'
import { type AgentTarget, detectAgents, installSkills, removeSkills } from '../core/agentSkills'
import { getGlobal, instructionsFor, setDocInstructions, setGlobal } from '../core/instructions'
import { askPerson, personName } from '../core/person'
import pkg from '../../package.json'
import * as plugins from '../core/plugins'
import { checkPlugin, scaffold } from '../../scripts/plugin-check.mjs'
import { type Kind, kindOf, languageOf } from '../shared/kinds'
import type { AgentOp } from '../shared/types'
import { type Ctx, RENDER_NEEDS_APP, call, liveOptions, runOp } from './common'
import { registerCommentCommands } from './comments'
import { registerSubscribeCommands } from './subscribe'
import { registerProjectCommands } from './projects'
import { registerDocCommands } from './doc'
import { registerPdfCommands } from './pdf'
import { registerSheetCommands } from './sheet'
import { registerSlidesCommands } from './slides' // slides
import { registerDesignCommands } from './design'
import { registerHistoryCommands } from './history'
import { flushHistory, listHistoryPaths } from '../core/history'

const program = new Command()
program
  .name('gdocs')
  .description(
    'gauzzaDocs: read and edit documents, spreadsheets, presentations, designs, PDFs and text files, live in the app or on disk.\n\n' +
      'When the app is running and a file is open in it, edits go into the open editor and appear as you watch\n' +
      '(undoable, saved by the app). Otherwise the file on disk is edited directly. --live opens the file first.\n' +
      'Before editing, run `gdocs instructions <file>`: it prints standing instructions (global and per file).\n' +
      'Two-way: `gdocs listen <file> --once` waits for the person\'s next comment or edit; answer with `gdocs reply`.\n' +
      'Every command takes --json. Content arguments accept "-" for standard input and "@path" for a file\n' +
      '(put -- before content that starts with a dash: gdocs append notes.md -- "- item").'
  )
  .option('--json', 'print JSON instead of text')
  .option('--agent <name>', 'name shown in the app while you edit (default: $GDOCS_AGENT or "Agent")')
  .showHelpAfterError()

const json = () => !!program.opts().json
/** Who the versions this command keeps are credited to: --agent, $GDOCS_AGENT, or "Agent". */
const agentName = (): string => program.opts().agent || process.env.GDOCS_AGENT || 'Agent'
const asAgent = () => ({ authors: [{ name: agentName(), by: 'agent' as const }] })
const out = (data: unknown, human: () => string) => console.log(json() ? JSON.stringify(data, null, 2) : human())
const input = (v: string | undefined): string => {
  if (v === undefined) return fs.readFileSync(0, 'utf8')
  if (v === '-') return fs.readFileSync(0, 'utf8')
  if (v.startsWith('@') && fs.existsSync(v.slice(1))) return fs.readFileSync(v.slice(1), 'utf8')
  return v
}
const ctx: Ctx = {
  json,
  out,
  input,
  agent: () => program.opts().agent || process.env.GDOCS_AGENT || 'Agent',
  run: async (file, op, o = {}) => {
    const r = await runOp(file, op, { live: !!o.live, offline: !!o.offline, focus: o.focus !== false, agent: program.opts().agent })
    if (!json() && process.stderr.isTTY) process.stderr.write(r.live ? '(live in gauzzaDocs)\n' : '')
    return r.result
  }
}
const show = (r: unknown) => (typeof r === 'string' ? r : JSON.stringify(r, null, 2))

// ---------- app ----------
program
  .command('status')
  .description('is the app running, and what does it have open')
  .action(async () => {
    const ping = await call('ping')
    const open = ping ? ((await call('list')) as { path: string; kind: string; dirty: boolean }[]) : []
    out({ running: !!ping, ...(ping as object), open }, () =>
      ping
        ? `gauzzaDocs is running.\n${open.length ? open.map(t => `  ${t.dirty ? '*' : ' '} ${docId(t.path)}  ${t.path}`).join('\n') : '  (no files open)'}`
        : 'gauzzaDocs is not running. Commands will edit files on disk.'
    )
  })

program
  .command('open <files...>')
  .description('open files in the app (starts nothing; the app must be running)')
  .action(async (files: string[]) => {
    const done: string[] = []
    for (const f of files) {
      const r = (await call('open', { path: path.resolve(f) })) as { path: string } | null
      if (!r) throw new Error('gauzzaDocs is not running. Start it first.')
      done.push(r.path)
    }
    out({ opened: done }, () => done.map(d => `opened ${d}`).join('\n'))
  })

program
  .command('new <kind> [name]')
  .description('create a new file: doc | sheet | slides | design | text (in the docs folder, or --dir). Opens it if the app is running')
  .option('--ext <ext>', 'file extension, e.g. md, docx, csv, py')
  .option('--dir <dir>', 'folder to create it in (default: the app\'s docs folder)')
  .option('--size <size>', `a design's size: ${Object.keys(PRESETS).join(', ')} or <w>x<h> (default ${DEFAULT_DESIGN_PRESET})`)
  .option('--no-open', 'do not open it in the app')
  .action(async (kind: Kind, name: string | undefined, o) => {
    if (!['doc', 'sheet', 'slides', 'design', 'text'].includes(kind)) throw new Error('kind must be doc, sheet, slides, design or text')
    if (o.size !== undefined && kind !== 'design') throw new Error('Only a design takes --size')
    if (kind === 'design' && o.ext && o.ext.replace(/^\./, '').toLowerCase() !== 'gdesign') throw new Error('A design is always a .gdesign file')
    const s = getSettings()
    const ext = o.ext || { doc: s.newDocFormat, sheet: 'xlsx', text: 'txt', pdf: 'pdf', slides: 'pptx', design: 'gdesign' }[kind]
    const stemName = name || { doc: 'Untitled document', sheet: 'Untitled spreadsheet', text: 'Untitled', pdf: 'Untitled', slides: 'Untitled presentation', design: 'Untitled design' }[kind]
    if (kind === 'design') newDesign(o.size || DEFAULT_DESIGN_PRESET) // an unknown size fails here, before any file is named
    const file = freeName(path.resolve(o.dir || s.docsDir), stemName, ext)
    await createFile(file, asAgent(), kind === 'design' ? o.size : undefined)
    if (o.open) await call('open', { path: file }).catch(() => null)
    out({ path: file }, () => file)
  })

program
  .command('close <file>')
  .description('close a file in the app (asks to save if it has changes, unless --force)')
  .option('--force', 'discard unsaved changes')
  .action(async (file: string, o) => out(await call('close', { path: path.resolve(file), force: !!o.force }), () => 'closed'))

program
  .command('look <file>')
  .alias('see')
  .description(
    'see the file as the app shows it: saves screenshots (one per slide or design artboard, or per screen of a doc, sheet, PDF or code) as PNGs for you to open'
  )
  .option('--from <n>', 'first slide, artboard or screen to show', '1')
  .option('--count <n>', 'how many to show', '3')
  .option('--all', 'every slide, artboard or screen (up to 30)')
  .option('--width <px>', 'window width (default 1200, slides 1280; designs show each artboard at up to 1600 px)')
  .option('--height <px>', 'window height (default 1400, slides 720)')
  .option('--theme <theme>', 'light or dark (default: the app theme)')
  .option('--out <dir>', 'folder for the images (default: a gauzzadocs-look folder in temp)')
  .action(async (file: string, o) => {
    const p = path.resolve(file)
    if (!fs.existsSync(p)) throw new Error(`No such file: ${p}`)
    const num = (v: unknown) => (v === undefined ? undefined : Number(v))
    const r = (await call('look', {
      path: p,
      from: num(o.from),
      count: num(o.count),
      all: !!o.all,
      width: num(o.width),
      height: num(o.height),
      theme: o.theme,
      out: o.out,
      agent: { name: program.opts().agent || process.env.GDOCS_AGENT || 'Agent' }
    })) as { unit: string; total: number; images: { n: number; file: string; width: number; height: number }[]; notes?: string[] } | null
    if (!r) {
      if (kindOf(p) === 'design') throw new Error(RENDER_NEEDS_APP)
      throw new Error('gdocs look needs gauzzaDocs running, since it pictures the file the way the app shows it. Start the app and try again.')
    }
    out(r, () => {
      const last = r.images.at(-1)?.n || 0
      const more = last < r.total ? `\n${r.total - last} more: gdocs look ${file} --from ${last + 1}` : ''
      const notes = r.notes?.length ? `\n\nLayout notes:\n${r.notes.map(n => `- ${n}`).join('\n')}` : ''
      return `${r.images.map(i => `${r.unit} ${i.n} of ${r.total}: ${i.file}`).join('\n')}${more}\nOpen each image with your image viewer tool to see it.${notes}`
    })
  })

program
  .command('list')
  .alias('recent')
  .description('recently opened files')
  .option('-n <count>', 'how many', '30')
  .action((o: { n: string }) => {
    const r = getRecent().slice(0, Number(o.n))
    out(r, () => r.map(x => `${x.kind.padEnd(6)} ${new Date(x.opened).toLocaleString().padEnd(22)} ${x.path}`).join('\n') || '(none)')
  })

// ---------- generic editing (every kind) ----------
liveOptions(
  program
    .command('read <file>')
    .description('print a file\'s content: docs as markdown (or --format html|text), sheets as CSV, slides as Markdown, PDFs as text, designs as layer lines')
    .option('--format <format>', 'md | html | text (docs); csv | json | formulas (sheets); text | json (pdf)')
    .option('--lines <range>', 'text files: only these lines, e.g. 10-40')
    .option('--range <range>', 'sheets: only this range, e.g. A1:D20')
    .option('--sheet <name>', 'sheets: which sheet')
    .option('--pages <pages>', 'pdf: which pages, e.g. 1-3')
)
  .action(async (file: string, o) => {
    const kind = kindOf(file)
    const op: AgentOp = { op: 'read' }
    if (o.format) op.format = o.format
    else if (kind === 'sheet') op.format = 'csv'
    else if (kind === 'design') op.format = 'text' // the lines gdocs design read prints
    if (o.lines) op.lines = o.lines
    if (o.range) op.range = o.range
    if (o.sheet) op.sheet = o.sheet
    if (o.pages) op.pages = o.pages
    const r = (await ctx.run(file, op, o)) as { content?: string }
    // Standing instructions come with every read: in the JSON, or as a note on stderr (stdout stays pure content).
    const ins = instructionsFor(path.resolve(file))
    if (!json() && (ins.global || ins.file)) process.stderr.write(`(agent instructions apply: run gdocs instructions "${file}")\n`)
    out({ ...(r as object), instructions: ins }, () => (typeof r?.content === 'string' ? r.content.replace(/\n$/, '') : show(r)))
  })

liveOptions(
  program
    .command('write <file> [content]')
    .description('replace the whole content (docs: markdown by default; sheets: CSV). Content from arg, "-" or stdin, or @file')
    .option('--format <format>', 'md | html | text (docs); csv | json (sheets)')
)
  .action(async (file: string, content: string | undefined, o) => {
    const op: AgentOp = { op: 'write', content: input(content) }
    if (o.format) op.format = o.format
    out(await ctx.run(file, op, o), () => 'written')
  })

for (const which of ['append', 'prepend'] as const) {
  liveOptions(
    program
      .command(`${which} <file> [content]`)
      .description(`${which === 'append' ? 'add to the end' : 'add to the start'} (docs take markdown by default)`)
      .option('--format <format>', 'md | html | text (docs)')
  )
    .action(async (file: string, content: string | undefined, o) => {
      const op: AgentOp = { op: which, content: input(content) }
      if (o.format) op.format = o.format
      out(await ctx.run(file, op, o), () => 'done')
    })
}

liveOptions(
  program
    .command('replace <file> <find> <with>')
    .description('find and replace text (docs keep their formatting around the match)')
    .option('--all', 'every match (default: first only)')
    .option('--regex', 'treat <find> as a JavaScript regular expression; $1 works in <with>')
    .option('-i, --ignore-case', 'ignore case')
)
  .action(async (file: string, find: string, withText: string, o) => {
    const r = (await ctx.run(file, { op: 'replace', find, with: withText, all: !!o.all, regex: !!o.regex, ignoreCase: !!o.ignoreCase }, o)) as { count?: number; replaced?: number; note?: string }
    out(r, () => `${r.count ?? r.replaced ?? 0} replaced${r.note ? `. ${r.note}` : ''}`)
  })

liveOptions(
  program
    .command('find <file> <query>')
    .description('find text: lines in text files, blocks in docs')
    .option('--regex', 'regular expression')
    .option('-i, --ignore-case', 'ignore case')
)
  .action(async (file: string, query: string, o) => {
    const r = (await ctx.run(file, { op: 'find', query, regex: !!o.regex, ignoreCase: !!o.ignoreCase }, o)) as {
      matches: { line?: number; col?: number; block?: number; text: string }[]
    }
    out(r, () => r.matches.map(m => `${m.line ?? m.block}${m.col ? `:${m.col}` : ''}  ${m.text}`).join('\n') || '(no matches)')
  })

liveOptions(
  program
    .command('lines <file> <action> <from> [to]')
    .description('text files: insert | replace | delete lines. insert <file> insert <line> (content from --content or stdin)')
    .option('--content <text>', 'content; "-" for stdin, @file for a file')
)
  .action(async (file: string, action: string, from: string, to: string | undefined, o) => {
    const ops: Record<string, AgentOp> = {
      insert: { op: 'insert', line: Number(from), content: input(o.content) },
      replace: { op: 'replaceLines', from: Number(from), to: Number(to ?? from), content: input(o.content) },
      delete: { op: 'deleteLines', from: Number(from), to: Number(to ?? from) }
    }
    if (!ops[action]) throw new Error('action must be insert, replace or delete')
    out(await ctx.run(file, ops[action], o), () => 'done')
  })

liveOptions(program.command('info <file>').description('what the file is: kind, size, lines/words/sheets/pages'))
  .action(async (file: string, o) => {
    const r = await ctx.run(file, { op: 'info' }, o)
    out({ path: path.resolve(file), kind: kindOf(file), language: languageOf(file), ...(r as object) }, () => show(r))
  })

liveOptions(
  program
    .command('op <file> [json]')
    .description('run any raw op (see ops reference: gdocs ops). JSON from arg, "-" or stdin')
)
  .action(async (file: string, raw: string | undefined, o) => {
    const op = JSON.parse(input(raw)) as AgentOp
    const r = await ctx.run(file, op, o)
    out(r, () => show(r))
  })

program
  .command('save <file>')
  .description('save a file that is open in the app')
  .action(async (file: string) => out(await ctx.run(file, { op: 'save' }, {}), () => 'saved'))

program
  .command('watch <file>')
  .description('print a line each time the file changes in the app (Ctrl+C to stop). Needs the app running')
  .action(async (file: string) => {
    const s = readServer()
    if (!s || !(await call('ping'))) throw new Error('gauzzaDocs is not running')
    const target = path.resolve(file).toLowerCase()
    const res = await fetch(`http://127.0.0.1:${s.port}/events`, { headers: { authorization: `Bearer ${s.token}` } })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (!chunk.startsWith('data: ')) continue
        const ev = JSON.parse(chunk.slice(6)) as { type: string; path?: string }
        if (ev.path && ev.path.toLowerCase() === target) console.log(json() ? JSON.stringify(ev) : `${new Date().toLocaleTimeString()} ${ev.type}`)
      }
    }
  })

program
  .command('convert <from> <to>')
  .description('convert between formats by extension: md/html/docx, xlsx/csv/tsv (works without the app)')
  .action(async (from: string, to: string) => {
    const f = await loadFile(from)
    if (kindOf(to) !== f.kind) throw new Error(`Cannot convert a ${f.kind} to ${path.extname(to)}`)
    const { saveFile } = await import('../core/files')
    await saveFile(to, f.payload, asAgent())
    out({ path: path.resolve(to) }, () => path.resolve(to))
  })

// ---------- formatting with plugins ----------
program
  .command('format <file>')
  .description('reformat a file with a plugin formatter (e.g. pretty-print JSON). Lists formatters with --list')
  .option('--with <formatter>', 'formatter id, e.g. json-tools.pretty (default: first that fits the language)')
  .option('--list', 'list available formatters')
  .option('--stdout', 'print the result instead of writing it')
  .option('--live', 'apply in the open editor (opens it)')
  .action(async (file: string, o) => {
    const fmts = await plugins.nodeFormatters()
    const lang = languageOf(file)
    if (o.list) return out(fmts.map(({ format: _f, ...x }) => x), () => fmts.map(f => `${f.id.padEnd(32)} ${f.name}${f.languages ? `  [${f.languages.join(', ')}]` : ''}`).join('\n') || 'No formatters. Install plugins: gdocs plugins marketplace')
    const f = o.with ? fmts.find(x => x.id === o.with) : fmts.find(x => !x.languages || x.languages.includes(lang))
    if (!f) throw new Error(o.with ? `No formatter "${o.with}"` : `No formatter for ${lang}. See gdocs format --list`)
    const cur = (await ctx.run(file, { op: 'read', format: kindOf(file) === 'doc' ? 'html' : undefined }, o)) as { content: string }
    const next = await f.format(cur.content, { language: lang, path: path.resolve(file) })
    if (o.stdout) return console.log(next)
    await ctx.run(file, { op: 'write', content: next, format: kindOf(file) === 'doc' ? 'html' : undefined }, o)
    out({ formatter: f.id, path: path.resolve(file) }, () => `formatted with ${f.id}`)
  })

// ---------- plugins ----------
const pl = program.command('plugins').description('manage plugins (formatters, previews and commands)')
pl.command('list').description('installed plugins').action(() => {
  const r = plugins.installed()
  out(r, () => r.map(p => `${p.enabled ? '●' : '○'} ${p.id.padEnd(24)} ${p.version.padEnd(8)} ${p.description || ''}`).join('\n') || '(none installed) — see gdocs plugins marketplace')
})
pl.command('marketplace').alias('library').alias('search').argument('[query]')
  .description('plugins on offer in the marketplace (✓ installed, ↑ update available)')
  .option('--category <name>', 'only this category')
  .action(async (q: string | undefined, o: { category?: string }) => {
    const lib = await plugins.library(bundledPlugins())
    const needle = q?.toLowerCase()
    const list = lib.plugins.filter(p =>
      (!needle || `${p.id} ${p.name} ${p.description} ${(p.tags || []).join(' ')}`.toLowerCase().includes(needle)) &&
      (!o.category || (p.category || '').toLowerCase() === o.category.toLowerCase()))
    out({ ...lib, plugins: list }, () => {
      const head = `${lib.name || 'Marketplace'}: ${lib.source}${lib.offline ? `\n(the online marketplace could not be reached: ${lib.offline}; showing the copy bundled with the app)` : ''}`
      const cats = [...new Set(list.map(p => p.category || 'Other'))]
      return [head, ...cats.map(c => `\n${c}\n` + list.filter(p => (p.category || 'Other') === c)
        .map(p => `  ${p.update ? '↑' : p.installed ? '✓' : ' '} ${`${p.icon || ''} ${p.id}`.padEnd(24)} ${p.version.padEnd(7)} ${p.description || ''}`).join('\n'))].join('\n')
    })
  })
pl.command('install <ids...>').description('install from the marketplace by id (checksums verified), or from a local folder').action(async (ids: string[]) => {
  const done: Awaited<ReturnType<typeof plugins.install>>[] = []
  for (const id of ids) done.push(await plugins.install(id, bundledPlugins()))
  out(done, () => done.map(p => `installed ${p.id} ${p.version}`).join('\n') + '\nIn the app: Plugins → Reload plugins.')
})
pl.command('new <id> [dir]')
  .description('start a plugin: writes plugin.json and an index.js with a formatter, a command and a preview to edit')
  .option('--name <name>', 'display name')
  .action((id: string, dir: string | undefined, o: { name?: string }) => {
    const target = path.resolve(dir || id)
    scaffold(target, id, o.name || id)
    out({ path: target }, () =>
      `Created ${target}\n\nNext:\n  1. edit index.js (API: plugins/README.md in the gauzzaDocs repo)\n  2. gdocs plugins validate "${target}"\n  3. gdocs plugins install "${target}"   then Plugins → Reload plugins in the app\n  4. to list it in the marketplace: Help → Submit a plugin`)
  })
pl.command('validate <dir>')
  .description('check a plugin folder against the marketplace rules (the same checks CI runs on submissions)')
  .action(async (dir: string) => {
    const r = await checkPlugin(path.resolve(dir), { requireFolderMatch: false })
    out(r, () => (r.problems.length ? `✗ ${r.problems.length} problem(s):\n${r.problems.map(p => `  - ${p}`).join('\n')}` : `✓ looks good: ${r.registered.join(', ')}`))
    if (r.problems.length) process.exitCode = 1
  })
pl.command('update [ids...]').description('update installed plugins to the marketplace\'s latest versions (all when no ids)').action(async (ids: string[]) => {
  const done = ids.length
    ? await Promise.all(ids.map(async id => ({ id, to: (await plugins.install(id, bundledPlugins())).version })))
    : await plugins.updateAll(bundledPlugins())
  out(done, () => (done.length ? done.map(d => `updated ${d.id} → ${d.to}`).join('\n') : 'Everything is up to date.'))
})
pl.command('remove <id>').action((id: string) => {
  plugins.remove(id)
  out({ removed: id }, () => `removed ${id}`)
})
pl.command('enable <id>').action((id: string) => out(plugins.setEnabled(id, true), () => `enabled ${id}`))
pl.command('disable <id>').action((id: string) => out(plugins.setEnabled(id, false), () => `disabled ${id}`))

/** The plugin marketplace shipped beside the CLI (dist/../plugins), used when GitHub cannot be reached. */
function bundledPlugins() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
  for (const p of [path.join(here, '..', 'plugins'), path.join(here, '..', '..', 'plugins')]) if (fs.existsSync(path.join(p, 'marketplace.json'))) return p
  return undefined
}

program
  .command('ops')
  .description('reference of every op, for `gdocs op`')
  .action(() => {
    const here = bundledPlugins()
    const doc = here ? path.join(here, '..', 'src', 'shared', 'ops.md') : ''
    console.log(doc && fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : 'See src/shared/ops.md in the gauzzaDocs repository.')
  })

// ---------- teaching AI agents to use gauzzaDocs ----------
const ag = program.command('agents').description('install the gauzzaDocs skill into AI agents (Claude Code, Codex, Copilot CLI, Gemini CLI)')
const showAgents = (list: AgentTarget[]) =>
  list.map(a => `${a.installed ? '✓' : a.detected ? '·' : ' '} ${a.id.padEnd(8)} ${a.label.padEnd(20)} ${a.installed ? 'skill installed' : a.detected ? 'found, not installed' : 'not found'}`).join('\n')
ag.command('list', { isDefault: true }).description('which agents are on this PC and which have the skill').action(() => {
  const r = detectAgents()
  out(r, () => `${showAgents(r)}\n\nInstall with: gdocs agents install (all agents found) or gdocs agents install claude codex`)
})
ag.command('install [ids...]').description('install or update the skill: agent ids (claude codex copilot gemini), "all", or none for every agent found')
  .action((ids: string[]) => {
    const pick = !ids.length ? 'detected' : ids.includes('all') ? 'all' : (ids as AgentTarget['id'][])
    const r = installSkills(pick, pkg.version)
    out(r, () => (r.length ? `${showAgents(r)}\n\nAgents load it next time they start.` : 'No agents found. Name one: gdocs agents install claude'))
  })
ag.command('remove [ids...]').description('remove the skill (all agents when no ids)').action((ids: string[]) => {
  const r = removeSkills(ids.length ? (ids as AgentTarget['id'][]) : 'all')
  out(r, () => showAgents(r))
})

program
  .command('instructions [file]')
  .description(
    'standing instructions for agents: the global ones, plus the ones saved invisibly in this file.\n' +
      'Agents: run this before editing a file, and follow what it says.'
  )
  .option('--set <text>', 'replace the instructions ("-" for stdin, @file); with --global, the global ones')
  .option('--global', 'the instructions for every file (~/.gauzzadocs/agent.md)')
  .option('--clear', 'remove them')
  .action(async (file: string | undefined, o) => {
    if (o.set !== undefined || o.clear) {
      const text = o.clear ? '' : input(o.set)
      if (o.global) setGlobal(text)
      else if (file) await setDocInstructions(path.resolve(file), text, asAgent())
      else throw new Error('Give a file, or --global')
      return out({ ok: true }, () => (o.clear ? 'cleared' : 'saved'))
    }
    const r = o.global ? { global: getGlobal(), file: '' } : instructionsFor(file && path.resolve(file))
    // Who the person is, so agents know whom to @mention when they need an answer.
    const person = personName()
    out({ ...r, person }, () => {
      const parts = []
      if (r.global) parts.push(`## For every file\n\n${r.global}`)
      if (file && !o.global) parts.push(r.file ? `## For ${path.basename(file)}\n\n${r.file}` : `(no instructions saved in ${path.basename(file)})`)
      if (!parts.length) parts.push('No agent instructions. Set them with --set, or in the app under Tools → Agent instructions.')
      parts.push(`## Asking ${person}\n\n${askPerson(person)}`)
      return parts.join('\n\n')
    })
  })

program
  .command('where')
  .description('where settings, plugins and new files live')
  .action(() => out({ home: HOME, docsDir: getSettings().docsDir, plugins: path.join(HOME, 'plugins') }, () =>
    `app data: ${HOME}\nnew files: ${getSettings().docsDir}\nplugins:   ${path.join(HOME, 'plugins')}`))

registerProjectCommands(program, ctx)
registerCommentCommands(program, ctx, agentName)
registerSubscribeCommands(program, ctx)
registerDocCommands(program, ctx)
registerSheetCommands(program, ctx)
registerPdfCommands(program, ctx, agentName)
registerSlidesCommands(program, ctx) // slides
registerDesignCommands(program, ctx)
registerHistoryCommands(program, ctx, agentName)

// Always node-style argv: installed copies run this under the app's Electron runtime (ELECTRON_RUN_AS_NODE),
// where Commander would otherwise treat the script path as the first command.
resolveDocIds(process.argv)
  .then(argv => program.parseAsync(argv, { from: 'node' }))
  .then(() => flushHistory()) // queued version history writes finish before the process ends
  .catch(async e => {
  await flushHistory().catch(() => {})
  const msg = (e as Error).message || String(e)
  if (json()) console.error(JSON.stringify({ error: msg }))
  else console.error(`error: ${msg}`)
  process.exit(1)
})

/**
 * Lets any command take a short document ID (doc:k3x9q2, shown in the app's status bar and comments panel) instead of
 * a path. Looked up among the files open in the app, recent files and files at the top of projects; files with version
 * history (which include files that no longer exist) only when none of those match. See resolveDocId.
 */
async function resolveDocIds(argv: string[]): Promise<string[]> {
  if (!argv.some(a => DOC_ID.test(a))) return argv
  const places = new Set<string>()
  const open = ((await call('list').catch(() => null)) as { path: string }[] | null) || []
  for (const t of open) places.add(t.path)
  for (const r of getRecent()) places.add(r.path)
  for (const p of listProjects()) {
    try {
      for (const f of fs.readdirSync(p.path)) places.add(path.join(p.path, f))
    } catch { /* missing project */ }
  }
  return argv.map(a => (DOC_ID.test(a) ? resolveDocId(a, places, listHistoryPaths) : a))
}
