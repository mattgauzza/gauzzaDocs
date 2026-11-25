import { type PDFFont, type PDFPage, PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import type { PdfEdit } from '../types'

/**
 * Applies edits to a PDF with pdf-lib. Isomorphic: the window uses it on save, the CLI on files on disk.
 *
 * Edits run in order and page numbers refer to the document as it stands when that edit runs, so a
 * `delete` of page 2 makes the old page 3 become page 2 for later edits. Coordinates are PDF points from the
 * top-left of the page as displayed (after its rotation); they are mapped to PDF user space here.
 */
export async function applyPdfEdits(bytes: Uint8Array, edits: PdfEdit[]): Promise<Uint8Array> {
  if (!edits.length) return bytes
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  let font: PDFFont | null = null
  const getFont = async () => (font ??= await doc.embedFont(StandardFonts.Helvetica))

  const pageAt = (n: number, what: string) => {
    const count = doc.getPageCount()
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`${what}: page ${n} is outside 1-${count}`)
    return doc.getPage(n - 1)
  }

  for (const e of edits) {
    switch (e.type) {
      case 'rotate': {
        const page = pageAt(e.page, 'rotate')
        page.setRotation(degrees(norm360(page.getRotation().angle + e.degrees)))
        break
      }
      case 'delete': {
        pageAt(e.page, 'delete')
        if (doc.getPageCount() === 1) throw new Error('Cannot delete the only page')
        doc.removePage(e.page - 1)
        break
      }
      case 'move': {
        const page = pageAt(e.page, 'move')
        const count = doc.getPageCount()
        const to = Math.min(Math.max(1, Math.round(e.to)), count)
        if (to === e.page) break
        doc.removePage(e.page - 1)
        doc.insertPage(to - 1, page)
        break
      }
      case 'text': {
        const page = pageAt(e.page, 'text')
        const f = await getFont()
        const size = e.size || 12
        const { angle, map } = mapper(page)
        const color = toRgb(e.color || '#000000')
        const lines = sanitize(f, e.text).split('\n')
        lines.forEach((line, i) => {
          if (!line) return
          // e.y is the top of the text box; the first baseline sits a little below it (line-height 1.2 on screen).
          const [x, y] = map(e.x, e.y + size * 0.87 + i * size * 1.2)
          page.drawText(line, { x, y, size, font: f, color, rotate: degrees(angle) })
        })
        break
      }
      case 'highlight':
      case 'rect': {
        const page = pageAt(e.page, e.type)
        const { angle, map } = mapper(page)
        const [x, y] = map(e.x, e.y + e.h) // display bottom-left
        const base = { x, y, width: e.w, height: e.h, rotate: degrees(angle) }
        if (e.type === 'highlight') page.drawRectangle({ ...base, color: toRgb(e.color || '#ffeb3b'), opacity: 0.35 })
        else {
          const border = e.color || (e.fill ? undefined : '#d93025')
          page.drawRectangle({
            ...base,
            ...(e.fill ? { color: toRgb(e.fill) } : {}),
            ...(border ? { borderColor: toRgb(border), borderWidth: 2 } : { borderWidth: 0 })
          })
        }
        break
      }
      case 'ink': {
        const page = pageAt(e.page, 'ink')
        const { map } = mapper(page)
        const pts = e.points.map(([px, py]) => map(px, py))
        const color = toRgb(e.color || '#1a73e8')
        const thickness = e.width || 2
        if (pts.length === 1) page.drawCircle({ x: pts[0][0], y: pts[0][1], size: thickness / 2, color })
        for (let i = 1; i < pts.length; i++)
          page.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness, color, lineCap: 1 })
        break
      }
      case 'image': {
        const page = pageAt(e.page, 'image')
        const data = decodeImage(e.png)
        const img = data[0] === 0xff && data[1] === 0xd8 ? await doc.embedJpg(data) : await doc.embedPng(data)
        const { angle, map } = mapper(page)
        const [x, y] = map(e.x, e.y + e.h)
        page.drawImage(img, { x, y, width: e.w, height: e.h, rotate: degrees(angle) })
        break
      }
      default:
        throw new Error(`Unknown PDF edit type "${(e as { type: string }).type}"`)
    }
  }
  return doc.save()
}

const norm360 = (a: number) => (((Math.round(a / 90) * 90) % 360) + 360) % 360

/** Maps a top-left display coordinate on a (possibly rotated) page to PDF user space. */
function mapper(page: PDFPage) {
  const r = norm360(page.getRotation().angle)
  const box = page.getCropBox()
  const { x: x0, y: y0, width: W, height: H } = box
  const map = (dx: number, dy: number): [number, number] => {
    switch (r) {
      case 90: return [x0 + dy, y0 + dx]
      case 180: return [x0 + W - dx, y0 + dy]
      case 270: return [x0 + W - dy, y0 + H - dx]
      default: return [x0 + dx, y0 + H - dy]
    }
  }
  return { angle: r, map }
}

/** Page size as displayed (after rotation), in points. */
export function displaySize(page: PDFPage) {
  const { width, height } = page.getCropBox()
  return norm360(page.getRotation().angle) % 180 ? { w: height, h: width } : { w: width, h: height }
}

export function toRgb(hex: string) {
  const m = hex.trim().replace(/^#/, '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  const n = parseInt(full, 16)
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Bad color "${hex}"; use #rrggbb`)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Standard fonts only cover WinAnsi; characters outside it become "?" instead of failing the save. */
function sanitize(font: PDFFont, text: string) {
  const ok = new Map<string, boolean>()
  return Array.from(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    '))
    .map(ch => {
      if (ch === '\n') return ch
      if (!ok.has(ch)) {
        try {
          font.encodeText(ch)
          ok.set(ch, true)
        } catch {
          ok.set(ch, false)
        }
      }
      return ok.get(ch) ? ch : '?'
    })
    .join('')
}

function decodeImage(src: string): Uint8Array {
  const b64 = src.replace(/^data:[^,]*,/, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** "1-3,5" / "all" / "2" -> sorted unique 1-based page numbers, checked against the page count. */
export function parsePages(spec: string | number | number[] | undefined, count: number): number[] {
  if (spec == null || spec === '' || spec === 'all') return Array.from({ length: count }, (_, i) => i + 1)
  if (Array.isArray(spec)) return check([...new Set(spec.map(Number))].sort((a, b) => a - b), count)
  const out = new Set<number>()
  for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+|end))?$/i)
    if (!m) throw new Error(`Cannot read page range "${part}". Use e.g. 1-3,5`)
    const a = Number(m[1])
    const b = m[2] ? (m[2].toLowerCase() === 'end' ? count : Number(m[2])) : a
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.add(p)
  }
  return check([...out].sort((x, y) => x - y), count)
}
function check(pages: number[], count: number) {
  for (const p of pages) if (!Number.isInteger(p) || p < 1 || p > count) throw new Error(`Page ${p} is outside 1-${count}`)
  return pages
}

/** Validates edits arriving from an agent, so a typo fails clearly instead of producing a broken file. */
export function checkEdits(edits: unknown): PdfEdit[] {
  if (!Array.isArray(edits)) throw new Error('edits must be an array of PDF edits')
  const n = (e: Record<string, unknown>, k: string) => {
    if (typeof e[k] !== 'number' || !Number.isFinite(e[k])) throw new Error(`${e.type} edit needs a number "${k}"`)
  }
  return edits.map(raw => {
    const e = raw as Record<string, unknown>
    if (!e || typeof e !== 'object') throw new Error('each edit must be an object')
    n(e, 'page')
    switch (e.type) {
      case 'text':
        n(e, 'x'); n(e, 'y')
        if (typeof e.text !== 'string') throw new Error('text edit needs "text"')
        break
      case 'highlight': case 'rect':
        for (const k of ['x', 'y', 'w', 'h']) n(e, k)
        break
      case 'image':
        for (const k of ['x', 'y', 'w', 'h']) n(e, k)
        if (typeof e.png !== 'string') throw new Error('image edit needs "png" (data URL or base64)')
        break
      case 'ink':
        if (!Array.isArray(e.points) || !e.points.every(p => Array.isArray(p) && p.length === 2)) throw new Error('ink edit needs "points": [[x,y],...]')
        break
      case 'rotate': n(e, 'degrees'); break
      case 'move': n(e, 'to'); break
      case 'delete': break
      default: throw new Error(`Unknown edit type "${String(e.type)}". Use text, highlight, rect, ink, image, rotate, delete, move`)
    }
    return e as unknown as PdfEdit
  })
}
