// Parses CSV/TSV (quoted fields supported) for a table preview and a column-aligning formatter.
function parse(text) {
  const sep = (text.split('\n')[0] || '').includes('\t') ? '\t' : ','
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return { rows, sep }
}

export function activate(api) {
  api.registerPreview({
    id: 'table',
    name: 'CSV table',
    languages: ['csv'],
    render(text, el) {
      const { rows } = parse(text)
      const shown = rows.slice(0, 2000)
      const esc = api.escapeHtml
      el.innerHTML = `<style>.csvp{border-collapse:collapse;font-size:13px}.csvp td,.csvp th{border:1px solid var(--line);padding:3px 8px;white-space:nowrap}.csvp th{background:var(--toolbar);position:sticky;top:0}</style>
<p style="color:var(--muted);margin:0 0 8px">${rows.length} rows${rows.length > shown.length ? `, first ${shown.length} shown` : ''}</p>
<table class="csvp"><thead><tr>${(shown[0] || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${shown.slice(1).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    }
  })
  api.registerFormatter({
    id: 'align',
    name: 'CSV: align columns',
    languages: ['csv'],
    format(text) {
      const { rows, sep } = parse(text)
      const w = []
      rows.forEach(r => r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, c.length))))
      return rows.map(r => r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join(sep === '\t' ? '\t' : ', ')).join('\n') + '\n'
    }
  })
}
