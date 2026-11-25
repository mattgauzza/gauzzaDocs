import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts'
import type { PdfEdit } from '../types'

/**
 * Wrapping a replaced paragraph to its old width. The app's preview and the saved PDF both call this, so they break
 * lines in the same places: widths come from the metrics of the standard PDF font the text is saved in.
 */
type Rep = Extract<PdfEdit, { type: 'replaceText' }>

const NAMES = {
  sans: [FontNames.Helvetica, FontNames.HelveticaOblique, FontNames.HelveticaBold, FontNames.HelveticaBoldOblique],
  serif: [FontNames.TimesRoman, FontNames.TimesRomanItalic, FontNames.TimesRomanBold, FontNames.TimesRomanBoldItalic],
  mono: [FontNames.Courier, FontNames.CourierOblique, FontNames.CourierBold, FontNames.CourierBoldOblique]
}
const fonts = new Map<string, Font>()
function fontOf(e: Pick<Rep, 'font' | 'bold' | 'italic'>) {
  const name = NAMES[e.font || 'sans'][(e.bold ? 2 : 0) + (e.italic ? 1 : 0)]
  if (!fonts.has(name)) fonts.set(name, Font.load(name))
  return fonts.get(name)!
}

/** Width of text in points at a size, in the standard font the edit is saved with. */
export function textWidth(text: string, e: Pick<Rep, 'font' | 'bold' | 'italic'>, size: number) {
  const f = fontOf(e)
  let units = 0
  for (const ch of text) {
    try {
      units += f.getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(ch.codePointAt(0)!).name) ?? 500
    } catch {
      units += 500 // not in the font: saved as a stand-in of about this width
    }
  }
  return (units * size) / 1000
}

type Measure = (text: string, size: number) => number

function wrap(text: string, e: Rep, size: number, measure: Measure) {
  const right = e.wrapRight!
  const firstWidth = right - e.x
  const width = right - (e.hang ?? e.x)
  const out: string[] = []
  for (const hard of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    for (const word of hard.split(/ +/)) {
      const room = out.length === 0 ? firstWidth : width
      const next = line ? `${line} ${word}` : word
      if (line && measure(next, size) > room + 0.5) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

/**
 * The lines a paragraph edit is drawn as, and the size and line spacing to draw them with. When the new words need
 * more lines than maxLines, the size steps down (to 80% at most) so it doesn't spill over what's below. measure gives
 * a width in points; by default the standard font's, or pass the installed font's (see edits.ts and pdf/sysfont.ts).
 */
export function fitParagraph(e: Rep, measure: Measure = (t, s) => textWidth(t, e, s)): { lines: string[]; size: number; lineHeight: number } {
  const spacing = e.lineHeight ?? e.size * 1.2
  let size = e.size
  let lines = wrap(e.text, e, size, measure)
  while (e.maxLines && lines.length > e.maxLines && size > e.size * 0.8) {
    size = Math.max(e.size * 0.8, size * 0.95)
    lines = wrap(e.text, e, size, measure)
  }
  return { lines, size, lineHeight: (spacing * size) / e.size }
}
