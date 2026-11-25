import type { Cell, Workbook } from '../types'
import { colIndex, colName, usedSize } from './address'
import { formatNumber, serialToDate, ymdSerial } from './format'

/**
 * Formula engine: tokenizer -> Pratt parser -> evaluator, plus whole-workbook recalculation.
 * Formulas are stored without the leading "=". Errors are values (FErr), as in spreadsheets.
 */

export class FErr {
  constructor(public code: string) {}
  toString() { return this.code }
}
export const ERR = {
  div0: new FErr('#DIV/0!'), ref: new FErr('#REF!'), name: new FErr('#NAME?'), value: new FErr('#VALUE!'),
  circ: new FErr('#CIRC!'), na: new FErr('#N/A'), num: new FErr('#NUM!'), err: new FErr('#ERROR!')
}
export type V = number | string | boolean | null | FErr
interface RangeV { rows: V[][] }
type Arg = V | RangeV
const isRange = (a: unknown): a is RangeV => !!a && typeof a === 'object' && 'rows' in (a as object)

// ---------------- tokenizer ----------------

export interface RefTok {
  sheet?: string
  // each end: col/row may be undefined for whole-row / whole-column ranges; abs flags for $
  a: { c?: number; r?: number; ac: boolean; ar: boolean }
  b?: { c?: number; r?: number; ac: boolean; ar: boolean }
}
export type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'err'; v: string; s: number; e: number }
  | { t: 'ref'; ref: RefTok; s: number; e: number }
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'func'; v: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }

const SHEET = `(?:'((?:[^']|'')+)'|([A-Za-z_][\\w.]*))!`
const CELLP = `(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})`
const RE_CELLRANGE = new RegExp(`^(?:${SHEET})?${CELLP}(?::${CELLP})?(?![\\w(])`)
const RE_COLRANGE = new RegExp(`^(?:${SHEET})?(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})(?![\\w(])`)
const RE_ROWRANGE = new RegExp(`^(?:${SHEET})?(\\$?)(\\d{1,7}):(\\$?)(\\d{1,7})(?![\\w(])`)
const ERRORS = ['#DIV/0!', '#REF!', '#NAME?', '#VALUE!', '#CIRC!', '#N/A', '#NUM!', '#NULL!', '#ERROR!']

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    const rest = src.slice(i)
    const prev = out[out.length - 1]
    // A ref may follow an operator/paren/comma/start only (not right after a number etc.).
    const canRef = !prev || prev.t === 'op' && prev.v !== ')' || prev.t === 'func'
    if (canRef) {
      let m = rest.match(RE_CELLRANGE)
      if (m) {
        const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2]
        const a = { c: colIndex(m[4]), r: Number(m[6]) - 1, ac: !!m[3], ar: !!m[5] }
        const b = m[8] ? { c: colIndex(m[8]), r: Number(m[10]) - 1, ac: !!m[7], ar: !!m[9] } : undefined
        out.push({ t: 'ref', ref: { sheet, a, b }, s: i, e: i + m[0].length })
        i += m[0].length
        continue
      }
      m = rest.match(RE_COLRANGE)
      if (m && !/^(TRUE|FALSE)$/i.test(m[4])) {
        const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2]
        out.push({ t: 'ref', ref: { sheet, a: { c: colIndex(m[4]), ac: !!m[3], ar: false }, b: { c: colIndex(m[6]), ac: !!m[5], ar: false } }, s: i, e: i + m[0].length })
        i += m[0].length
        continue
      }
      m = rest.match(RE_ROWRANGE)
      if (m) {
        const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2]
        out.push({ t: 'ref', ref: { sheet, a: { r: +m[4] - 1, ac: false, ar: !!m[3] }, b: { r: +m[6] - 1, ac: false, ar: !!m[5] } }, s: i, e: i + m[0].length })
        i += m[0].length
        continue
      }
    }
    let m = rest.match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i)
    if (m) { out.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length }); i += m[0].length; continue }
    if (ch === '"') {
      let j = i + 1, v = ''
      for (; j < src.length; j++) {
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j++; continue } break }
        v += src[j]
      }
      out.push({ t: 'str', v, s: i, e: j + 1 })
      i = j + 1
      continue
    }
    if (ch === '#') {
      const e = ERRORS.find(x => rest.toUpperCase().startsWith(x))
      if (e) { out.push({ t: 'err', v: e, s: i, e: i + e.length }); i += e.length; continue }
    }
    m = rest.match(/^[A-Za-z_][\w.]*/)
    if (m) {
      const after = src.slice(i + m[0].length).match(/^\s*\(/)
      out.push({ t: after ? 'func' : 'name', v: m[0].toUpperCase(), s: i, e: i + m[0].length })
      i += m[0].length
      if (after) i += after[0].length
      continue
    }
    m = rest.match(/^(<>|<=|>=|[-+*/^&=<>%(),;:{}])/)
    if (m) { out.push({ t: 'op', v: m[0] === ';' ? ',' : m[0], s: i, e: i + 1 + (m[0].length - 1) }); i += m[0].length; continue }
    throw new Error(`Unexpected "${ch}"`)
  }
  return out
}

// ---------------- parser ----------------

export type Node =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'bool'; v: boolean } | { t: 'err'; v: string }
  | { t: 'ref'; ref: RefTok }
  | { t: 'name'; v: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }

const BIN: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }

export function parse(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`)
    p++
  }
  function primary(): Node {
    const t = toks[p++]
    if (!t) throw new Error('Unexpected end of formula')
    switch (t.t) {
      case 'num': return { t: 'num', v: t.v }
      case 'str': return { t: 'str', v: t.v }
      case 'err': return { t: 'err', v: t.v }
      case 'ref': return { t: 'ref', ref: t.ref }
      case 'name':
        if (t.v === 'TRUE' || t.v === 'FALSE') return { t: 'bool', v: t.v === 'TRUE' }
        return { t: 'name', v: t.v }
      case 'func': {
        const args: Node[] = []
        if (isOp(')')) { p++; return { t: 'call', fn: t.v, args } }
        for (;;) {
          args.push(isOp(',') || isOp(')') ? { t: 'str', v: '' } : expr(0))
          if (isOp(',')) { p++; continue }
          expect(')')
          break
        }
        return { t: 'call', fn: t.v, args }
      }
      case 'op':
        if (t.v === '(') { const e = expr(0); expect(')'); return e }
        if (t.v === '-' || t.v === '+') return { t: 'un', op: t.v, a: unary() }
    }
    throw new Error(`Unexpected "${src.slice(t.s, t.e)}"`)
  }
  function unary(): Node {
    let n = primary()
    while (isOp('%')) { p++; n = { t: 'pct', a: n } }
    return n
  }
  function expr(minPrec: number): Node {
    let left = unary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op' || !(t.v in BIN)) break
      const prec = BIN[t.v]
      if (prec < minPrec) break
      p++
      const right = expr(prec + 1)
      left = { t: 'bin', op: t.v, a: left, b: right }
    }
    return left
  }
  const tree = expr(0)
  if (p < toks.length) throw new Error(`Unexpected "${src.slice(toks[p].s, toks[p].e)}"`)
  return tree
}

// ---------------- evaluation ----------------

export interface EvalCtx {
  /** Value of a cell, evaluating its formula if needed. */
  cell(sheet: number, r: number, c: number): V
  sheetIndex(name: string | undefined): number // -1 when unknown
  size(sheet: number): { rows: number; cols: number }
  sheet: number // the sheet the formula lives on
}

function rangeOf(ref: RefTok, ctx: EvalCtx): RangeV | V {
  const si = ctx.sheetIndex(ref.sheet)
  if (si < 0) return ERR.ref
  const size = ctx.size(si)
  const a = ref.a, b = ref.b
  if (!b) return ctx.cell(si, a.r!, a.c!)
  const r1 = a.r ?? 0, c1 = a.c ?? 0
  let r2 = b.r ?? Math.max(size.rows - 1, 0), c2 = b.c ?? Math.max(size.cols - 1, 0)
  // clip whole-column/whole-row and oversized ranges to the used area
  if (b.r === undefined) r2 = Math.max(size.rows - 1, 0)
  const lo = [Math.min(r1, r2), Math.min(c1, c2)], hi = [Math.max(r1, r2), Math.max(c1, c2)]
  const rows: V[][] = []
  const rEnd = Math.min(hi[0], Math.max(lo[0], size.rows - 1) + 0)
  const cEnd = Math.min(hi[1], Math.max(lo[1], size.cols - 1))
  // keep the declared shape for small ranges (lookups care), clip only beyond the used area
  const rr = hi[0] - lo[0] < 5000 ? hi[0] : rEnd
  const cc = hi[1] - lo[1] < 500 ? hi[1] : cEnd
  for (let r = lo[0]; r <= rr; r++) {
    const row: V[] = []
    for (let c = lo[1]; c <= cc; c++) row.push(ctx.cell(si, r, c))
    rows.push(row)
  }
  return { rows }
}

const toNum = (v: V): number => {
  if (v instanceof FErr) throw v
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const s = v.trim().replace(/,/g, '')
  const pct = s.endsWith('%')
  const n = Number(pct ? s.slice(0, -1) : s.replace(/^\$/, ''))
  if (s === '' || Number.isNaN(n)) throw ERR.value
  return pct ? n / 100 : n
}
const toStr = (v: V): string => {
  if (v instanceof FErr) throw v
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatNumber(v)
  return v
}
const toBool = (v: V): boolean => {
  if (v instanceof FErr) throw v
  if (typeof v === 'string') {
    if (/^true$/i.test(v)) return true
    if (/^false$/i.test(v) || v === '') return false
    throw ERR.value
  }
  return !!v
}
const scalar = (a: Arg): V => (isRange(a) ? (a.rows[0]?.[0] ?? null) : a)
/** All values of the args, ranges flattened. */
const flat = (args: Arg[]): { v: V; fromRange: boolean }[] =>
  args.flatMap((a): { v: V; fromRange: boolean }[] => (isRange(a) ? a.rows.flat().map(v => ({ v, fromRange: true })) : [{ v: a, fromRange: false }]))
/** Numbers for SUM-like functions: ranges contribute only numbers, direct args are coerced. */
function nums(args: Arg[]): number[] {
  const out: number[] = []
  for (const { v, fromRange } of flat(args)) {
    if (v instanceof FErr) throw v
    if (fromRange) { if (typeof v === 'number') out.push(v) }
    else if (v != null) out.push(toNum(v))
  }
  return out
}

function compare(a: V, b: V): number {
  if (a instanceof FErr) throw a
  if (b instanceof FErr) throw b
  const rank = (v: V) => (v == null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3)
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'string') return a.toLowerCase().localeCompare((b as string).toLowerCase())
  return (a as number) - (b as number) > 0 ? 1 : (a as number) < (b as number) ? -1 : 0
}

/** COUNTIF-style criteria: 5, ">5", "<>x", "=x", "ab*", "?b". */
function criteria(crit: V): (v: V) => boolean {
  if (typeof crit === 'number' || typeof crit === 'boolean') return v => v === crit || (typeof v === 'string' && v !== '' && Number(v) === crit)
  const s = crit == null ? '' : String(crit)
  const m = s.match(/^(<>|<=|>=|=|<|>)?([\s\S]*)$/)!
  const op = m[1] || '=', rhs = m[2]
  const n = rhs.trim() !== '' && !Number.isNaN(Number(rhs)) ? Number(rhs) : null
  if (n !== null) {
    return v => {
      if (typeof v !== 'number') return op === '<>' ? true : false
      return op === '=' ? v === n : op === '<>' ? v !== n : op === '<' ? v < n : op === '>' ? v > n : op === '<=' ? v <= n : v >= n
    }
  }
  if (op === '=' || op === '<>') {
    const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*') + '$', 'i')
    const test = (v: V) => (rhs === '' ? v == null || v === '' : v != null && !(v instanceof FErr) && re.test(String(v)))
    return op === '=' ? test : v => !test(v)
  }
  return v => {
    if (typeof v !== 'string') return false
    const c = v.toLowerCase().localeCompare(rhs.toLowerCase())
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0
  }
}

const rows2 = (a: Arg): V[][] => (isRange(a) ? a.rows : [[a]])
const roundTo = (n: number, d: number, mode: 'round' | 'up' | 'down') => {
  const f = Math.pow(10, d)
  const x = Number((Math.abs(n) * f).toPrecision(15))
  const r = mode === 'round' ? Math.round(x) : mode === 'up' ? Math.ceil(x) : Math.floor(x)
  return (Math.sign(n) * r) / f
}
function median(xs: number[]) {
  if (!xs.length) throw ERR.num
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function lookupIndex(key: V, list: V[], mode: number): number {
  if (mode === 0) return list.findIndex(v => v != null && compare(v, key) === 0)
  let best = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i] == null) continue
    const c = compare(list[i], key)
    if (mode > 0 ? c <= 0 : c >= 0) best = i
    else if (mode > 0) break
  }
  return best
}

/** Text format for TEXT(): "0.00", "#,##0", "0%", "yyyy-mm-dd", "mm/dd/yyyy", "dddd"... */
function textFormat(n: number, fmt: string): string {
  if (/[ymdhs]/i.test(fmt.replace(/"[^"]*"/g, '')) && !/^[#0.,%$]+$/.test(fmt)) {
    const d = serialToDate(n)
    const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate(), h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds()
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const p2 = (x: number) => String(x).padStart(2, '0')
    let minuteCtx = false
    return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|"[^"]*"/gi, tok => {
      const t = tok.toLowerCase()
      if (tok.startsWith('"')) return tok.slice(1, -1)
      if (t === 'yyyy') return String(Y)
      if (t === 'yy') return p2(Y % 100)
      if (t === 'mmmm') return months[M - 1]
      if (t === 'mmm') return months[M - 1].slice(0, 3)
      if (t === 'mm' || t === 'm') { const v = minuteCtx ? mi : M; return t === 'mm' ? p2(v) : String(v) }
      if (t === 'dddd') return days[d.getUTCDay()]
      if (t === 'ddd') return days[d.getUTCDay()].slice(0, 3)
      if (t === 'dd') return p2(D)
      if (t === 'd') return String(D)
      if (t === 'hh' || t === 'h') { minuteCtx = true; const hh = /AM\/PM/i.test(fmt) ? ((h + 11) % 12) + 1 : h; return t === 'hh' ? p2(hh) : String(hh) }
      if (t === 'ss' || t === 's') return t === 'ss' ? p2(s) : String(s)
      if (t === 'am/pm') return h < 12 ? 'AM' : 'PM'
      return tok
    })
  }
  return formatNumber(n, fmt)
}

type Fn = (args: Arg[], ctx: EvalCtx) => V
const FNS: Record<string, Fn> = {
  SUM: a => nums(a).reduce((x, y) => x + y, 0),
  PRODUCT: a => nums(a).reduce((x, y) => x * y, 1),
  AVERAGE: a => { const n = nums(a); if (!n.length) throw ERR.div0; return n.reduce((x, y) => x + y, 0) / n.length },
  MIN: a => { const n = nums(a); return n.length ? Math.min(...n) : 0 },
  MAX: a => { const n = nums(a); return n.length ? Math.max(...n) : 0 },
  MEDIAN: a => median(nums(a)),
  COUNT: a => flat(a).filter(({ v, fromRange }) => typeof v === 'number' || (!fromRange && v != null && !(v instanceof FErr) && !Number.isNaN(Number(v)) && v !== '')).length,
  COUNTA: a => flat(a).filter(({ v }) => v != null && v !== '').length,
  COUNTBLANK: a => flat(a).filter(({ v }) => v == null || v === '').length,
  COUNTIF: ([r, c]) => { const t = criteria(scalar(c)); return rows2(r).flat().filter(t).length },
  SUMIF: ([r, c, s]) => {
    const t = criteria(scalar(c)), src = rows2(r), sum = s ? rows2(s) : src
    let tot = 0
    src.forEach((row, i) => row.forEach((v, j) => { const x = sum[i]?.[j]; if (t(v) && typeof x === 'number') tot += x }))
    return tot
  },
  AVERAGEIF: ([r, c, s]) => {
    const t = criteria(scalar(c)), src = rows2(r), sum = s ? rows2(s) : src
    let tot = 0, n = 0
    src.forEach((row, i) => row.forEach((v, j) => { const x = sum[i]?.[j]; if (t(v) && typeof x === 'number') { tot += x; n++ } }))
    if (!n) throw ERR.div0
    return tot / n
  },
  AND: a => { const v = flat(a).filter(x => x.v != null && x.v !== ''); if (!v.length) throw ERR.value; return v.every(x => toBool(x.v)) },
  OR: a => { const v = flat(a).filter(x => x.v != null && x.v !== ''); if (!v.length) throw ERR.value; return v.some(x => toBool(x.v)) },
  NOT: ([a]) => !toBool(scalar(a)),
  ROUND: ([n, d]) => roundTo(toNum(scalar(n)), d ? toNum(scalar(d)) : 0, 'round'),
  ROUNDUP: ([n, d]) => roundTo(toNum(scalar(n)), d ? toNum(scalar(d)) : 0, 'up'),
  ROUNDDOWN: ([n, d]) => roundTo(toNum(scalar(n)), d ? toNum(scalar(d)) : 0, 'down'),
  ABS: ([n]) => Math.abs(toNum(scalar(n))),
  INT: ([n]) => Math.floor(toNum(scalar(n))),
  MOD: ([n, d]) => { const a = toNum(scalar(n)), b = toNum(scalar(d)); if (b === 0) throw ERR.div0; return a - b * Math.floor(a / b) },
  POWER: ([n, p]) => Math.pow(toNum(scalar(n)), toNum(scalar(p))),
  SQRT: ([n]) => { const x = toNum(scalar(n)); if (x < 0) throw ERR.num; return Math.sqrt(x) },
  CONCAT: a => flat(a).map(x => toStr(x.v)).join(''),
  CONCATENATE: a => flat(a).map(x => toStr(x.v)).join(''),
  TEXTJOIN: ([d, skip, ...rest]) => {
    const sk = toBool(scalar(skip))
    return flat(rest).map(x => toStr(x.v)).filter(s => !sk || s !== '').join(toStr(scalar(d)))
  },
  LEN: ([s]) => toStr(scalar(s)).length,
  LEFT: ([s, n]) => toStr(scalar(s)).slice(0, n ? toNum(scalar(n)) : 1),
  RIGHT: ([s, n]) => { const t = toStr(scalar(s)), k = n ? toNum(scalar(n)) : 1; return k <= 0 ? '' : t.slice(-k) },
  MID: ([s, st, n]) => { const a = toNum(scalar(st)); if (a < 1) throw ERR.value; return toStr(scalar(s)).substr(a - 1, toNum(scalar(n))) },
  UPPER: ([s]) => toStr(scalar(s)).toUpperCase(),
  LOWER: ([s]) => toStr(scalar(s)).toLowerCase(),
  PROPER: ([s]) => toStr(scalar(s)).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, a, b) => a + b.toUpperCase()),
  TRIM: ([s]) => toStr(scalar(s)).trim().replace(/ {2,}/g, ' '),
  SUBSTITUTE: ([s, f, w, nth]) => {
    const t = toStr(scalar(s)), from = toStr(scalar(f)), to = toStr(scalar(w))
    if (!from) return t
    if (!nth) return t.split(from).join(to)
    const k = toNum(scalar(nth))
    let i = -1
    for (let n = 0; n < k; n++) { i = t.indexOf(from, i + 1); if (i < 0) return t }
    return t.slice(0, i) + to + t.slice(i + from.length)
  },
  FIND: ([f, s, st]) => { const i = toStr(scalar(s)).indexOf(toStr(scalar(f)), st ? toNum(scalar(st)) - 1 : 0); if (i < 0) throw ERR.value; return i + 1 },
  SEARCH: ([f, s, st]) => { const i = toStr(scalar(s)).toLowerCase().indexOf(toStr(scalar(f)).toLowerCase(), st ? toNum(scalar(st)) - 1 : 0); if (i < 0) throw ERR.value; return i + 1 },
  VLOOKUP: ([k, r, col, approx]) => {
    const rows = rows2(r), ci = toNum(scalar(col)) - 1
    if (ci < 0 || ci >= (rows[0]?.length ?? 0)) throw ERR.ref
    const exact = approx !== undefined && !toBool(scalar(approx))
    const i = lookupIndex(scalar(k), rows.map(x => x[0]), exact ? 0 : 1)
    if (i < 0) throw ERR.na
    return rows[i][ci]
  },
  HLOOKUP: ([k, r, row, approx]) => {
    const rows = rows2(r), ri = toNum(scalar(row)) - 1
    if (ri < 0 || ri >= rows.length) throw ERR.ref
    const exact = approx !== undefined && !toBool(scalar(approx))
    const i = lookupIndex(scalar(k), rows[0], exact ? 0 : 1)
    if (i < 0) throw ERR.na
    return rows[ri][i]
  },
  INDEX: ([r, row, col]) => {
    const rows = rows2(r)
    let ri = row ? toNum(scalar(row)) : 1, ci = col ? toNum(scalar(col)) : 1
    if (rows.length === 1 && !col) { ci = ri; ri = 1 }
    const v = rows[ri - 1]?.[ci - 1]
    if (v === undefined || ri < 1 || ci < 1) throw ERR.ref
    return v
  },
  MATCH: ([k, r, t]) => {
    const rows = rows2(r)
    const list = rows.length === 1 ? rows[0] : rows.map(x => x[0])
    const i = lookupIndex(scalar(k), list, t === undefined ? 1 : toNum(scalar(t)))
    if (i < 0) throw ERR.na
    return i + 1
  },
  XLOOKUP: ([k, l, ret, nf]) => {
    const lr = rows2(l), rr = rows2(ret)
    const vertical = lr.length > 1 || lr[0].length === 1
    const list = vertical ? lr.map(x => x[0]) : lr[0]
    const key = scalar(k)
    const i = list.findIndex(v => v != null && compare(v, key) === 0)
    if (i < 0) { if (nf !== undefined) return scalar(nf); throw ERR.na }
    return (vertical ? rr[i]?.[0] : rr[0]?.[i]) ?? null
  },
  TODAY: () => { const d = new Date(); return ymdSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) },
  NOW: () => { const d = new Date(); return ymdSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400 },
  DATE: ([y, m, d]) => ymdSerial(toNum(scalar(y)), toNum(scalar(m)), toNum(scalar(d))),
  YEAR: ([d]) => serialToDate(toNum(scalar(d))).getUTCFullYear(),
  MONTH: ([d]) => serialToDate(toNum(scalar(d))).getUTCMonth() + 1,
  DAY: ([d]) => serialToDate(toNum(scalar(d))).getUTCDate(),
  TEXT: ([v, f]) => { const x = scalar(v); return typeof x === 'number' || (typeof x === 'string' && !Number.isNaN(Number(x)) && x !== '') ? textFormat(toNum(x), toStr(scalar(f))) : toStr(x) },
  VALUE: ([v]) => toNum(scalar(v)),
  ISBLANK: ([v]) => { const x = scalar(v); return x == null || x === '' },
  ISNUMBER: ([v]) => typeof scalar(v) === 'number',
  ISTEXT: ([v]) => typeof scalar(v) === 'string',
  ISERROR: ([v]) => scalar(v) instanceof FErr,
  PI: () => Math.PI,
  RAND: () => Math.random(),
  N: ([v]) => { const x = scalar(v); return typeof x === 'number' ? x : typeof x === 'boolean' ? +x : 0 }
}
export const FUNCTION_NAMES = [...Object.keys(FNS), 'IF', 'IFERROR', 'IFNA', 'IFS'].sort()

function evalNode(n: Node, ctx: EvalCtx): Arg {
  switch (n.t) {
    case 'num': return n.v
    case 'str': return n.v
    case 'bool': return n.v
    case 'err': return new FErr(n.v)
    case 'name': return ERR.name
    case 'ref': return rangeOf(n.ref, ctx)
    case 'pct': {
      const v = scalar(evalNode(n.a, ctx))
      return v instanceof FErr ? v : toNum(v) / 100
    }
    case 'un': {
      const v = scalar(evalNode(n.a, ctx))
      if (v instanceof FErr) return v
      return n.op === '-' ? -toNum(v) : toNum(v)
    }
    case 'bin': {
      const a = scalar(evalNode(n.a, ctx)), b = scalar(evalNode(n.b, ctx))
      if (a instanceof FErr) return a
      if (b instanceof FErr) return b
      switch (n.op) {
        case '+': return toNum(a) + toNum(b)
        case '-': return toNum(a) - toNum(b)
        case '*': return toNum(a) * toNum(b)
        case '/': { const d = toNum(b); if (d === 0) return ERR.div0; return toNum(a) / d }
        case '^': return Math.pow(toNum(a), toNum(b))
        case '&': return toStr(a) + toStr(b)
        case '=': return compare(a, b) === 0
        case '<>': return compare(a, b) !== 0
        case '<': return compare(a, b) < 0
        case '>': return compare(a, b) > 0
        case '<=': return compare(a, b) <= 0
        case '>=': return compare(a, b) >= 0
      }
      return ERR.value
    }
    case 'call': {
      const fn = n.fn
      // lazy functions
      if (fn === 'IF') {
        const c = scalar(evalNode(n.args[0], ctx))
        if (c instanceof FErr) return c
        return toBool(c) ? (n.args[1] ? evalNode(n.args[1], ctx) : true) : n.args[2] ? evalNode(n.args[2], ctx) : false
      }
      if (fn === 'IFS') {
        for (let i = 0; i + 1 < n.args.length; i += 2) {
          const c = scalar(evalNode(n.args[i], ctx))
          if (c instanceof FErr) return c
          if (toBool(c)) return evalNode(n.args[i + 1], ctx)
        }
        return ERR.na
      }
      if (fn === 'IFERROR' || fn === 'IFNA') {
        let v: Arg
        try { v = evalNode(n.args[0], ctx) } catch (e) { v = e instanceof FErr ? e : ERR.value }
        const s = scalar(v)
        if (s instanceof FErr && (fn === 'IFERROR' || s.code === '#N/A')) return n.args[1] ? evalNode(n.args[1], ctx) : ''
        return v
      }
      const f = FNS[fn]
      if (!f) return ERR.name
      const args = n.args.map(a => evalNode(a, ctx))
      return f(args, ctx)
    }
  }
}

const astCache = new Map<string, Node | Error>()
export function parseCached(f: string): Node | Error {
  let n = astCache.get(f)
  if (!n) {
    try { n = parse(f) } catch (e) { n = e as Error }
    if (astCache.size > 20000) astCache.clear()
    astCache.set(f, n)
  }
  return n
}

export function evaluate(f: string, ctx: EvalCtx): V {
  const ast = parseCached(f)
  if (ast instanceof Error) return ERR.err
  try {
    const r = scalar(evalNode(ast, ctx))
    if (typeof r === 'number' && !Number.isFinite(r)) return ERR.num
    return r
  } catch (e) {
    if (e instanceof FErr) return e
    return ERR.value
  }
}

const LAZY = new Set(['IF', 'IFERROR', 'IFNA', 'IFS'])
export function hasUnknownFunction(f: string): boolean {
  const ast = parseCached(f)
  if (ast instanceof Error) return false
  const walk = (n: Node): boolean =>
    n.t === 'call' ? (!FNS[n.fn] && !LAZY.has(n.fn)) || n.args.some(walk) : n.t === 'bin' ? walk(n.a) || walk(n.b) : n.t === 'un' || n.t === 'pct' ? walk(n.a) : false
  return walk(ast)
}

// ---------------- workbook recalculation ----------------

const cellValue = (c: Cell | undefined): V => {
  const v = c?.v
  if (v === undefined) return null
  if (typeof v === 'string' && c?.f && v.startsWith('#') && /^#[A-Z/0!?]+[!?A]?$/.test(v)) return new FErr(v)
  return v
}

export interface Changed { sheet: number; range: { r1: number; c1: number; r2: number; c2: number } }

/** Ranges a formula reads (cached per formula text). Whole rows/columns become open-ended ranges. */
const refsCache = new Map<string, { sheet?: string; r1: number; c1: number; r2: number; c2: number }[]>()
function refsOf(f: string) {
  let r = refsCache.get(f)
  if (!r) {
    r = formulaRefs(f).map(x => ({ sheet: x.sheet, r1: Math.min(x.r1, x.r2), c1: Math.min(x.c1, x.c2), r2: Math.max(x.r1, x.r2), c2: Math.max(x.c1, x.c2) }))
    if (refsCache.size > 20000) refsCache.clear()
    refsCache.set(f, r)
  }
  return r
}

/**
 * Formula cells that must be re-evaluated after `changed`: the formulas inside the changed ranges, then
 * everything that reads them, transitively. Returns null when the change is too broad (recalculate everything).
 */
function downstream(wb: Workbook, changed: Changed[]): Set<string> | null {
  let area = 0
  for (const ch of changed) area += (ch.range.r2 - ch.range.r1 + 1) * (ch.range.c2 - ch.range.c1 + 1)
  if (area > 100_000) return null
  const byName = new Map(wb.sheets.map((s, i) => [s.name.toLowerCase(), i]))
  // index: cell key -> formula keys reading it (small ranges); big ranges checked linearly
  const index = new Map<string, string[]>()
  const big: { key: string; si: number; r1: number; c1: number; r2: number; c2: number }[] = []
  const pos = new Map<string, [number, number, number]>()
  wb.sheets.forEach((s, si) => {
    for (const a in s.cells) {
      const f = s.cells[a].f
      if (!f) continue
      const key = si + '!' + a
      const m = a.match(/^([A-Z]+)(\d+)$/)!
      pos.set(key, [si, Number(m[2]) - 1, colIndex(m[1])])
      for (const ref of refsOf(f)) {
        const ti = ref.sheet === undefined ? si : byName.get(ref.sheet.toLowerCase())
        if (ti === undefined) continue
        const n = (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1)
        if (n > 64) big.push({ key, si: ti, ...ref })
        else for (let r = ref.r1; r <= ref.r2; r++) for (let c = ref.c1; c <= ref.c2; c++) {
          const k = ti + '!' + colName(c) + (r + 1)
          const list = index.get(k)
          if (list) list.push(key)
          else index.set(k, [key])
        }
      }
    }
  })
  const dirty = new Set<string>()
  const queue: [number, number, number][] = []
  for (const ch of changed) {
    const g = ch.range
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
      queue.push([ch.sheet, r, c])
      const key = ch.sheet + '!' + colName(c) + (r + 1)
      if (pos.has(key)) dirty.add(key)
    }
  }
  while (queue.length) {
    const [si, r, c] = queue.pop()!
    const readers = [...(index.get(si + '!' + colName(c) + (r + 1)) || [])]
    for (const b of big) if (b.si === si && r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) readers.push(b.key)
    for (const k of readers) {
      if (dirty.has(k)) continue
      dirty.add(k)
      queue.push(pos.get(k)!)
    }
  }
  return dirty
}

/**
 * Recomputes formula cells. With `changed`, only formulas downstream of those ranges are re-evaluated (the rest
 * keep their stored results); without it, every formula is. Mutates `wb.sheets[i].cells` by REPLACING changed
 * cell objects (never mutating a Cell), so callers that copied the cells maps keep older snapshots intact.
 * Evaluation is demand-driven with memoization, so dependencies are always computed first; cycles yield #CIRC!.
 */
export function recalc(wb: Workbook, changed?: Changed[]): void {
  const dirty = changed ? downstream(wb, changed) : null
  if (dirty && dirty.size === 0) return
  const memo = new Map<string, V>()
  const visiting = new Set<string>()
  const sizes: ({ rows: number; cols: number } | undefined)[] = []
  const byName = new Map(wb.sheets.map((s, i) => [s.name.toLowerCase(), i]))

  const mk = (sheet: number): EvalCtx => ({
    sheet,
    cell: (si, r, c) => get(si, r, c),
    sheetIndex: name => (name === undefined ? sheet : byName.get(name.toLowerCase()) ?? -1),
    size: si => (sizes[si] ??= wb.sheets[si] ? usedSize(wb.sheets[si].cells) : { rows: 0, cols: 0 })
  })
  const ctxs = wb.sheets.map((_, i) => mk(i))

  function get(si: number, r: number, c: number): V {
    const sheet = wb.sheets[si]
    if (!sheet) return ERR.ref
    const a = colName(c) + (r + 1)
    const cell = sheet.cells[a]
    if (!cell?.f) return cellValue(cell)
    const key = si + '!' + a
    if (dirty && !dirty.has(key)) return cellValue(cell) // upstream of nothing that changed: stored result is current
    if (memo.has(key)) return memo.get(key)!
    if (visiting.has(key)) throw ERR.circ
    visiting.add(key)
    let v: V
    try {
      v = evaluate(cell.f, ctxs[si])
    } catch (e) {
      v = e instanceof FErr ? e : ERR.value
    }
    visiting.delete(key)
    memo.set(key, v)
    return v
  }

  const update = (si: number, a: string) => {
    const s = wb.sheets[si]
    const cell = s.cells[a]
    if (!cell?.f) return
    const m = a.match(/^([A-Z]+)(\d+)$/)!
    const v = get(si, Number(m[2]) - 1, colIndex(m[1]))
    // A function we do not implement keeps the result the file was saved with (e.g. from Excel).
    if (v instanceof FErr && v.code === '#NAME?' && cell.v !== undefined && cell.v !== '#NAME?' && hasUnknownFunction(cell.f)) return
    const out = v instanceof FErr ? v.code : v
    if (out !== cell.v) s.cells[a] = { ...cell, v: out }
  }
  if (dirty) for (const key of dirty) {
    const i = key.indexOf('!')
    update(Number(key.slice(0, i)), key.slice(i + 1))
  }
  else wb.sheets.forEach((s, si) => { for (const a in s.cells) if (s.cells[a].f) update(si, a) })
}

// ---------------- formula rewriting (fill, paste, insert/delete rows and columns) ----------------

function refText(ref: RefTok): string {
  const sh = ref.sheet === undefined ? '' : /^[A-Za-z_][\w.]*$/.test(ref.sheet) ? `${ref.sheet}!` : `'${ref.sheet.replace(/'/g, "''")}'!`
  const end = (e: RefTok['a']) => (e.c !== undefined ? (e.ac ? '$' : '') + colName(e.c) : '') + (e.r !== undefined ? (e.ar ? '$' : '') + (e.r + 1) : '')
  return sh + end(ref.a) + (ref.b ? ':' + end(ref.b) : '')
}

/** Rewrites every reference in a formula. `fn` returns the new ref, or null for a deleted target (#REF!). */
export function mapRefs(f: string, fn: (ref: RefTok) => RefTok | null): string {
  let toks: Tok[]
  try { toks = tokenize(f) } catch { return f }
  let out = '', last = 0
  for (const t of toks) {
    if (t.t !== 'ref') continue
    const n = fn(t.ref)
    out += f.slice(last, t.s) + (n ? refText(n) : '#REF!')
    last = t.e
  }
  return out + f.slice(last)
}

/** Shifts relative references by (dr, dc), as when copying a formula to another cell. */
export function shiftFormula(f: string, dr: number, dc: number): string {
  const sh = (e: RefTok['a']): RefTok['a'] | null => {
    const r = e.r === undefined || e.ar ? e.r : e.r + dr
    const c = e.c === undefined || e.ac ? e.c : e.c + dc
    if ((r !== undefined && r < 0) || (c !== undefined && c < 0)) return null
    return { ...e, r, c }
  }
  return mapRefs(f, ref => {
    const a = sh(ref.a), b = ref.b ? sh(ref.b) : undefined
    if (!a || b === null) return null
    return { ...ref, a, b }
  })
}

/** Cell refs used by a formula, for highlighting while editing. */
export function formulaRefs(f: string): { sheet?: string; r1: number; c1: number; r2: number; c2: number; s: number; e: number }[] {
  let toks: Tok[]
  try { toks = tokenize(f) } catch { return [] }
  return toks.flatMap(t => {
    if (t.t !== 'ref') return []
    const { a, b, sheet } = t.ref
    const e = b || a
    return [{ sheet, r1: a.r ?? 0, c1: a.c ?? 0, r2: e.r ?? 999999, c2: e.c ?? 16383, s: t.s, e: t.e }]
  })
}
