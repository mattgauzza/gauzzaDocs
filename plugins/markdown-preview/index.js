// Markdown preview (rendered with the app's own markdown renderer) and a formatter that aligns pipe tables.
function alignTables(md) {
  return md.replace(/((?:^\|.*\|[ \t]*(?:\n|$))+)/gm, block => {
    const rows = block.trimEnd().split('\n').map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    const widths = rows[0].map((_, i) => Math.max(3, ...rows.map(r => (r[i] || '').length)))
    const isRule = c => /^:?-+:?$/.test(c || '')
    const fmt = r => '| ' + widths.map((w, i) => {
      const c = r[i] || ''
      if (!isRule(c)) return c.padEnd(w)
      return (c.startsWith(':') ? ':' : '-') + '-'.repeat(w - 2) + (c.endsWith(':') ? ':' : '-')
    }).join(' | ') + ' |'
    return rows.map(fmt).join('\n') + (block.endsWith('\n') ? '\n' : '')
  })
}

const CSS = `
.mdp { font: 15px/1.65 var(--font); max-width: 760px; }
.mdp h1, .mdp h2 { border-bottom: 1px solid var(--line-soft); padding-bottom: .3em; }
.mdp code { font-family: var(--mono); font-size: 13px; background: var(--toolbar); padding: 1px 5px; border-radius: 4px; }
.mdp pre { background: var(--toolbar); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
.mdp pre code { background: none; padding: 0; }
.mdp table { border-collapse: collapse; }
.mdp td, .mdp th { border: 1px solid var(--line); padding: 4px 10px; }
.mdp blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid var(--line); color: var(--muted); }
.mdp img { max-width: 100%; }`

export function activate(api) {
  api.registerPreview({
    id: 'preview',
    name: 'Markdown preview',
    languages: ['markdown'],
    render(text, el) {
      el.innerHTML = `<style>${CSS}</style><div class="mdp">${api.markdown.toHtml(text)}</div>`
      el.querySelectorAll('script, iframe, object').forEach(s => s.remove())
    }
  })
  api.registerFormatter({ id: 'tables', name: 'Markdown: align tables', languages: ['markdown'], format: alignTables })
}
