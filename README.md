# gauzzaDocs

A fast, local editor that feels like Google Docs and Sheets: documents, spreadsheets, PDFs and any text or code file,
in tabs, in one lightweight app. A command-line tool (`gdocs`) lets AI agents and scripts read and edit the same files,
live in the open editor while you watch.

- **Docs**: real pages on a gray canvas with the Docs toolbar, headings, lists, checklists, tables, images, links, an
  outline and comments. Opens and saves `.html`, `.md` and `.docx` (Word). Export to PDF.
- **Markdown** (what AI tools write): Edit, Read (a clean GitHub-style page), Split (source beside the live page) and
  Source views. Front matter, task lists, tables and fenced code survive open and save unchanged; open tabs follow an
  agent's changes as it writes.
- **Sheets**: formula bar, formulas (SUM, IF, VLOOKUP, XLOOKUP, …), formatting, merged cells, conditional formatting,
  charts, frozen rows, multiple sheets. Opens and saves `.xlsx`, `.csv`, `.tsv`.
- **PDFs**: view, select text, add text, highlight, draw, white out, add a signature image, rotate, reorder and delete pages.
- **Everything else**: a code editor like Notepad++: syntax highlighting for about 100 languages, find/replace, multiple
  cursors, folding, word wrap. Plugins add formatters, previews and commands.
- Files stay ordinary files on your PC. No account, no server, nothing is uploaded.

The sibling project [Qmail](https://github.com/mattgauzza/quickMail) does the same for email.

## Install

Download the latest installer from the [Releases page](https://github.com/mattgauzza/gauzzaDocs/releases/latest):

- **Windows**: `gauzzaDocs-Setup-x.y.z.exe`. It installs for your user only, with no administrator prompt. The installer
  is not code-signed, so Windows may say "Windows protected your PC": choose **More info → Run anyway**.
- **macOS (Apple Silicon)**: `gauzzaDocs-x.y.z-mac-arm64.dmg`. The app is not signed with an Apple certificate, so run
  `xattr -cr /Applications/gauzzaDocs.app` once in Terminal before opening it.
- **Linux**: `gauzzaDocs-x.y.z-linux-amd64.deb` (`sudo apt install ./gauzzaDocs-*.deb`) or the `.AppImage`.

The first start puts the `gdocs` command on your PATH (Windows: in the per-user WindowsApps folder; macOS and Linux:
`~/.local/bin`). Nothing else needs installing.

**Updates** are automatic on Windows and the Linux AppImage: the app checks GitHub releases at start and every half hour,
downloads in the background, and shows a green download button in the tab strip. Click it to restart into the new
version, or just close the app. On macOS, download the new `.dmg`.

## Agents: the `gdocs` CLI

```
gdocs status                              # is the app running, what is open
gdocs read report.md                      # docs as markdown, sheets as CSV, PDFs as text
gdocs append report.md "## Next steps" --live   # opens it in the app and types it in while you watch
gdocs replace report.md "Q3" "Q4" --all   # keeps the formatting around each match
gdocs doc insert report.md --after "Summary" --md "A new paragraph."
gdocs sheet set budget.xlsx B7 "=SUM(B2:B6)"
gdocs sheet format budget.xlsx A7:D7 --bold
gdocs pdf text contract.pdf --pages 1-3
gdocs pdf highlight contract.pdf --page 2 --x 72 --y 140 --w 300 --h 14
gdocs format data.json --with json-tools.pretty
gdocs op notes.txt '{"op":"replaceLines","from":3,"to":5,"content":"…"}'
```

- When the app is running and the file is open there, edits go into the open editor: you see them happen, the agent's
  name shows at the top, and Ctrl+Z undoes them. When it is not open, the file on disk is edited directly.
  `--live` opens the file first; `--offline` always edits the disk copy.
- Every command takes `--json`; errors exit non-zero with `{"error": "..."}`. Content arguments take `-` for standard
  input or `@file`. `gdocs --help` and `gdocs <command> --help` list everything; `gdocs ops` prints the raw op reference.
- Set `GDOCS_AGENT=Claude` (or `--agent Claude`) to choose the name shown in the app.
- The bridge listens on 127.0.0.1 only and needs the token in `~/.gauzzadocs/server.json`, so only programs running
  as you can use it.

In the app, **Agent** (top right of any file) shows the commands and ready-made prompts to copy.

### Two-way: comments and edits stream back to the agent

Comment on anything (select text, **Ctrl+Alt+M**, or the comment button top right) and an agent that is listening
hears it at once. So do your own edits, as small before/after diffs. The agent answers in the thread, and its reply
appears live in the comments panel. While an agent listens, the header says so ("Claude is listening").

```
gdocs listen report.md --once         # wait for the person's next comment, reply or edit, then exit
gdocs comments report.md --waiting    # threads still waiting for an answer
gdocs reply report.md <id> "Done, moved it under Risks." --resolve
gdocs comment report.md "Should this be a table?" --quote "Q4 numbers"
```

`listen` first replays open threads that are still waiting for an answer, so nothing said while no agent was
listening gets lost. The agent's own edits and replies are never echoed back to it. A loop like "listen --once, act,
reply, listen again" turns any coding agent into a collaborator in the doc; Agent → "Work on a doc with me" has a
prompt for it. Comments live in `~/.gauzzadocs/comments.json` and follow renames made in the app. They work without the
app too (`gdocs comments`, `reply`); only `listen` needs it running. Your edits are only diffed while an agent is
listening, so it costs nothing otherwise.

### Your writing voice, with Empirical

gauzzaDocs pairs well with [Empirical](https://empirical.gauzza.com), persistent memory for AI agents that we also
build. Its command-line tool, [`@empirical-gauzza/cli`](https://www.npmjs.com/package/@empirical-gauzza/cli), gives
Claude Code, Codex, Copilot and Cursor one shared memory, including **your writing voice**: how you write, learned once
in a short interview, then used by every agent that drafts in your name.

```
npm install -g @empirical-gauzza/cli
empirical install                      # sign in and set up
empirical plugin install claude --voice   # adds the writing-voice skill (also: codex, copilot, all)
```

Set up your voice at [empirical.gauzza.com/voice](https://empirical.gauzza.com/voice) (also Help → Set up your writing
voice in the app). Then make it a standing instruction for every file, so agents look it up before writing:

```
gdocs instructions --global --set 'Before writing in my name, look up my voice: empirical memory query --match "how this person writes" --tags writing-voice --top-k 50'
```

### Standing instructions for agents

Tools → Agent instructions holds two layers of instructions that agents get before they touch a file:

- **For every file**: `~/.gauzzadocs/agent.md`, e.g. "before writing in my name, look up my writing voice with
  `empirical memory query --match "how this person writes" --tags writing-voice --top-k 50`".
- **For one file**: saved invisibly inside the file so they travel with it (an inert `<script type="text/x-gdocs-instructions">`
  in an HTML file's head, a leading `<!-- gdocs:instructions … -->` comment in Markdown). Word, Excel, PDF and code files
  keep theirs in `~/.gauzzadocs/instructions.json`, which follows renames made in the app. Files with instructions show
  an **Instructions** chip in the header.

```
gdocs instructions report.md                       # both layers; agents run this first
gdocs instructions report.md --set "Keep it under one page."
gdocs instructions --global --set @my-rules.md
```

`gdocs read --json` includes them, and a plain `gdocs read` notes on stderr when they apply.

## Status bar

Every file has a status bar along the bottom, like a code editor: words, characters, paragraphs, pages and reading
time for documents (and the selection's count); Ln/Col, line length, line count, longest line (click to jump), language
and indent for code; the current page for PDFs; the line position for large files. On the right: format, line endings,
encoding, size on disk (click to show in folder) and save state.

## Memory

Only what is in use is loaded:

- Each editor (documents, sheets, PDF, code) is a separate bundle that loads the first time a file of that kind opens.
- Background tabs go to sleep: the tab in focus and the two most recently used stay loaded; others drop their editor and
  content once saved and reload from disk when clicked (or when an agent edits them). Unsaved tabs never sleep.
  Tabs restored at start-up stay asleep until opened.
- PDFs stream from disk by byte range, so only the pages on screen are read; the whole file is read only to save or
  rearrange pages. Page text is extracted only when searched or asked for.
- Text and CSV files over 32 MB open in a read-only viewer that reads only the lines on screen (a sparse line index,
  about 160 KB for 20 million lines). Search streams through the file. `gdocs` can still edit them on disk.
- Sheets store only non-empty cells, render only visible cells, recalculate only what depends on a change, and keep
  undo as small diffs.

## Tabs

Every open file is a tab, like a code editor: drag to reorder, middle-click to close, right-click for close others / close
to the right / copy path / show in folder, Ctrl+Tab to switch. Tabs from the last session reopen at start. A dot marks
unsaved changes.

Saving works like Google Docs: changes save automatically a moment after you stop typing. Word and PDF files are the
exception (saving them can drop things the app does not support), so those save on Ctrl+S. If a file changes on disk,
the open tab reloads; if you also have unsaved changes, you choose which version to keep.

## Plugins

Plugins → Marketplace… browses [`plugins/marketplace.json`](plugins/marketplace.json) in this repository: 13 base
plugins in six categories (formatters for JSON, XML, SQL and CSS; writing review; Markdown and HTML previews; CSV and
Markdown tables; JSON ⇄ YAML; developer utilities; log insights). Every download is checked against the SHA-256 in the
marketplace file. Writing one takes a single JavaScript file: see [plugins/README.md](plugins/README.md).

```
gdocs plugins marketplace      # what is on offer, by category
gdocs plugins install json-tools sql-format writing-tools
gdocs plugins update           # install every available update
gdocs format query.sql         # uses the first formatter for the file's language
```

## Sharing

gauzzaDocs keeps files as ordinary files and has no server, so sharing works the way it does for any local file:
keep them in a synced folder (OneDrive, Dropbox, Google Drive, iCloud, Syncthing) or a git repository. Open tabs reload
when a synced copy changes, and if you also have unsaved changes you choose which version to keep. Comments are stored
on your PC, not in the file, so they are not shared yet.

## Support

gauzzaDocs is free and open source ([MIT](LICENSE)). Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md),
and [plugins/README.md](plugins/README.md#submitting-a-plugin) to publish a plugin.

## Where things live

- Your files: wherever they are. New files go to `Documents\gauzzaDocs` (change it in Settings).
- App data: `~/.gauzzadocs` (settings, recent files, plugins, the bridge address).

## Build from source

Needs Node 22+.

```
npm install
npm run dev          # the app, with hot reload
npm run build        # app + CLI (dist/cli.mjs)
node dist/cli.mjs --help
npm run dist         # Windows installer in release/
```

Installed copies put `gdocs` on the PATH the first time the app starts.

## Layout

```
src/shared     pure code used everywhere: file kinds, types, markdown/html conversion, the ops agents run,
               the sheet formula engine, PDF edits
src/core       Node only: loading and saving each format, running ops on files on disk, plugins, paths
src/main       Electron main process: window, file dialogs, the live-edit bridge (server.ts)
src/cli        the gdocs command
src/renderer   the window: App.tsx (tabs, menus, saving, agent routing) and one folder per editor
plugins        the plugin library
```
