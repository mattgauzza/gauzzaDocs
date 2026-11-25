# Version history and work history

Date: 2026-11-25. Status: approach agreed with Matt ("version history idea looks good"); review questions answered,
outside changes confirmed ("then yes add that to version history"), one hardening pass done, secret files decided
("yes no history for those"). Ready for Matt's approval.

## Intent

Agents now edit Matt's files live, several at once, and he edits alongside them. He needs to see how a file got to
where it is, who changed what (him or which agent), and get back to any earlier state. Google Docs' version history is
the model he knows. He also asked for "work history": a timeline of who did what on a file.

## Goals

- Every save of a file keeps a version, attributed to who changed it since the previous version: the person, and the
  agents by name.
- The first time gauzzaDocs or `gdocs` writes to a file, the file as it was before that write is kept as the baseline
  version, so the very first agent edit can be undone. Opening or reading a file records nothing.
- Changes made outside gauzzaDocs (Word, VS Code, git, agents writing the file directly) become versions too, credited to
  "outside gauzzaDocs", so nothing that was on disk is lost under the next save.
- A panel to browse versions by day, see what changed between a version and now, restore a version, and name one.
- A per-file work history: the person's saves, agent edits, comments, replies, resolves, agents connecting,
  disconnecting and subscribing, restores and named versions.
- Command line for agents: list versions, show one, diff two, restore one, name one, read the work history, forget a
  file's history.
- Works for every kind: docs (.md, .html, .docx), sheets (.xlsx, .csv), slides (.pptx), PDFs and text or code files.

## Non-goals

- Keystroke-level history. Versions are per save; autosave already saves every few seconds for most kinds.
- Syncing or sharing history between machines. Encrypting history.
- Branches or merges.
- Showing git commits for files that live in a git repo (possible later; not in this version).
- Versioning files over the large-file limit (32 MB, src/core/large.ts LARGE_BYTES).

## Anti-goals

- Touching Matt's own git repos or putting anything next to his files (no `.git`, no sidecar folders).
- History that grows without bound or makes saving slower.
- A history failure that fails or delays a save.
- Restoring one file's content into another file.

## Constraints

- Memory-frugal and async, like the rest of the app: hashing, compressing, comparing and writing history happen in the
  existing worker thread (src/main/worker.ts), off the editor's path.
- Files are written from several places, and all of them must record versions:
  - core `saveFile` (src/core/files.ts), used by the app's worker for editor saves and by `runOffline`
    (src/core/ops/index.ts) for agent edits to files that aren't open, in the app and in the CLI;
  - Save As, Export onto an existing path, and `createFile` onto an existing path;
  - `setDocInstructions` (src/core/instructions.ts), which writes standing instructions into .md and .html files from
    main and from `gdocs instructions --set`.
- The CLI can write while the app is running (`--offline`, or any command when the file isn't open), so the app's
  worker, main and any number of CLI processes may touch the same history at once.
- Renames and moves in the app (src/main/index.ts around renameRecent / renameInstructions / renameComments, and folder
  renames in the explorer) must carry history along.
- Agents may read history, so its text output follows the same rules as other `gdocs` output (plain lines, `--json`).

## Approaches considered

1. **Plain copies in content-addressed storage (chosen).** Each version's bytes are stored once by SHA-256; a small JSON
   index per file lists the versions. Works the same for binary formats, needs no external tools, and identical saves
   cost nothing.
2. **A hidden git repo under ~/.gauzzadocs/history** (system git or isomorphic-git). Matt asked about this. Most of these
   formats are zip or binary, so git would store them whole anyway; system git may not be installed; isomorphic-git is
   slow on large binaries; mapping arbitrary paths into one repo is awkward. No real gain over approach 1.
3. **Git in the file's own folder.** Rejected: it would touch Matt's projects and repos (anti-goal).

## Design

### Identity: which history belongs to which file

- A file's history key is the SHA-256 of its canonical path: `fs.realpathSync.native`, lowercased on Windows only (the
  same rule as samePath in src/core/paths.ts). So a mapped drive and its UNC path, or a junction, share one history,
  and on Linux `Notes.md` and `notes.md` stay separate.
- The index stores the canonical path, and a reader refuses an index whose path doesn't match the file it was asked
  about. The short doc id (src/shared/docId.ts) is only a CLI alias; it also resolves against history indexes, so a
  file's history can be found after the file is gone.
- Renamed or moved outside the app: when a file with no history is first recorded, and a file whose latest version has
  the same hash is missing from disk, the new file takes over that history and logs "moved from <old path>".
- Renames and moves in the app, including renaming a folder in the explorer, move the history of every file under them.

### Storage

- `~/.gauzzadocs/history/objects/<first 2 hex>/<sha256>`: one file per distinct content, named by the hash of the
  original bytes. Text is gzipped; formats that are already compressed (.docx, .xlsx, .pptx, .pdf, images) are stored as
  they are. Objects are written to a temp name and renamed into place.
- `~/.gauzzadocs/history/files/<key>.json`: `{ path, versions: [...] }`. Each version is
  `{ n, firstAt, at, hash, size, mtime, authors: [{ name, by: 'person' | 'agent' | 'outside' }], summary, name?,
  baseline?, beforeRestore?, restoredFrom? }`. `n` counts up per file (v1, v2, ...); `size` and `mtime` are the file's
  as written (what saveFile returns), used to notice outside changes.
- `~/.gauzzadocs/history/files/<key>.log.jsonl`: the work history, one event per line, append-only.
- Every write of an index keeps the previous one as `<key>.json.bak`.

### Two writers at once

- Every read-modify-write of a file's index or log holds `<key>.lock`, created with the exclusive `wx` flag and holding
  the process id and time. A lock older than 30 seconds, or whose process is gone, may be taken over.
- A writer holds the file's lock from just before it writes the user's file until its version is recorded, and
  outside-change detection takes the same lock. So gauzzaDocs' own writes are never mistaken for outside changes.
- In the app, the worker is the only history writer: it queues history jobs per file, and main sends it events (work
  history, recordings) instead of writing itself. CLI processes write directly, under the same locks.
- Temp names include the process id, thread id and a random suffix. A rename that fails with EPERM or EBUSY (Windows
  antivirus and indexers) is retried for up to a second.

### When a version is recorded

- Every write goes through core `saveFile`, which takes the authors of the change:
  - Before the first write to a file with no history, it copies the file on disk into the history store as the
    baseline (copy now, hash and compress later).
  - It builds every format's bytes in memory (docBytes, exceljs writeBuffer and deckToPptx can already do this) and
    writes them by temp file and rename, then hands those exact bytes to the history queue. No re-reading the file
    after writing.
- Save As, Export onto an existing path, `createFile` onto an existing path and `setDocInstructions` record versions
  the same way. The rpc `op` path (src/main/index.ts) passes the agent's name through to `runOffline`.
- Skipped when the bytes hash the same as the latest version.
- Folding: a save folds into the latest version (replacing its content and `at`) only when that version is unnamed,
  not the baseline, not marked `beforeRestore`, has no `restoredFrom`, has the same authors, and the save is within
  10 minutes of that version's `firstAt`. So a long session becomes a version every 10 minutes, not one version all day.

### Who changed it

- The app knows, per tab, whether a change came from the person or from an agent op (agent ops carry the agent's name).
  Each tab keeps the set of authors since its last save and passes it with the save.
- CLI writes are attributed to the CLI's agent name (`--agent` or `GDOCS_AGENT`, default "Agent"). `gdocs` writes are
  never "outside".
- The summary is built from what happened: the agent ops' short descriptions ("replaced text in Risks", "inserted after
  'Risks'"), or "Edited" for the person, plus a size of change where cheap to compute.

### Changes made outside gauzzaDocs

- A file has changed outside when its size or modified time differs from the latest version's and its hash differs
  too. Detection runs in main and the worker, under the file's lock:
  - when a file is loaded (which also covers waking a tab that was asleep);
  - before every save, so the file on disk is recorded before gauzzaDocs writes over it;
  - when the folder watcher reports a change (src/main/folders.ts, which needs to report changed file paths, not just
    folders). Only folders shown on screen are watched; other files are caught at their next load or save.
- The editor's existing 2-second modified-time check (src/renderer/src/App.tsx) keeps doing what it does (reload, or
  mark the tab changed outside); it asks the worker to record first.
- Who made an outside change can't be known (Word, git and other programs leave no name), so these versions are
  credited to "outside gauzzaDocs". Several outside saves between two checks become one version.
- Recordings triggered by the watcher wait in a low-priority queue behind loads and saves.

### Restoring

Restore is an explicit request, so it always writes the file, for every kind, whether the file is open or not:

1. If the tab has unsaved changes, they are turned into bytes (the same code saveFile uses) and recorded as a version
   without writing the file.
2. The bytes on disk are recorded if they differ from the latest version.
3. The version holding the state before the restore is marked `beforeRestore`.
4. The stored bytes are written exactly (temp file and rename). For .md and .html, the current standing-instructions
   block is swapped into the restored content, so a restore never changes standing instructions.
5. The result is recorded with `restoredFrom: n`, the work history logs "restored v12", and an open tab reloads from
   disk. This exact-bytes route is what brings back a Word file's baseline without a lossy conversion.

If the current file is over the size limit, its content can't be kept: the panel warns and restores only on
confirmation; the CLI needs `--discard-current`. Undoing a restore is restoring the `beforeRestore` version.

### Keeping it small

- Keep every version for 30 days. After that, one per day; after a year, one per month.
- Never deleted by cleanup: a file's latest version, anything under 7 days old, the baseline, named versions.
- A global cap (default 1 GB, a setting). Above it, cleanup thins the files using the most space first, applying the
  one-per-day rule to them early. When the protected versions alone exceed the cap, cleanup stops and the history
  settings show the overage.
- History for a file that has been gone for 90 days is removed, except named versions. A file counts as gone only when
  its folder is reachable and the file isn't there (a disconnected drive doesn't count).
- Only the app runs cleanup, in the worker, at start and once a day. It never deletes an object modified in the last 24
  hours; a writer that reuses an existing object touches its modified time first.
- The work log follows the same age rules, is capped at 2 MB per file, and one agent's consecutive ops within a minute
  merge into one event.

### Failures

- An index that fails to parse is never overwritten: it is renamed `<key>.json.corrupt-<time>` and the `.bak` is used.
  Cleanup skips its whole run while any index is unreadable.
- An object that fails to read or doesn't match its hash counts as missing, and is rewritten the next time that content
  is saved.
- Log readers skip lines that don't parse.
- A history failure (disk full, permissions) never fails the save: the app shows "Version history paused: <reason>" once
  per session and keeps saving.
- On quit, the app waits up to 5 seconds for queued history writes before stopping the worker.

### Privacy

- History is stored unencrypted under the home folder; the history settings say so.
- "Delete history for this file" in the panel and `gdocs history forget <file>` remove the index, the log and every
  object no other file uses, immediately.
- **Secret files (Matt: "yes no history for those"):** by default, no history is kept for `.env` and `.env.*`, `*.pem`,
  `*.key`, `*.pfx`, `*.p12`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, and anything under `.ssh`, `.aws`, `.gnupg` or
  `.azure`. The patterns are a setting. Work-history summaries never quote content from these files. Without this, a key
  rotated out of a .env file stays recoverable from history and from any backup of the home folder.

### Seeing what changed

- A real line diff (Myers, for example the `diff` package) in `src/shared/diff.ts`, used by the panel and the CLI. The
  existing src/renderer/src/shell/diff.ts only trims a common start and end; it stays for agent edit events.
- Comparisons run in the worker. Docs and slides are compared as Markdown (deckToMarkdown for slides), sheets cell by
  cell (sheet name, cell, old, new), PDFs as page text, text files as they are.
- Versions are compared only when both are under 8 MB. Above that the panel says "Too large to compare here" and offers
  Open as a copy.

### In the app

- File > Version history (Ctrl+Alt+Shift+H, as in Google Docs) opens a right-side panel, resizable like the comments
  panel, with two tabs:
  - **Versions:** grouped by day; each row shows the time, author avatars in their agent colors
    (src/shared/agentColors.ts) or "outside gauzzaDocs", the summary and the name if any. Selecting one shows its
    changes against the current file, with Restore this version, Name this version and Open as a copy (opens that
    version as a new untitled file).
  - **Work history:** the event timeline, newest first.
- History settings: total size, the cap, the secret-file patterns, and "history paused" status if there is one.

### Command line

```
gdocs history <file>                    # versions: v12  Nov 25 3:04 PM  Claude, Matt  replaced text in Risks
gdocs history show <file> v7            # that version's content, the way gdocs read prints it
gdocs history diff <file> v7 [v9]       # changes from v7 to v9, or to now
gdocs history restore <file> v7         # live when the file is open (the app writes and reloads it), else on disk
gdocs history name <file> v7 "Sent to Dave"
gdocs history log <file>                # the work history
gdocs history forget <file>             # delete this file's history
```

Every command takes `--json` and a doc id instead of the path, like the rest of `gdocs`. `gdocs history` accepts
paths that no longer exist.

### Work history events

Recorded where they already happen and sent to the worker: saves, comments and replies and resolves (src/core/comments.ts
callers in src/main/index.ts), agents connecting and disconnecting (src/main/server.ts), subscriptions added, removed
and woken (src/core/subscriptions.ts and the runner), agent ops that change a file (the rpc `op` case), outside changes,
versions named, restores. Each event: `{ at, type, by, summary }`.

## Decisions after review

A builder read the first draft and raised six questions; a hardening review then raised ten problems. Where each landed:

- Outside changes: included (Matt). See "Changes made outside gauzzaDocs".
- Work history meaning: the timeline as described, including the person's saves (Matt approved the description).
- Cap versus "always kept": see "Keeping it small".
- Restoring over unsaved changes, and standing instructions in .md and .html: see "Restoring".
- The existing .original.docx and .original.pptx backups stay as they are for now; removing them is a separate change.
- Hardening: folding after a restore, restore going through the editor, the baseline taken after the first write,
  writers the first draft missed, lost updates between concurrent writers, corrupted indexes, path-based ids, detection
  that relied on code that doesn't exist, secret files, Office files defeating deduplication, and a diff that wasn't a
  line diff. Each is fixed in the section it belongs to above.

## Left to the builder

- Exact summary wording and how much change size to show.
- Panel layout details and how the diff is drawn.
- How cleanup schedules itself, within "at start and once a day".
- Whether "Open as a copy" opens read-only or as a normal untitled file.
