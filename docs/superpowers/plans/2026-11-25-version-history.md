# Version History and Work History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every write to a file keeps a version attributed to who made it (the person, an agent, or "outside gauzzaDocs"), with a panel and `gdocs history` commands to see, compare, restore, name and forget versions, plus a per-file work timeline.

**Architecture:** A history store in `src/core/history/` (used by both the app's worker and the CLI) keeps content-addressed copies under `~/.gauzzadocs/history`, a JSON index per file keyed by the SHA-256 of the canonical path, and an append-only event log. Every write goes through core `saveFile`, which builds bytes in memory, writes atomically under the file's history lock, and queues the recording. Main and the window talk to it only through worker jobs; the CLI calls it directly.

**Tech Stack:** TypeScript, Node fs/crypto/zlib, Electron worker_threads (src/main/worker.ts), React (renderer), Commander (CLI), node:test via `npm test`, `diff` npm package for line diffs.

**Spec:** `docs/superpowers/specs/2026-11-25-version-history-design.md`

## Global Constraints

- Store root: `path.join(HOME, 'history')` (HOME from src/core/paths.ts, so `GAUZZADOCS_HOME` isolates tests). Nothing is ever written next to the user's files except the file itself.
- Objects: `history/objects/<first 2 hex>/<sha256>`, hash of the original bytes; gzip text; store `.docx .xlsx .pptx .pdf .png .jpg .jpeg .gif .webp .zip` as they are.
- Index: `history/files/<key>.json` = `{ path, versions }`; previous kept as `<key>.json.bak`; log `history/files/<key>.log.jsonl`. key = SHA-256 hex of the canonical path (`fs.realpathSync.native`, lowercased on win32 only).
- Version fields: `n, firstAt, at, hash, size, mtime, authors: [{ name, by: 'person' | 'agent' | 'outside' }], summary, name?, baseline?, beforeRestore?, restoredFrom?`.
- Locks: `history/files/<key>.lock`, created with flag `wx`, content `{ pid, at }`, stale after 30 s or when the pid is gone.
- Temp names include pid, thread id and a random suffix; renames failing with EPERM or EBUSY retry for up to 1 s.
- Not versioned: files over 32 MB (`LARGE_BYTES`), and secret files matching the default exclude list: `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, and anything under `.ssh`, `.aws`, `.gnupg`, `.azure`. The list is a setting.
- Folding: into the latest version only if unnamed, not baseline, not `beforeRestore`, no `restoredFrom`, same authors, and within 10 minutes of its `firstAt`.
- Retention: all versions 30 days; then one per day; after a year one per month. Never removed by cleanup: latest version, anything under 7 days old, baseline, named. Cap default 1 GB (setting); objects modified in the last 24 hours are never deleted. History for files gone 90 days is removed except named versions (gone = folder reachable, file absent).
- Work log: capped at 2 MB per file; one agent's consecutive ops within 60 s merge into one event.
- Comparisons only when both versions are under 8 MB; otherwise "Too large to compare here".
- History failures never fail or delay a save; the app shows "Version history paused: <reason>" once per session. On quit the app waits up to 5 s for queued history writes.
- Outside changes are credited as "outside gauzzaDocs". `gdocs` writes are always credited to the agent name (`--agent`, `GDOCS_AGENT`, default "Agent").
- Panel shortcut: Ctrl+Alt+Shift+H. Settings say history is stored unencrypted.
- Copy in UI and CLI output follows the README's plain style: no em dashes, no Oxford commas, ASCII only.

## Review Focus

- Two processes (the app's worker and a CLI process) recording versions of the same file at once: no version lost, no duplicate `n`. Test added to Task 1.
- On Windows an antivirus or indexer holds the file briefly, so a rename fails with EPERM or EBUSY: the write retries and succeeds. Test added to Task 1.
- A versioned file grows past 32 MB: saves keep working and record nothing; restoring over it needs `discardCurrent`. Test added to Task 4.
- The file was deleted from disk, then restored from history: restore recreates it. Test added to Task 4.
- The same file reached with different case or separators on Windows (`C:\Docs\Plan.md` and `c:/docs/plan.md`): one history. Test added to Task 1 (win32 only).

---

## File Structure

- `src/core/history/store.ts`: store paths, canonical path and key, objects, index read/write with `.bak`/corrupt handling, locks, atomic file write with rename retry, exclusion matching.
- `src/core/history/queue.ts`: per-key serial queue, `flushHistory()`, paused callback.
- `src/core/history/record.ts`: `guardedWrite` around every write (baseline, outside detection, folding, moved-file adoption), `checkOutside`.
- `src/core/history/manage.ts`: list, show, name, forget, move, restore.
- `src/core/history/log.ts`: work history events.
- `src/core/history/cleanup.ts`: retention and the cap.
- `src/core/history/compare.ts`: a version's comparable text by kind, and comparing two versions.
- `src/core/history/index.ts`: the public API (re-exports).
- `src/shared/diff.ts`: line diff.
- Modified: `src/core/files.ts`, `src/core/formats/{doc,sheet,slides,text,pdf}.ts`, `src/core/instructions.ts`, `src/core/ops/index.ts`, `src/core/paths.ts`, `src/shared/types.ts`, `src/main/{worker,work,index,folders}.ts`, `src/renderer/src/{App.tsx,lib.ts}`, `src/renderer/src/shell/{History.tsx (new),Dialogs.tsx,shell.css}`, `src/cli/{history.ts (new),index.ts,common.ts}`, `src/core/agentSkills.ts`, `README.md`.

---

### Task 1: History store

**Files:**
- Create: `src/core/history/store.ts`
- Modify: `src/shared/types.ts` (add `Author`, `HistoryVersion`, `HistoryIndex`; `Settings.historyExclude?: string[]`, `Settings.historyCapMB?: number`), `src/core/paths.ts` (defaults: `historyExclude: DEFAULT_EXCLUDE`, `historyCapMB: 1024`)
- Test: `test/history-store.test.ts`

**Interfaces:**
- Produces:
  - `type Author = { name: string; by: 'person' | 'agent' | 'outside' }`
  - `interface HistoryVersion` (fields in Global Constraints), `interface HistoryIndex { path: string; versions: HistoryVersion[] }`
  - `HISTORY_DIR: string`, `DEFAULT_EXCLUDE: string[]`
  - `canonicalPath(file: string): string`, `historyKey(file: string): string`
  - `putObject(bytes: Uint8Array, ext: string): Promise<string>` (returns sha256; touches mtime if it already exists)
  - `getObject(hash: string): Promise<Uint8Array | null>` (null when missing, unreadable or hash mismatch)
  - `readIndex(key: string, expectedPath?: string): HistoryIndex | null` (refuses, returning null, an index whose `path`
    isn't `expectedPath` by `samePath`), `writeIndex(key: string, index: HistoryIndex): void`
  - `objectPath(hash: string): string`, `indexPath(key: string): string` (exported for tests and cleanup)
  - `withLock<T>(key: string, fn: () => Promise<T>): Promise<T>`
  - `writeAtomic(file: string, bytes: Uint8Array): Promise<{ size: number; mtime: number }>`
  - `isExcluded(file: string, patterns?: string[]): boolean`
  - `listHistoryPaths(): string[]` (paths from all indexes, for doc id resolution)

- [ ] **Step 1: Write the failing tests** (set `process.env.GAUZZADOCS_HOME` to a temp dir before a dynamic `import('../src/core/history/store')`, as test/comments.test.ts does)

```ts
test('objects: stored once by hash, verified on read', async () => {
  const h = await putObject(Buffer.from('hello'), 'md')
  assert.equal(h, sha256('hello'))
  assert.deepEqual(Buffer.from((await getObject(h))!), Buffer.from('hello'))
  fs.writeFileSync(objectPath(h), 'garbage')            // corrupted object
  assert.equal(await getObject(h), null)
})
test('index: .bak kept; a corrupt index is set aside, never overwritten', () => {
  writeIndex(k, idx1); writeIndex(k, idx2)
  fs.writeFileSync(indexPath(k), '{ broken')
  assert.deepEqual(readIndex(k), idx1)                  // falls back to .bak
  assert.ok(fs.readdirSync(filesDir).some(f => f.startsWith(`${k}.json.corrupt-`)))
})
test('locks: two processes recording at once lose nothing', async () => {
  // child process (spawned with process.execPath on a small script importing the bundled store) appends 20 versions
  // under withLock while this process appends 20: the index ends with 40 versions, n = 1..40, no duplicates
})
test('locks: a stale lock (dead pid or older than 30 s) is taken over', async () => { /* write lock file with pid 999999 */ })
test('an index for another path is refused', () => {
  writeIndex(k, { path: 'C:/a.md', versions: [] })
  assert.equal(readIndex(k, 'C:/b.md'), null)
})
test('writeAtomic retries a rename that fails with EPERM or EBUSY', async () => {
  // stub fs.renameSync / fs.promises.rename to throw EPERM twice, then succeed: file written, no temp left behind
})
test('exclusions: secrets are not versioned', () => {
  for (const f of ['.env', 'app/.env.local', 'k.pem', 'id_rsa', 'C:/Users/m/.ssh/config', 'x/.aws/credentials']) assert.ok(isExcluded(f))
  for (const f of ['plan.md', 'env.md', 'keynote.pptx']) assert.ok(!isExcluded(f))
})
test('identity: one history for one file however it is written', { skip: process.platform !== 'win32' }, () => {
  assert.equal(historyKey('C:\\Docs\\Plan.md'), historyKey('c:/docs/plan.md'))
})
```

- [ ] **Step 2: Run `npm test -- history-store`.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement `store.ts` and the type/settings additions.** Lock: `fs.openSync(lockPath, 'wx')`, retry every 50 ms for up to 10 s; staleness by `process.kill(pid, 0)` throwing or age over 30 s. Gzip with `zlib.gzipSync` except the stored-as-is extensions. `isExcluded` matches basenames against the glob list (`*` wildcard only) and path segments against `.ssh .aws .gnupg .azure`; it reads `getSettings().historyExclude` when no list is passed.
- [ ] **Step 4: Run `npm test -- history-store`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): content-addressed store, locked indexes, exclusions`

### Task 2: Recording around writes

**Files:**
- Create: `src/core/history/queue.ts`, `src/core/history/record.ts`, `src/core/history/index.ts`
- Test: `test/history-record.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `interface WriteContext { authors: Author[]; summary?: string }`
  - `guardedWrite(file: string, ctx: WriteContext, write: () => Promise<Uint8Array>): Promise<{ size: number; mtime: number }>`: takes the lock, records the baseline (first write to a file with no history) or an outside change (size/mtime differ from the latest version and the hash differs too), calls `write` (which writes atomically and returns the bytes it wrote), resolves once the write is done, then records the new version on the key's queue and releases the lock after it.
  - `checkOutside(file: string, opts?: { low?: boolean }): Promise<HistoryVersion | null>` (`low` jobs wait behind
    loads and saves on the queue; the folder watcher uses it)
  - `listVersions(file: string): HistoryVersion[]` (oldest first; used from here on, including the tests below)
  - `flushHistory(): Promise<void>`, `onHistoryPaused(cb: (reason: string) => void): void`
  - `enqueue(key: string, job: () => Promise<void>, opts?: { low?: boolean }): void` (queue.ts)
- Rules: skip when excluded, over 32 MB, or same hash as latest; fold per Global Constraints; on the first record of a file with no history, adopt the history of a missing file whose latest hash matches and log `{ type: 'moved', summary: 'moved from <old path>' }` (log API lands in Task 5; until then call a no-op hook `onMoved`). Any error inside recording calls the paused callback and never rejects the write.

- [ ] **Step 1: Write the failing tests**

```ts
test('baseline: the first write keeps the file as it was before it', async () => {
  fs.writeFileSync(f, 'original')
  await guardedWrite(f, agent('Claude'), writeText(f, 'changed')); await flushHistory()
  const v = listVersions(f)
  assert.deepEqual(v.map(x => [x.n, x.baseline ?? false, x.authors[0].name]), [[1, true, 'outside gauzzaDocs'], [2, false, 'Claude']])
})
test('folding: same authors within 10 minutes of firstAt fold; a different author starts a new version', async () => { /* fake clock via Date.now stub */ })
test('folding: a session longer than 10 minutes gets a version every 10 minutes, not one all day', async () => {})
test('outside change: a file edited by another program is recorded before gauzzaDocs writes over it', async () => {
  // write v2 via guardedWrite, then fs.writeFileSync(f, 'by Word') with a different mtime, then guardedWrite again:
  // versions are baseline, Claude, outside gauzzaDocs ('by Word'), Claude
})
test('identical bytes record nothing', async () => {})
test('excluded and over-32MB files are written but never versioned', async () => {})
test('moved outside the app: a new path with the same content takes over the history', async () => {})
test('a history failure (read-only store) still writes the file and reports paused once', async () => {})
```

- [ ] **Step 2: Run `npm test -- history-record`.** Expected: FAIL.
- [ ] **Step 3: Implement `queue.ts`, `record.ts`, `index.ts`.**
- [ ] **Step 4: Run `npm test -- history-record`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): record versions around every write`

### Task 3: Every write goes through saveFile

**Files:**
- Modify: `src/core/files.ts` (`saveFile`, `createFile`), `src/core/formats/doc.ts` (`saveDoc` keeps its `.original.docx` backup step, then returns `docBytes`), `src/core/formats/sheet.ts` (new `sheetBytes(file, workbook): Promise<Uint8Array>` using `wb.xlsx.writeBuffer()` or CSV text; `saveSheet` uses it), `src/core/formats/slides.ts` (new `slidesBytes(file, deck): Promise<Uint8Array>`; backup step kept), `src/core/formats/text.ts`, `src/core/formats/pdf.ts`, `src/core/instructions.ts` (`setDocInstructions` writes .md/.html through `guardedWrite`), `src/core/ops/index.ts` (`runOffline(file, op, ctx?: WriteContext)` passes ctx to `saveFile`)
- Test: `test/files-history.test.ts`; existing format tests must still pass

**Interfaces:**
- Consumes: `guardedWrite`, `writeAtomic` (Tasks 1-2).
- Produces:
  - `payloadBytes(file: string, payload: FilePayload): Promise<Uint8Array>` (also used by restore for unsaved editor content)
  - `saveFile(file: string, payload: FilePayload, ctx?: WriteContext): Promise<number>` (still returns mtime; ctx defaults to `{ authors: [{ name: 'Agent', by: 'agent' }] }`)
  - `runOffline(file: string, op: AgentOp, ctx?: WriteContext): Promise<unknown>`

- [ ] **Step 1: Write the failing tests**

```ts
test('saveFile writes every kind in memory then atomically, and records a version', async () => {
  for (const [name, payload] of samples) {           // .md, .html, .docx, .xlsx, .csv, .pptx, .pdf, .txt
    await saveFile(p(name), payload, person('Matt')); await flushHistory()
    const bytes = fs.readFileSync(p(name))
    assert.equal(listVersions(p(name)).at(-1)!.hash, sha256(bytes), name)   // the bytes on disk are the bytes recorded
  }
})
test('runOffline credits the agent', async () => {})
test('setDocInstructions records a version of the .md file', async () => {})
test('createFile over an existing file keeps it as the baseline', async () => {})
```

- [ ] **Step 2: Run `npm test -- files-history`.** Expected: FAIL.
- [ ] **Step 3: Implement.** No format writer writes to the target path directly any more; `saveFile` calls `guardedWrite(file, ctx, async () => { const b = await payloadBytes(file, payload); await writeAtomic(file, b); return b })`.
- [ ] **Step 4: Run `npm test`.** Expected: all tests PASS, including doc-docx, sheet, slides and pdf suites.
- [ ] **Step 5: Commit** `feat(history): every save writes in memory, atomically, with a version`

### Task 4: Managing history

**Files:**
- Create: `src/core/history/manage.ts` (export from `index.ts`)
- Test: `test/history-manage.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (`payloadBytes`, `getDocInstructions`, `withInstructions` from src/core/instructions.ts).
- Produces:
  - `showVersion(file: string, n: number): Promise<Uint8Array>`
  - `nameVersion(file: string, n: number, name: string): void`
  - `forgetHistory(file: string): Promise<void>` (index, log and objects no other index uses)
  - `moveHistory(from: string, to: string): void` (a file, or every index under a folder)
  - `restoreVersion(file: string, n: number, opts: { authors: Author[]; unsaved?: Uint8Array; discardCurrent?: boolean }): Promise<HistoryVersion>`: steps 1-5 of the spec's Restoring section; throws `"<file> is over 32 MB, so its current content can't be kept. Restore anyway with discardCurrent."` when the current file is over the limit and `discardCurrent` isn't set.

- [ ] **Step 1: Write the failing tests**

```ts
test('restore writes the stored bytes exactly and can be undone', async () => {
  // v1 baseline docx bytes, v2 edited: restore v1 -> file bytes === v1 bytes; latest has restoredFrom 1;
  // the version before the restore is beforeRestore; restoring that one brings v2's content back
})
test('restore keeps unsaved editor content as a version first, without writing it', async () => {})
test('restore keeps the current standing instructions in .md and .html', async () => {})
test('restore recreates a file that was deleted from disk', async () => {})
test('restore over a file grown past 32 MB needs discardCurrent', async () => {})
test('folding never merges into a restore or the state before it', async () => {})
test('forget removes index, log and unshared objects', async () => {})
test('moveHistory follows a folder rename', async () => {})
```

- [ ] **Step 2: Run `npm test -- history-manage`.** Expected: FAIL.
- [ ] **Step 3: Implement `manage.ts`.**
- [ ] **Step 4: Run `npm test -- history-manage`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): list, show, name, forget, move and restore`

### Task 5: Work history log

**Files:**
- Create: `src/core/history/log.ts` (export from `index.ts`; replace Task 2's `onMoved` no-op with `appendEvent`)
- Test: `test/history-log.test.ts`

**Interfaces:**
- Produces:
  - `interface HistoryEvent { at: number; type: 'save' | 'agent-op' | 'comment' | 'reply' | 'resolved' | 'connected' | 'disconnected' | 'subscribed' | 'unsubscribed' | 'woken' | 'outside' | 'named' | 'restored' | 'moved'; by: string; summary: string }`
  - `appendEvent(file: string, ev: HistoryEvent): Promise<void>` (under the key's lock; merges consecutive `agent-op` events by the same `by` within 60 s into "<n> edits"; trims to the newest half when over 2 MB; never quotes content for excluded files)
  - `readLog(file: string, limit?: number): HistoryEvent[]` (newest first, skips lines that don't parse)
  - Task 2's recorder now appends a `save` event (by the version's authors) or an `outside` event after each recorded
    version, and `restoreVersion` and `nameVersion` append `restored` and `named`.

- [ ] **Step 1: Write the failing tests:** merging within 60 s, no merge across agents or after 60 s, 2 MB cap, a garbage line is skipped, excluded files get summaries without quoted text.
- [ ] **Step 2: Run `npm test -- history-log`.** Expected: FAIL.
- [ ] **Step 3: Implement `log.ts`.**
- [ ] **Step 4: Run `npm test -- history-log`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): work history log`

### Task 6: Retention and the size cap

**Files:**
- Create: `src/core/history/cleanup.ts` (export from `index.ts`)
- Test: `test/history-cleanup.test.ts`

**Interfaces:**
- Produces: `cleanupHistory(now: number, capBytes: number): Promise<{ removedVersions: number; freedBytes: number; overCapBytes?: number; skipped?: 'corrupt-index' }>`

- [ ] **Step 1: Write the failing tests** (versions with backdated `at`):
  - 31 days old: thinned to one per day; 400 days old: one per month.
  - Latest, under-7-days, baseline and named versions survive everything.
  - Over the cap: the file using the most space is thinned first; another file's last 7 days are untouched; when protected versions alone exceed the cap, `overCapBytes` is returned and nothing protected is removed.
  - A file gone for 91 days (folder exists, file doesn't) loses all but named versions; one on a missing drive (folder unreachable) keeps everything.
  - An object modified in the last 24 hours is never deleted even if no index uses it.
  - Any unreadable index makes the run return `{ skipped: 'corrupt-index' }` with nothing removed.
- [ ] **Step 2: Run `npm test -- history-cleanup`.** Expected: FAIL.
- [ ] **Step 3: Implement `cleanup.ts`.** Log files follow the same age rules.
- [ ] **Step 4: Run `npm test -- history-cleanup`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): retention and size cap`

### Task 7: Comparing versions

**Files:**
- Create: `src/shared/diff.ts`, `src/core/history/compare.ts` (export from `index.ts`)
- Modify: `package.json` (add `diff` and `@types/diff` if the installed major has no bundled types)
- Test: `test/diff.test.ts`

**Interfaces:**
- Produces:
  - `type Hunk = { kind: 'same' | 'add' | 'del'; lines: string[] }`
  - `lineDiff(a: string, b: string, context = 3): Hunk[]` (Myers via `diffLines` from `diff`; long `same` runs collapsed to `context` lines each side)
  - `versionText(file: string, bytes: Uint8Array): Promise<string>`: docs as Markdown (htmlToMarkdown), slides as `deckToMarkdown`, sheets as one line per non-empty cell `Sheet!A1: value`, PDFs as page text, text as is. Loads bytes by writing them to a temp file with the same extension under `os.tmpdir()` and calling `loadFile`.
  - `compareVersions(file: string, a: Uint8Array, b: Uint8Array): Promise<{ hunks: Hunk[] } | { tooLarge: true }>` (8 MB limit on either side)

- [ ] **Step 1: Write the failing tests:** an edit in paragraph 2 and paragraph 50 gives two separate hunks; a sheet change shows `Sheet1!B7: 10` removed and `Sheet1!B7: 12` added; a 9 MB side returns `{ tooLarge: true }`.
- [ ] **Step 2: Run `npm test -- diff`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `src/renderer/src/shell/diff.ts` stays as it is (agent edit events).
- [ ] **Step 4: Run `npm test -- diff`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): line diff and version comparison`

### Task 8: Worker and main wiring

**Files:**
- Modify: `src/main/worker.ts` (jobs), `src/main/work.ts` (worker events), `src/main/index.ts`, `src/main/folders.ts`
- Test: build plus the manual check in Step 3

**Interfaces:**
- Consumes: the history API (Tasks 1-7).
- Produces:
  - Worker jobs: `saveFile: [file, payload, ctx?]`, `loadFile` runs `checkOutside` first, `runOffline: [file, op, ctx?]`, `historyList: [file]`, `historyLog: [file]`, `historyDiff: [file, a, b?]` (b omitted = the file now), `historyRestore: [file, n, opts]`, `historyName: [file, n, name]`, `historyForget: [file]`, `historyMove: [from, to]`, `historyCheck: [file]` (low priority), `historyEvent: [file, event]`, `historyCleanup: []`, `historyStats: []` (`{ bytes, capBytes, overCapBytes? }`), `historyFlush: []`, `historyOpenCopy: [file, n]` (writes `<stem> (v<n>).<ext>` in the docs folder, returns its path)
  - Worker posts `{ event: 'history-paused', reason }`; `work.ts` exports `onWorkerEvent(cb: (name: string, data: unknown) => void)`.
  - Main window API (`window.gd.call`): `save(file, payload, ctx?)` plus every history job above under the same names; event to the window: `'history-paused'` (once per session).
  - Main: the rpc `op` case passes `{ authors: [{ name: agent.name, by: 'agent' }], summary: op.op }` to `runOffline`; `rename` and `renameEntry` call `historyMove`; Save As and Export go through `saveFile` with the person as author; comments, replies, resolves, listener connect/disconnect (src/main/server.ts callback), subscribe/unsubscribe/wake and agent ops send `historyEvent`; `historyCleanup` runs after `warmUp()` and every 24 h; `before-quit` waits up to 5 s for `historyFlush` before `stopWorker()`; rpc method `historyRestore` (for the CLI) asks the window over a new `'history-restore'` channel when the file is open, otherwise runs the job.
  - `folders.ts`: the watcher callback becomes `send(root, dir, file)`; main sends `historyCheck` for files whose history exists.

- [ ] **Step 1: Implement the jobs, events and hooks.**
- [ ] **Step 2: Run `npx tsc --noEmit` and `npm test`.** Expected: no type errors, all tests PASS.
- [ ] **Step 3: Manual check in an isolated instance** (`GAUZZADOCS_HOME` set to a temp folder, its own `--user-data-dir`): open a .md file, type, wait 2 s, then run `node -e` against the store to see a version credited to the person; edit the file from another program and wait 3 s: an "outside gauzzaDocs" version appears.
- [ ] **Step 4: Commit** `feat(history): worker jobs, main hooks and work history events`

### Task 9: In the app

**Files:**
- Create: `src/renderer/src/shell/History.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/lib.ts`, `src/renderer/src/shell/Dialogs.tsx` (SettingsDialog history section), `src/renderer/src/shell/shell.css`, `src/preload/index.ts` and `src/renderer/src/env.d.ts` (`'history-restore'` serve channel, `'history-paused'` event)
- Test: manual, with screenshots, in an isolated instance

**Interfaces:**
- Consumes: the window API from Task 8.
- Produces:
  - Per-tab authors in App: a `Map<tabId, Map<string, Author>>`; `onChange` adds the person (name from main's `userName`, exposed as `api.userName()`) or, while an agent op runs on that tab, the agent; `save()` passes them and a summary of the agent op names, then clears them.
  - When the 2-second check marks a dirty tab changed outside, it calls `api.historyCheck(path)`.
  - `HistoryPanel({ path, onClose, onReload, say })`: right-side, resizable via `usePanelSize`, tabs Versions and Work history; version rows grouped by day with avatars in `agentColor` colors or "outside gauzzaDocs"; selecting a row shows `historyDiff` hunks; actions Restore this version, Name this version, Open as a copy; "Delete history for this file" at the bottom.
  - File menu "Version history" with shortcut Ctrl+Alt+Shift+H.
  - Restore from the panel: `peekPayload` of a dirty tab goes as `unsaved`, then the tab reloads from disk.
  - `'history-restore'` serve handler (CLI restores of open files) does the same.
  - Settings: total size and cap (MB), the exclude patterns (one per line), "History is stored unencrypted in <HOME>/history.", and the paused reason if any.
  - A toast "Version history paused: <reason>" on the first `'history-paused'` event.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run `npx tsc --noEmit` and `npm test`.** Expected: clean.
- [ ] **Step 3: Check in an isolated instance with `npm run build` and the scratchpad CDP helper:** make three edits as the person and one with `gdocs replace --agent Claude`; open the panel (Ctrl+Alt+Shift+H); screenshot shows four rows with the right names and colors; select the agent's row: the diff shows its change; restore the first version: the document shows the original text and a "restored v1" row appears; Work history lists the agent op and the restore.
- [ ] **Step 4: Commit** `feat(history): version history panel, authors per tab, settings`

### Task 10: Command line, skill text and README

**Files:**
- Create: `src/cli/history.ts`
- Modify: `src/cli/index.ts` (register; `resolveDocIds` also searches `listHistoryPaths()`), `src/cli/common.ts` (`runOp` passes `{ authors: [{ name: agentName, by: 'agent' }] }` to `runOffline`; `await flushHistory()` before the CLI exits), `src/core/agentSkills.ts`, `README.md`
- Test: `test/history-cli.test.ts`

**Interfaces:**
- Consumes: the history API; `call('historyRestore', ...)` from Task 8 when the app runs.
- Produces the commands from the spec's Command line section, each with `--json`, accepting doc ids and paths that no longer exist: `history <file>`, `history show <file> <v>`, `history diff <file> <v> [<v2>]`, `history restore <file> <v> [--discard-current]`, `history name <file> <v> <name>`, `history log <file>`, `history forget <file>`. Versions are written `v7` or `7`. Text output lines look like `v12  Nov 25 3:04 PM  Claude, Matt  replaced text in Risks`.

- [ ] **Step 1: Write the failing test:** build the CLI with `node scripts/build-cli.mjs`, then `execFile(process.execPath, ['dist/cli.mjs', ...])` with `GAUZZADOCS_HOME` set: `replace` twice with `--agent Claude --offline`, then `history <file> --json` lists baseline plus Claude's versions; `history restore <file> 1 --offline` brings the original back; `history forget` leaves `history list` empty.
- [ ] **Step 2: Run `npm test -- history-cli`.** Expected: FAIL.
- [ ] **Step 3: Implement the commands.** Add to the skill: "`gdocs history <file>` shows who changed what; `gdocs history diff <file> v7` shows a change; restore only when the person asks." Add a README section "Version history" in Matt's voice: what's kept, outside changes, secret files skipped, where it lives and that it's unencrypted, the commands.
- [ ] **Step 4: Run `npm test`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(history): gdocs history commands, skill text and README`
