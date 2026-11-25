/**
 * Removes text-showing operators from a page content stream, so edited text is really gone from the PDF (copy, search
 * and text extraction no longer find it) instead of only being painted over.
 *
 * The stream is tokenized and replayed with just enough graphics/text state to know where each Tj / TJ / ' / "
 * starts (CTM through q/Q/cm, text matrix through BT/Tm/Td/TD/T and TL). An operator is removed when its starting
 * point falls inside one of the boxes (PDF user space). Everything else is copied byte for byte.
 *
 * Limits: text inside form XObjects is not touched (the cover rectangle still hides it); and because glyph widths are
 * not measured, a show operator that starts outside a box is kept even if it runs into it.
 */
export interface Box { x0: number; y0: number; x1: number; y1: number }

type M = number[]
const I: M = [1, 0, 0, 1, 0, 0]
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
] // row-vector convention, as in the PDF spec: p' = p x M
const apply = (m: M, x: number, y: number) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]) // ( ) < > [ ] { } / %
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c)

interface Op { op: string; nums: (number | null)[]; start: number; end: number }

/** Splits a content stream into operators with their operands (numbers parsed, anything else kept as null). */
export function tokenize(src: Uint8Array): Op[] {
  const ops: Op[] = []
  let operands: (number | null)[] = []
  let opStart = -1
  let i = 0
  const n = src.length
  const skipString = () => {
    // at '('
    let depth = 0
    for (; i < n; i++) {
      const c = src[i]
      if (c === 92) i++ // backslash escape
      else if (c === 40) depth++
      else if (c === 41 && --depth === 0) {
        i++
        return
      }
    }
  }
  const skipHex = () => {
    while (i < n && src[i] !== 62) i++
    i++
  }
  const skipNested = (open: number, close: number) => {
    // at '[' or the second '<' of '<<'
    let depth = 0
    while (i < n) {
      const c = src[i]
      if (c === 40) { skipString(); continue }
      if (c === 60 && src[i + 1] !== 60) { skipHex(); continue }
      if (open === 91 && c === 91) depth++
      else if (open === 91 && c === 93) {
        if (--depth === 0) { i++; return }
      } else if (open === 60 && c === 60 && src[i + 1] === 60) { depth++; i += 2; continue }
      else if (open === 60 && c === 62 && src[i + 1] === 62) {
        if (--depth === 0) { i += 2; return }
        i += 2
        continue
      }
      i++
    }
    void close
  }
  const mark = () => {
    if (opStart < 0) opStart = i
  }
  while (i < n) {
    const c = src[i]
    if (WS.has(c)) { i++; continue }
    if (c === 37) { while (i < n && src[i] !== 10 && src[i] !== 13) i++; continue } // comment
    if (c === 40) { mark(); skipString(); operands.push(null); continue }
    if (c === 60) {
      mark()
      if (src[i + 1] === 60) skipNested(60, 62)
      else skipHex()
      operands.push(null)
      continue
    }
    if (c === 91) { mark(); skipNested(91, 93); operands.push(null); continue }
    if (c === 47) { mark(); i++; while (i < n && isRegular(src[i])) i++; operands.push(null); continue }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) { i++; continue } // stray delimiter: ignore
    // a number or a keyword
    const s = i
    while (i < n && isRegular(src[i])) i++
    const word = String.fromCharCode(...src.subarray(s, i))
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      if (opStart < 0) opStart = s
      operands.push(Number(word))
      continue
    }
    if (word === 'true' || word === 'false' || word === 'null') {
      if (opStart < 0) opStart = s
      operands.push(null)
      continue
    }
    if (word === 'BI') {
      // inline image: dictionary, ID, binary data, EI
      const id = indexOf(src, 'ID', i)
      let j = id < 0 ? n : id + 3
      for (; j < n - 2; j++) if (WS.has(src[j - 1]) && src[j] === 69 && src[j + 1] === 73 && (j + 2 >= n || !isRegular(src[j + 2]))) break
      i = Math.min(n, j + 2)
      ops.push({ op: 'BI', nums: [], start: opStart >= 0 ? opStart : s, end: i })
    } else ops.push({ op: word, nums: operands, start: opStart >= 0 ? opStart : s, end: i })
    operands = []
    opStart = -1
  }
  return ops
}

function indexOf(src: Uint8Array, word: string, from: number) {
  const a = word.charCodeAt(0)
  const b = word.charCodeAt(1)
  for (let i = from; i < src.length - 1; i++) if (src[i] === a && src[i + 1] === b && (i === 0 || !isRegular(src[i - 1])) && !isRegular(src[i + 2] ?? 32)) return i
  return -1
}

export interface Cut { start: number; end: number; replace?: string }

/** Returns a copy of the stream without the text operators that start inside any box, and how many were removed. */
export function removeTextInBoxes(src: Uint8Array, boxes: Box[], tolerance = 1): { bytes: Uint8Array; removed: number } {
  const cuts = findTextCuts(src, boxes, tolerance)
  return { bytes: cuts.length ? applyCuts(src, cuts) : src, removed: cuts.length }
}

/** Byte ranges of the text operators that start inside any box (with the replacement that keeps line moves). */
export function findTextCuts(src: Uint8Array, boxes: Box[], tolerance = 1): Cut[] {
  const ops = tokenize(src)
  let ctm = I
  const stack: M[] = []
  let tm = I
  let tlm = I
  let tl = 0
  const cuts: Cut[] = []
  const inside = (x: number, y: number) =>
    boxes.some(b => x >= b.x0 - tolerance && x <= b.x1 + tolerance && y >= b.y0 - tolerance && y <= b.y1 + tolerance)
  const startPoint = () => apply(mul(tm, ctm), 0, 0)
  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -tl], tlm)
    tm = tlm
  }
  for (const o of ops) {
    const v = o.nums
    const num = (k: number) => (typeof v[v.length - k] === 'number' ? (v[v.length - k] as number) : 0)
    switch (o.op) {
      case 'q': stack.push(ctm); break
      case 'Q': ctm = stack.pop() || I; break
      case 'cm': ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break
      case 'BT': tm = tlm = I; break
      case 'Tm': tm = tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; break
      case 'Td': tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break
      case 'TD': tl = -num(1); tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break
      case 'TL': tl = num(1); break
      case 'T*': nextLine(); break
      case 'Tj':
      case 'TJ': {
        const [x, y] = startPoint()
        if (inside(x, y)) cuts.push({ start: o.start, end: o.end })
        break
      }
      case "'": {
        nextLine()
        const [x, y] = startPoint()
        if (inside(x, y)) cuts.push({ start: o.start, end: o.end, replace: 'T*' }) // keep the line move
        break
      }
      case '"': {
        const aw = num(3)
        const ac = num(2)
        nextLine()
        const [x, y] = startPoint()
        if (inside(x, y)) cuts.push({ start: o.start, end: o.end, replace: `${aw} Tw ${ac} Tc T*` })
        break
      }
    }
  }
  return cuts
}

export function applyCuts(src: Uint8Array, cuts: Cut[]): Uint8Array {
  const parts: Uint8Array[] = []
  let at = 0
  for (const c of cuts) {
    parts.push(src.subarray(at, c.start))
    if (c.replace) parts.push(new TextEncoder().encode(c.replace))
    at = c.end
  }
  parts.push(src.subarray(at))
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let k = 0
  for (const p of parts) {
    out.set(p, k)
    k += p.length
  }
  return out
}
