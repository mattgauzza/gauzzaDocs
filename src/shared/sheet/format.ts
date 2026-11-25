/** Display formatting for cell values (CellStyle.fmt) and parsing of typed-in values. */

const EPOCH = Date.UTC(1899, 11, 30)
export const serialToDate = (n: number) => new Date(EPOCH + Math.round(n * 86400000))
export const dateToSerial = (d: Date) => (d.getTime() - EPOCH) / 86400000
/** Serial for a local calendar date (no time zone drift). */
export const ymdSerial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - EPOCH) / 86400000

const pad = (n: number) => String(n).padStart(2, '0')
function fmtDate(n: number, withTime: boolean) {
  const d = serialToDate(n)
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
  return withTime ? `${date} ${d.getUTCHours()}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date
}

export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : n < 0 ? '-Infinity' : '#NUM!'
  if (n === 0) return '0'
  const a = Math.abs(n)
  if (a >= 1e15 || a < 1e-9) return n.toExponential(5).replace(/\.?0+e/, 'e')
  const s = Number(n.toPrecision(15)).toString()
  if (s.length <= 12) return s
  // trim to about 11 significant chars like spreadsheets do in narrow cells
  return Number(n.toPrecision(a >= 1 ? Math.max(11, Math.ceil(Math.log10(a)) + 1) : 10)).toString()
}

const isDateFmt = (f: string) => f === 'date' || f === 'datetime' || (/[dy]/i.test(f.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,$%]+$/.test(f))

/** Format a number with fmt like "0.00", "#,##0", "0%", "$#,##0.00", "date", "datetime" or an Excel numFmt. */
export function formatNumber(n: number, fmt?: string): string {
  if (!fmt || fmt === 'general' || fmt === 'General' || fmt === '@') return formatGeneral(n)
  if (fmt === 'date') return fmtDate(n, false)
  if (fmt === 'datetime') return fmtDate(n, true)
  if (isDateFmt(fmt)) return fmtDate(n, /h/i.test(fmt))
  const section = fmt.split(';')[n < 0 && fmt.includes(';') ? 1 : 0] || fmt.split(';')[0]
  const clean = section.replace(/\[[^\]]*\]/g, '').replace(/_./g, '').replace(/\\(.)/g, '$1')
  const pct = clean.includes('%')
  const thousands = /[#0],[#0]/.test(clean)
  const dm = clean.match(/\.([0#]+)/)
  const decimals = dm ? dm[1].length : 0
  const prefix = (clean.match(/^[^#0.,]*/)?.[0] || '').replace(/"/g, '').replace(/-/g, '')
  const suffix = (clean.match(/[^#0.,%]*%?[^#0.,]*$/)?.[0] || '').replace(/"/g, '').replace('%', '')
  let v = pct ? n * 100 : n
  const neg = v < 0 && !(n < 0 && fmt.includes(';'))
  v = Math.abs(v)
  let body = v.toFixed(decimals)
  if (thousands) {
    const [i, d] = body.split('.')
    body = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '')
  }
  return `${neg ? '-' : ''}${prefix}${body}${pct ? '%' : ''}${suffix}`
}

export function formatValue(v: unknown, fmt?: string): string {
  if (v == null) return ''
  if (typeof v === 'number') return formatNumber(v, fmt)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

/**
 * What a typed-in string means: number, percent, currency, boolean, date, or text.
 * Returns the value and a format suggestion for the cell when the input implies one.
 */
export function parseInput(text: string): { v: string | number | boolean | null; fmt?: string } {
  const s = text.trim()
  if (s === '') return { v: null }
  if (/^(true|false)$/i.test(s)) return { v: s.toLowerCase() === 'true' }
  let m = s.match(/^([-+]?)\$\s?([\d,]*\.?\d+)$/)
  if (m && /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d*\.?\d+$/.test(m[2])) return { v: Number(m[1] + m[2].replace(/,/g, '')), fmt: '$#,##0.00' }
  m = s.match(/^([-+]?\d*\.?\d+)\s?%$/)
  if (m) return { v: Number(m[1]) / 100, fmt: '0%' }
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { v: Number(s) }
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return { v: Number(s.replace(/,/g, '')), fmt: '#,##0' + (s.includes('.') ? '.00' : '') }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return { v: ymdSerial(+m[1], +m[2], +m[3]), fmt: 'date' }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m && +m[1] <= 12 && +m[2] <= 31) return { v: ymdSerial(+m[3], +m[1], +m[2]), fmt: 'date' }
  return { v: text }
}
