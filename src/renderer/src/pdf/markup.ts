import type { PdfEdit } from '../../../shared/types'
import { fitParagraph } from '../../../shared/pdf/wrap'
import { sysFont } from './sysfont'

/** Markup that stays editable on the page until saved (page structure changes are applied at once instead). */
export type Markup = Extract<PdfEdit, { type: 'text' | 'highlight' | 'rect' | 'ink' | 'image' | 'replaceText' }>
export type ReplaceEdit = Extract<PdfEdit, { type: 'replaceText' }>
export const isMarkup = (e: PdfEdit): e is Markup => ['text', 'highlight', 'rect', 'ink', 'image', 'replaceText'].includes(e.type)

export type Tool = 'select' | 'edittext' | 'text' | 'highlight' | 'draw' | 'whiteout' | 'rect'

/** CSS for the standard font a replaceText edit is drawn with, so what you type looks like what gets saved. */
export const cssFamily = (f: ReplaceEdit['font']) =>
  f === 'serif' ? "'Times New Roman', Times, serif" : f === 'mono' ? "'Courier New', Courier, monospace" : 'Helvetica, Arial, sans-serif'
export const cssFont = (e: ReplaceEdit, scale = 1) => {
  const sys = sysFont(e.fontName)
  return sys ? `${e.size * scale}px "${sys.family}"` : `${e.italic ? 'italic ' : ''}${e.bold ? 'bold ' : ''}${e.size * scale}px ${cssFamily(e.font)}`
}
/** The font an edit is shown in: the PDF's own font when it's installed (bold or italic is in that file), else a standard one. */
export const fontStyle = (e: ReplaceEdit) => {
  const sys = sysFont(e.fontName)
  return sys
    ? { fontFamily: `"${sys.family}"`, fontWeight: 400, fontStyle: 'normal' as const }
    : { fontFamily: cssFamily(e.font), fontWeight: e.bold ? 700 : 400, fontStyle: (e.italic ? 'italic' : 'normal') as 'italic' | 'normal' }
}
/** Widths for wrapping a paragraph in the font it's shown and saved in. */
export const fitOf = (e: ReplaceEdit) => fitParagraph(e, sysFont(e.fontName)?.measure)

/**
 * Edited lines are laid out with line-height 1.2em (the spacing they are saved with). This is where the first CSS line
 * box has to start, in points, for its baseline to sit on the PDF baseline; the ratios come from the CSS fonts' metrics.
 */
const BASELINE = { sans: 0.9465, serif: 0.9375, mono: 0.8665 }
const baseline12 = (e: ReplaceEdit) => sysFont(e.fontName)?.baseline12 ?? BASELINE[e.font || 'sans']
export const lineTop = (e: ReplaceEdit) => {
  if (e.wrapRight == null) return (e.base ?? e.y + e.h * 0.8) + (e.dy || 0) - baseline12(e) * e.size
  // A paragraph uses its own line spacing: the baseline moves down by half of the extra leading.
  const fit = fitOf(e)
  return (e.base ?? e.y + e.h * 0.8) + (e.dy || 0) - (baseline12(e) + (fit.lineHeight / fit.size - 1.2) / 2) * fit.size
}
/** Left edge of a replaced paragraph (its first line may be indented, or hang). */
export const paraLeft = (e: ReplaceEdit) => Math.min(e.x, e.hang ?? e.x)

export const DEFAULT_COLORS: Record<string, string> = { text: '#000000', highlight: '#ffeb3b', draw: '#1a73e8', rect: '#d93025' }

/** Text box size, measured the way the overlay lays it out (line-height 1.2, Helvetica ~0.55em per char). */
let measureCtx: CanvasRenderingContext2D | null = null
export function textBox(e: Extract<PdfEdit, { type: 'text' }>) {
  const size = e.size || 12
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const lines = (e.text || ' ').split('\n')
  let w = 0
  if (measureCtx) {
    measureCtx.font = `${size}px Helvetica, Arial, sans-serif`
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width)
  } else w = Math.max(...lines.map(l => l.length)) * size * 0.55
  return { x: e.x, y: e.y, w: Math.max(w, size), h: lines.length * size * 1.2 }
}

export function bbox(e: Markup) {
  switch (e.type) {
    case 'text':
      return textBox(e)
    case 'replaceText': {
      if (e.wrapRight != null) {
        const fit = fitOf(e)
        const left = paraLeft(e)
        return { x: left + (e.dx || 0), y: lineTop(e), w: Math.max(6, e.wrapRight - left), h: Math.max(1, fit.lines.length) * fit.lineHeight }
      }
      measureCtx ??= document.createElement('canvas').getContext('2d')
      let w = e.w
      if (measureCtx) {
        measureCtx.font = cssFont(e)
        w = Math.max(...(e.text || ' ').split('\n').map(l => measureCtx!.measureText(l).width))
      }
      const lines = Math.max(1, (e.text || ' ').split('\n').length)
      return { x: e.x + (e.dx || 0), y: lineTop(e), w: Math.max(w, 6), h: lines * e.size * 1.2 }
    }
    case 'ink': {
      const xs = e.points.map(p => p[0])
      const ys = e.points.map(p => p[1])
      const pad = (e.width || 2) / 2 + 2
      const x = Math.min(...xs) - pad
      const y = Math.min(...ys) - pad
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
    }
    default:
      return { x: e.x, y: e.y, w: e.w, h: e.h }
  }
}

export function translate(e: Markup, dx: number, dy: number): Markup {
  // An edited line moves its new text only; the cover stays where the old words were.
  if (e.type === 'replaceText') return { ...e, dx: (e.dx || 0) + dx, dy: (e.dy || 0) + dy }
  if (e.type === 'ink') return { ...e, points: e.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
  return { ...e, x: e.x + dx, y: e.y + dy }
}

/** Resize from the bottom-right corner (box-shaped markup only). */
export function resize(e: Markup, w: number, h: number, keepAspect = false): Markup {
  if (e.type === 'text' || e.type === 'ink' || e.type === 'replaceText') return e
  if (keepAspect && e.w && e.h) h = (w * e.h) / e.w
  return { ...e, w: Math.max(4, w), h: Math.max(4, h) }
}

/** Reads an image file as a PNG or JPEG data URL (other formats are converted to PNG). */
export async function readImage(file: File): Promise<{ src: string; w: number; h: number }> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
  const img = new Image()
  img.src = url
  await img.decode()
  if (/^data:image\/(png|jpeg)/.test(url)) return { src: url, w: img.naturalWidth, h: img.naturalHeight }
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d')!.drawImage(img, 0, 0)
  return { src: c.toDataURL('image/png'), w: c.width, h: c.height }
}

/**
 * Text and background colors of a line on the rendered page: the background is the most common color in a thin ring
 * around the box, the text is the average of the pixels inside that differ most from it.
 */
export function sampleColors(canvas: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }, pageWidthPt: number) {
  const fallback = { color: '#000000', bg: '#ffffff' }
  if (!canvas.width || !canvas.height) return fallback
  const k = canvas.width / pageWidthPt // canvas pixels per point
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return fallback
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)))
  const x0 = clamp((box.x - 3) * k, canvas.width - 1)
  const y0 = clamp((box.y - 3) * k, canvas.height - 1)
  const x1 = clamp((box.x + box.w + 3) * k, canvas.width)
  const y1 = clamp((box.y + box.h + 3) * k, canvas.height)
  if (x1 - x0 < 2 || y1 - y0 < 2) return fallback
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
  } catch {
    return fallback
  }
  const W = x1 - x0
  const H = y1 - y0
  const ring = Math.max(1, Math.round(2 * k))
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  const inner: [number, number, number][] = []
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (data[i + 3] < 8) continue
      const px: [number, number, number] = [data[i], data[i + 1], data[i + 2]]
      if (x < ring || y < ring || x >= W - ring || y >= H - ring) {
        const key = ((px[0] >> 4) << 8) | ((px[1] >> 4) << 4) | (px[2] >> 4)
        const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
        b.n++
        b.r += px[0]
        b.g += px[1]
        b.b += px[2]
        buckets.set(key, b)
      } else inner.push(px)
    }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0]
  if (!top) return fallback
  const bg: [number, number, number] = [top.r / top.n, top.g / top.n, top.b / top.n]
  const dist = (p: [number, number, number]) => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2])
  const far = Math.max(0, ...inner.map(dist))
  const ink = far > 40 ? inner.filter(p => dist(p) > far * 0.6) : []
  const avg = (ps: [number, number, number][], c: 0 | 1 | 2) => ps.reduce((n, p) => n + p[c], 0) / ps.length
  const hex = (c: [number, number, number]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  return { bg: hex(bg), color: ink.length ? hex([avg(ink, 0), avg(ink, 1), avg(ink, 2)]) : '#000000' }
}
