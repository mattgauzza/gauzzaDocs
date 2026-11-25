import type { Deck, DeckTheme, Slide, SlideElement, SlideLayout, SlidePara, SlideRun } from '../types'
import { DEFAULT_THEME, SLIDE_W, makeSlide, newId, r3, run } from './model'

/**
 * Decks as Markdown, for agents and for `gdocs read`:
 *
 *   <!-- layout: title -->        optional; title | titleBody | twoColumn | section | blank
 *   # Slide title
 *   A plain line (a subtitle on title slides, a paragraph elsewhere)
 *   - bullet
 *     - nested bullet (two spaces per level)
 *   1. numbered item
 *   <!-- column -->               starts the right column (two columns layout)
 *   ![chart](./chart.png)         an image (embedded images read back as embedded:<id>)
 *   Notes: speaker notes, to the end of the slide
 *   ---                           next slide
 */
const LAYOUT_IDS: SlideLayout[] = ['title', 'titleBody', 'twoColumn', 'section', 'blank']

// ---------- deck -> Markdown ----------

const runsToMd = (runs: SlideRun[]) =>
  runs
    .map(r => {
      if (!r.text) return ''
      let t = r.text.replace(/([*_`\\])/g, '\\$1')
      if (r.b && r.i) t = `***${t}***`
      else if (r.b) t = `**${t}**`
      else if (r.i) t = `*${t}*`
      return t
    })
    .join('')

function parasToMd(paras: SlidePara[]): string[] {
  const out: string[] = []
  let n = 0
  for (const p of paras) {
    const text = runsToMd(p.runs)
    if (!p.bullet) n = 0
    if (!text.trim()) continue
    const pad = '  '.repeat(p.level || 0)
    if (p.bullet === 'number') out.push(`${pad}${++n}. ${text}`)
    else if (p.bullet === 'bullet') out.push(`${pad}- ${text}`)
    else out.push(text)
  }
  return out
}

export function slideToMarkdown(s: Slide): string {
  const lines: string[] = []
  if (s.layout !== 'titleBody') lines.push(`<!-- layout: ${s.layout} -->`)
  const title = s.elements.find(e => e.role === 'title')
  if (title) lines.push(`# ${(title.paras || []).map(p => runsToMd(p.runs)).join(' ').trim()}`)
  const bodies = s.elements.filter(e => e.role === 'body')
  for (const el of s.elements) {
    if (el === title) continue
    if (el.type === 'image') {
      lines.push(`![image](${el.src && !el.src.startsWith('data:') ? el.src : `embedded:${el.id}`})`)
      continue
    }
    if (el.role === 'body' && s.layout === 'twoColumn' && bodies.indexOf(el) === 1) lines.push('<!-- column -->')
    if (el.paras) lines.push(...parasToMd(el.paras))
  }
  if (s.notes.trim()) lines.push('', `Notes: ${s.notes.trim()}`)
  return lines.join('\n')
}

export const deckToMarkdown = (deck: Deck) => deck.slides.map(slideToMarkdown).join('\n\n---\n\n') + '\n'

// ---------- Markdown -> deck ----------

/** **bold**, *italic*, ***both*** and backslash escapes into runs. */
export function mdToRuns(text: string, base: Partial<SlideRun>): SlideRun[] {
  const runs: SlideRun[] = []
  // Asterisks only: underscores are left alone so snake_case names in agent text stay as they are.
  const re = /\\([*_`\\])|(\*\*\*)(.+?)\2|(\*\*)(.+?)\4|(\*)(.+?)\6/g
  let last = 0
  let plain = ''
  const flush = () => {
    if (plain) runs.push({ ...base, text: plain })
    plain = ''
  }
  for (let m = re.exec(text); m; m = re.exec(text)) {
    plain += text.slice(last, m.index)
    last = m.index + m[0].length
    if (m[1]) {
      plain += m[1]
      continue
    }
    flush()
    if (m[3] !== undefined) runs.push({ ...base, text: m[3], b: true, i: true })
    else if (m[5] !== undefined) runs.push({ ...base, text: m[5], b: true })
    else runs.push({ ...base, text: m[7], i: true })
  }
  plain += text.slice(last)
  flush()
  return runs.length ? runs : [{ ...base, text: '' }]
}

interface Parsed {
  layout?: SlideLayout
  title?: string
  lines: { kind: 'bullet' | 'number' | 'plain'; level: number; text: string; column: 0 | 1 }[]
  images: { alt: string; src: string }[]
  notes: string
  hasColumn: boolean
}

function parseChunk(chunk: string): Parsed {
  const out: Parsed = { lines: [], images: [], notes: '', hasColumn: false }
  let column: 0 | 1 = 0
  let inNotes = false
  const notes: string[] = []
  for (const raw of chunk.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (inNotes) {
      notes.push(line)
      continue
    }
    const lm = line.match(/^<!--\s*layout:\s*([\w-]+)\s*-->$/i)
    if (lm) {
      const id = LAYOUT_IDS.find(l => l.toLowerCase() === lm[1].toLowerCase().replace(/-/g, ''))
      if (id) out.layout = id
      continue
    }
    if (/^<!--\s*column\s*-->$/i.test(line)) {
      column = 1
      out.hasColumn = true
      continue
    }
    const nm = line.match(/^notes:\s*(.*)$/i)
    if (nm) {
      inNotes = true
      if (nm[1]) notes.push(nm[1])
      continue
    }
    const hm = line.match(/^#{1,2}\s+(.*)$/)
    if (hm && out.title === undefined) {
      out.title = hm[1].trim()
      continue
    }
    const im = line.match(/^\s*!\[([^\]]*)\]\(([^)]*)\)\s*$/)
    if (im) {
      out.images.push({ alt: im[1], src: im[2] })
      continue
    }
    const bm = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (bm) {
      out.lines.push({ kind: /\d/.test(bm[2]) ? 'number' : 'bullet', level: Math.min(4, Math.floor(bm[1].replace(/\t/g, '  ').length / 2)), text: bm[3], column })
      continue
    }
    if (line.trim()) out.lines.push({ kind: 'plain', level: 0, text: line.trim().replace(/^#{3,6}\s+/, ''), column })
  }
  out.notes = notes.join('\n').trim()
  return out
}

/**
 * One slide from its Markdown. `existing` lets embedded:<id> images (and their places) survive a round trip, and keeps
 * the slide's id when an agent updates it.
 */
export function slideFromMarkdown(md: string, theme: DeckTheme = DEFAULT_THEME, index = 1, existing?: Slide): Slide {
  const p = parseChunk(md)
  const body = p.lines
  const hasBullets = body.some(l => l.kind !== 'plain')
  const layout: SlideLayout =
    p.layout ??
    (p.hasColumn ? 'twoColumn'
      : index === 0 && !hasBullets && body.length <= 2 && !p.images.length ? 'title'
        : p.title !== undefined && !body.length && !p.images.length ? 'section'
          : p.title === undefined && !body.length && !p.images.length ? 'blank'
            : 'titleBody')
  const subtitle = layout === 'title' || layout === 'section' ? body.map(l => l.text).join(' ') || undefined : undefined
  const s = makeSlide(layout, { title: p.title, subtitle, notes: p.notes }, theme)
  if (existing) s.id = existing.id

  const toParas = (items: typeof body, size: number): SlidePara[] =>
    items.map(l => ({
      runs: mdToRuns(l.text, { size: Math.max(14, size - l.level * 2), color: theme.text }),
      ...(l.kind === 'plain' ? {} : { bullet: l.kind, level: l.level })
    }))
  const bodies = s.elements.filter(e => e.role === 'body')
  if (layout === 'titleBody' && bodies[0]) bodies[0].paras = body.length ? toParas(body, 20) : bodies[0].paras
  if (layout === 'twoColumn') {
    const left = body.filter(l => l.column === 0)
    const right = body.filter(l => l.column === 1)
    if (bodies[0] && left.length) bodies[0].paras = toParas(left, 18)
    if (bodies[1] && right.length) bodies[1].paras = toParas(right, 18)
  }
  if (layout === 'blank' && body.length) {
    s.elements.push({ id: newId(), type: 'text', x: 0.6, y: 0.6, w: SLIDE_W - 1.2, h: 6.2, paras: toParas(body, 20), valign: 'top' })
  }
  const title = s.elements.find(e => e.role === 'title')
  if (title && p.title !== undefined && title.paras?.[0]) {
    const base = { ...title.paras[0].runs[0], text: '' }
    title.paras[0].runs = mdToRuns(p.title, base)
  }

  // Images: an embedded one keeps its place; new ones go to the right half (or the middle of an empty slide).
  const prior = new Map((existing?.elements || []).filter(e => e.type === 'image').map(e => [e.id, e]))
  p.images.forEach((img, k) => {
    const ref = img.src.match(/^embedded:(.+)$/)
    const old = ref ? prior.get(ref[1]) : undefined
    if (old) return void s.elements.push(structuredClone(old))
    if (ref) return // unknown embedded image: nothing to show
    const w = 4.8
    const h = 3.6
    const placed = layout === 'titleBody' || layout === 'twoColumn'
    if (placed && bodies[0] && k === 0) bodies[0].w = r3(SLIDE_W - 1.2 - w - 0.4)
    s.elements.push({ id: newId(), type: 'image', src: img.src, x: r3(placed ? SLIDE_W - 0.6 - w : (SLIDE_W - w) / 2), y: r3(placed ? 1.8 + k * 0.4 : 1.95), w, h })
  })
  return s
}

/** Splits Markdown into slides on lines that are exactly "---" (outside fenced code). */
export function splitSlides(md: string): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  let fence = false
  const lines = md.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, m => (/^---\n[\w-]+:/.test(m) ? '' : m)).split('\n')
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && /^\s*---\s*$/.test(line)) {
      chunks.push(cur.join('\n'))
      cur = []
    } else cur.push(line)
  }
  chunks.push(cur.join('\n'))
  return chunks.map(c => c.trim()).filter((c, i, all) => c || all.length === 1)
}

export function markdownToDeck(md: string, theme: DeckTheme = DEFAULT_THEME, existing?: Deck): Deck {
  const chunks = splitSlides(md)
  return {
    size: existing?.size || { w: SLIDE_W, h: 7.5 },
    theme: { ...(existing?.theme || theme) },
    slides: chunks.map((c, i) => slideFromMarkdown(c, existing?.theme || theme, i, existing?.slides[i]))
  }
}
