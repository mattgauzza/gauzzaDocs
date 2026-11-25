import type { PdfEdit } from '../../../shared/types'

/** Markup that stays editable on the page until saved (page structure changes are applied at once instead). */
export type Markup = Extract<PdfEdit, { type: 'text' | 'highlight' | 'rect' | 'ink' | 'image' }>
export const isMarkup = (e: PdfEdit): e is Markup => ['text', 'highlight', 'rect', 'ink', 'image'].includes(e.type)

export type Tool = 'select' | 'text' | 'highlight' | 'draw' | 'whiteout' | 'rect'

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
  if (e.type === 'ink') return { ...e, points: e.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
  return { ...e, x: e.x + dx, y: e.y + dy }
}

/** Resize from the bottom-right corner (box-shaped markup only). */
export function resize(e: Markup, w: number, h: number, keepAspect = false): Markup {
  if (e.type === 'text' || e.type === 'ink') return e
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
