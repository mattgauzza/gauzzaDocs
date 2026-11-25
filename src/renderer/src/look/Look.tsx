import { Suspense, useEffect, useRef, useState } from 'react'
import type { Kind } from '../../../shared/kinds'
import type { FilePayload, Settings } from '../../../shared/types'
import { slideHtml } from '../../../shared/slides/html'
import { EDITORS } from '../editors'
import { api } from '../lib'

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
      if (req.kind === 'slides') return { unit: 'slide', total: document.querySelectorAll('.look-unit').length }
      const el = scroller()
      return { unit: 'screen', total: el ? screens(el) : 1 }
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
