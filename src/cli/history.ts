import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import {
  compareVersions,
  forgetHistory,
  listVersions,
  nameVersion,
  readLog,
  restoreVersion,
  showVersion,
  versionText,
  type HistoryEvent,
} from '../core/history'
import { describeOp } from '../shared/history/describe'
import { kindOf } from '../shared/kinds'
import type { HistoryVersion } from '../shared/types'
import { call } from './common'
import type { Ctx } from './common'

/** "v7" or "7" as a number. */
export function parseVersion(v: string | undefined): number {
  const m = /^v?(\d+)$/i.exec(String(v ?? '').trim())
  const n = m ? Number(m[1]) : 0
  if (!n) throw new Error(`Not a version number: ${v ?? '(none)'}. Use a number like 7 or v7.`)
  return n
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (t: number) => DATE.format(t).replace(',', '')
const people = (v: HistoryVersion) => [...new Set(v.authors.map(a => a.name))].join(', ') || 'Unknown'

/** `v12  Nov 25 3:04 PM  Claude, Matt  replaced text in Risks`, with plain marks for named, baseline and restore versions. */
export function versionLine(v: HistoryVersion): string {
  const marks = [
    v.name ? `Named: ${v.name}` : '',
    v.baseline ? 'Baseline' : '',
    v.beforeRestore ? 'Before a restore' : '',
    v.restoredFrom ? `Restored from v${v.restoredFrom}` : ''
  ].filter(Boolean)
  return `v${v.n}  ${when(v.at)}  ${people(v)}  ${v.summary}${marks.length ? `  (${marks.join('; ')})` : ''}`
}

/** One work history event, worded the way the app words it. */
export function eventLine(file: string, e: HistoryEvent): string {
  const text = e.type === 'agent-op' ? describeOp(e.summary, kindOf(file)) : e.summary
  return `${when(e.at)}  ${e.by}  ${text}`
}

/** Lines of a diff: "  " same, "- " deleted, "+ " added, and "..." where lines were skipped. */
export function diffText(r: Awaited<ReturnType<typeof compareVersions>>): string {
  if ('tooLarge' in r) return 'Too large to compare here'
  if (!r.hunks.length) return 'No changes.'
  const out: string[] = []
  r.hunks.forEach((h, i) => {
    if (h.kind === 'same' && i > 0 && r.hunks[i - 1].kind === 'same') out.push('...') // two same hunks in a row: lines were skipped
    const mark = h.kind === 'same' ? '  ' : h.kind === 'del' ? '- ' : '+ '
    for (const l of h.lines) out.push(mark + l)
  })
  return out.join('\n')
}

/**
 * Version history for agents:
 *   gdocs history report.md             versions, who made them, what changed
 *   gdocs history diff report.md v7     what changed since v7
 *   gdocs history restore report.md v7  only when the person asks
 */
export function registerHistoryCommands(program: Command, ctx: Ctx, agentName: () => string) {
  const abs = (f: string) => path.resolve(f)
  const h = program
    .command('history')
    .description('version history of a file: who changed what, and going back. Works for files that no longer exist.')

  h.command('list <file>', { isDefault: true })
    .description('versions of a file, oldest first (the default: gdocs history <file>)')
    .action((file: string) => {
      const v = listVersions(abs(file))
      ctx.out(v, () => (v.length ? v.map(versionLine).join('\n') : `No history for ${file}.`))
    })

  h.command('show <file> <version>')
    .description('the content of a version, the way gdocs read prints it')
    .action(async (file: string, version: string) => {
      const n = parseVersion(version)
      const bytes = await showVersion(abs(file), n)
      const content = await versionText(abs(file), bytes)
      ctx.out({ version: n, content }, () => content.replace(/\n$/, ''))
    })

  h.command('diff <file> <version> [version2]')
    .description('changes from a version to another one, or to the file now')
    .action(async (file: string, version: string, version2: string | undefined) => {
      const f = abs(file)
      const a = parseVersion(version)
      const before = await showVersion(f, a)
      let after: Uint8Array
      if (version2 !== undefined) after = await showVersion(f, parseVersion(version2))
      else if (fs.existsSync(f)) after = fs.readFileSync(f)
      else {
        const all = listVersions(f)
        after = await showVersion(f, all[all.length - 1].n)
      }
      const r = await compareVersions(f, before, after)
      ctx.out(r, () => diffText(r))
    })

  h.command('restore <file> <version>')
    .description('put a version back. Live when the file is open in the app (unsaved work is kept as a version first)')
    .option('--offline', 'restore on disk even if the app is running')
    .option('--discard-current', 'when the current file is over 32 MB, restore without keeping it')
    .action(async (file: string, version: string, o) => {
      const f = abs(file)
      const n = parseVersion(version)
      const agent = { name: agentName() }
      const live = o.offline
        ? null
        : ((await call('historyRestore', { path: f, n, discardCurrent: !!o.discardCurrent, agent })) as { version: HistoryVersion; live: boolean } | null)
      const version2 = live
        ? live.version
        : await restoreVersion(f, n, { authors: [{ name: agent.name, by: 'agent' }], discardCurrent: !!o.discardCurrent })
      ctx.out({ restored: n, version: version2, live: !!live?.live }, () => `Restored v${n}${live?.live ? ' in gauzzaDocs' : ''}. It is now v${version2.n}.`)
    })

  h.command('name <file> <version> <name>')
    .description('name a version so it is kept for good (an empty name clears it)')
    .action(async (file: string, version: string, name: string) => {
      const f = abs(file)
      const n = parseVersion(version)
      const by = agentName()
      const r = await call('historyName', { path: f, n, name, agent: { name: by } })
      if (r === null) await nameVersion(f, n, name, by)
      ctx.out({ version: n, name: name.trim() }, () => (name.trim() ? `Named v${n} "${name.trim()}".` : `Cleared the name of v${n}.`))
    })

  h.command('log <file>')
    .description('the work history: saves, agent edits, comments, restores, newest last')
    .action((file: string) => {
      const f = abs(file)
      const events = readLog(f)
      ctx.out(events, () => (events.length ? events.map(e => eventLine(f, e)).join('\n') : `No work history for ${file}.`))
    })

  h.command('forget <file>')
    .description('delete all history of a file, for good')
    .action(async (file: string) => {
      const f = abs(file)
      const r = await call('historyForget', { path: f })
      if (r === null) await forgetHistory(f)
      ctx.out({ forgotten: f }, () => `Deleted the history of ${file}.`)
    })
}
