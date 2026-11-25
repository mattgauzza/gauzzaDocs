import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Teaches AI coding agents to use gauzzaDocs: one skill (SKILL.md) installed where each agent looks for global skills.
 * Paths match the ones Empirical's installer uses for the same agents:
 *   Claude Code     ~/.claude/skills/gauzzadocs/SKILL.md
 *   Codex (+ other agents that read ~/.agents)  ~/.agents/skills/gauzzadocs/SKILL.md
 *   GitHub Copilot  ~/.copilot/skills/gauzzadocs/SKILL.md
 *   Gemini CLI      ~/.gemini/extensions/gauzzadocs/ (gemini-extension.json + GEMINI.md)
 * Files we write carry a marker line, so updates rewrite them and removal never touches anything else.
 */
export const SKILL_NAME = 'gauzzadocs'
const MARKER = 'installed-by: gauzzaDocs'

export interface AgentTarget {
  id: 'claude' | 'codex' | 'copilot' | 'gemini'
  label: string
  configDir: string
  detected: boolean // the agent's folder exists or its command is on PATH
  installed: boolean
  files: string[]
}

const home = () => os.homedir()

function onPath(cmd: string) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

const TARGETS: { id: AgentTarget['id']; label: string; dir: () => string; cmd: string; files: () => string[] }[] = [
  { id: 'claude', label: 'Claude Code', dir: () => path.join(home(), '.claude'), cmd: 'claude', files: () => [path.join(home(), '.claude', 'skills', SKILL_NAME, 'SKILL.md')] },
  { id: 'codex', label: 'Codex', dir: () => path.join(home(), '.codex'), cmd: 'codex', files: () => [path.join(home(), '.agents', 'skills', SKILL_NAME, 'SKILL.md')] },
  { id: 'copilot', label: 'GitHub Copilot CLI', dir: () => path.join(home(), '.copilot'), cmd: 'copilot', files: () => [path.join(home(), '.copilot', 'skills', SKILL_NAME, 'SKILL.md')] },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    dir: () => path.join(home(), '.gemini'),
    cmd: 'gemini',
    files: () => [path.join(home(), '.gemini', 'extensions', SKILL_NAME, 'gemini-extension.json'), path.join(home(), '.gemini', 'extensions', SKILL_NAME, 'GEMINI.md')]
  }
]

const isOurs = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER) || file.endsWith('gemini-extension.json')
  } catch {
    return false
  }
}

export function detectAgents(opts: { checkPath?: boolean } = {}): AgentTarget[] {
  return TARGETS.map(t => {
    const files = t.files()
    return {
      id: t.id,
      label: t.label,
      configDir: t.dir(),
      detected: fs.existsSync(t.dir()) || (opts.checkPath !== false && onPath(t.cmd)),
      installed: files.every(f => fs.existsSync(f)) && isOurs(files[files.length - 1]),
      files
    }
  })
}

/** The skill itself. Agents read the front matter to decide when to load it. */
export function skillText(version: string) {
  return `---
name: ${SKILL_NAME}
description: Use when reading, writing or editing the person's documents, spreadsheets, presentations, PDFs, Markdown or text files with gauzzaDocs (the gdocs command), when they say a file is open in gauzzaDocs, ask you to work on a doc with them, or mention comments in a doc. Edits land live in the open editor while they watch, and their comments and edits stream back to you.
---
<!-- ${MARKER} ${version}. Reinstalled by the app on update; edit a copy under a different name to customise. -->

# gauzzaDocs

gauzzaDocs is the person's local editor for documents (.docx .md .html), spreadsheets (.xlsx .csv .tsv), presentations
(.pptx), PDFs and any text or code file. The \`gdocs\` command (also \`gauzzadocs\`, if \`gdocs\` is taken on this machine) reads and edits
them. When the app is running and the file is open, your edits go into the open editor: the person watches them
happen and can undo them. Otherwise the file on disk is edited.

## Before you edit

1. \`gdocs instructions <file>\` prints standing instructions from the person (for every file and for this file).
   Follow them. They may tell you to look up their writing voice before you write in their name.
2. \`gdocs status\` shows whether the app is running and which files are open. Each file has a short ID (doc:k3x9q2) you can use instead of its path in any command.
3. Read with \`gdocs read <file>\`: documents and presentations come back as Markdown, spreadsheets as CSV, PDFs as text.
   \`--json\` on any command gives machine-readable output; errors exit non-zero with {"error": "..."}.

## Editing

Prefer small, targeted edits over rewriting a whole file, so the person's formatting survives:

\`\`\`
gdocs replace report.md "old text" "new text" [--all]
gdocs doc insert report.md --after "Heading or text" --md "New paragraph"
gdocs append report.md - --live          # content from stdin; --live opens it so they can watch
gdocs sheet set budget.xlsx B7 "=SUM(B2:B6)"
gdocs sheet set-range budget.xlsx A1 --values '[["Item","Cost"],["Desk",300]]'
gdocs pdf highlight contract.pdf --page 2 --x 72 --y 140 --w 300 --h 14
gdocs write notes.md - --format md       # whole-file replace, only when asked
\`\`\`

\`gdocs --help\`, \`gdocs <command> --help\` and \`gdocs ops\` list everything.

PDFs: \`gdocs replace contract.pdf "old words" "new words"\` changes text that's already on the page, even when the
words run across lines of a paragraph. The paragraph is rewrapped to its old width and spacing, in the same color on
the same background. Do it with the app running (it opens the file if needed) so the colors match; on disk alone the
new words come out black on white.

## Presentations (.pptx)

A deck reads and writes as Markdown: \`---\` between slides, \`# Title\` per slide, \`- bullets\` (indent two spaces to
nest), a plain line under the first slide's title is its subtitle, a slide with only a title is a section header,
\`Notes:\` starts the speaker notes and \`![](picture.png)\` adds a picture. \`<!-- layout: twoColumn -->\` picks a
layout (title, titleBody, twoColumn, section, blank) and \`<!-- column -->\` starts the right column. Slides are
numbered from 1.

\`\`\`
gdocs new slides "Quarterly review"               # a new .pptx in the docs folder
gdocs slides from-md deck.pptx --md @outline.md --live   # build the whole deck from Markdown
gdocs slides outline deck.pptx
gdocs slides add deck.pptx --title "Risks" --bullets "Hiring|Supply|  Lead times" --notes "Keep it short"
gdocs slides update deck.pptx 3 --title "Risks" --bullets "Hiring|Supply"
gdocs slides move deck.pptx 5 2
gdocs slides notes deck.pptx 2 "Mention the survey numbers."
gdocs slides delete deck.pptx 4
\`\`\`

Prefer \`slides update\` with --title, --bullets or --notes over --md or rewriting the deck: those change only that text,
so pictures, shapes and positions the person set by hand stay put. Files made in PowerPoint with charts, tables,
SmartArt or animations open with those parts simplified; the first save keeps the untouched original beside it as
<name>.original.pptx.

## Seeing the document

\`gdocs look <file>\` saves screenshots of the file the way the app shows it and prints their paths: one per slide,
or one per screen of a document, sheet, PDF or code file. Open them with your image tool (Read in Claude Code,
view_image in Codex) to check how it reads and looks: headings, spacing, tables, slide layout, anything cut off or
crowded. Do it after big or visual changes and before you tell the person a document is done, not after every small
edit. \`--from 4 --count 2\` picks screens, \`--all\` takes up to 30. It needs the app running, and for an open file
it shows the unsaved changes too.

It also prints layout notes when it finds problems: a heading left at the bottom of a page, a mostly empty page, a
table taller than a page, slide text cut off by its box or something past the slide edge. Fix them: shorten or split
the content, resize the box, or start a section on a new page with
\`gdocs doc insert <file> --before "Section heading" --page-break\`. Then look again.

## Working together through comments

The person can comment on any selection or edit the file while you work. To hear them:

\`\`\`
gdocs listen <file> --once      # waits for their next comment, reply or edit, then exits; replays threads you missed
gdocs comments <file> --waiting # threads still waiting for your answer
gdocs reply <file> <id> "Done: moved it under Risks." --resolve
gdocs comment <file> "Should this be a table?" --quote "Q4 numbers"
\`\`\`

When they ask you to work on a doc with them, loop: \`listen --once\`, do what the comment asks with small edits,
reply in the thread (resolve it when it is done), then listen again until they tell you to stop. Comments that start
with "@agent:" (Rewrite, Make shorter, Fix grammar, Explain) are requests about the quoted text. Your own edits and
replies are never sent back to you.

The person can disconnect you from the app. \`listen\` then prints why and exits with code 3, and trying again is
refused. When that happens, stop listening and don't reconnect unless they ask you to.

## Working with other agents

Several agents can work on one document. To take part:

- Say who you are: set GDOCS_AGENT (or pass --agent) to a one-word name, e.g. \`GDOCS_AGENT=Claude\`. Your edits and
  comments are signed with it and others can @mention you.
- \`gdocs participants <file>\` shows who else is on it and their roles. \`gdocs listen <file> --from others --settle 20 --once\`
  waits for the next batch of edits and comments from the person and other agents. Events that @mention you or reply in
  your thread are marked forYou.
- Review rather than rewrite: comment on another participant's text (\`--quote\` the exact words, @mention them) instead
  of replacing it, unless the person or they asked you to change it. Fix only small things like typos directly.
- Answer in the thread and resolve it when done. Don't reply just to acknowledge, and don't keep a back-and-forth going
  with another agent: if two rounds don't settle it, leave it for the person.
- When you need the person's answer or a decision, ask in a comment and @mention them by the name their comments are
  signed with (\`gdocs instructions <file>\` says it, e.g. @Matt). gauzzaDocs makes that thread glow for them. Don't
  @mention them just to report progress.
- The person can also subscribe agents to a document (\`gdocs subscribe <file> codex --role writer --brief "..." --start\`),
  and gauzzaDocs then wakes them in the background when there is something for them to do.
`
}

const extensionJson = (version: string) =>
  JSON.stringify({ name: SKILL_NAME, version, description: 'Use gauzzaDocs (gdocs) to edit the person\'s documents live', contextFileName: 'GEMINI.md' }, null, 2) + '\n'

export function installSkills(ids: AgentTarget['id'][] | 'all' | 'detected', version: string) {
  const all = detectAgents()
  const pick = ids === 'all' ? all : ids === 'detected' ? all.filter(a => a.detected) : all.filter(a => ids.includes(a.id))
  for (const a of pick) {
    for (const f of a.files) {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, f.endsWith('.json') ? extensionJson(version) : skillText(version))
    }
  }
  return detectAgents({ checkPath: false }).filter(a => pick.some(p => p.id === a.id))
}

export function removeSkills(ids: AgentTarget['id'][] | 'all') {
  const all = detectAgents({ checkPath: false })
  const pick = ids === 'all' ? all : all.filter(a => ids.includes(a.id))
  for (const a of pick) {
    const ours = a.files.filter(isOurs)
    if (!ours.length) continue
    for (const f of ours) fs.rmSync(f, { force: true })
    try {
      fs.rmdirSync(path.dirname(a.files[0])) // the skill folder, only if now empty
    } catch { /* not empty or gone */ }
  }
  return detectAgents({ checkPath: false }).filter(a => pick.some(p => p.id === a.id))
}

/** On app start: bring already-installed skills up to this version (never installs new ones). */
export function refreshInstalledSkills(version: string) {
  const stale = detectAgents({ checkPath: false }).filter(a => a.installed && !fs.readFileSync(a.files[a.files.length - 1], 'utf8').includes(`${MARKER} ${version}`))
  if (stale.length) installSkills(stale.map(a => a.id), version)
}
