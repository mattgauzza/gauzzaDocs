import hljs from 'highlight.js/lib/common'
import { Marked, type Token } from 'marked'
import { escapeHtml, splitFrontMatter } from '../../../shared/convert'

/**
 * Markdown for reading (Reading mode, and the preview half of Split): GitHub-style rendering straight from the
 * source, so nothing the rich editor cannot represent is lost from view. Each top-level block carries the source
 * line it starts on (data-line) so the preview can follow the source as it scrolls.
 */
const md = new Marked({ gfm: true, async: false })

/** GitHub's heading anchors: lower-case, punctuation dropped, spaces to dashes, repeats numbered. */
export function slugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section'
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

/** Front matter as a small table: top-level `key: value` lines; anything nested stays with its key as written. */
export function propertiesHtml(yaml: string, open = false) {
  const rows: [string, string][] = []
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-][^:]*):\s?(.*)$/)
    if (m && !/^\s/.test(line)) rows.push([m[1].trim(), m[2]])
    else if (rows.length && line.trim()) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? '\n' : '') + line
  }
  const value = (v: string) => {
    const t = v.trim().replace(/^["']|["']$/g, '')
    const list = t.match(/^\[(.*)\]$/)
    if (list) return list[1].split(',').map(x => `<span class="md-chip">${escapeHtml(x.trim().replace(/^["']|["']$/g, ''))}</span>`).join(' ')
    return v.includes('\n') ? `<pre>${escapeHtml(v)}</pre>` : escapeHtml(t)
  }
  const body = rows.length
    ? `<table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${value(v)}</td></tr>`).join('')}</table>`
    : `<pre>${escapeHtml(yaml)}</pre>`
  return `<details class="md-props"${open ? ' open' : ''}><summary>Properties <span>${rows.length || ''}</span></summary>${body}</details>`
}

// SVG animation elements can rewrite an href after cleaning (<animate attributeName="href" values="javascript:...">);
// SVG element names are case-sensitive, so the camelCase ones are listed as written.
const DROP = 'script,iframe,object,embed,style,link,meta,base,form,frame,frameset,animate,set,animateMotion,animateTransform,discard'
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background'])
/**
 * Markdown may carry raw HTML; keep the formatting, drop anything that could run or load code. (The window's
 * Content-Security-Policy also blocks inline scripts and javascript: links; this is the first line.)
 */
function sanitize(root: HTMLElement) {
  root.querySelectorAll(DROP).forEach(el => el.remove())
  root.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase()
      // Browsers ignore tabs, newlines and control characters inside a URL scheme ("java\tscript:").
      const v = a.value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(a.name)
      else if (URL_ATTRS.has(name) && (/^(javascript|vbscript):/.test(v) || (v.startsWith('data:') && !(name === 'src' && v.startsWith('data:image/')))))
        el.removeAttribute(a.name)
      // <use> may only point inside this document.
      else if (el.localName === 'use' && (name === 'href' || name === 'xlink:href') && !v.startsWith('#')) el.removeAttribute(a.name)
    }
  })
}

export function highlight(code: string, lang: string | undefined) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch { /* fall through */ }
  return escapeHtml(code)
}

/** Source -> safe HTML for reading. */
export function renderMarkdown(src: string): string {
  const { frontMatter, body } = splitFrontMatter(src)
  let line = (src.slice(0, src.length - body.length).match(/\n/g) || []).length
  const tokens = md.lexer(body)
  const parts: string[] = []
  if (frontMatter !== null) parts.push(`<div class="md-block" data-line="0">${propertiesHtml(frontMatter)}</div>`)
  for (const t of tokens as Token[]) {
    if (t.type !== 'space') {
      const list = Object.assign([t], { links: tokens.links }) as unknown as Parameters<typeof md.parser>[0]
      parts.push(`<div class="md-block" data-line="${line}">${md.parser(list)}</div>`)
    }
    line += (t.raw.match(/\n/g) || []).length
  }
  const doc = new DOMParser().parseFromString(`<div>${parts.join('')}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement
  sanitize(root)
  const slug = slugger()
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    h.id = slug(h.textContent || '')
    const a = doc.createElement('a')
    a.className = 'md-anchor'
    a.href = `#${h.id}`
    a.textContent = '#'
    a.setAttribute('aria-hidden', 'true')
    h.prepend(a)
  })
  root.querySelectorAll('pre > code').forEach(code => {
    const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1]
    code.innerHTML = highlight(code.textContent || '', lang)
    code.classList.add('hljs')
    if (lang) code.parentElement!.setAttribute('data-lang', lang)
  })
  root.querySelectorAll('a[href]').forEach(a => {
    if (!a.getAttribute('href')!.startsWith('#')) a.setAttribute('rel', 'noreferrer')
  })
  return root.innerHTML
}
