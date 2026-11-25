import type { Deck, DeckTheme, Slide, SlideElement, SlideLayout, SlidePara, SlideRun } from '../types'

/**
 * Presentation model helpers, shared by the slides editor, the .pptx reader/writer and the agent ops.
 * Slides are 16:9, 13.333 x 7.5 inches (PowerPoint's "Widescreen"); every position is in inches.
 */
export const SLIDE_W = 13.333
export const SLIDE_H = 7.5

export const THEMES: DeckTheme[] = [
  { name: 'Simple light', headFont: 'Arial', bodyFont: 'Arial', text: '#202124', accent: '#1a73e8', background: '#ffffff' },
  { name: 'Simple dark', headFont: 'Arial', bodyFont: 'Arial', text: '#f1f3f4', accent: '#8ab4f8', background: '#202124' },
  { name: 'Serif', headFont: 'Georgia', bodyFont: 'Georgia', text: '#3c2f2f', accent: '#b5651d', background: '#fbf8f1' },
  { name: 'Coral', headFont: 'Trebuchet MS', bodyFont: 'Trebuchet MS', text: '#2d2d2d', accent: '#ff6f61', background: '#ffffff' },
  { name: 'Ocean', headFont: 'Segoe UI', bodyFont: 'Segoe UI', text: '#ffffff', accent: '#ffd166', background: '#0b3c5d' }
]
export const DEFAULT_THEME = THEMES[0]

export const LAYOUTS: { id: SlideLayout; label: string }[] = [
  { id: 'title', label: 'Title slide' },
  { id: 'titleBody', label: 'Title and body' },
  { id: 'twoColumn', label: 'Two columns' },
  { id: 'section', label: 'Section header' },
  { id: 'blank', label: 'Blank' }
]

let counter = 0
/** Short unique ids (time + counter + random): stable enough to address elements across a session and in files. */
export const newId = (prefix = 'e') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Rounds to 1/1000 inch so values survive the trip through EMU (914400 per inch) unchanged. */
export const r3 = (n: number) => Math.round(n * 1000) / 1000

export const run = (text: string, extra: Partial<SlideRun> = {}): SlideRun => ({ text, ...extra })
export const para = (text: string, extra: Partial<SlidePara> = {}, runExtra: Partial<SlideRun> = {}): SlidePara => ({ runs: [run(text, runExtra)], ...extra })

/** The text an element shows, one line per paragraph. */
export const elementText = (el: SlideElement) => (el.paras || []).map(p => p.runs.map(r => r.text).join('')).join('\n')
export const slideTitle = (s: Slide) => {
  const t = s.elements.find(e => e.role === 'title') || s.elements.find(e => e.type === 'text' && elementText(e).trim())
  return t ? elementText(t).split('\n')[0].trim() : ''
}
export const slideText = (s: Slide) => s.elements.map(elementText).filter(Boolean).join('\n')
export const countWords = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || []).length

interface SlideContent {
  title?: string
  subtitle?: string
  bullets?: string[] // "  - nested" style indentation by two spaces per level is accepted
  right?: string[] // second column for twoColumn
  notes?: string
}

/** A bullet line ("  sub item" with two spaces per level) to a paragraph. */
export function bulletPara(line: string, size: number, theme: DeckTheme, numbered = false): SlidePara {
  const m = line.match(/^(\s*)(.*)$/)!
  const level = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2))
  return { runs: [run(m[2], { size: Math.max(14, size - level * 2), color: theme.text })], bullet: numbered ? 'number' : 'bullet', level }
}

/** A slide in one of the layouts, filled with content. Sizes and positions follow Google Slides' defaults. */
export function makeSlide(layout: SlideLayout, content: SlideContent = {}, theme: DeckTheme = DEFAULT_THEME): Slide {
  const els: SlideElement[] = []
  const text = (role: SlideElement['role'], x: number, y: number, w: number, h: number, paras: SlidePara[], valign: SlideElement['valign'] = 'top') =>
    els.push({ id: newId(), type: 'text', role, x, y, w, h, paras, valign })
  const head = (t: string, size: number, align: SlidePara['align'] = 'left') => [para(t, { align }, { size, color: theme.text, font: theme.headFont })]
  const body = (lines: string[] | undefined, size = 20) =>
    lines && lines.length ? lines.map(l => bulletPara(l, size, theme)) : [{ runs: [run('', { size, color: theme.text })], bullet: 'bullet' as const, level: 0 }]
  switch (layout) {
    case 'title':
      text('title', 0.9, 2.2, SLIDE_W - 1.8, 1.6, head(content.title ?? '', 44, 'center'), 'bottom')
      text('subtitle', 0.9, 3.95, SLIDE_W - 1.8, 1.0, [para(content.subtitle ?? '', { align: 'center' }, { size: 22, color: theme.text })])
      break
    case 'section':
      text('title', 0.9, 2.6, SLIDE_W - 1.8, 1.5, head(content.title ?? '', 40), 'middle')
      if (content.subtitle) text('subtitle', 0.9, 4.1, SLIDE_W - 1.8, 0.8, [para(content.subtitle, {}, { size: 20, color: theme.text })])
      break
    case 'titleBody':
      text('title', 0.6, 0.45, SLIDE_W - 1.2, 1.0, head(content.title ?? '', 32), 'bottom')
      text('body', 0.6, 1.65, SLIDE_W - 1.2, 5.2, body(content.bullets))
      break
    case 'twoColumn':
      text('title', 0.6, 0.45, SLIDE_W - 1.2, 1.0, head(content.title ?? '', 32), 'bottom')
      text('body', 0.6, 1.65, (SLIDE_W - 1.5) / 2, 5.2, body(content.bullets, 18))
      text('body', 0.9 + (SLIDE_W - 1.5) / 2, 1.65, (SLIDE_W - 1.5) / 2, 5.2, body(content.right, 18))
      break
    case 'blank':
      break
  }
  for (const e of els) Object.assign(e, { x: r3(e.x), y: r3(e.y), w: r3(e.w), h: r3(e.h) })
  return { id: newId('s'), layout, elements: els, notes: content.notes ?? '' }
}

export function newDeck(theme: DeckTheme = DEFAULT_THEME): Deck {
  return { size: { w: SLIDE_W, h: SLIDE_H }, theme: { ...theme }, slides: [makeSlide('title', {}, theme)] }
}

/** Deep copy with fresh ids (duplicate slide). */
export function cloneSlide(s: Slide): Slide {
  return { ...structuredClone(s), id: newId('s'), elements: s.elements.map(e => ({ ...structuredClone(e), id: newId() })) }
}

/** Applies a theme to a deck: fonts and colors of text that used the old theme's values, and slide backgrounds. */
export function applyTheme(deck: Deck, theme: DeckTheme): Deck {
  const old = deck.theme
  const fix = (r: SlideRun): SlideRun => ({
    ...r,
    color: !r.color || r.color.toLowerCase() === old.text.toLowerCase() ? theme.text : r.color,
    font: r.font === old.headFont ? theme.headFont : r.font === old.bodyFont ? theme.bodyFont : r.font
  })
  return {
    ...deck,
    theme: { ...theme },
    slides: deck.slides.map(s => ({
      ...s,
      background: !s.background || s.background.toLowerCase() === old.background.toLowerCase() ? undefined : s.background,
      elements: s.elements.map(e => (e.paras ? { ...e, paras: e.paras.map(p => ({ ...p, runs: p.runs.map(fix) })) } : e))
    }))
  }
}

export const bg = (s: Slide, deck: Deck) => s.background || deck.theme.background
