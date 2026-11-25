// CSS tools: format, minify, sort properties, and a color swatch preview.

// Strings and comments are swapped for placeholders so braces and semicolons inside them are left alone.
function protect(css) {
  const saved = []
  const out = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, m => `\u0000${saved.push(m) - 1}\u0000`)
  return { out, back: s => s.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[i]) }
}

export function formatCss(css, sort = false) {
  const { out, back } = protect(css)
  let depth = 0
  const lines = []
  let buf = ''
  const pad = () => '  '.repeat(depth)
  const props = []
  const flushProps = () => {
    const list = sort ? [...props].sort((a, b) => a.localeCompare(b)) : props
    for (const p of list) lines.push(pad() + p)
    props.length = 0
  }
  for (const ch of out) {
    if (ch === '{') {
      flushProps()
      lines.push(pad() + buf.trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ') + ' {')
      buf = ''
      depth++
    } else if (ch === '}') {
      if (buf.trim()) props.push(prop(buf))
      buf = ''
      flushProps()
      depth = Math.max(0, depth - 1)
      lines.push(pad() + '}')
      if (depth === 0) lines.push('')
    } else if (ch === ';') {
      if (buf.trim()) props.push(prop(buf))
      buf = ''
    } else buf += ch
  }
  if (buf.trim()) lines.push(buf.trim())
  return back(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()) + '\n'
}
const prop = s => {
  const t = s.trim()
  if (t.startsWith('\u0000')) return t // a comment on its own
  const i = t.indexOf(':')
  return i < 0 ? `${t};` : `${t.slice(0, i).trim()}: ${t.slice(i + 1).trim().replace(/\s+/g, ' ')};`
}

export function minifyCss(css) {
  const { out, back } = protect(css)
  return back(
    out
      .replace(/\u0000(\d+)\u0000/g, (m, i) => m) // keep strings; comments go below
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>~+])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim()
  ).replace(/\/\*[\s\S]*?\*\//g, '')
}

const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi

export function activate(api) {
  const langs = ['css', 'sass', 'less']
  api.registerFormatter({ id: 'pretty', name: 'CSS: format', languages: langs, format: t => formatCss(t) })
  api.registerFormatter({ id: 'sorted', name: 'CSS: format and sort properties', languages: langs, format: t => formatCss(t, true) })
  api.registerFormatter({ id: 'minify', name: 'CSS: minify', languages: ['css'], format: minifyCss })
  api.registerPreview({
    id: 'colors',
    name: 'Colors in this file',
    languages: [...langs, 'html'],
    render(text, el) {
      const counts = new Map()
      for (const m of text.matchAll(COLOR)) counts.set(m[0].toLowerCase(), (counts.get(m[0].toLowerCase()) || 0) + 1)
      const esc = api.escapeHtml
      el.innerHTML = counts.size
        ? `<style>.sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.sw div{border:1px solid var(--line);border-radius:8px;overflow:hidden;font:12px var(--mono)}.sw i{display:block;height:56px}.sw span{display:block;padding:6px 8px}</style>
           <p style="color:var(--muted)">${counts.size} colors</p>
           <div class="sw">${[...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<div><i style="background:${esc(c)}"></i><span>${esc(c)} ×${n}</span></div>`).join('')}</div>`
        : '<p style="color:var(--muted)">No colors found.</p>'
    }
  })
}
