# Version history and work history

Date: 2026-11-25. Status: approach agreed with Matt ("version history idea looks good"); all review questions answered;
this document is for his approval.

## Intent

Agents now edit Matt's files live, several at once, and he edits alongside them. He needs to see how a file got to
where it is, who changed what (him or which agent), and get back to any earlier state. Google Docs' version history is
the model he knows. He also asked for "work history": a timeline of who did what on a file.

## Goals

- Every save of a file keeps a version, attributed to who changed it since the previous version: the person, and the
  agents by name.
- The first time gauzzaDocs or `gdocs` touches a file, the file as it was is kept as the baseline version, so the very
  first agent edit can be undone.
- A panel to browse versions by day, see what changed between a version and now, restore a version, and name one.
- A per-file work history: agent edits, comments, replies, resolves, agents connecting, disconnecting and subscribing,
  restores and named versions.
- Command line for agents: list versions, show one, diff two, restore one, read the work history.
- Works for every kind: docs (.md, .html, .docx), sheets (.xlsx, .csv), slides (.pptx), PDFs and text or code files.

## Non-goals

- Keystroke-level history. Versions are per save; autosave already saves every few seconds for most kinds.
- Syncing or sharing history between machines.
- Branches or merges.
- Showing git commits for files that live in a git repo (possible later; not in this version).

## Anti-goals

- Touching Matt's own git repos or putting anything next to his files (no `.git`, no sidecar folders).
- History that grows without bound or makes saving slower.

## Constraints

- Memory-frugal and async, like the rest of the app: hashing, compressing and writing history happen in the existing
  worker thread (src/main/worker.ts) after the save completes, never blocking the editor.
- The CLI writes files on its own when the app isn't running (src/core/ops/index.ts runOffline calls saveFile), so the
  history code lives in src/core and is used by both the app's worker and the CLI.
- Files over the large-file limit (32 MB, src/core/large.ts LARGE_BYTES) are not versioned.
- Renames in the app (src/main/index.ts around renameRecent / renameInstructions / renameComments) must carry the
  history along, the same way comments follow a rename.
- Agents may be told to read history, so its text output follows the same rules as other `gdocs` output (plain lines,
  `--json` for structure).

## Approaches considered

1. **Plain copies in content-addressed storage (chosen).** Each version's bytes are gzipped and stored once by SHA-256;
   a small JSON index per file lists the versions. Works the same for binary formats (docx, xlsx, pptx and pdf are zips
   or binary, so text deltas don't help them), needs no external tools, and identical saves cost nothing.
2. **A hidden git repo under ~/.gauzzadocs/history** (system git or isomorphic-git). Matt asked about this. Git gives
   deltas for text, but most of these formats are zip or binary so they'd be stored whole anyway; system git may not be
   installed; isomorphic-git is slow on large binaries and adds weight; mapping arbitrary paths from anywhere on disk
   into one repo is awkward. No real gain over approach 1.
3. **Git in the file's own folder.** Rejected: it would touch Matt's projects and repos (anti-goal).

## Design

### Storage

- `~/.gauzzadocs/history/objects/<first 2 hex>/<sha256>.gz`: gzipped file bytes, written once.
- `~/.gauzzadocs/history/files/<doc id>.json`: `{ path, versions: [...] }`, where each version is
  `{ n, at, hash, size, authors: [{ name, by: 'person' | 'agent' }], summary, name?, restoredFrom? }`.
  `n` counts up per file (v1, v2, ...). The doc id is the existing short id (src/shared/docId.ts).
- `~/.gauzzadocs/history/files/<doc id>.log.jsonl`: the work history, one event per line, append-only.
- Index writes are atomic (write a temp file, then rename) and re-read before each update, since the app and the CLI
  can both write.

### When a version is recorded

- After every successful save, by the app (worker saveFile) or by the CLI (offline ops).
- Before the first save gauzzaDocs makes to a file it has no history for: the bytes on disk become v1 (the baseline).
- Skipped when the saved bytes hash the same as the latest version.
- Folding: if the latest version is under 10 minutes old, unnamed, not the baseline, and has the same authors, the new
  save replaces it instead of adding one. The replaced object is cleaned up later if nothing else uses it.

### Who changed it

- The app already knows, per tab, whether a change came from the person or from an agent op (agent ops carry the
  agent's name). Each tab keeps the set of authors since its last save and passes it with the save.
- CLI writes are attributed to the CLI's agent name (`--agent` or `GDOCS_AGENT`, default "Agent").
- The summary is built from what happened: the agent ops' short descriptions ("replaced 'Q3' with 'Q4'", "inserted
  after 'Risks'"), or "Edited" for the person, plus a size of change (lines or cells changed) where cheap to compute.

### Keeping it small

- Keep every version for 30 days. After that, one per day; after a year, one per month.
- The baseline and named versions are always kept.
- A global cap (default 1 GB, a setting) removes the oldest unnamed versions first.
- Pruning and cleanup of unused objects run in the worker when the app starts and once a day.

### Seeing what changed

- Two versions are compared through the readers the app already has, then line-diffed with the existing diff
  (src/renderer/src/shell/diff.ts): docs as Markdown, slides as Markdown (deckToMarkdown), sheets as one line per
  changed cell (sheet name, cell, old, new), PDFs as page text, text files as they are.

### In the app

- File > Version history (Ctrl+Alt+Shift+H, as in Google Docs) opens a right-side panel, resizable like the comments
  panel, with two tabs:
  - **Versions:** grouped by day; each row shows the time, author avatars in their agent colors
    (src/shared/agentColors.ts), the summary and the name if any. Selecting one shows its changes against the current
    file, with Restore this version, Name this version and Open as a copy (opens that version as a new untitled file).
  - **Work history:** the event timeline, newest first.
- Restore records the current state as a version first, writes the old version to the file and reloads the tab, then
  logs a "restored v12" event. Restoring is itself undoable by restoring the version made just before it.

### Command line

```
gdocs history <file>                    # versions: v12  Nov 25 3:04 PM  Claude, Matt  replaced 'Q3' with 'Q4'
gdocs history show <file> v7            # that version's content, the way gdocs read prints it
gdocs history diff <file> v7 [v9]       # changes from v7 to v9, or to now
gdocs history restore <file> v7         # live when the file is open (the app reloads it), else on disk
gdocs history name <file> v7 "Sent to Dave"
gdocs history log <file>                # the work history
```

Every command takes `--json` and a doc id instead of the path, like the rest of `gdocs`.

### Work history events

Recorded where they already happen: comments and replies and resolves (src/core/comments.ts callers in
src/main/index.ts), agents connecting and disconnecting (src/main/server.ts), subscriptions added, removed and woken
(src/core/subscriptions.ts and the runner), agent ops that change a file (the rpc `op` case), versions named and
restores. Each event: `{ at, type, by, summary }`.

## Decisions after review

A builder read this document and raised six questions. Matt answered the first by asking whether gauzzaDocs can
know about outside changes at all; it can, as below. The other five are the author's calls (Matt can change them).

- **Changes made outside gauzzaDocs (included).** Files also change in Word, VS Code, git, and through subscribed
  agents that edit the file directly. What gauzzaDocs can know, and how:
  - Open files: it already checks every open file's modified time every 2 seconds (src/renderer/src/App.tsx, the
    "reload when the file changes on disk" effect). Before it reloads a changed file, or when it marks a file with
    unsaved changes as changed outside, the new state on disk becomes a version.
  - Files in a project that already have history: projects are already watched (src/main/folders.ts, fs.watch,
    recursive, skipping dot folders and build output). A change to such a file records a version a few seconds later,
    open or not.
  - Everything else: when gauzzaDocs opens a file that has history, it compares the size and modified time with the
    last version (hashing only when those differ) and records the file as it is now if it changed.
  - Who changed it can't be known (Word, git and other programs leave no name), so these versions are credited to
    "outside gauzzaDocs". Several outside saves between two checks become one version. `gdocs` writes are never
    "outside": the CLI records its own versions under the agent's name.
  - Before gauzzaDocs saves over a file, the same size and modified-time check runs, so an outside change is never
    lost under the next save.
- **What "work history" means (settled).** Matt approved the timeline as described: agent edits, comments, replies,
  resolves, agents connecting and disconnecting. The person's own saves are in it too.
- **Cap versus "always kept" (author's call).** The size cap never deletes baselines or named versions on its own; the
  history settings show the total size, and history for files that have been gone for 90 days is removed, except named
  versions.
- **Restoring over unsaved changes (author's call).** The unsaved editor content is recorded as a version first
  (without writing the file), then the restored content replaces the editor's content as one undoable change. The tab
  is then unsaved and saves by its normal rules, so formats that only save when asked (.docx, .pdf, lossy .pptx) still
  wait to be asked. An agent's live restore works the same way. A restore on a file that isn't open records the bytes
  on disk, then writes the old version.
- **Standing instructions inside .md and .html files (author's call).** A restore keeps the current instructions and
  puts them back into the restored content; diffs and summaries ignore that block.
- **The existing .original.docx and .original.pptx backups (author's call).** They stay as they are for now; removing
  them is a separate change.

## Left to the builder

- Exact summary wording and how much change size to show.
- Panel layout details and how the diff is drawn.
- How pruning schedules itself, within "at start and once a day".
- Whether "Open as a copy" opens read-only or as a normal untitled file.
