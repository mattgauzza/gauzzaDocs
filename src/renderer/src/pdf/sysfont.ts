import { api } from '../lib'

/**
 * Installed fonts in the PDF editor: when a line's PDF font (Calibri, Segoe UI...) is installed on this PC, its new
 * words are previewed and saved in that same font. The preview measures with the font file's own glyph widths (the
 * same way pdf-lib does when it embeds the font), so lines wrap in the same places on screen and in the saved file.
 */
export interface SysFont {
  /** CSS family registered from the font file itself (bold or italic is part of the file, not CSS). */
  family: string
  measure(text: string, size: number): number
  /** Where the baseline sits in a CSS line box of line-height 1.2, as a fraction of the font size. */
  baseline12: number
}

const loading = new Map<string, Promise<SysFont | null>>()
const loaded = new Map<string, SysFont | null>()
const bytes = new Map<string, Promise<Uint8Array | null>>()

/** The font file for a PDF font name (null when not installed), fetched once. */
export function sysFontBytes(name: string) {
  if (!bytes.has(name)) bytes.set(name, api.systemFont(name).catch(() => null))
  return bytes.get(name)!
}

function measureBaseline(family: string) {
  const box = document.createElement('div')
  box.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:100px/1.2 "${family}"`
  box.innerHTML = 'Hg<span style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>'
  document.body.append(box)
  const ratio = (box.lastElementChild as HTMLElement).offsetTop / 100
  box.remove()
  return ratio
}

export function loadSysFont(name: string): Promise<SysFont | null> {
  if (!loading.has(name))
    loading.set(
      name,
      (async () => {
        const data = await sysFontBytes(name)
        if (!data) return null
        const fontkit = (await import('@pdf-lib/fontkit')).default
        const font = fontkit.create(data)
        const family = `gd-sys-${name.replace(/[^a-z0-9]/gi, '')}`
        const face = new FontFace(family, data.slice().buffer as ArrayBuffer)
        await face.load()
        document.fonts.add(face)
        const upm = font.unitsPerEm
        return {
          family,
          measure: (text: string, size: number) => {
            let w = 0
            for (const g of font.layout(text).glyphs) w += g.advanceWidth
            return (w * size) / upm
          },
          baseline12: measureBaseline(family)
        }
      })()
        .catch(() => null)
        .then(f => (loaded.set(name, f), f))
    )
  return loading.get(name)!
}

/** The font if it's already loaded (call loadSysFont first), else null: callers fall back to standard fonts. */
export const sysFont = (name?: string) => (name ? loaded.get(name) || null : null)
