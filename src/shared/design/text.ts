import type { FontSource } from './fonts'
import { boxOf } from './geometry'
import type { TextLayer, TextRun } from './types'

// Text layout for designs, measured with the font files themselves (fontkit), so line breaks are the same in the
// editor, `gdocs look`, thumbnails and every export. Positions are in artboard coordinates: `x` is where a line or
// span starts, a line's `y` is its baseline.

export interface TextSpan { text: string; run: number; x: number; width: number }
export interface TextLine { x: number; y: number; width: number; spans: TextSpan[] }
export interface TextLayout { lines: TextLine[]; height: number; overflow: boolean }

const EPS = 1e-6
const DEFAULT_LINE_HEIGHT = 1.2

/**
 * Drops what XML 1.0 can't hold: control characters other than tab, newline and carriage return, lone surrogates and
 * the two noncharacters at the top of the BMP. With the u flag a surrogate pair is one code point, so the surrogate
 * range only matches lone halves.
 */
export function cleanText(s: string): string {
  return s.replace(/[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]/gu, '')
}

/** A number rounded to 2 decimals (or `digits`), with no trailing zeros. Bad values are 0; never Infinity. */
export function num(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) >= 1e15) return String(v) // too big to have decimals, and v * 10^digits could overflow
  const p = 10 ** digits
  return String(Math.round(v * p) / p)
}

let segmenter: Intl.Segmenter | null = null
/** User-perceived characters, so a letter and its combining marks break together. */
function graphemes(s: string): string[] {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return Array.from(s)
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' })
  return Array.from(segmenter.segment(s), x => x.segment)
}

/** The runs a layer draws: its own, or one run of `overrideText` in the first run's style. Text is cleaned for XML. */
export function textRuns(layer: TextLayer, overrideText?: string): TextRun[] {
  const runs = overrideText === undefined ? layer.runs : layer.runs.slice(0, 1).map(r => ({ ...r, text: overrideText }))
  return runs.map(r => ({ ...r, text: cleanText(String(r.text ?? '')).replace(/\r\n?/g, '\n') }))
}

/** A run's size as layout uses it: a positive finite number, else 0. */
export const runSize = (r: TextRun): number => (Number.isFinite(r.size) && r.size > 0 ? r.size : 0)
const sizeOf = runSize

interface Shaped { glyphs: any[]; positions: any[]; k: number; spacing: number; width: number }

/** Lays out one run's text with its font (the fallback when the font is missing). Never throws. */
function shape(fonts: FontSource, run: TextRun, text: string): Shaped {
  const font = fonts.get(run.font).font
  const k = sizeOf(run) / (font?.unitsPerEm || 1000)
  const spacing = Number.isFinite(run.letterSpacing) ? (run.letterSpacing as number) : 0
  let glyphs: any[] = []
  let positions: any[] = []
  try {
    ;({ glyphs, positions } = font.layout(text))
  } catch {
    glyphs = []
  }
  let width = 0
  for (let i = 0; i < glyphs.length; i++) width += advance(glyphs[i], positions[i]) * k + spacing
  return { glyphs, positions, k, spacing, width }
}

const advance = (g: any, p: any): number => p?.xAdvance ?? g?.advanceWidth ?? 0

function ascentOf(fonts: FontSource, run: TextRun): number {
  const font = fonts.get(run.font).font
  const asc = font?.ascent
  return typeof asc === 'number' ? (asc / (font.unitsPerEm || 1000)) * sizeOf(run) : sizeOf(run) * 0.8
}

interface Piece { run: number; text: string }
interface Token { space: boolean; pieces: Piece[]; width: number }

/** Words and runs of spaces. A word can cross runs, so a token holds pieces. */
function tokenize(pieces: Piece[], measure: (run: number, text: string) => number): Token[] {
  const tokens: Token[] = []
  for (const p of pieces) {
    for (const part of p.text.split(/( +)/)) {
      if (!part) continue
      const space = part[0] === ' '
      const last = tokens[tokens.length - 1]
      if (last && last.space === space) last.pieces.push({ run: p.run, text: part })
      else tokens.push({ space, pieces: [{ run: p.run, text: part }], width: 0 })
    }
  }
  for (const t of tokens) t.width = t.pieces.reduce((a, p) => a + measure(p.run, p.text), 0)
  return tokens
}

function trimEnd(pieces: Piece[]): Piece[] {
  const out = pieces.slice()
  while (out.length) {
    const text = out[out.length - 1].text.replace(/ +$/, '')
    if (text) {
      out[out.length - 1] = { ...out[out.length - 1], text }
      break
    }
    out.pop()
  }
  return out
}

function toSpans(pieces: Piece[]): TextSpan[] {
  const spans: TextSpan[] = []
  for (const p of pieces) {
    const last = spans[spans.length - 1]
    if (last && last.run === p.run) last.text += p.text
    else spans.push({ text: p.text, run: p.run, x: 0, width: 0 })
  }
  return spans
}

/** Splits a line into word chunks placed with `extra` spread over the spaces after the first word, or null. */
function justify(spans: TextSpan[], extra: number, measure: (run: number, text: string) => number): TextSpan[] | null {
  if (extra <= EPS) return null
  const chunks: TextSpan[] = []
  for (const s of spans) for (const c of s.text.match(/[^ ]+ *| +/g) ?? []) chunks.push({ text: c, run: s.run, x: 0, width: 0 })
  let seenWord = false
  let count = 0
  for (const c of chunks) {
    if (/[^ ]/.test(c.text)) seenWord = true
    if (seenWord) count += c.text.length - c.text.replace(/ +$/, '').length
  }
  if (!count) return null
  const per = extra / count
  let natural = 0
  let counted = 0
  seenWord = false
  for (const c of chunks) {
    c.width = measure(c.run, c.text)
    c.x = natural + per * counted
    natural += c.width
    if (/[^ ]/.test(c.text)) seenWord = true
    if (seenWord) counted += c.text.length - c.text.replace(/ +$/, '').length
  }
  return chunks
}

/**
 * Box text wraps on spaces at the box width, and a word wider than the box breaks by letter. Point text never wraps.
 * Both break at newlines. Each line is `lineHeight` (default 1.2) times its largest run's size, its baseline at the
 * line's top plus that run's ascent. `overflow` is true when box text is taller than its box.
 */
export function layoutText(layer: TextLayer, fonts: FontSource, overrideText?: string): TextLayout {
  const runs = textRuns(layer, overrideText)
  if (!runs.length) return { lines: [], height: 0, overflow: false }
  const cache = new Map<string, number>()
  const measure = (run: number, text: string): number => {
    const key = run + '\u0000' + text
    let w = cache.get(key)
    if (w === undefined) {
      w = shape(fonts, runs[run], text).width
      cache.set(key, w)
    }
    return w
  }

  const paras: { pieces: Piece[]; run: number }[] = [{ pieces: [], run: 0 }]
  runs.forEach((r, i) =>
    r.text.split('\n').forEach((part, j) => {
      if (j > 0) paras.push({ pieces: [], run: i })
      if (part) paras[paras.length - 1].pieces.push({ run: i, text: part })
    })
  )

  const wrap = layer.mode === 'box'
  const box = boxOf(layer)
  const maxW = box.w
  const raw: { pieces: Piece[]; run: number; last: boolean }[] = []
  for (const para of paras) {
    if (!wrap) {
      raw.push({ pieces: para.pieces, run: para.run, last: true })
      continue
    }
    let cur: Piece[] = []
    let w = 0
    const flush = () => {
      raw.push({ pieces: cur, run: para.run, last: false })
      cur = []
      w = 0
    }
    for (const t of tokenize(para.pieces, measure)) {
      if (t.space) {
        cur.push(...t.pieces)
        w += t.width
        continue
      }
      // spaces before the word stay on the line they end, leading spaces included
      if (cur.length && w + t.width > maxW + EPS) flush()
      if (t.width <= maxW + EPS) {
        cur.push(...t.pieces)
        w += t.width
        continue
      }
      for (const p of t.pieces) {
        for (const ch of graphemes(p.text)) {
          const cw = measure(p.run, ch)
          if (cur.length && w + cw > maxW + EPS) flush()
          cur.push({ run: p.run, text: ch })
          w += cw
        }
      }
    }
    raw.push({ pieces: cur, run: para.run, last: true })
  }

  const lines: TextLine[] = []
  const metrics: { lh: number; ascent: number }[] = []
  for (const r of raw) {
    let spans = toSpans(trimEnd(r.pieces))
    let big = spans.length ? spans[0].run : r.run
    for (const s of spans) if (sizeOf(runs[s.run]) > sizeOf(runs[big])) big = s.run
    const lhFactor = runs[big].lineHeight
    metrics.push({
      lh: sizeOf(runs[big]) * (Number.isFinite(lhFactor) ? (lhFactor as number) : DEFAULT_LINE_HEIGHT),
      ascent: ascentOf(fonts, runs[big])
    })
    for (const s of spans) s.width = measure(s.run, s.text)
    let width = spans.reduce((a, s) => a + s.width, 0)
    const stretched = layer.align === 'justify' && wrap && !r.last ? justify(spans, maxW - width, measure) : null
    if (stretched) {
      spans = stretched
      width = maxW
    } else {
      let x = 0
      for (const s of spans) {
        s.x = x
        x += s.width
      }
    }
    const x0 = layer.align === 'center' ? box.x + (box.w - width) / 2 : layer.align === 'right' ? box.x + box.w - width : box.x
    for (const s of spans) s.x += x0
    lines.push({ x: x0, y: 0, width, spans })
  }

  const height = metrics.reduce((a, m) => a + m.lh, 0)
  let top = layer.valign === 'middle' ? box.y + (box.h - height) / 2 : layer.valign === 'bottom' ? box.y + box.h - height : box.y
  lines.forEach((l, i) => {
    l.y = top + metrics[i].ascent
    top += metrics[i].lh
  })
  return { lines, height, overflow: wrap && height > box.h + EPS }
}

/** Glyph outlines for one span: path data with the pen starting at `x` on baseline `y`. */
export function glyphPath(fonts: FontSource, run: TextRun, text: string, x: number, y: number): string {
  const { glyphs, positions, k, spacing } = shape(fonts, run, text)
  const out: string[] = []
  let pen = x
  for (let i = 0; i < glyphs.length; i++) {
    const p = positions[i]
    const ox = pen + (p?.xOffset || 0) * k
    const oy = y - (p?.yOffset || 0) * k
    let cmds: any[] = []
    try {
      cmds = glyphs[i].path?.commands ?? []
    } catch {
      cmds = []
    }
    for (const c of cmds) {
      const a = (c.args as number[]).map((v, j) => num(j % 2 ? oy - v * k : ox + v * k)).join(' ')
      if (c.command === 'moveTo') out.push('M' + a)
      else if (c.command === 'lineTo') out.push('L' + a)
      else if (c.command === 'quadraticCurveTo') out.push('Q' + a)
      else if (c.command === 'bezierCurveTo') out.push('C' + a)
      else if (c.command === 'closePath') out.push('Z')
    }
    pen += advance(glyphs[i], p) * k + spacing
  }
  return out.join('')
}

/** Glyph outlines for every span that draws something, shifted by `dx`, `dy`, with the run each one is in. */
export function textPaths(
  layer: TextLayer, fonts: FontSource, overrideText?: string, dx = 0, dy = 0
): { d: string; run: number }[] {
  const runs = textRuns(layer, overrideText)
  return layoutText(layer, fonts, overrideText)
    .lines.flatMap(l => l.spans.map(s => ({ d: glyphPath(fonts, runs[s.run], s.text, s.x + dx, l.y + dy), run: s.run })))
    .filter(p => p.d)
}

/** A text layer's glyph outlines as one path in the layer box's coordinates: the form `glyphs` stores. */
export function textOutlines(layer: TextLayer, fonts: FontSource): string {
  const b = boxOf(layer)
  return textPaths(layer, fonts, undefined, -b.x, -b.y).map(p => p.d).join('')
}

/** What later tasks show about a text layer: a font that isn't available, and text taller than its box. */
export function textReport(layer: TextLayer, fonts: FontSource): { missingFont: boolean; overflow: boolean } {
  return {
    missingFont: layer.runs.some(r => !!fonts.get(r.font).missing),
    overflow: layoutText(layer, fonts).overflow
  }
}
