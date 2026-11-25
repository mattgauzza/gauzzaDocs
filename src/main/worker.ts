import { parentPort } from 'node:worker_threads'
import { createFile, loadFile, saveFile } from '../core/files'
import { findInFile, forgetIndex, indexFile, readLines } from '../core/large'
import { runOffline } from '../core/ops'
import * as plugins from '../core/plugins'
import { detectAgents, installSkills, refreshInstalledSkills, removeSkills } from '../core/agentSkills'

/**
 * All file work runs here, on its own thread, never on the main process thread. Windows shows "not responding" as
 * soon as the main thread stalls (it runs the window's message loop), and loading a format library for the first
 * time, converting a big Word file, indexing a 2 GB log or installing a plugin can each take seconds.
 * Main sends { id, fn, args } and gets back { id, result } or { id, error }; long jobs may also post { id, progress }.
 */
type Fn = (args: any[], progress: (p: unknown) => void) => unknown

const fns: Record<string, Fn> = {
  loadFile: ([file]) => loadFile(file),
  saveFile: ([file, payload]) => saveFile(file, payload),
  createFile: ([file]) => createFile(file),
  runOffline: ([file, op]) => runOffline(file, op),
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
  pluginsSetEnabled: ([id, on]) => plugins.setEnabled(id, on)
}

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
