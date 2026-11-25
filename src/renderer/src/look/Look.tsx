import { Suspense, useEffect, useRef, useState } from 'react'
import type { Kind } from '../../../shared/kinds'
import type { FilePayload, Settings } from '../../../shared/types'
import { slideHtml } from '../../../shared/slides/html'
import { EDITORS } from '../editors'
import { api } from '../lib'
import { CONTENT_H, MARGIN } from '../doc/pagination'

/**
 * The hidden window that lets agents see a file (`gdocs look`). Main sends the content (the open tab's, unsaved
 * changes included, or the file from disk), this mounts the same editor the app uses, and main captures it one
 * page, slide or screen at a time. Nothing here saves or changes anything.
 */
interface Job { n: number; path: string; kind: Kind; payload: FilePayload; settings: Settings }
interface Rect { x: number; y: number; width: number; height: number }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const frames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
/** The part of each editor that holds the content (no toolbars, no side panels). */
const SCROLLERS = '.doc-canvas, .md-reader-scroll, .pdf-scroll, .sg-scroll, .cm-scroller'
/** Screens overlap a little so a line cut at the bottom of one is whole at the top of the next. */
const OVERLAP = 48

function scroller(): HTMLElement | null {
  let best: HTMLElement | null = null
  let area = 0
  for (const el of document.querySelectorAll<HTMLElement>(`.look-host :is(${SCROLLERS})`)) {
    const a = el.clientWidth * el.clientHeight
    if (a > area) (best = el), (area = a)
  }
  return best
}

function screens(el: HTMLElement) {
  const step = Math.max(200, el.clientHeight - OVERLAP)
  return Math.max(1, Math.ceil(Math.max(0, el.scrollHeight - el.clientHeight) / step) + 1)
}

// ---------- layout notes: problems an agent should fix, in words, next to the pictures ----------
const clip = (el: Element | null) => {
  const t = ((el as HTMLElement | null)?.innerText || '').trim().replace(/\s+/g, ' ')
  return t.length > 48 ? `${t.slice(0, 45)}...` : t
}
const whatIs = (el: Element) => (el.querySelector('table') || el.tagName === 'TABLE' ? 'table' : el.tagName === 'PRE' ? 'code block' : el.querySelector('img') ? 'picture' : 'block')

/** Pages of a document: headings left at the bottom of a page, mostly empty pages, blocks too tall for a page. */
function docNotes(): string[] {
  const pm = document.querySelector<HTMLElement>('.look-host .ProseMirror')
  if (!pm) return []
  const scale = pm.getBoundingClientRect().height / (pm.offsetHeight || 1) || 1
  const notes: string[] = []
  let page = 1
  let last: HTMLElement | null = null
  for (const el of pm.children as HTMLCollectionOf<HTMLElement>) {
    if (el.classList.contains('gd-page-gap')) {
      const empty = (parseFloat(el.querySelector<HTMLElement>('.gd-page-fill')?.style.height || '0') - MARGIN) / CONTENT_H
      const next = el.nextElementSibling
      if (last && /^H[1-6]$/.test(last.tagName)) notes.push(`Page ${page} ends with the heading "${clip(last)}" and its section starts on page ${page + 1}.`)
      else if (empty > 0.5 && !last?.classList.contains('page-break') && next)
        notes.push(`Page ${page} is ${Math.round(empty * 100)}% empty because the ${whatIs(next)} "${clip(next)}" didn't fit, so it starts page ${page + 1}.`)
      page++
      last = null
      continue
    }
    if (el.getBoundingClientRect().height / scale > CONTENT_H + 1) notes.push(`The ${whatIs(el)} "${clip(el)}" is taller than a page and runs past the bottom of page ${page}. Split it into smaller parts.`)
    last = el
  }
  return notes
}

/** Slides: text cut off by its box, and things that go past the edge of the slide. */
function slideNotes(): string[] {
  const notes: string[] = []
  document.querySelectorAll<HTMLElement>('.look-unit .gd-slide').forEach((slide, i) => {
    const s = slide.getBoundingClientRect()
    for (const box of slide.children as HTMLCollectionOf<HTMLElement>) {
      const text = box.querySelector<HTMLElement>('.gd-text')
      const what = text ? `"${clip(text)}"` : box.querySelector('img') ? 'a picture' : 'a shape'
      if (text && text.scrollHeight > text.clientHeight + 2) notes.push(`Slide ${i + 1}: the text ${what} doesn't fit its box and is cut off.`)
      const r = box.getBoundingClientRect()
      if (r.right > s.right + 2 || r.bottom > s.bottom + 2 || r.left < s.left - 2 || r.top < s.top - 2) notes.push(`Slide ${i + 1}: ${what} goes past the edge of the slide.`)
    }
  })
  return notes
}

export default function Look() {
  const [job, setJob] = useState<Job | null>(null)
  const ready = useRef<(() => void) | null>(null)
  const kind = useRef<Kind>('doc')

  useEffect(() => {
    const offPrepare = window.gd.serve('look-prepare', async (req: Omit<Job, 'n' | 'settings'> & { theme?: string }) => {
      const settings = await api.settings()
      const theme = req.theme || settings.theme
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
      else delete document.documentElement.dataset.theme
      kind.current = req.kind
      setJob(null)
      await frames()
      const settled = new Promise<void>(r => (ready.current = r))
      setJob({ ...req, settings, n: Date.now() })
      if (req.kind === 'slides') ready.current?.()
      await Promise.race([settled, sleep(20_000)])
      await document.fonts.ready
      await sleep(req.kind === 'pdf' ? 1200 : 700) // pagination, pdf.js first pages, sheet layout
      await frames()
      if (req.kind === 'slides') return { unit: 'slide', total: document.querySelectorAll('.look-unit').length, notes: slideNotes() }
      const el = scroller()
      return { unit: 'screen', total: el ? screens(el) : 1, notes: req.kind === 'doc' ? docNotes() : [] }
    })

    const offShot = window.gd.serve('look-shot', async (req: { index: number }): Promise<Rect> => {
      if (kind.current === 'slides') {
        const unit = document.querySelectorAll<HTMLElement>('.look-unit')[req.index]
        if (!unit) throw new Error(`There is no slide ${req.index + 1}`)
        unit.scrollIntoView({ block: 'start' })
        await frames()
        const r = unit.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      }
      const el = scroller()
      const host = document.querySelector<HTMLElement>('.look-host')!
      if (!el) {
        const r = host.getBoundingClientRect()
        return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) }
      }
      el.scrollTop = req.index * Math.max(200, el.clientHeight - OVERLAP)
      el.dispatchEvent(new Event('scroll'))
      await frames()
      await sleep(kind.current === 'pdf' ? 700 : 150) // pdf.js draws pages as they scroll in; code and sheets virtualize
      await frames()
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: el.clientWidth, height: el.clientHeight }
    })
    return () => (offPrepare(), offShot())
  }, [])

  if (!job) return <div className="look-host" />
  if (job.payload.kind === 'slides') {
    const deck = job.payload.deck
    return (
      <div className="look-host look-slides">
        {deck.slides.map((s, i) => <div key={i} className="look-unit" dangerouslySetInnerHTML={{ __html: slideHtml(s, deck) }} />)}
      </div>
    )
  }
  const E = EDITORS[job.kind]
  return (
    <div className="look-host">
      <Suspense fallback={null}>
        <E key={job.n} path={job.path} payload={job.payload} settings={job.settings} active onChange={() => {}} setHandle={h => h && ready.current?.()} />
      </Suspense>
    </div>
  )
}
