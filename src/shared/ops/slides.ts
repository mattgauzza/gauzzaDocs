import type { AgentOp, Deck, Slide, SlideLayout, SlidePara } from '../types'
import { deckToMarkdown, mdToRuns, slideFromMarkdown, slideToMarkdown, splitSlides } from '../slides/markdown'
import { THEMES, applyTheme, bulletPara, cloneSlide, countWords, makeSlide, slideText, slideTitle } from '../slides/model'
import { OpError, type OpHandler, escapeRe, str } from './types'

/**
 * Ops on presentations (.pptx). Slides are numbered from 1; `slide` also accepts a slide id or "last".
 *   read     { format?: "md" | "json" | "text" }           -> { content } (Markdown by default, see shared/slides/markdown.ts)
 *   write    { content, format?: "md" | "json" }           replaces every slide
 *   append / prepend { content }                           adds slides written as Markdown
 *   addSlide { at?, layout?, title?, subtitle?, bullets?, right?, notes?, md? } -> { slide, id }
 *   updateSlide { slide, title?, subtitle?, bullets?, right?, notes?, md? }
 *   deleteSlide { slide }   moveSlide { slide, to }   duplicateSlide { slide }   setNotes { slide, notes }
 *   setTheme { name }       replace { find, with, all?, regex?, ignoreCase? } -> { count }
 *   find { query }          outline   info
 * Pure: the slides editor applies these to its deck live, and core/ops/slides.ts to files on disk.
 */
export function applySlidesOp(deck: Deck, op: AgentOp): { result: unknown; deck?: Deck } {
  const theme = deck.theme
  const lines = (v: unknown): string[] | undefined =>
    v == null ? undefined : Array.isArray(v) ? v.map(String) : String(v).split('\n').filter(l => l.trim()).map(l => l.replace(/^(\s*)[-*+]\s+/, '$1'))
  const at = (ref: unknown, allowEnd = false): number => {
    if (ref === 'last' || (ref == null && allowEnd)) return deck.slides.length - (allowEnd && ref == null ? 0 : 1)
    if (typeof ref === 'string' && !/^\d+$/.test(ref)) {
      const i = deck.slides.findIndex(s => s.id === ref)
      if (i < 0) throw new OpError(`No slide with id ${ref}`)
      return i
    }
    const n = Number(ref)
    const max = deck.slides.length + (allowEnd ? 1 : 0)
    if (!Number.isInteger(n) || n < 1 || n > max) throw new OpError(`slide must be 1-${max} (got ${ref})`)
    return n - 1
  }
  const withSlides = (slides: Slide[]) => ({ ...deck, slides })
  const summary = (s: Slide, i: number) => ({ slide: i + 1, id: s.id, layout: s.layout, title: slideTitle(s) })

  switch (op.op) {
    case 'read': {
      const f = str(op, 'format', 'md')
      if (f === 'json') return { result: { content: JSON.stringify(stripImages(deck), null, 2) } }
      if (f === 'text') return { result: { content: deck.slides.map((s, i) => `Slide ${i + 1}\n${slideText(s)}${s.notes ? `\nNotes: ${s.notes}` : ''}`).join('\n\n') } }
      return { result: { content: deckToMarkdown(deck), slides: deck.slides.length } }
    }
    case 'write': {
      const content = str(op, 'content')
      const f = str(op, 'format', 'md')
      if (f === 'json') {
        const parsed = JSON.parse(content) as Deck
        if (!Array.isArray(parsed.slides)) throw new OpError('JSON must be a deck: { slides: [...] }')
        // Images read as embedded:<id> come back from the current deck.
        const srcs = new Map(deck.slides.flatMap(s => s.elements.filter(e => e.src).map(e => [e.id, e.src!] as const)))
        for (const s of parsed.slides) for (const e of s.elements) if (e.src?.startsWith('embedded:')) e.src = srcs.get(e.src.slice(9)) || e.src
        return { result: { ok: true, slides: parsed.slides.length }, deck: { ...deck, ...parsed, theme: parsed.theme || theme } }
      }
      const chunks = splitSlides(content)
      const slides = chunks.map((c, i) => slideFromMarkdown(c, theme, i, deck.slides[i]))
      return { result: { ok: true, slides: slides.length }, deck: withSlides(slides) }
    }
    case 'append':
    case 'prepend': {
      const chunks = splitSlides(str(op, 'content'))
      const base = op.op === 'append' ? deck.slides.length : 0
      const added = chunks.map((c, k) => slideFromMarkdown(c, theme, base + k))
      const slides = op.op === 'append' ? [...deck.slides, ...added] : [...added, ...deck.slides]
      return { result: { ok: true, added: added.length, slides: slides.length }, deck: withSlides(slides) }
    }
    case 'addSlide': {
      const i = op.at == null ? deck.slides.length : at(op.at, true)
      const s = op.md
        ? slideFromMarkdown(String(op.md), theme, i)
        : makeSlide((str(op, 'layout') || (op.bullets || op.right ? 'titleBody' : 'titleBody')) as SlideLayout, {
            title: op.title as string | undefined,
            subtitle: op.subtitle as string | undefined,
            bullets: lines(op.bullets),
            right: lines(op.right),
            notes: op.notes as string | undefined
          }, theme)
      if (!['title', 'titleBody', 'twoColumn', 'section', 'blank'].includes(s.layout)) throw new OpError('layout must be title, titleBody, twoColumn, section or blank')
      const slides = [...deck.slides]
      slides.splice(i, 0, s)
      return { result: { slide: i + 1, id: s.id }, deck: withSlides(slides) }
    }
    case 'updateSlide': {
      const i = at(op.slide)
      const old = deck.slides[i]
      let s: Slide
      if (op.md != null) s = slideFromMarkdown(String(op.md), theme, i, old)
      else {
        s = structuredClone(old)
        if (op.title != null) setRoleText(s, 'title', String(op.title))
        if (op.subtitle != null) setRoleText(s, 'subtitle', String(op.subtitle))
        const bodies = s.elements.filter(e => e.role === 'body')
        const fill = (k: number, items: string[] | undefined) => {
          if (!items) return
          let b = bodies[k]
          if (!b) {
            // A slide without a body (title only, blank): give it one, like switching to Title and body.
            const tpl = makeSlide('titleBody', {}, theme).elements.find(e => e.role === 'body')!
            s.elements.push(tpl)
            b = tpl
          }
          b.paras = items.map(l => bulletPara(l, k === 0 && bodies.length < 2 ? 20 : 18, theme))
        }
        fill(0, lines(op.bullets))
        fill(1, lines(op.right))
        if (op.notes != null) s.notes = String(op.notes)
      }
      const slides = [...deck.slides]
      slides[i] = s
      return { result: { ok: true, slide: i + 1 }, deck: withSlides(slides) }
    }
    case 'deleteSlide': {
      const i = at(op.slide)
      if (deck.slides.length === 1) throw new OpError('A presentation needs at least one slide')
      return { result: { ok: true, slides: deck.slides.length - 1 }, deck: withSlides(deck.slides.filter((_, k) => k !== i)) }
    }
    case 'duplicateSlide': {
      const i = at(op.slide)
      const slides = [...deck.slides]
      const copy = cloneSlide(slides[i])
      slides.splice(i + 1, 0, copy)
      return { result: { slide: i + 2, id: copy.id }, deck: withSlides(slides) }
    }
    case 'moveSlide': {
      const i = at(op.slide)
      const to = at(op.to)
      const slides = [...deck.slides]
      const [s] = slides.splice(i, 1)
      slides.splice(to, 0, s)
      return { result: { ok: true, slide: to + 1 }, deck: withSlides(slides) }
    }
    case 'setNotes': {
      const i = at(op.slide)
      const slides = [...deck.slides]
      slides[i] = { ...slides[i], notes: str(op, 'notes') }
      return { result: { ok: true }, deck: withSlides(slides) }
    }
    case 'setTheme': {
      const t = THEMES.find(x => x.name.toLowerCase() === str(op, 'name').toLowerCase())
      if (!t) throw new OpError(`Themes: ${THEMES.map(x => x.name).join(', ')}`)
      return { result: { ok: true, theme: t.name }, deck: applyTheme(deck, t) }
    }
    case 'replace': {
      const find = str(op, 'find')
      if (!find) throw new OpError('"replace" needs find')
      const re = new RegExp(op.regex ? find : escapeRe(find), (op.all ? 'g' : '') + (op.ignoreCase ? 'i' : ''))
      const withText = str(op, 'with')
      let count = 0
      const next = structuredClone(deck)
      outer: for (const s of next.slides) {
        for (const e of s.elements)
          for (const p of e.paras || [])
            for (const r of p.runs) {
              if (!op.all && count) break outer
              r.text = r.text.replace(re, (...m) => (count++, op.regex ? m[0].replace(new RegExp(re.source, op.ignoreCase ? 'i' : ''), withText) : withText))
            }
        if (op.all || !count) s.notes = s.notes.replace(re, () => (count++, withText))
      }
      return { result: { count }, deck: count ? next : undefined }
    }
    case 'find': {
      const q = str(op, 'query').toLowerCase()
      if (!q) throw new OpError('"find" needs query')
      const matches: { slide: number; block: number; text: string }[] = []
      deck.slides.forEach((s, i) => {
        for (const line of [...slideText(s).split('\n'), s.notes]) if (line.toLowerCase().includes(q)) matches.push({ slide: i + 1, block: i + 1, text: line })
      })
      return { result: { matches } }
    }
    case 'outline':
      return { result: { slides: deck.slides.map(summary) } }
    case 'info':
      return {
        result: {
          slides: deck.slides.length,
          words: countWords(deck.slides.map(slideText).join(' ')),
          theme: deck.theme.name,
          outline: deck.slides.map(summary)
        }
      }
    case 'slide': {
      const i = at(op.slide)
      return { result: { ...summary(deck.slides[i], i), content: slideToMarkdown(deck.slides[i]), notes: deck.slides[i].notes } }
    }
    default:
      throw new OpError(
        `Unknown op "${op.op}" for presentations. Try: read, write, append, addSlide, updateSlide, deleteSlide, moveSlide, duplicateSlide, setNotes, setTheme, replace, find, outline, info`
      )
  }
}

function setRoleText(s: Slide, role: 'title' | 'subtitle', text: string) {
  let el = s.elements.find(e => e.role === role)
  if (!el) {
    const tpl = makeSlide(role === 'title' ? 'titleBody' : 'title').elements.find(e => e.role === role)!
    s.elements.unshift(tpl)
    el = tpl
  }
  const base = { ...(el.paras?.[0]?.runs[0] || {}), text: '' }
  const p0: SlidePara = { ...(el.paras?.[0] || { runs: [] }), runs: mdToRuns(text, base) }
  el.paras = [p0]
}

/** Image data stays out of JSON reads (it can be megabytes); the ids say where images are. */
function stripImages(deck: Deck): Deck {
  return {
    ...deck,
    slides: deck.slides.map(s => ({ ...s, elements: s.elements.map(e => (e.src?.startsWith('data:') ? { ...e, src: `embedded:${e.id}` } : e)) }))
  }
}

export const slidesOps: OpHandler = (payload, op) => {
  if (payload.kind !== 'slides') throw new OpError('not a presentation')
  const r = applySlidesOp(payload.deck, op)
  return { result: r.result, payload: r.deck ? { ...payload, deck: r.deck } : undefined }
}

