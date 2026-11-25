import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { HOME } from '../core/paths'
import {
  type AgentKind, type DocEvent, type Subscription, buildPrompt, chainStep, findSubscription, listSubscriptions, rateCheck,
  routeEvent, updateSubscription
} from '../core/subscriptions'

/**
 * Runs subscribed agents (see src/core/subscriptions.ts). When an event wakes an agent, this starts that agent's own
 * CLI headless in the document's folder (Claude Code, Codex, Gemini CLI or Copilot CLI, with the person's own login),
 * gives it a prompt on stdin, and logs the run. Everything is async; nothing here blocks the window.
 * Safety: one run at a time per agent, a rate limit, a ten minute timeout, and every agent on a doc pauses when agents
 * keep waking each other with nothing from the person in between.
 */
const run = promisify(execFile)
export type AgentRunState = 'idle' | 'working' | 'waiting' | 'paused' | 'error'
export interface AgentStatus {
  id: string
  path: string
  name: string
  agent: AgentKind
  role: Subscription['role']
  brief: string
  state: AgentRunState
  pausedReason?: string
  error?: string
  access: 'limited' | 'full'
  lastRun?: { start: number; end?: number; code?: number | null; log: string }
  nextAt?: number
}

const RUN_TIMEOUT = 10 * 60_000
const KEEP_LOGS = 20
const runsDir = (id: string) => path.join(HOME, 'agent-runs', id)

/** Gemini has no narrow allow list that works reliably, so it runs with its own auto-approve. Shown as "Full access". */
export const ACCESS: Record<AgentKind, 'limited' | 'full'> = { claude: 'limited', codex: 'limited', gemini: 'full', copilot: 'limited' }

function commandFor(sub: Subscription, dir: string, promptFile: string): { args: string[]; stdin: boolean } {
  switch (sub.agent) {
    case 'claude':
      // Only gdocs (and empirical, for the writing voice) may run without asking; nothing else can.
      return {
        args: ['-p', '--output-format', 'text', '--allowedTools', 'Bash(gdocs *)', 'Bash(gauzzadocs *)', 'Bash(empirical *)', 'PowerShell(gdocs *)', 'PowerShell(empirical *)'],
        stdin: true
      }
    case 'codex':
      // Workspace-write sandbox, with network on so gdocs can reach the app on 127.0.0.1.
      return { args: ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-C', dir, '-'], stdin: true }
    case 'gemini':
      return { args: ['-p', 'Do the task described in the input above.', '--approval-mode', 'yolo', '-o', 'text'], stdin: true }
    case 'copilot':
      return {
        args: ['-p', `Read the file ${promptFile} and do exactly what it says.`, '-s', '--add-dir', path.dirname(promptFile), '--allow-tool', 'shell(gdocs:*)', 'shell(gauzzadocs:*)', 'shell(empirical:*)'],
        stdin: false
      }
  }
}

const shimCache = new Map<string, string>()
/** npm installs these as .cmd shims on Windows, which only run through cmd.exe. */
async function resolveShim(cmd: string): Promise<string> {
  if (shimCache.has(cmd)) return shimCache.get(cmd)!
  if (process.platform !== 'win32') return cmd
  const { stdout } = await run('where', [cmd], { windowsHide: true }).catch(() => ({ stdout: '' }))
  const hits = stdout.split(/\r?\n/).filter(Boolean)
  const pick = hits.find(h => /\.(cmd|exe|bat)$/i.test(h)) || hits[0]
  if (!pick) throw new Error(`${cmd} isn't installed or isn't on PATH`)
  shimCache.set(cmd, pick)
  return pick
}

const quote = (a: string) => `"${a.replace(/"/g, '\\"')}"`

export class AgentRunner {
  private pending = new Map<string, DocEvent[]>()
  private timers = new Map<string, NodeJS.Timeout>()
  private procs = new Map<string, ChildProcess>()
  private starts = new Map<string, number[]>()
  private last = new Map<string, NonNullable<AgentStatus['lastRun']>>()
  private errors = new Map<string, string>()
  private nextAt = new Map<string, number>()
  private chains = new Map<string, number>()
  private turns = new Set<string>() // subscriptions that have had a first turn this session

  constructor(private opts: { notify(states: AgentStatus[]): void; binDir: string; onRunStart?(sub: Subscription): void }) {}

  /** Every bridge event passes through here. */
  onEvent(ev: DocEvent) {
    if (!ev.path || !ev.by) return
    const subs = listSubscriptions(ev.path)
    if (!subs.length) return
    if (ev.by === 'user') this.chains.set(ev.path.toLowerCase(), 0)
    for (const w of routeEvent(subs, ev)) this.queue(w.id, ev, w.settle ? 30_000 : 3_000)
  }

  /** The person (or --start) asks an agent to take a turn now. */
  wake(id: string, note?: string) {
    this.queue(id, { type: 'wake', by: 'user', note, at: Date.now() }, 0)
  }

  private queue(id: string, ev: DocEvent, delay: number) {
    this.pending.set(id, [...(this.pending.get(id) || []), ev])
    clearTimeout(this.timers.get(id))
    this.timers.set(id, setTimeout(() => this.tryRun(id), delay))
    this.publish()
  }

  private tryRun(id: string) {
    this.timers.delete(id)
    const sub = listSubscriptions().find(s => s.id === id)
    if (!sub || sub.paused) return void (this.pending.delete(id), this.publish())
    if (this.procs.has(id)) return // runs again when the current run ends
    const now = Date.now()
    const rate = rateCheck(this.starts.get(id) || [], now)
    if (!rate.ok) {
      this.nextAt.set(id, rate.retryAt!)
      this.timers.set(id, setTimeout(() => this.tryRun(id), rate.retryAt! - now + 500))
      return this.publish()
    }
    const events = this.pending.get(id) || []
    this.pending.delete(id)
    this.nextAt.delete(id)
    const docKey = sub.path.toLowerCase()
    const step = chainStep(this.chains.get(docKey) || 0, events.some(e => e.by === 'user'))
    this.chains.set(docKey, step.chain)
    if (step.pause) {
      for (const s of listSubscriptions(sub.path)) {
        updateSubscription(s.id, { paused: true, pausedReason: 'The agents kept waking each other with nothing from you in between, so I paused them. Resume one when you want them back.' })
        clearTimeout(this.timers.get(s.id))
        this.pending.delete(s.id)
      }
      this.chains.set(docKey, 0)
      return this.publish()
    }
    this.start(sub, events).catch(e => {
      this.errors.set(id, (e as Error).message)
      this.publish()
    })
  }

  private async start(sub: Subscription, events: DocEvent[]) {
    const dir = fs.existsSync(path.dirname(sub.path)) ? path.dirname(sub.path) : os.homedir()
    const logDir = runsDir(sub.id)
    fs.mkdirSync(logDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logFile = path.join(logDir, `${stamp}.log`)
    const promptFile = path.join(logDir, 'prompt.md')
    const first = !this.turns.has(sub.id)
    this.turns.add(sub.id)
    const prompt = buildPrompt(sub, listSubscriptions(sub.path), events, first)
    fs.writeFileSync(promptFile, prompt)
    const { args, stdin } = commandFor(sub, dir, promptFile)
    const shim = await resolveShim(sub.agent)
    const env = {
      ...process.env,
      GDOCS_AGENT: sub.name,
      PATH: `${this.opts.binDir}${path.delimiter}${process.env.PATH || ''}`,
      NO_COLOR: '1'
    }
    delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"${quote(shim)} ${args.map(quote).join(' ')}"`], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(shim, args, { cwd: dir, env })
    this.procs.set(sub.id, child)
    this.errors.delete(sub.id)
    this.starts.set(sub.id, [...(this.starts.get(sub.id) || []).filter(t => Date.now() - t < 60 * 60_000), Date.now()])
    const entry = { start: Date.now(), log: logFile } as NonNullable<AgentStatus['lastRun']>
    this.last.set(sub.id, entry)
    this.opts.onRunStart?.(sub)
    this.publish()

    const out = fs.createWriteStream(logFile)
    out.write(`# ${sub.name} (${sub.agent}, ${sub.role}) ${new Date().toLocaleString()}\n# ${shim} ${args.join(' ')}\n\n## Prompt\n\n${prompt}\n\n## Output\n\n`)
    child.stdout?.pipe(out, { end: false })
    child.stderr?.pipe(out, { end: false })
    if (stdin) child.stdin?.end(prompt)
    else child.stdin?.end()
    const killer = setTimeout(() => {
      out.write('\n\n(stopped: the run took longer than 10 minutes)\n')
      this.kill(sub.id)
    }, RUN_TIMEOUT)

    child.on('close', code => {
      clearTimeout(killer)
      this.procs.delete(sub.id)
      entry.end = Date.now()
      entry.code = code
      out.end(`\n\n(exit ${code})\n`)
      if (code !== 0) this.errors.set(sub.id, `The last run ended with exit code ${code}. View the run for details.`)
      this.prune(sub.id)
      // Anything that arrived while it worked gets its own turn.
      if (this.pending.get(sub.id)?.length) this.timers.set(sub.id, setTimeout(() => this.tryRun(sub.id), 3_000))
      this.publish()
    })
    child.on('error', e => this.errors.set(sub.id, e.message))
  }

  private prune(id: string) {
    try {
      const logs = fs.readdirSync(runsDir(id)).filter(f => f.endsWith('.log')).sort()
      for (const f of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) fs.rmSync(path.join(runsDir(id), f), { force: true })
    } catch { /* nothing to prune */ }
  }

  kill(id: string) {
    const p = this.procs.get(id)
    if (!p?.pid) return
    if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true }, () => {})
    else p.kill('SIGTERM')
  }

  /** Subscription removed or paused: stop anything queued or running for it. */
  stop(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.pending.delete(id)
    this.kill(id)
    this.publish()
  }

  lastLog(id: string): string {
    const l = this.last.get(id)?.log
    const file = l && fs.existsSync(l) ? l : (() => {
      try {
        const logs = fs.readdirSync(runsDir(id)).filter(f => f.endsWith('.log')).sort()
        return logs.length ? path.join(runsDir(id), logs[logs.length - 1]) : ''
      } catch {
        return ''
      }
    })()
    return file ? fs.readFileSync(file, 'utf8') : 'No runs yet.'
  }

  states(file?: string): AgentStatus[] {
    return listSubscriptions(file).map(s => ({
      id: s.id,
      path: s.path,
      name: s.name,
      agent: s.agent,
      role: s.role,
      brief: s.brief,
      access: ACCESS[s.agent],
      state: s.paused ? 'paused' : this.procs.has(s.id) ? 'working' : this.errors.has(s.id) ? 'error' : this.pending.get(s.id)?.length || this.nextAt.has(s.id) ? 'waiting' : 'idle',
      pausedReason: s.pausedReason,
      error: this.errors.get(s.id),
      lastRun: this.last.get(s.id),
      nextAt: this.nextAt.get(s.id)
    }))
  }

  publish() {
    this.opts.notify(this.states())
  }

  shutdown() {
    for (const id of this.procs.keys()) this.kill(id)
    for (const t of this.timers.values()) clearTimeout(t)
  }
}

/** Launchers the agents use, pointing at this app's own CLI and data folder (so a dev build never touches the installed one). */
export function writeLaunchers(binDir: string, nodeExe: string, cli: string) {
  fs.mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    const body = `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodeExe}" "${cli}" %*\r\n`
    for (const n of ['gdocs.cmd', 'gauzzadocs.cmd']) fs.writeFileSync(path.join(binDir, n), body)
    // Git Bash (Claude Code's shell on Windows) can't run a .cmd by bare name; npm writes the same kind of script.
    const fwd = (p: string) => p.replace(/\\/g, '/')
    const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${fwd(nodeExe)}" "${fwd(cli)}" "$@"\n`
    for (const n of ['gdocs', 'gauzzadocs']) fs.writeFileSync(path.join(binDir, n), sh)
  } else {
    const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeExe}" "${cli}" "$@"\n`
    for (const n of ['gdocs', 'gauzzadocs']) fs.writeFileSync(path.join(binDir, n), sh, { mode: 0o755 })
  }
}

export { findSubscription }
