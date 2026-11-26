import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { runOffline } from '../core/ops'
import { readServer, samePath } from '../core/paths'
import { describeOps } from '../shared/history/describe'
import { kindOf } from '../shared/kinds'
import type { AgentOp } from '../shared/types'

/** Talks to the running app over the live-edit bridge. Returns null when the app is not running. */
export async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const s = readServer()
  if (!s) return null
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${s.port}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params })
    })
  } catch {
    return null // stale server.json: the app is not running
  }
  if (res.status === 401) throw new Error('The app refused the request (token mismatch). Restart gauzzaDocs.')
  const body = (await res.json()) as { result?: unknown; error?: string }
  if (body.error) throw new Error(body.error)
  return body.result
}

export const appRunning = async () => (await call('ping')) !== null

export interface RunOpts { live?: boolean; offline?: boolean; agent?: string; focus?: boolean }

export const OPEN_IN_APP = 'This design is open in gauzzaDocs. Edit it there, or close it first.'

/** What drawing a design to pixels (PNG export, gdocs look, thumbnails) says when the app isn't running. */
export const RENDER_NEEDS_APP = 'Start gauzzaDocs to render designs. Editing and SVG export work without it.'

/**
 * A design open in the app takes every op in its editor: one made on disk would land under the editor's undo history,
 * and the app would never reload it. With the app not running, editing on disk is fine.
 */
export async function refuseOpenDesign(p: string): Promise<void> {
  if (kindOf(p) !== 'design') return
  let open: boolean
  try {
    open = !!((await call('isOpen', { path: p })) as { open?: boolean } | null)?.open
  } catch (e) {
    // an app from before isOpen: its tab list says the same
    if (!/^Unknown method/.test((e as Error).message)) throw e
    const tabs = (await call('list')) as { path: string }[] | null
    open = !!tabs?.some(t => samePath(t.path, p))
  }
  if (open) throw new Error(OPEN_IN_APP)
}

/**
 * Runs an op on a file: in the app when it is running and the file is open there (or --live asks to open it),
 * otherwise directly on disk. Returns the op's result and whether it ran live.
 */
export async function runOp(file: string, op: AgentOp, opts: RunOpts = {}): Promise<{ result: unknown; live: boolean }> {
  const p = path.resolve(file)
  if (!fs.existsSync(p)) throw new Error(`No such file: ${p}`)
  if (opts.offline) await refuseOpenDesign(p)
  else {
    const r = (await call('op', {
      path: p,
      op,
      live: !!opts.live,
      focus: opts.focus !== false,
      agent: { name: opts.agent || process.env.GDOCS_AGENT || 'Agent' }
    })) as { result: unknown; live: boolean } | null
    if (r) return r
    if (opts.live) throw new Error('gauzzaDocs is not running. Start the app, or drop --live to edit the file on disk.')
  }
  // The version this edit keeps is credited to the agent, with the same wording the app uses.
  const by = opts.agent || process.env.GDOCS_AGENT || 'Agent'
  return { result: await runOffline(p, op, { authors: [{ name: by, by: 'agent' }], summary: describeOps([op.op], kindOf(p)) }), live: false }
}

export interface Ctx {
  json: () => boolean
  out: (data: unknown, human: () => string) => void
  run: (file: string, op: AgentOp, cmdOpts?: Record<string, unknown>) => Promise<unknown>
  /** Reads a value that may be "-" (standard input) or "@file" (contents of a file). */
  input: (v: string | undefined) => string
}

/** Options every editing command takes. */
export const liveOptions = (c: Command) =>
  c
    .option('--live', 'open the file in the app (if not already) and edit it there, so you can watch')
    .option('--offline', 'edit the file on disk even if it is open in the app')
    .option('--no-focus', 'with --live, do not bring the window to the front')
