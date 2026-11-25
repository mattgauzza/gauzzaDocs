/** A1 addresses. Rows and columns are 0-based internally; "A1" is { r: 0, c: 0 }. */
export interface Pos { r: number; c: number }
export interface Range { r1: number; c1: number; r2: number; c2: number }

export function colName(c: number): string {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
export function colIndex(name: string): number {
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
export const addr = (r: number, c: number) => `${colName(c)}${r + 1}`

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/
export function parseAddr(a: string): Pos | null {
  const m = a.trim().match(CELL)
  if (!m) return null
  const r = Number(m[2]) - 1
  return r < 0 ? null : { r, c: colIndex(m[1]) }
}

/** "A1", "A1:C9", "A:C" (whole columns), "2:5" (whole rows). Whole rows/cols are clipped to `max`. */
export function parseRange(s: string, max: Pos = { r: 1048575, c: 16383 }): Range | null {
  const [a, b = a] = s.trim().split(':')
  const pa = parseAddr(a), pb = parseAddr(b)
  if (pa && pb) return norm({ r1: pa.r, c1: pa.c, r2: pb.r, c2: pb.c })
  if (/^\$?[A-Za-z]{1,3}$/.test(a) && /^\$?[A-Za-z]{1,3}$/.test(b))
    return norm({ r1: 0, c1: colIndex(a.replace('$', '')), r2: max.r, c2: colIndex(b.replace('$', '')) })
  if (/^\$?\d+$/.test(a) && /^\$?\d+$/.test(b))
    return norm({ r1: Number(a.replace('$', '')) - 1, c1: 0, r2: Number(b.replace('$', '')) - 1, c2: max.c })
  return null
}
export const norm = (g: Range): Range => ({
  r1: Math.min(g.r1, g.r2), c1: Math.min(g.c1, g.c2), r2: Math.max(g.r1, g.r2), c2: Math.max(g.c1, g.c2)
})
export const rangeStr = (g: Range) =>
  g.r1 === g.r2 && g.c1 === g.c2 ? addr(g.r1, g.c1) : `${addr(g.r1, g.c1)}:${addr(g.r2, g.c2)}`
export const inRange = (g: Range, r: number, c: number) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2

/** Last used row/col of a cell map (−1 when empty). */
export function usedSize(cells: Record<string, unknown>): { rows: number; cols: number } {
  let rows = 0, cols = 0
  for (const k in cells) {
    const p = parseAddr(k)
    if (p) {
      if (p.r + 1 > rows) rows = p.r + 1
      if (p.c + 1 > cols) cols = p.c + 1
    }
  }
  return { rows, cols }
}
