import { parentPort } from 'node:worker_threads'
import { createFile, loadFile, saveFile } from '../core/files'
import { fontFaceBytes, listFontFaces, systemFontBytes } from '../core/systemFonts'
import { fallbackFontBytes } from '../core/design/fallbackFont'
import { layoutDiagram } from '../core/design/layout'
import { findInFile, forgetIndex, indexFile, readLines } from '../core/large'
import { runOffline } from '../core/ops'
import * as plugins from '../core/plugins'
import * as projects from '../core/projects'
import { detectAgents, installSkills, refreshInstalledSkills, removeSkills } from '../core/agentSkills'
import { checkOutside, onHistoryPaused, recoverDroppedObjects } from '../core/history'
import { setDocInstructions } from '../core/instructions'
import { historyJobs } from './historyJobs'

/**
 * All file work runs here, on its own thread, never on the main process thread. Windows shows "not responding" as
 * soon as the main thread stalls (it runs the window's message loop), and loading a format library for the first
 * time, converting a big Word file, indexing a 2 GB log or installing a plugin can each take seconds.
 * Main sends { id, fn, args } and gets back { id, result } or { id, error }; long jobs may also post { id, progress }.
 * Things main should hear about unasked are posted as { event, ...data } (see onWorkerEvent in work.ts).
 * This thread is also the app's only version history writer (see historyJobs.ts).
 */
type Fn = (args: any[], progress: (p: unknown) => void) => unknown

const fns: Record<string, Fn> = {
  // An outside change (another program wrote the file) is kept as a version before the file is shown.
  loadFile: async ([file]) => (await checkOutside(file), loadFile(file)),
  // ctx: who made the change ({ authors, summary }), for the version this save keeps.
  saveFile: ([file, payload, ctx]) => saveFile(file, payload, ctx),
  systemFont: ([name]) => systemFontBytes(name),
  // Designs in the window: installed font faces by family, weight and style (the first call scans every font file, so
  // only ever here), the fallback font, and diagram layout (ELK runs generated code the window's policy refuses).
  designFontBytes: ([ref]) => fontFaceBytes(ref),
  designFallbackFont: () => fallbackFontBytes(),
  designLayout: ([graph]) => layoutDiagram(graph),
  // The font picker: every face by family, weight, style and PostScript name (where its file is stays here).
  fontFaces: async () => (await listFontFaces()).map(({ family, weight, style, postscript }) => ({ family, weight, style, postscript })),
  // preset: a new design's size (a PRESETS name or <w>x<h>); other kinds ignore it
  createFile: ([file, ctx, preset]) => createFile(file, ctx, preset),
  setDocInstructions: ([file, text, ctx]) => setDocInstructions(file, text, ctx),
  runOffline: ([file, op, ctx]) => runOffline(file, op, ctx),
  largeIndex: async ([file], progress) => {
    const i = await indexFile(file, f => progress(f))
    return { lines: i.lines, size: i.size, crlf: i.crlf }
  },
  largeLines: ([file, from, count]) => readLines(file, from, count),
  largeFind: ([file, q, opts]) => findInFile(file, q, opts),
  largeForget: ([file]) => forgetIndex(file),
  // Agent detection shells out to `where`, which can take a moment per agent: keep it off the main thread too.
  agentsDetect: () => detectAgents(),
  agentsInstall: ([ids, version]) => installSkills(ids, version),
  agentsRemove: ([ids]) => removeSkills(ids),
  agentsRefresh: ([version]) => refreshInstalledSkills(version),
  pluginsInstalled: () => plugins.installed(),
  pluginsLibrary: ([fallback]) => plugins.library(fallback),
  pluginsInstall: ([id, fallback]) => plugins.install(id, fallback),
  pluginsUpdateAll: ([fallback]) => plugins.updateAll(fallback),
  pluginsRemove: ([id]) => plugins.remove(id),
  pluginsSetEnabled: ([id, on]) => plugins.setEnabled(id, on),
  // Projects (folders on the home screen and in the explorer). Listing and search never block the window.
  projectsList: () => projects.listProjects(),
  projectsAdd: ([dir, name]) => projects.addProject(dir, name),
  projectsRemove: ([key]) => projects.removeProject(key),
  projectsRename: ([dir, name]) => projects.renameProject(dir, name),
  projectsTouch: ([dir]) => projects.touchProject(dir),
  projectFor: ([file]) => projects.projectFor(file) || null,
  listFolder: ([dir]) => projects.listFolder(dir),
  searchFolder: ([root, q, opts]) => projects.searchFolder(root, q, opts),
  // Version history: list, compare, restore, name, forget, move, outside checks, work history, cleanup.
  ...historyJobs
}

// A history failure never fails a save; main shows "Version history paused: <reason>" once.
onHistoryPaused(reason => parentPort!.postMessage({ event: 'history-paused', reason }))

// Objects a fold moved aside and could not put back (the app quit in between, or Windows refused) go back now, so the
// versions that use them can be read again without waiting for the next cleanup.
setTimeout(() => void recoverDroppedObjects().catch(() => {}), 500)

parentPort!.on('message', async (msg: { id: number; fn: string; args: unknown[] }) => {
  const progress = (p: unknown) => parentPort!.postMessage({ id: msg.id, progress: p })
  try {
    const fn = fns[msg.fn]
    if (!fn) throw new Error(`Unknown worker job ${msg.fn}`)
    parentPort!.postMessage({ id: msg.id, result: await fn(msg.args, progress) })
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error)?.message || String(e) })
  }
})

// Warm up: load the format libraries now, in the background, so the first spreadsheet, Word file or PDF the person
// opens does not wait on (and an antivirus scan of) thousands of small module files.
setTimeout(() => {
  for (const m of [() => import('exceljs'), () => import('mammoth'), () => import('pdf-lib'), () => import('@turbodocx/html-to-docx')]) m().catch(() => {})
}, 1500)
