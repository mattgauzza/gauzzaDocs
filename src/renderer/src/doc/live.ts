import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { htmlToMarkdown, toHtml } from '../../../shared/convert'
import { countWords } from '../../../shared/ops/doc'
import type { AgentOp } from '../../../shared/types'
import { flashKey } from './extensions'

/**
 * Text search over the live document. Inside a textblock every character and every inline leaf (image, hard break)
 * takes one document position, so a match at string index i in block text starts at blockPos + 1 + i.
 */
export function searchDoc(doc: PMNode, query: string, opts: { regex?: boolean; ignoreCase?: boolean } = {}): [number, number][] {
  if (!query) return []
  let re: RegExp
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (opts.ignoreCase ? 'i' : ''))
  } catch {
    return []
  }
  const out: [number, number][] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    node.forEach(child => {
      text += child.isText ? child.text! : '￼'.repeat(child.nodeSize)
    })
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue
      out.push([pos + 1 + m.index!, pos + 1 + m.index! + m[0].length])
    }
    return false
  })
  return out
}

/** Replaces ranges back to front in one transaction; inserted text takes the marks at the match start. */
export function replaceRanges(editor: Editor, ranges: [number, number][], withText: (matched: string) => string) {
  if (!ranges.length) return
  const tr = editor.state.tr
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) {
    const matched = editor.state.doc.textBetween(a, b)
    const marks = editor.state.doc.resolve(a + 1 > b ? a : a + 1).marks()
    const text = withText(matched)
    if (text) tr.replaceWith(a, b, editor.schema.text(text, marks))
    else tr.delete(a, b)
  }
  editor.view.dispatch(tr)
}

/** Flashes the blocks in [from, to] and scrolls the first into view. */
export function flash(editor: Editor, from: number, to: number) {
  const { view } = editor
  view.dispatch(view.state.tr.setMeta(flashKey, { from, to }).setMeta('addToHistory', false))
  try {
    const dom = view.domAtPos(Math.min(from + 1, view.state.doc.content.size)).node as HTMLElement
    const el = dom.nodeType === 1 ? dom : dom.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch { /* position outside the view */ }
  setTimeout(() => {
    if (!editor.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false))
  }, 1700)
}

const topBlocks = (doc: PMNode) => {
  const out: { node: PMNode; pos: number }[] = []
  doc.forEach((node, pos) => out.push({ node, pos }))
  return out
}

export function outline(doc: PMNode) {
  const out: { level: number; text: string; pos: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      if (node.textContent.trim()) out.push({ level: node.attrs.level, text: node.textContent.trim(), pos })
      return false
    }
    return !node.isTextblock
  })
  return out
}

const fmt = (op: AgentOp, fallback = 'md') => {
  const f = typeof op.format === 'string' ? op.format : fallback
  if (!['md', 'html', 'text'].includes(f)) throw new Error(`format must be md, html or text (got "${f}")`)
  return f
}
const content = (op: AgentOp) => {
  if (typeof op.content !== 'string') throw new Error(`"${op.op}" needs content (string)`)
  return toHtml(op.content, fmt(op)).trim()
}

/** Inserts HTML at pos and flashes what was added. */
function insertAt(editor: Editor, pos: number, html: string) {
  const before = editor.state.doc.content.size
  editor.chain().insertContentAt(pos, html, { updateSelection: false }).run()
  const added = editor.state.doc.content.size - before
  flash(editor, pos, pos + Math.max(1, added))
}

/** Agent ops on the live editor; same contract as the offline ops in src/shared/ops/doc.ts. */
export function runDocOp(editor: Editor, op: AgentOp): unknown {
  const doc = editor.state.doc
  switch (op.op) {
    case 'read': {
      const f = fmt(op)
      const html = editor.getHTML()
      if (f === 'html') return { content: html }
      if (f === 'text') return { content: editor.getText({ blockSeparator: '\n\n' }) }
      return { content: htmlToMarkdown(html) }
    }
    case 'write': {
      editor.chain().setContent(content(op) || '<p></p>', { emitUpdate: true }).run()
      flash(editor, 0, editor.state.doc.content.size)
      return { ok: true }
    }
    case 'append':
    case 'prepend': {
      const html = content(op)
      const empty = doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0
      if (empty) {
        editor.chain().setContent(html, { emitUpdate: true }).run()
        flash(editor, 0, editor.state.doc.content.size)
      } else insertAt(editor, op.op === 'append' ? doc.content.size : 0, html)
      return { ok: true }
    }
    case 'insert': {
      const after = typeof op.after === 'string' ? op.after : ''
      const before = typeof op.before === 'string' ? op.before : ''
      if (!after && !before) throw new Error('"insert" needs after or before (text of the block to insert next to)')
      const target = (after || before).toLowerCase()
      const blocks = topBlocks(doc)
      const i = blocks.findIndex(b => b.node.textContent.toLowerCase().includes(target))
      if (i < 0) throw new Error(`No block contains "${after || before}"`)
      const b = blocks[i]
      insertAt(editor, after ? b.pos + b.node.nodeSize : b.pos, content(op))
      return { ok: true, block: i + 1 }
    }
    case 'replace': {
      if (typeof op.find !== 'string') throw new Error('"replace" needs find (string)')
      const withText = typeof op.with === 'string' ? op.with : ''
      let ranges = searchDoc(doc, op.find, { regex: !!op.regex, ignoreCase: !!op.ignoreCase })
      if (!op.all) ranges = ranges.slice(0, 1)
      const single = op.regex ? new RegExp(op.find, op.ignoreCase ? 'i' : '') : null
      replaceRanges(editor, ranges, m => (single ? m.replace(single, withText) : withText))
      if (ranges.length) {
        const first = editor.state.doc.content.size >= ranges[0][0] ? ranges[0][0] : 0
        flash(editor, first, first + withText.length)
      }
      return { count: ranges.length }
    }
    case 'find': {
      if (typeof op.query !== 'string') throw new Error('"find" needs query (string)')
      const q = op.ignoreCase ? op.query.toLowerCase() : op.query
      return {
        matches: topBlocks(doc)
          .map((b, i) => ({ block: i + 1, text: b.node.textContent }))
          .filter(b => (op.ignoreCase ? b.text.toLowerCase() : b.text).includes(q))
      }
    }
    case 'outline':
      return { headings: outline(doc).map(({ level, text }) => ({ level, text })) }
    case 'info': {
      const text = editor.getText({ blockSeparator: '\n' })
      return { words: countWords(text), chars: text.length, blocks: doc.childCount, headings: outline(doc).length }
    }
    default:
      throw new Error(`Unknown op "${op.op}" for documents. Try: read, write, append, prepend, insert, replace, find, outline, info`)
  }
}
