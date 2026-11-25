import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Deck } from '../../../shared/types'
import { SLIDE_H, SLIDE_W } from '../../../shared/slides/model'
import { SlideImage } from './Filmstrip'
import { Icon } from './icons'

/** Size of an element, kept up to date (a callback ref, so it follows the element when the view switches). */
function useSize() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    if (!el) return
    const set = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, size] as const
}

/** The largest 16:9 width that fits a box. */
const fitW = (w: number, h: number) => Math.max(0, Math.min(w, (h * SLIDE_W) / SLIDE_H))

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Slideshow, full screen. Arrows, Space, Page Up/Down or a click move between slides; Esc ends it. S switches to the
 * presenter view (current and next slide, speaker notes, timer) and back; B blacks out the screen.
 */
export function Present({ deck, start, presenter: startPresenter, onExit }: { deck: Deck; start: number; presenter: boolean; onExit(at: number): void }) {
  const n = deck.slides.length
  const [i, setI] = useState(Math.min(start, n - 1))
  const [end, setEnd] = useState(false)
  const [black, setBlack] = useState(false)
  const [presenter, setPresenter] = useState(startPresenter)
  const [t0, setT0] = useState(() => Date.now())
  const [paused, setPaused] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [notesSize, setNotesSize] = useState(20)
  const [bar, setBar] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [stageRef, stage] = useSize()
  const exited = useRef(false)
  const st = useRef({ i, end })
  st.current = { i, end }

  const exit = () => {
    if (exited.current) return
    exited.current = true
    onExit(st.current.i)
  }
  const next = () => {
    const { i, end } = st.current
    setBlack(false)
    if (i < n - 1) setI(i + 1)
    else if (!end) setEnd(true)
    else exit()
  }
  const prev = () => {
    setBlack(false)
    if (st.current.end) setEnd(false)
    else setI(Math.max(0, st.current.i - 1))
  }

  useEffect(() => {
    rootRef.current?.requestFullscreen?.().catch(() => {})
    const fs = () => !document.fullscreenElement && exit()
    document.addEventListener('fullscreenchange', fs)
    const tick = setInterval(() => setNow(Date.now()), 500)
    return () => {
      clearInterval(tick)
      document.removeEventListener('fullscreenchange', fs)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = e.key
      let done = true
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) next()
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) prev()
      else if (k === 'Home') (setEnd(false), setI(0))
      else if (k === 'End') (setEnd(false), setI(n - 1))
      else if (k === 'Escape') exit()
      else if (k === 's' || k === 'S') setPresenter(v => !v)
      else if (k === 'b' || k === 'B' || k === '.') setBlack(v => !v)
      else done = false
      if (done) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  useEffect(() => {
    if (!bar) return
    const t = setTimeout(() => setBar(false), 2500)
    return () => clearTimeout(t)
  }, [bar, i])

  const slide = deck.slides[i]
  const elapsed = (paused ?? now) - t0
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  if (presenter) {
    const nextSlide = deck.slides[i + 1]
    return (
      <div ref={rootRef} className="sl-present sl-presenter">
        <div className="sl-pv-main" ref={stageRef}>
          <div className="sl-pv-label">{end ? 'End of presentation' : `Slide ${i + 1} of ${n}`}</div>
          {!end && slide && <SlideImage slide={slide} deck={deck} width={fitW(stage.w, stage.h - 28)} />}
        </div>
        <div className="sl-pv-side">
          <div className="sl-pv-label">Next</div>
          {nextSlide && !end ? <SlideImage slide={nextSlide} deck={deck} width={300} /> : <div className="sl-pv-endcard">End of presentation</div>}
          <div className="sl-pv-timer">
            <span>{clock(elapsed)}</span>
            <button className="tb" title={paused ? 'Resume' : 'Pause'} onClick={() => (paused ? (setT0(t0 + Date.now() - paused), setPaused(null)) : setPaused(Date.now()))}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <button className="tb" title="Reset timer" onClick={() => (setT0(Date.now()), setPaused(paused ? Date.now() : null))}>
              <Icon name="reset" />
            </button>
          </div>
          <div className="sl-pv-nav">
            <button className="sl-pv-btn" onClick={prev}><Icon name="left" /> Previous</button>
            <button className="sl-pv-btn" onClick={next}>Next <Icon name="right" /></button>
          </div>
          <div className="sl-pv-nav">
            <button className="sl-pv-btn" title="S" onClick={() => setPresenter(false)}>Audience view</button>
            <button className="sl-pv-btn" title="Esc" onClick={exit}>End show</button>
          </div>
        </div>
        <div className="sl-pv-notes">
          <div className="sl-pv-notes-head">
            <span>Speaker notes</span>
            <button className="tb" title="Smaller" onClick={() => setNotesSize(s => Math.max(12, s - 2))}>A-</button>
            <button className="tb" title="Larger" onClick={() => setNotesSize(s => Math.min(40, s + 2))}>A+</button>
          </div>
          <div className="sl-pv-notes-text" style={{ fontSize: notesSize }}>{(!end && slide?.notes) || <span className="muted">No notes for this slide.</span>}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="sl-present"
      onClick={next}
      onContextMenu={e => (e.preventDefault(), prev())}
      onMouseMove={() => setBar(true)}
    >
      <div className="sl-present-stage" ref={stageRef}>
        {black ? null : end ? (
          <div className="sl-end">End of presentation. Click to exit.</div>
        ) : (
          slide && <SlideImage slide={slide} deck={deck} width={fitW(stage.w, stage.h)} />
        )}
      </div>
      <div className={`sl-present-bar${bar ? ' show' : ''}`} onClick={stop} onContextMenu={stop}>
        <button className="tb" title="Previous" onClick={prev}><Icon name="left" /></button>
        <span>{Math.min(i + 1, n)} / {n}</span>
        <button className="tb" title="Next" onClick={next}><Icon name="right" /></button>
        <span className="sl-present-sep" />
        <button className="tb" title="Presenter view (S)" onClick={() => setPresenter(true)}><Icon name="presenter" /></button>
        <button className="tb" title="Exit (Esc)" onClick={exit}><Icon name="close" /></button>
      </div>
    </div>
  )
}
