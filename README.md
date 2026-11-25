# gauzzaDocs

gauzzaDocs is a desktop editor for documents, spreadsheets, PDFs and any text or code file. It works like Google Docs
and Sheets and keeps everything in tabs on your own PC. It comes with a command line tool, `gdocs`, that AI agents use to
read and edit the same files while you watch. You can comment back to the agent from inside the doc.

- Documents look like Google Docs, with real pages, the usual toolbar, comments and an outline. They open and save as
  Word, Markdown or HTML and export to PDF.
- Markdown files (which is mostly what AI writes) have Edit, Read, Split and Source views. Front matter, tables, task
  lists and code blocks come back out the same way they went in.
- Spreadsheets have a formula bar, the usual formulas, formatting, merged cells, conditional formatting and charts.
  They open and save as Excel, CSV or TSV.
- PDFs let you change the text that's already there, fill in forms and sign them. You can also add text, highlights,
  drawing or whiteout. Pages can be rotated, reordered or deleted.
- Every other file opens in a code editor that works like Notepad++. Plugins add formatters, previews and commands.
- Files stay normal files on your PC. There's no account and nothing gets uploaded.

My email app [Qmail](https://github.com/mattgauzza/quickMail) works the same way for mail.

## Why I built it

I don't have an Office subscription. LibreOffice and OpenOffice feel ancient, slow and hard to use. I wanted something
that feels like Google Docs but runs on my own computer.

I also wanted a real connection to my AI. When an agent edits a doc for me, I want to watch it happen. And if I leave a
comment or change something, that should stream straight back to the agent so it can keep going.

So gauzzaDocs is an editor that feels like Google Docs plus a command line tool agents use to work in the same files
with you.

## Install

Download the latest installer from the [Releases page](https://github.com/mattgauzza/gauzzaDocs/releases/latest).

On Windows, run `gauzzaDocs-Setup-x.y.z.exe`. It installs for your user only and doesn't ask for an administrator. The
installer isn't code signed, so Windows may show "Windows protected your PC". Choose More info, then Run anyway.

On a Mac with Apple Silicon, open `gauzzaDocs-x.y.z-mac-arm64.dmg` and drag the app to Applications. The app isn't
signed with an Apple certificate, so run `xattr -cr /Applications/gauzzaDocs.app` once in Terminal before you open it.

On Linux, install `gauzzaDocs-x.y.z-linux-amd64.deb` with `sudo apt install ./gauzzaDocs-*.deb`, or use the AppImage.

The first time it starts, the app puts the `gdocs` command on your PATH. If another program already uses that name,
gauzzaDocs leaves it alone and you can use `gauzzadocs` instead. Nothing else needs installing.

The first time you open the app it walks you through three optional steps. You can pick gauzzaDocs as the default app
for your documents, connect your AI agents and set up your writing voice. It's under Help if you skip it.

Updates are automatic on Windows and with the Linux AppImage. The app checks GitHub when it starts and every half hour,
downloads new versions in the background and shows a green download button in the tab strip. Click it to restart into
the new version, or just close the app and it updates then. On a Mac, download the new `.dmg`.

## The gdocs command line tool

```
gdocs status                              # is the app running and what's open
gdocs read report.md                      # docs as Markdown, sheets as CSV, PDFs as text
gdocs append report.md "## Next steps" --live   # opens it in the app and types it in while you watch
gdocs replace report.md "Q3" "Q4" --all   # keeps the formatting around each match
gdocs doc insert report.md --after "Summary" --md "A new paragraph."
gdocs sheet set budget.xlsx B7 "=SUM(B2:B6)"
gdocs sheet format budget.xlsx A7:D7 --bold
gdocs pdf text contract.pdf --pages 1-3
gdocs pdf highlight contract.pdf --page 2 --x 72 --y 140 --w 300 --h 14
gdocs pdf replace-text invoice.pdf "1,250 USD" "1,400 USD"
gdocs pdf fill application.pdf name="Jamie Chen" agree=true
gdocs format data.json --with json-tools.pretty
```

When the app is running and the file is open, edits go straight into the open editor. You see them happen, the agent's
name shows at the top and Ctrl+Z undoes them. When the file isn't open, the tool edits it on disk. `--live` opens the
file first and `--offline` always edits the copy on disk.

Every command takes `--json`, and errors exit non zero with `{"error": "..."}`. Content can come from standard input
(`-`) or a file (`@notes.md`). `gdocs --help` lists everything and `gdocs ops` prints every raw operation. Set
`GDOCS_AGENT=Claude` to choose the name the app shows while the agent works.

Every file has a short document ID like `doc:k3x9q2`. You'll find it in the status bar and the comments panel. Any command takes it instead of the path, so `gdocs listen doc:k3x9q2` works without pasting a long path.

The tool talks to the app over 127.0.0.1 with a token stored in `~/.gauzzadocs/server.json`, so only programs running
as you can use it. In the app, the Agent button at the top right of any file shows these commands and some prompts you
can copy.

### Connecting your agents

`gdocs agents install` adds a gauzzaDocs skill to Claude Code, Codex, GitHub Copilot CLI and Gemini CLI if they're on
your PC. The skill tells the agent how to use `gdocs`, to check your standing instructions first and how to answer
your comments. `gdocs agents` shows which ones are connected and `gdocs agents remove` takes it back out.

### Comments and edits stream back to the agent

Select some text and press Ctrl+Alt+M (or use the comment button) to leave a comment. An agent that's listening gets it
right away, along with small before and after diffs of anything you change. It answers in the comment thread and its
reply shows up live. The header says "Claude is listening" while one is connected.

```
gdocs listen report.md --once         # wait for your next comment, reply or edit, then exit
gdocs comments report.md --waiting    # threads still waiting for an answer
gdocs reply report.md <id> "Done, moved it under Risks." --resolve
gdocs comment report.md "Should this be a table?" --quote "Q4 numbers"
```

An agent that runs `listen --once`, does what you asked, replies and then listens again will keep working with you
until you tell it to stop. The Agent button has a "Work on a doc with me" prompt for that. When an agent starts
listening it first gets any comments it missed. Its own edits and replies aren't sent back to it.

Comments are saved in `~/.gauzzadocs/comments.json` and follow a file when you rename it in the app. Your edits are
only compared while an agent is listening, so there's no cost the rest of the time.

Click "Claude is listening" in the header to see every agent connected to the file. Disconnect cuts one off. The agent
is told you disconnected it, and it can't listen to that file again until you click Allow again or restart the app.
Subscribed agents show up in the same list, where you can pause or remove them.

### Agents can see the document

Reading the text doesn't tell an agent how the page looks. `gdocs look` renders the file the way the app shows it and
saves screenshots: one per slide, or one per screen of a doc, sheet, PDF or code file. The agent opens them with its
own image tool and checks the layout, the tables and anything that's cut off. The skill tells agents to do this after
big changes and before they call a draft done. It renders in a hidden window, so it doesn't move what you're looking
at, and it includes changes you haven't saved yet.

```
gdocs look report.md                    # the first 3 screens
gdocs look deck.pptx --all              # every slide, up to 30
gdocs look report.md --from 4 --count 2
```

### Agents working together

I can put more than one agent on a document and let them work it out between them. Each one is subscribed to the doc
with a role and a brief. gauzzaDocs runs it in the background with its own CLI and my own login, so there are no API
keys. An agent gets a turn when I comment, when someone @mentions it, when someone replies in its thread or, for
reviewers and editors, after someone else's edits settle down.

```
gdocs subscribe plan.md codex --role writer --brief "Write a one page plan for the move. Short summary at the top." --start
gdocs subscribe plan.md claude --role reviewer --brief "Review it and leave at most two comments a turn."
gdocs participants plan.md
gdocs wake plan.md claude --note "Check the numbers in section 2"
```

Codex writes the draft and I watch it land in the open doc. Claude reads it, quotes the parts it has a problem with
and @mentions Codex. Codex fixes them and answers in the thread. I can comment at any point and whoever owns that part
picks it up. In the app it's the Add agent button next to the comments button, and each agent shows up there as an
avatar with what it's doing.

Agents hear each other's edits and comments too, but never their own. An agent you run yourself can join with
`gdocs listen plan.md --from others --settle 20 --once`.

There are limits so they can't run away. Each agent gets one turn at a time and at most six turns in ten minutes. A
turn can't run longer than ten minutes. If they keep waking each other without anything from me in between, every agent on that doc pauses.
Each turn is logged, and View last run on an agent's avatar shows what it did.

### Your writing voice with Empirical

I also build [Empirical](https://empirical.gauzza.com), a shared memory for AI agents. Its command line tool is
[`@empirical-gauzza/cli`](https://www.npmjs.com/package/@empirical-gauzza/cli) on npm, and it gives Claude Code, Codex,
Copilot and Cursor the same memory. It can also hold your writing voice. You do a short interview once, and after that
any agent writing in your name can look it up.

```
npm install -g @empirical-gauzza/cli
empirical install                         # sign in and set up
empirical plugin install claude --voice   # adds the writing voice skill (also codex, copilot or all)
```

Set up your voice at [empirical.gauzza.com/voice](https://empirical.gauzza.com/voice). It's also under Help in the app.
Then add it to your standing instructions so agents check it before they write:

```
gdocs instructions --global --set 'Before writing in my name, look up my voice: empirical memory query --match "how this person writes" --tags writing-voice --top-k 50'
```

### Standing instructions for agents

Tools > Agent instructions holds two sets of instructions that agents read before they touch a file. The ones for
every file live in `~/.gauzzadocs/agent.md`. The ones for a single file are saved invisibly inside it, so they go
wherever the file goes. HTML files keep them in a hidden block in the page head and Markdown files keep them in a
hidden comment at the top. Word, Excel, PDF and code files keep theirs in `~/.gauzzadocs/instructions.json`. A file
with its own instructions shows an Instructions chip in the header.

```
gdocs instructions report.md                       # both sets; agents run this first
gdocs instructions report.md --set "Keep it under one page."
gdocs instructions --global --set @my-rules.md
```

`gdocs read --json` includes them too.

## Projects

Any folder can be a project. Click + next to Projects on the home screen, or drop a folder onto it. A project shows
its files like Drive does, folders first, with search across the whole folder and a New button that creates the file
right there. Right click a file to rename it, copy its path or send it to the Recycle Bin. Removing a project only takes
it off the list and never touches the files.

While you're editing, View > Explorer (Ctrl+Shift+E) opens the project as a tree beside the doc, with the file you're
on highlighted. Both views update by themselves when files change on disk.

Agents can see your projects too:

```
gdocs projects                     # your projects
gdocs projects add ~/Clients --name Clients
gdocs ls Clients                   # one level of a project or folder
```

## Editing PDFs

I wanted to fix a typo in a PDF without hunting down the Word file it came from. Press E for Edit text and click any
line to change it. A line that's part of a paragraph opens the whole paragraph, and what you type wraps to the same
width and line spacing. The new words go in the same spot at the same size and color, in the closest standard font, and
the old words are taken out of the file instead of just painted over. Forms fill in right on the page and Sign lets you
draw your signature and drop it on the line. Agents do the same with `gdocs replace` and `gdocs pdf fill`, even when the
words they're changing run across lines. With the app running they edit the open file live, so the colors match.
Open as document in the Tools menu turns a PDF into a Word file you can rewrite, but you get the text, headings and
lists, not the layout. Scanned pages have no text to edit.

## Presentations

I wanted to put a quick deck together without opening PowerPoint. Presentations look like Google Slides, with the
slides down the left, the slide in the middle and speaker notes under it. You can add text boxes, shapes and pictures,
drag them around, resize or rotate them and pick a theme. Press F5 to present. During the show S switches to a
presenter view with your notes, the next slide and a timer. Decks open and save as PowerPoint files and export to PDF.

Agents write decks in Markdown, so they don't have to place anything by hand. Each slide starts with a `# Title` and
there's a `---` line between slides. `gdocs slides from-md deck.pptx --md @outline.md --live` builds the whole deck
while you watch, and `gdocs slides add`, `update` and `notes` change one slide at a time. A PowerPoint file with charts,
tables or animations opens with those parts simplified, so it only saves on Ctrl+S and the first save keeps the
original next to it.

## Tabs and saving

Every open file is a tab, like in a code editor. Drag tabs to reorder them, middle click to close one and right click
for close others, copy path or show in folder. Ctrl+Tab switches between them, and your tabs come back the next time
you open the app.

Changes save a moment after you stop typing, like Google Docs. A Word file that has things the editor can't keep
(headers, footnotes or tracked changes) only saves when you press Ctrl+S, and the first save keeps a copy of the
original next to it. PDFs also save on Ctrl+S. If a file changes on disk the tab reloads. If you have unsaved changes
at the same time, you choose which version to keep.

The status bar at the bottom works like a code editor's. Documents show words, pages and reading time. Code shows the
line and column, line length and the longest line. PDFs show the current page. On the right you get the format, line
endings, encoding, size on disk and whether everything is saved.

## Memory use

Opening, saving and converting files happens on a background thread, so a big Word file or a huge log never freezes
the window. The app only loads what you're using. Each editor loads the first time you open that kind of file, so if you never
open a PDF the PDF code never loads.

Tabs you aren't using go to sleep once they're saved. The tab you're on and the last two you used stay loaded, and the
rest reload from disk when you click them or an agent edits them. Tabs with unsaved changes never sleep.

PDFs are read from disk a piece at a time, so only the pages on screen are loaded. Text and CSV files over 32 MB open
in a read only viewer that reads only the lines on screen. `gdocs` can still edit those files. Spreadsheets only keep
the cells that have something in them and only redraw what's on screen.

## Plugins

Plugins > Marketplace in the app shows every plugin in [`plugins/marketplace.json`](plugins/marketplace.json) in this
repo. There are formatters for JSON, XML, SQL and CSS, a writing review, Markdown and HTML previews, table and YAML
converters, developer utilities and a log viewer. The full list is in [plugins/MARKETPLACE.md](plugins/MARKETPLACE.md).
Every download is checked against the SHA-256 recorded in the marketplace file before it's installed.

```
gdocs plugins marketplace      # what's available, by category
gdocs plugins install json-tools sql-format writing-tools
gdocs plugins update           # install every available update
gdocs format query.sql         # uses the first formatter for the file's language
```

A plugin is one JavaScript file and a `plugin.json`. `gdocs plugins new my-plugin` gives you a starting point and
[plugins/README.md](plugins/README.md) explains how to write one and get it listed.

## Sharing

gauzzaDocs has no server, so sharing works the way it does for any file on your PC. Keep your files in a synced folder
like OneDrive, Dropbox or Google Drive, or in a git repository, and open tabs reload when the synced copy changes.
Comments are saved on your PC, so they don't travel with the file yet.

## Contributing

gauzzaDocs is free and open source under the [MIT license](LICENSE). Issues and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md), and [plugins/README.md](plugins/README.md#submitting-a-plugin) if you want to
publish a plugin.

If gauzzaDocs is useful to you, you can support it on [Ko-fi](https://ko-fi.com/mattgauzza). The heart in the app's tab
strip goes there too.

## Where things live

New files go to `Documents\gauzzaDocs`, and you can change that in Settings. Your other files stay wherever they are.
Settings, recent files, plugins and the connection details for `gdocs` are in `~/.gauzzadocs`.

## Build from source

You need Node 22 or newer.

```
npm install
npm run dev          # the app with hot reload
npm run build        # the app and the CLI (dist/cli.mjs)
node dist/cli.mjs --help
npm run dist         # an installer for your platform in release/
```

## Layout

```
src/shared     code used everywhere: file kinds, types, Markdown and HTML conversion, the operations agents run,
               the spreadsheet formula engine and PDF edits
src/core       Node only: loading and saving each format, running operations on files on disk, plugins, paths
src/main       the Electron main process: the window, file dialogs and the bridge the CLI talks to (server.ts)
src/cli        the gdocs command
src/renderer   the window: App.tsx (tabs, menus, saving, agents) and one folder per editor
plugins        the plugin marketplace
```
