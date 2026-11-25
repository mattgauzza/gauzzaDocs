/** CSV/TSV parse and write (RFC 4180 quoting). */
export function parseCsv(text: string, delim?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const d = delim ?? guessDelim(text)
  const rows: string[][] = []
  let row: string[] = [], field = '', q = false, i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        q = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { q = true; i++; continue }
    if (ch === d) { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch; i++
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function guessDelim(text: string) {
  const line = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : 2000)
  const tabs = line.split('\t').length, commas = line.split(',').length, semis = line.split(';').length
  return tabs > commas && tabs >= semis ? '\t' : semis > commas ? ';' : ','
}

export function writeCsv(rows: unknown[][], delim = ','): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return s.includes(delim) || /["\r\n]/.test(s) || (delim === ',' && /^\s|\s$/.test(s) && s.trim() !== s)
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  return rows.map(r => r.map(esc).join(delim)).join('\n') + (rows.length ? '\n' : '')
}
