import { Marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/**
 * Markdown <-> HTML for documents. Isomorphic: the window, main and the CLI use the same rules.
 *
 * The HTML side is what the rich editor (TipTap) holds, so both directions are tuned to round-trip the Markdown
 * that AI tools write (GitHub style: front matter, `-` bullets, task lists, pipe tables, fenced code with a
 * language, `**bold**`, bare URLs) without churn: open + save leaves such a file as it was.
 */

// ---------- front matter ----------

const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** YAML front matter at the very top (`---` … `---`), and the rest. */
export function splitFrontMatter(md: string): { frontMatter: string | null; body: string } {
  const m = md.match(FRONT)
  return m ? { frontMatter: m[1], body: md.slice(m[0].length).replace(/^\r?\n/, '') } : { frontMatter: null, body: md }
}
export const joinFrontMatter = (frontMatter: string | null, body: string) =>
  frontMatter === null ? body : `---\n${frontMatter}\n---\n\n${body.replace(/^\n+/, '')}`

/** How front matter travels inside the editor's HTML: an opaque block the editor shows as "Properties". */
const frontMatterHtml = (yaml: string) => `<div data-front-matter=""><pre>${escapeHtml(yaml)}</pre></div>`

// ---------- Markdown -> HTML ----------

const md = new Marked({ gfm: true, async: false })

/** marked writes task items as `<li><input type="checkbox">…`; the editor's checklists expect data attributes. */
function taskLists(html: string) {
  return html
    .replace(/<li>(\s*<p>)?\s*<input (checked="" )?disabled="" type="checkbox">\s?/g, (_m, p: string | undefined, c: string | undefined) =>
      `<li data-type="taskItem" data-checked="${c ? 'true' : 'false'}">${p || ''}`)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1')
}

export function markdownToHtml(src: string): string {
  const { frontMatter, body } = splitFrontMatter(src.replace(/^﻿/, ''))
  const html = taskLists(md.parse(body) as string)
  return (frontMatter !== null ? frontMatterHtml(frontMatter) : '') + html
}

// ---------- HTML -> Markdown ----------

/** Turndown's escaping is cautious to the point of noise (every `_` in snake_case). Escape only what would change meaning. */
const ESCAPES: [RegExp, string][] = [
  [/\\/g, '\\\\'],
  [/\*/g, '\\*'],
  [/^-(?=\s)/g, '\\-'],
  [/^\+ /g, '\\+ '],
  [/^(=+)$/g, '\\$1'],
  [/^(#{1,6}) /g, '\\$1 '],
  [/`/g, '\\`'],
  [/^~~~/g, '\\~~~'],
  [/\[(?=[^\]]*\](?:\(|\[|:))/g, '\\['], // only where it would start a link

  [/^>/g, '\\>'],
  [/(^|[^\p{L}\p{N}_])_|_(?=[^\p{L}\p{N}_]|$)/gu, '$1\\_'],
  [/^(\d+)\. /g, '$1\\. ']
]
const escapeMarkdown = (s: string) => ESCAPES.reduce((acc, [re, rep]) => acc.replace(re, rep), s)

/** Tidies editor HTML into what turndown's GFM table rule recognises: no <colgroup>, no <p> inside cells. */
function forTurndown(html: string) {
  return html
    .replace(/<colgroup>[\s\S]*?<\/colgroup>/gi, '')
    .replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, t: string, a: string, inner: string) =>
      `<${t}${a}>${inner.replace(/<\/p>\s*<p[^>]*>/gi, '<br>').replace(/<\/?p[^>]*>/gi, '').trim()}</${t}>`)
}

export const PAGE_BREAK_MD = '<div style="page-break-after: always"></div>'

let td: TurndownService | null = null
function turndown() {
  if (td) return td
  td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
    // A page break is an empty div, and turndown drops empty elements before any rule sees them. Keep it as the raw
    // HTML that Markdown to PDF tools understand; marked passes it back through and the editor reads it as a break.
    blankReplacement: (_c, node) =>
      node.nodeName === 'DIV' && /page-break/.test(`${(node as HTMLElement).getAttribute('class')} ${(node as HTMLElement).getAttribute('style')}`)
        ? `\n\n${PAGE_BREAK_MD}\n\n`
        : (node as unknown as { isBlock: boolean }).isBlock ? '\n\n' : ''
  })
  td.use(gfm)
  ;(td as unknown as { escape: (s: string) => string }).escape = escapeMarkdown

  const listPrefix = (li: HTMLElement) => {
    const parent = li.parentNode as HTMLElement
    if (parent?.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start') || 1)
      return `${start + Array.prototype.indexOf.call(parent.children, li)}. `
    }
    return '- '
  }
  // Editors wrap item text in <p>, which turndown ends with blank lines; keep lists tight, and write "- item" / "1. item".
  const listBody = (content: string, indent: number) =>
    content.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n\n+/g, '\n').replace(/\n/g, '\n' + ' '.repeat(indent))
  td.addRule('tightListItem', {
    filter: 'li',
    replacement(content, node) {
      const li = node as HTMLElement
      const prefix = listPrefix(li)
      return prefix + listBody(content, prefix.length) + (li.nextSibling ? '\n' : '')
    }
  })
  // Checklist items (the editor's and marked's shapes): "- [x] text".
  td.addRule('taskItem', {
    filter: node => {
      if (node.nodeName !== 'LI') return false
      const li = node as HTMLElement
      if (li.getAttribute('data-type') === 'taskItem') return true
      const first = li.firstElementChild as HTMLElement | null
      const box = first?.nodeName === 'LABEL' ? (first.firstElementChild as HTMLElement | null) : first
      return box?.nodeName === 'INPUT' && box.getAttribute('type') === 'checkbox'
    },
    replacement(content, node) {
      const li = node as HTMLElement
      const box = li.querySelector('input[type=checkbox]') as HTMLInputElement | null
      const checked = li.getAttribute('data-checked') === 'true' || (!!box && box.hasAttribute('checked'))
      const body = listBody(content.replace(/^\s*\[[ xX]\]\s*/, ''), 2)
      return `- [${checked ? 'x' : ' '}] ${body}` + (li.nextSibling ? '\n' : '')
    }
  })
  td.addRule('checkboxInput', { filter: node => node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox', replacement: () => '' })
  td.addRule('strike', { filter: ['del', 's', 'strike'] as (keyof HTMLElementTagNameMap)[], replacement: c => `~~${c}~~` })
  // A link whose text is its address was a bare URL in the source (GFM autolinks it); keep it bare.
  td.addRule('bareLink', {
    filter: node => node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href') && (node as HTMLElement).getAttribute('href') === node.textContent && !(node as HTMLElement).getAttribute('title'),
    replacement: (_c, node) => (node as HTMLElement).getAttribute('href') || ''
  })
  td.addRule('frontMatter', {
    filter: node => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-front-matter'),
    replacement: (_c, node) => `\n\n---\n${(node.textContent || '').replace(/\n+$/, '')}\n---\n\n`
  })
  return td
}

export function htmlToMarkdown(html: string): string {
  return turndown().turndown(forTurndown(html)).replace(/^\s+/, '').trim() + '\n'
}

// ---------- plain text and helpers ----------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" }
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e) => (ENT[e] ?? (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1).replace(/^x/, '0x'))) : m)))

/** Plain text of an HTML fragment: one line per block. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|table)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Plain text -> paragraphs. */
export const textToHtml = (text: string) =>
  text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')

/** Content in any accepted format -> HTML. */
export function toHtml(content: string, format: string = 'md'): string {
  if (format === 'html') return content
  if (format === 'text') return textToHtml(content)
  return markdownToHtml(content)
}

/** The body of a full HTML document, or the fragment itself. */
export function bodyOf(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return (m ? m[1] : html).trim()
}

/**
 * What a page printed to PDF may load: what a data: URL page could load from our print HTML, so it's the same whether
 * the page is printed from a data: URL or from a file (a long one): embedded images, inline styles and embedded fonts.
 * Never a local file or anything from the network.
 */
export const PRINT_POLICY = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"

/** A page with PRINT_POLICY as the first thing in its head (or first of all, when it has no head). */
export function withPrintPolicy(page: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PRINT_POLICY}">`
  const head = /<head(\s[^>]*)?>/i.exec(page)
  return head ? page.slice(0, head.index + head[0].length) + meta + page.slice(head.index + head[0].length) : meta + page
}

/** Wraps an editor fragment in a standalone page that looks like the editor when opened in a browser. */
export function wrapHtml(body: string, title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="generator" content="gauzzaDocs">
<title>${escapeHtml(title)}</title>
<style>
body { max-width: 816px; margin: 40px auto; padding: 0 96px; font: 11pt/1.5 Arial, Helvetica, sans-serif; color: #202124; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4px 8px; }
img { max-width: 100%; } blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 16px; color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}
