import path from 'node:path'
import type { Command } from 'commander'
import * as store from '../core/comments'
import { readServer } from '../core/paths'
import { call } from './common'
import type { Ctx } from './common'

/**
 * The two-way channel between the person and an agent:
 *   gdocs listen <file>          stream the person's comments, replies and edits as they happen (--once: wait for one)
 *   gdocs comments <file>        the threads; gdocs comment / reply / resolve to answer
 * Comments go through the app when it is running (so they appear in its panel at once), else straight to the store.
 */
export function registerCommentCommands(program: Command, ctx: Ctx, agentName: () => string) {
  const abs = (f: string) => path.resolve(f)
  const via = async <T>(method: string, params: Record<string, unknown>, offline: () => T): Promise<T> => {
    const r = await call(method, { ...params, agent: { name: agentName() } })
    return r === null ? offline() : (r as T)
  }
  const show = (t: store.Thread) => {
    const lines = [`[${t.id}] ${t.author}${t.by === 'agent' ? ' (agent)' : ''}${t.resolved ? ' · resolved' : ''}${t.quote ? ` on "${clip(t.quote, 80)}"` : ''}`, `    ${t.text}`]
    for (const r of t.replies) lines.push(`    ↳ [${r.id}] ${r.author}${r.by === 'agent' ? ' (agent)' : ''}: ${r.text}`)
    return lines.join('\n')
  }

  program
    .command('comments <file>')
    .description('comment threads on a file (open ones; --all includes resolved)')
    .option('--all', 'include resolved threads')
    .option('--waiting', 'only threads whose last word is the person\'s (waiting for an answer)')
    .action(async (file: string, o) => {
      let ts = await via('comments', { path: abs(file), all: !!o.all }, () => store.list(abs(file), { all: !!o.all }))
      if (o.waiting) ts = ts.filter(waiting)
      ctx.out(ts, () => ts.map(show).join('\n\n') || '(no comments)')
    })

  program
    .command('comment <file> <text>')
    .description('start a comment thread as the agent ("-" reads the text from stdin)')
    .option('--quote <text>', 'the passage the comment is about')
    .action(async (file: string, text: string, o) => {
      const body = ctx.input(text)
      const t = await via('comment', { path: abs(file), text: body, quote: o.quote }, () =>
        store.add(abs(file), { text: body, quote: o.quote, author: agentName(), by: 'agent' }))
      ctx.out(t, () => `commented [${t.id}]`)
    })

  program
    .command('reply <file> <id> <text>')
    .description('reply to a comment thread as the agent ("-" reads the text from stdin)')
    .option('--resolve', 'and mark the thread resolved')
    .action(async (file: string, id: string, text: string, o) => {
      const body = ctx.input(text)
      const r = await via('reply', { path: abs(file), id, text: body }, () => store.reply(abs(file), id, { text: body, author: agentName(), by: 'agent' }))
      if (o.resolve) await via('resolve', { path: abs(file), id }, () => store.resolve(abs(file), id))
      ctx.out(r, () => `replied${o.resolve ? ' and resolved' : ''}`)
    })

  program
    .command('resolve <file> <id>')
    .description('mark a comment thread resolved (--reopen to undo)')
    .option('--reopen', 'reopen instead')
    .action(async (file: string, id: string, o) => {
      const t = await via('resolve', { path: abs(file), id, reopen: !!o.reopen }, () => store.resolve(abs(file), id, !o.reopen))
      ctx.out(t, () => (o.reopen ? 'reopened' : 'resolved'))
    })

  program
    .command('listen [file]')
    .description(
      'stream what the person does: their comments, replies, resolves and edits (yours are left out). Needs the app.\n' +
        'Starts by replaying open threads still waiting for an answer. --once returns after the first event,\n' +
        'which suits agents: listen --once, act on it, reply, listen again. The person sees that you are listening.'
    )
    .option('--once', 'exit after the first event')
    .option('--timeout <seconds>', 'give up after this long (exit code 2)')
    .option('--no-catch-up', 'do not replay threads already waiting for an answer')
    .option('--comments-only', 'leave out edits')
    .action(async (file: string | undefined, o) => {
      const s = readServer()
      if (!s || (await call('ping')) === null) throw new Error('gauzzaDocs is not running; start it to listen. (Comments still work: gdocs comments <file>)')
      const target = file ? abs(file) : undefined
      const print = (ev: Record<string, unknown>) => console.log(ctx.json() ? JSON.stringify(ev) : human(ev))
      let timer: NodeJS.Timeout | undefined
      if (o.timeout) {
        timer = setTimeout(() => {
          if (ctx.json()) console.log(JSON.stringify({ type: 'timeout' }))
          else console.error('(no activity)')
          process.exit(2)
        }, Number(o.timeout) * 1000)
      }

      if (o.catchUp !== false && target) {
        const pending = ((await call('comments', { path: target })) as store.Thread[]).filter(waiting)
        for (const t of pending) {
          print({ type: 'comment', path: target, by: 'user', author: lastAuthor(t), thread: t, waiting: true })
          if (o.once) return void (clearTimeout(timer), process.exit(0))
        }
      }

      const q = new URLSearchParams({ agent: agentName(), ...(target ? { path: target } : {}) })
      const res = await fetch(`http://127.0.0.1:${s.port}/events?${q}`, { headers: { authorization: `Bearer ${s.token}` } })
      if (!res.ok || !res.body) throw new Error(`Could not listen (HTTP ${res.status})`)
      if (!ctx.json() && process.stderr.isTTY) process.stderr.write(`listening${target ? ` to ${path.basename(target)}` : ''} as ${agentName()}…\n`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (!chunk.startsWith('data: ')) continue
          const ev = JSON.parse(chunk.slice(6)) as Record<string, unknown>
          if (ev.by !== 'user') continue // the agent's own actions and housekeeping events are not news to it
          if (o.commentsOnly && ev.type === 'edit') continue
          print(ev)
          if (o.once) {
            clearTimeout(timer)
            process.exit(0)
          }
        }
      }
    })
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const lastAuthor = (t: store.Thread) => (t.replies.length ? t.replies[t.replies.length - 1].author : t.author)
/** Open thread whose most recent message is the person's: an agent owes an answer. */
const waiting = (t: store.Thread) => !t.resolved && (t.replies.length ? t.replies[t.replies.length - 1].by : t.by) === 'user'

function human(ev: Record<string, unknown>): string {
  const file = typeof ev.path === 'string' ? path.basename(ev.path) : ''
  const t = ev.thread as store.Thread | undefined
  switch (ev.type) {
    case 'comment':
      return `${ev.waiting ? 'waiting' : 'comment'} [${t!.id}] ${ev.author} on ${file}${t!.quote ? ` about "${clip(t!.quote, 100)}"` : ''}:\n  ${t!.text}${
        t!.replies.length ? '\n' + t!.replies.map(r => `  ↳ ${r.author}: ${r.text}`).join('\n') : ''}\n  (answer: gdocs reply "${ev.path}" ${t!.id} "…")`
    case 'reply': {
      const r = ev.reply as store.Reply
      return `reply [${t!.id}] ${r.author} on ${file}${t!.quote ? ` (thread about "${clip(t!.quote, 60)}")` : ''}:\n  ${r.text}\n  (answer: gdocs reply "${ev.path}" ${t!.id} "…")`
    }
    case 'resolved':
      return `${ev.resolved ? 'resolved' : 'reopened'} [${t!.id}] by ${ev.author} on ${file}`
    case 'deleted':
      return `deleted thread [${ev.id}] on ${file}`
    case 'edit': {
      if (ev.summary) return `edit by the person on ${file}: ${ev.summary}`
      const rem = (ev.removed as string[]) || []
      const add = (ev.added as string[]) || []
      return [`edit by the person on ${file} at line ${ev.line}:`, ...rem.map(l => `  - ${l}`), ...add.map(l => `  + ${l}`), ...(ev.truncated ? ['  (more lines changed; gdocs read to see all)'] : [])].join('\n')
    }
    default:
      return `${ev.type} ${file}`
  }
}
