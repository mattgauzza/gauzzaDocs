import path from 'node:path'
import type { Command } from 'commander'
import * as subs from '../core/subscriptions'
import { call } from './common'
import type { Ctx } from './common'

/**
 * Subscribing agents to a document: the app wakes them (through their own CLI) when there is something for them to do,
 * so several agents and the person can work on one doc together.
 *   gdocs subscribe report.md codex --role writer --brief "Write a one page plan for ..." --start
 *   gdocs subscribe report.md claude --role reviewer --brief "Review it and leave at most two comments"
 */
export function registerSubscribeCommands(program: Command, ctx: Ctx) {
  const abs = (f: string) => path.resolve(f)
  const need = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const r = await call(method, params)
    if (r === null) throw new Error('gauzzaDocs is not running. Subscribed agents are run by the app, so start it first.')
    return r as T
  }

  program
    .command('subscribe <file> <agent>')
    .description(
      'add an agent to a document: claude, codex, gemini or copilot. The app wakes it in the background (with its own CLI\n' +
        'and login) when someone comments, @mentions it, replies to it or, for reviewers and editors, edits the doc.'
    )
    .option('--name <name>', 'one-word name others @mention (default: Claude, Codex, Gemini or Copilot)')
    .option('--role <role>', 'writer, reviewer, editor or custom', 'custom')
    .option('--brief <text>', 'what you want from it ("-" for stdin, @file)')
    .option('--start', 'give it a turn right away (a writer starts writing)')
    .action(async (file: string, agent: string, o) => {
      const kind = agent.toLowerCase() as subs.AgentKind
      if (!subs.AGENT_LABELS[kind]) throw new Error('agent must be claude, codex, gemini or copilot')
      if (!['writer', 'reviewer', 'editor', 'custom'].includes(o.role)) throw new Error('--role must be writer, reviewer, editor or custom')
      const brief = o.brief !== undefined ? ctx.input(o.brief) : ''
      const sub = await need<subs.Subscription>('subscribe', { path: abs(file), agent_kind: kind, name: o.name, role: o.role, brief, start: !!o.start })
      ctx.out(sub, () => `${sub.name} (${subs.AGENT_LABELS[sub.agent]}, ${sub.role}) is on ${path.basename(sub.path)}${o.start ? ' and starting now' : ''}.`)
    })

  program
    .command('unsubscribe <file> <name>')
    .description('take an agent off a document (stops it if it is working)')
    .action(async (file: string, name: string) => {
      const r = await need<{ removed: string }>('unsubscribe', { path: abs(file), name })
      ctx.out(r, () => `${r.removed} left ${path.basename(file)}.`)
    })

  program
    .command('participants <file>')
    .description('agents on a document and what each is doing')
    .action(async (file: string) => {
      const r = ((await call('participants', { path: abs(file) })) ?? subs.listSubscriptions(abs(file))) as (subs.Subscription & { state?: string; pausedReason?: string })[]
      ctx.out(r, () =>
        r.length
          ? r.map(p => `${p.name.padEnd(10)} ${subs.AGENT_LABELS[p.agent].padEnd(20)} ${p.role.padEnd(9)} ${p.state || (p.paused ? 'paused' : 'idle')}${p.pausedReason ? `  (${p.pausedReason})` : ''}${p.brief ? `\n           ${p.brief.split('\n')[0].slice(0, 100)}` : ''}`).join('\n')
          : `No agents on ${path.basename(file)}. Add one: gdocs subscribe ${path.basename(file)} claude --role reviewer`)
    })

  program
    .command('wake <file> <name>')
    .description('give a subscribed agent a turn now (also resumes it if it was paused)')
    .option('--note <text>', 'what you want it to do this turn')
    .action(async (file: string, name: string, o) => {
      const r = await need<{ woke: string }>('wake', { path: abs(file), name, note: o.note })
      ctx.out(r, () => `${r.woke} is taking a turn.`)
    })
}
