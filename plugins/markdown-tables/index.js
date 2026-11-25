// Markdown tables: CSV/TSV <-> pipe tables.

function parseDelimited(text) {
  const sep = (text.split('\n')[0] || '').includes('\t') ? '\t' : ','
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) row.push(cell), (cell = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell), rows.push(row), (row = []), (cell = '')
    } else cell += c
  }
  if (cell || row.length) row.push(cell), rows.push(row)
  return rows.filter(r => r.some(x => x.trim()))
}

export function toMarkdownTable(text) {
  const rows = parseDelimited(text.trim())
  if (!rows.length) throw new Error('Nothing to convert: select CSV or TSV text first')
  const cols = Math.max(...rows.map(r => r.length))
  const cell = s => (s || '').trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const numeric = c => rows.slice(1).every(r => !r[c] || /^-?[\d,.]+%?$/.test(r[c].trim()))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map(r => cell(r[c]).length)))
  const line = r => '| ' + widths.map((w, c) => (numeric(c) ? cell(r[c]).padStart(w) : cell(r[c]).padEnd(w))).join(' | ') + ' |'
  const rule = '| ' + widths.map((w, c) => (numeric(c) ? '-'.repeat(w - 1) + ':' : '-'.repeat(w))).join(' | ') + ' |'
  return [line(rows[0]), rule, ...rows.slice(1).map(line)].join('\n') + '\n'
}

export function toCsv(md) {
  const rows = md
    .trim()
    .split('\n')
    .filter(l => /^\s*\|/.test(l))
    .map(l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')))
    .filter(r => !r.every(c => /^:?-+:?$/.test(c)))
  const q = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return rows.map(r => r.map(q).join(',')).join('\n') + '\n'
}

export function activate(api) {
  const run = (fn, what) => ({ editor, toast }) => {
    if (!editor) return toast('Open a file first')
    const sel = editor.getSelection()
    try {
      const out = fn(sel || editor.getText())
      sel ? editor.replaceSelection(out) : editor.setText(out)
      toast(what)
    } catch (e) {
      toast(e.message)
    }
  }
  api.registerCommand({ id: 'from-csv', title: 'Tables: CSV/TSV → Markdown table', run: run(toMarkdownTable, 'Converted to a Markdown table') })
  api.registerCommand({ id: 'to-csv', title: 'Tables: Markdown table → CSV', run: run(toCsv, 'Converted to CSV') })
  api.registerFormatter({
    id: 'tidy',
    name: 'Markdown: tidy all tables',
    languages: ['markdown'],
    format: text => text.replace(/((?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+)/gm, block => toMarkdownTable(toCsv(block)) + (block.endsWith('\n') ? '' : ''))
  })
}
