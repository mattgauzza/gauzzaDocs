import type { FontSource } from './fonts'
import { designToSvg, esc } from './render'
import type { Design } from './types'

// File > Print for a design: each artboard on its own letter page, drawn by designToSvg in raster mode (text as
// outlines, so it prints the same without its fonts installed) and scaled to fit inside half inch margins. An artboard
// wider than it is tall prints on a landscape page.

const DPI = 96
/** The area inside the margins of a portrait letter page, in inches. */
const AREA = { w: 7.5, h: 10 }

const round2 = (v: number): number => Math.round(v * 100) / 100

/** The page to print a design with, as HTML for the app's Print (one artboard per page). */
export function designPrintHtml(design: Design, opts: { fonts: FontSource; assets: Record<string, Uint8Array> }, title: string): string {
  const pages = design.artboards.map(a => {
    const wide = a.width > a.height
    const room = wide ? { w: AREA.h * DPI, h: AREA.w * DPI } : { w: AREA.w * DPI, h: AREA.h * DPI }
    const k = Math.min(room.w / Math.max(1, a.width), room.h / Math.max(1, a.height))
    const size = { width: round2(a.width * k), height: round2(a.height * k) }
    return `<div class="page${wide ? ' wide' : ''}">${designToSvg(design, a.id, { ...opts, mode: 'raster', size })}</div>`
  })
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: letter portrait; margin: 0.5in }
@page wide { size: letter landscape; margin: 0.5in }
html, body { margin: 0; padding: 0 }
.page { display: flex; align-items: center; justify-content: center; width: ${AREA.w}in; height: ${AREA.h}in; overflow: hidden; break-after: page }
.page.wide { page: wide; width: ${AREA.h}in; height: ${AREA.w}in }
.page:last-child { break-after: auto }
.page > svg { display: block; flex: none }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact }
</style></head><body>` +
    pages.join('') +
    '</body></html>'
  )
}
