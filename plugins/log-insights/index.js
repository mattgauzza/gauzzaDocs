// Log insights: summarises a log. Only the first 200,000 lines are read so huge logs stay quick
// (files over 32 MB open in the large-file viewer, which does not run previews).

const LEVEL = /\b(FATAL|CRITICAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i
const TIME = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/
const norm = l => ({ err: 'ERROR', warning: 'WARN', critical: 'FATAL' })[l.toLowerCase()] || l.toUpperCase()
// Fold the parts that vary (numbers, hex ids, uuids, quoted values) so identical errors group together.
const shape = s =>
  s
    .replace(TIME, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, '"…"')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)

export function summarise(text) {
  const lines = text.split('\n', 200_000)
  const levels = {}
  const errors = new Map()
  let first = null
  let last = null
  for (const l of lines) {
    const m = l.match(LEVEL)
    const t = l.match(TIME)
    if (t) {
      first ??= t[1]
      last = t[1]
    }
    if (!m) continue
    const lv = norm(m[1])
    levels[lv] = (levels[lv] || 0) + 1
    if (lv === 'ERROR' || lv === 'FATAL' || lv === 'WARN') {
      const k = `${lv}|${shape(l.slice(m.index + m[0].length))}`
      const e = errors.get(k) || { level: lv, shape: k.split('|')[1], count: 0, example: l.trim().slice(0, 300) }
      e.count++
      errors.set(k, e)
    }
  }
  return { lines: lines.length, levels, top: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 25), first, last }
}

const COLORS = { FATAL: '#a50e0e', ERROR: '#c5221f', WARN: '#b06000', INFO: '#1967d2', DEBUG: '#5f6368', TRACE: '#80868b' }

export function activate(api) {
  api.registerPreview({
    id: 'summary',
    name: 'Log insights',
    languages: ['text', 'json'],
    render(text, el) {
      const s = summarise(text)
      const esc = api.escapeHtml
      const total = Object.values(s.levels).reduce((a, b) => a + b, 0)
      if (!total) {
        el.innerHTML = '<p style="color:var(--muted)">No log levels (ERROR, WARN, INFO…) found in this file.</p>'
        return
      }
      const order = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].filter(l => s.levels[l])
      el.innerHTML = `<style>
        .li { font: 13px/1.5 var(--font); } .li-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: 8px 0 4px; }
        .li-legend { display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 12px; } .li-legend b { color: var(--text); }
        .li table { width: 100%; border-collapse: collapse; margin-top: 14px; } .li td { padding: 6px 4px; border-top: 1px solid var(--line-soft); vertical-align: top; }
        .li code { font: 12px var(--mono); overflow-wrap: anywhere; } .li .n { text-align: right; font-weight: 600; white-space: nowrap; }
      </style>
      <div class="li">
        <div style="color:var(--muted)">${s.lines.toLocaleString()} lines${s.first ? ` · ${esc(s.first)} → ${esc(s.last)}` : ''}</div>
        <div class="li-bar">${order.map(l => `<i style="flex:${s.levels[l]};background:${COLORS[l]}"></i>`).join('')}</div>
        <div class="li-legend">${order.map(l => `<span><b style="color:${COLORS[l]}">${l}</b> ${s.levels[l].toLocaleString()}</span>`).join('')}</div>
        ${s.top.length ? `<table>${s.top.map(e => `<tr><td class="n" style="color:${COLORS[e.level]}">${e.count}×</td><td><code title="${esc(e.example)}">${esc(e.shape)}</code></td></tr>`).join('')}</table>` : ''}
      </div>`
    }
  })
}
