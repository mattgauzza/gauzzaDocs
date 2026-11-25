import { escapeHtml, htmlToMarkdown, htmlToText, toHtml } from '../convert'
import type { AgentOp } from '../types'
import { OpError, need, str } from './types'

/**
 * Pure helpers for documents held as an HTML string (the offline path; the live editor works on TipTap's model).
 * See src/shared/ops.md, "doc".
 */

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source', 'embed', 'param', 'track'])

/** Splits an HTML fragment into its top-level blocks (elements, or stray text runs). */
export function splitBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)[^>]*?(\/?)>/g
  let depth = 0
  let start = 0
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (s: string) => {
    if (s.trim()) blocks.push(s.trim())
  }
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue
    const name = (m[1] || '').toLowerCase()
    const closing = m[0][1] === '/'
    const selfClose = m[2] === '/' || VOID.has(name)
    if (depth === 0 && !closing) {
      pushText(html.slice(last, m.index))
      start = m.index
    }
    if (closing) depth = Math.max(0, depth - 1)
    else if (!selfClose) depth++
    if (depth === 0) {
      blocks.push(html.slice(start, re.lastIndex))
      last = re.lastIndex
    }
  }
  if (depth > 0) blocks.push(html.slice(start))
  else pushText(html.slice(last))
  return blocks
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" }
const decode = (s: string) =>
  s.replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1).replace(/^x/i, '0x'))) : m))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Find/replace that only touches text between tags, so markup and the formatting around a match survive.
 * A match must sit inside one text run (a phrase split by <b> in the middle is not found offline).
 */
export function replaceInHtml(html: string, find: string, withText: string, opts: { all?: boolean; regex?: boolean; ignoreCase?: boolean }) {
  const re = new RegExp(opts.regex ? find : escapeRe(find), 'g' + (opts.ignoreCase ? 'i' : ''))
  let count = 0
  const out = html.replace(/(<[^>]*>)|([^<]+)/g, (seg, tag, text) => {
    if (tag || (!opts.all && count > 0)) return seg
    const plain = decode(text)
    let changed = false
    const next = plain.replace(re, (...m) => {
      if (!opts.all && count > 0) return m[0]
      count++
      changed = true
      return opts.regex ? m[0].replace(new RegExp(re.source, opts.ignoreCase ? 'i' : ''), withText) : withText
    })
    return changed ? escapeHtml(next) : seg
  })
  return { html: out, count }
}

export interface Heading { level: number; text: string }

export function outlineOf(html: string): Heading[] {
  const out: Heading[] = []
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = htmlToText(m[2]).trim()
    if (text) out.push({ level: Number(m[1]), text })
  }
  return out
}

export function countWords(text: string) {
  const words = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
  return words ? words.length : 0
}

const fmtOf = (op: AgentOp) => {
  const f = str(op, 'format', 'md')
  if (!['md', 'html', 'text'].includes(f)) throw new OpError(`format must be md, html or text (got "${f}")`)
  return f
}

/** Applies a doc op to an HTML string. Returns the result and the new HTML if it changed. */
export function applyDocOp(html: string, op: AgentOp): { result: unknown; html?: string } {
  switch (op.op) {
    case 'read': {
      const f = str(op, 'format', 'md')
      if (f === 'html') return { result: { content: html } }
      if (f === 'text') return { result: { content: htmlToText(html) } }
      if (f === 'md') return { result: { content: htmlToMarkdown(html) } }
      throw new OpError(`format must be md, html or text (got "${f}")`)
    }
    case 'write':
      return { result: { ok: true }, html: toHtml(need<string>(op, 'content'), fmtOf(op)) || '<p></p>' }
    case 'append':
    case 'prepend': {
      const add = toHtml(need<string>(op, 'content'), fmtOf(op))
      const base = /^\s*(<p><\/p>)?\s*$/.test(html) ? '' : html
      return { result: { ok: true }, html: op.op === 'append' ? base + add : add + base }
    }
    case 'insert': {
      const after = str(op, 'after')
      const before = str(op, 'before')
      if (!after && !before) throw new OpError('"insert" needs after or before (text of the block to insert next to)')
      const target = (after || before).toLowerCase()
      const blocks = splitBlocks(html)
      const i = blocks.findIndex(b => htmlToText(b).toLowerCase().includes(target))
      if (i < 0) throw new OpError(`No block contains "${after || before}"`)
      blocks.splice(after ? i + 1 : i, 0, toHtml(need<string>(op, 'content'), fmtOf(op)).trim())
      return { result: { ok: true, block: i + 1 }, html: blocks.join('\n') }
    }
    case 'replace': {
      const r = replaceInHtml(html, need<string>(op, 'find'), str(op, 'with'), { all: !!op.all, regex: !!op.regex, ignoreCase: !!op.ignoreCase })
      return { result: { count: r.count }, html: r.count ? r.html : undefined }
    }
    case 'find': {
      const q = need<string>(op, 'query')
      const ci = !!op.ignoreCase
      const matches = splitBlocks(html)
        .map((b, i) => ({ block: i + 1, text: htmlToText(b) }))
        .filter(b => (ci ? b.text.toLowerCase().includes(q.toLowerCase()) : b.text.includes(q)))
      return { result: { matches } }
    }
    case 'outline':
      return { result: { headings: outlineOf(html) } }
    case 'info': {
      const text = htmlToText(html)
      return { result: { words: countWords(text), chars: text.length, blocks: splitBlocks(html).length, headings: outlineOf(html).length } }
    }
    default:
      throw new OpError(`Unknown op "${op.op}" for documents. Try: read, write, append, prepend, insert, replace, find, outline, info`)
  }
}
