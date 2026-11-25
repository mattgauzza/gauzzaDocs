/**
 * Plain text of PDF pages from a pdf.js document (the browser build in the window, the legacy build in Node).
 * Text items are grouped into lines by their baseline, lines ordered top to bottom, words left to right.
 */
interface TextItemLike { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }
export interface PdfJsDocLike {
  numPages: number
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
}

export async function pageText(doc: PdfJsDocLike, n: number): Promise<string> {
  const page = await doc.getPage(n)
  const { items } = await page.getTextContent()
  const parts = (items as TextItemLike[])
    .filter(i => typeof i.str === 'string' && i.transform)
    .map(i => ({ s: i.str!, x: i.transform![4], y: i.transform![5], w: i.width || 0, h: Math.abs(i.height || i.transform![3] || 10) }))
  const lines: { y: number; h: number; items: typeof parts }[] = []
  for (const p of parts) {
    if (!p.s.trim() && !p.w) continue
    const line = lines.find(l => Math.abs(l.y - p.y) <= Math.max(2, Math.min(l.h, p.h) * 0.4))
    if (line) line.items.push(p)
    else lines.push({ y: p.y, h: p.h, items: [p] })
  }
  lines.sort((a, b) => b.y - a.y)
  return lines
    .map(l => {
      l.items.sort((a, b) => a.x - b.x)
      let out = ''
      let end = -Infinity
      for (const it of l.items) {
        if (out && it.x - end > it.h * 0.15 && !out.endsWith(' ') && !it.s.startsWith(' ')) out += ' '
        out += it.s
        end = it.x + it.w
      }
      return out.trimEnd()
    })
    .join('\n')
    .trim()
}

export async function allText(doc: PdfJsDocLike, pages?: number[]): Promise<{ page: number; text: string }[]> {
  const list = pages || Array.from({ length: doc.numPages }, (_, i) => i + 1)
  const out: { page: number; text: string }[] = []
  for (const n of list) out.push({ page: n, text: await pageText(doc, n) })
  return out
}

export const joinPages = (pages: { page: number; text: string }[]) =>
  pages.map(p => `--- Page ${p.page} ---\n${p.text}`).join('\n\n')
