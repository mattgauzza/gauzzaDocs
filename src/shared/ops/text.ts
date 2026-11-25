import type { AgentOp } from '../types'
import { OpError, type OpHandler, escapeRe, need, num, replaceIn, str } from './types'

/**
 * Ops on plain text / code files. Lines are 1-based and inclusive.
 *   read     { lines?: "10-20" }                 -> { content, lines }
 *   write    { content }
 *   append   { content }       prepend { content }
 *   insert   { line, content }                   insert before line N (N = lines+1 appends)
 *   replace  { find, with, all?, regex?, ignoreCase? } -> { count }
 *   replaceLines { from, to, content }           deleteLines { from, to }
 *   find     { query, regex?, ignoreCase? }      -> { matches: [{ line, col, text }] }
 *   info                                         -> { lines, chars }
 */
export function applyTextOp(text: string, op: AgentOp): { result: unknown; text?: string } {
  const lines = () => text.split('\n')
  const range = (from: number, to: number, n: number) => {
    if (from < 1 || to < from || from > n + 1) throw new OpError(`line range ${from}-${to} is outside 1-${n}`)
    return [from - 1, Math.min(to, n)] as const
  }
  switch (op.op) {
    case 'read': {
      const all = lines()
      const spec = str(op, 'lines')
      if (!spec) return { result: { content: text, lines: all.length } }
      const [a, b] = spec.split('-').map(Number)
      const [s, e] = range(a, b || a, all.length)
      return { result: { content: all.slice(s, e).join('\n'), from: s + 1, to: e, lines: all.length } }
    }
    case 'write':
      return { result: { ok: true }, text: need<string>(op, 'content') }
    case 'append': {
      const c = need<string>(op, 'content')
      return { result: { ok: true }, text: text === '' ? c : text.endsWith('\n') ? text + c : `${text}\n${c}` }
    }
    case 'prepend': {
      const c = need<string>(op, 'content')
      return { result: { ok: true }, text: c.endsWith('\n') || text === '' ? c + text : `${c}\n${text}` }
    }
    case 'insert': {
      const all = lines()
      const at = num(op, 'line', all.length + 1)!
      const [s] = range(at, at, all.length)
      all.splice(s, 0, ...need<string>(op, 'content').split('\n'))
      return { result: { ok: true }, text: all.join('\n') }
    }
    case 'replace': {
      const r = replaceIn(text, need<string>(op, 'find'), str(op, 'with'), { all: !!op.all, regex: !!op.regex, ignoreCase: !!op.ignoreCase })
      return { result: { count: r.count }, text: r.count ? r.text : undefined }
    }
    case 'replaceLines':
    case 'deleteLines': {
      const all = lines()
      const from = num(op, 'from')!
      const [s, e] = range(from, num(op, 'to', from)!, all.length)
      all.splice(s, e - s, ...(op.op === 'replaceLines' ? need<string>(op, 'content').split('\n') : []))
      return { result: { ok: true, removed: e - s }, text: all.join('\n') }
    }
    case 'find': {
      const q = need<string>(op, 'query')
      const re = new RegExp(op.regex ? q : escapeRe(q), op.ignoreCase ? 'gi' : 'g')
      const matches: { line: number; col: number; text: string }[] = []
      lines().forEach((l, i) => {
        for (const m of l.matchAll(re)) {
          matches.push({ line: i + 1, col: (m.index ?? 0) + 1, text: l })
          if (m[0] === '') break
        }
      })
      return { result: { matches } }
    }
    case 'info':
      return { result: { lines: lines().length, chars: text.length } }
    default:
      throw new OpError(`Unknown op "${op.op}" for text files. Try: read, write, append, prepend, insert, replace, replaceLines, deleteLines, find, info`)
  }
}

export const textOps: OpHandler = (payload, op) => {
  if (payload.kind !== 'text') throw new OpError('not a text file')
  const r = applyTextOp(payload.text, op)
  return { result: r.result, payload: r.text === undefined ? undefined : { ...payload, text: r.text } }
}
