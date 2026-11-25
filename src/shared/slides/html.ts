import type { Deck, Slide, SlideElement, SlidePara, SlideRun } from '../types'
import { SLIDE_H, SLIDE_W, bg } from './model'

/**
 * Slides as HTML in real units (inches, points), so the editor canvas, thumbnails, print and PDF export all draw the
 * same thing. The editor scales a 13.333in x 7.5in stage with a CSS transform.
 */
export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function runHtml(r: SlideRun, deck: Deck) {
  const css = [
    r.b ? 'font-weight:700' : '',
    r.i ? 'font-style:italic' : '',
    r.u ? 'text-decoration:underline' : '',
    `color:${r.color || deck.theme.text}`,
    r.size ? `font-size:${r.size}pt` : '',
    r.font ? `font-family:${esc(cssFont(r.font))}` : ''
  ].filter(Boolean)
  return `<span style="${css.join(';')}">${esc(r.text) || '&#8203;'}</span>`
}

export const cssFont = (f: string) => `'${f.replace(/'/g, '')}', Arial, sans-serif`

/** Paragraphs with bullets drawn as real glyphs (inline styles only, so the HTML stands alone for print). */
export function parasHtml(paras: SlidePara[], deck: Deck) {
  const counters: number[] = []
  return paras
    .map(p => {
      const level = p.level || 0
      const size = p.runs[0]?.size || 18
      const align = p.align ? `text-align:${p.align};` : ''
      const content = p.runs.map(r => runHtml(r, deck)).join('') || '&#8203;'
      if (!p.bullet) {
        counters.length = 0
        return `<div style="${align}font-size:${size}pt;line-height:1.25;margin:0 0 .25em;min-height:1.25em">${content}</div>`
      }
      counters.length = level + 1
      counters[level] = (counters[level] || 0) + 1
      const marker = p.bullet === 'number' ? `${counters[level]}.` : ['•', '◦', '▪', '•', '◦'][level] || '•'
      const color = p.runs[0]?.color || deck.theme.text
      return `<div style="${align}display:flex;gap:.5em;margin:0 0 .25em ${level * 0.9}em;font-size:${size}pt;line-height:1.25"><span style="flex:none;min-width:.8em;color:${color}">${marker}</span><span style="flex:1;min-width:0">${content}</span></div>`
    })
    .join('')
}

export function shapeSvg(el: SlideElement) {
  const w = Math.max(el.w, 0.01) * 100
  const h = Math.max(el.h, 0.01) * 100
  const sw = (el.strokeWidth ?? (el.stroke ? 1 : 0)) * (100 / 72)
  const stroke = el.stroke ? `stroke="${el.stroke}" stroke-width="${sw}"` : 'stroke="none"'
  const fill = el.fill ? `fill="${el.fill}"` : 'fill="none"'
  let body = ''
  switch (el.shape) {
    case 'ellipse':
      body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" ${fill} ${stroke}/>`
      break
    case 'roundRect': {
      const rr = Math.min(w, h) * 0.16
      body = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${rr}" ${fill} ${stroke}/>`
      break
    }
    case 'line':
    case 'arrow': {
      const lw = Math.max(sw, 100 / 72)
      const color = el.stroke || '#5f6368'
      const head =
        el.shape === 'arrow'
          ? `<defs><marker id="ah${el.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker></defs>`
          : ''
      body = `${head}<line x1="0" y1="0" x2="${w}" y2="${h}" stroke="${color}" stroke-width="${lw}" stroke-linecap="round" ${el.shape === 'arrow' ? `marker-end="url(#ah${el.id})"` : ''}/>`
      break
    }
    default:
      body = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" ${fill} ${stroke}/>`
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="100%" style="position:absolute;inset:0;overflow:visible">${body}</svg>`
}

/** The inside of an element box: its shape, picture and/or text. */
export function elementInner(el: SlideElement, deck: Deck) {
  let html = ''
  if (el.type === 'shape') html += shapeSvg(el)
  if (el.type === 'image' && el.src) html += `<img src="${esc(el.src)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill" draggable="false">`
  if (el.paras && el.paras.length) {
    const justify = el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start'
    html += `<div class="gd-text" style="position:absolute;inset:0;padding:.08in .1in;display:flex;flex-direction:column;justify-content:${justify};overflow:hidden;overflow-wrap:anywhere;font-family:${esc(cssFont(deck.theme.bodyFont))}">${parasHtml(el.paras, deck)}</div>`
  }
  return html
}

export const elementBox = (el: SlideElement) =>
  `position:absolute;left:${el.x}in;top:${el.y}in;width:${el.w}in;height:${el.h}in;${el.rotation ? `transform:rotate(${el.rotation}deg);` : ''}`

export function slideHtml(s: Slide, deck: Deck) {
  const els = s.elements.map(el => `<div style="${elementBox(el)}">${elementInner(el, deck)}</div>`).join('')
  return `<div class="gd-slide" style="position:relative;width:${SLIDE_W}in;height:${SLIDE_H}in;overflow:hidden;background:${bg(s, deck)};font-family:${esc(cssFont(deck.theme.bodyFont))};color:${deck.theme.text}">${els}</div>`
}

/** A printable page per slide, landscape at slide size (used by Print and Export as PDF). */
export function deckPrintHtml(deck: Deck, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: ${SLIDE_W}in ${SLIDE_H}in; margin: 0 }
html, body { margin: 0; padding: 0 }
.page { width: ${SLIDE_W}in; height: ${SLIDE_H}in; page-break-after: always; break-after: page; overflow: hidden }
.page:last-child { page-break-after: auto; break-after: auto }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact }
</style></head><body>${deck.slides.map(s => `<div class="page">${slideHtml(s, deck)}</div>`).join('')}</body></html>`
}
