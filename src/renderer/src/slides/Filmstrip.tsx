import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Deck, Slide } from '../../../shared/types'
import { slideHtml } from '../../../shared/slides/html'
import { SLIDE_H, SLIDE_W } from '../../../shared/slides/model'
import { PX } from './Canvas'

/** A slide drawn small (thumbnails, presenter view): the real slide HTML, scaled. */
export const SlideImage = memo(
  function SlideImage({ slide, deck, width }: { slide: Slide; deck: Deck; width: number }) {
    const html = useMemo(() => slideHtml(slide, deck), [slide, deck.theme])
    const s = width / (SLIDE_W * PX)
    return (
      <div className="sl-img" style={{ width, height: (width * SLIDE_H) / SLIDE_W }}>
        <div style={{ transform: `scale(${s})`, transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    )
  },
  (a, b) => a.slide === b.slide && a.deck.theme === b.deck.theme && a.width === b.width
)

const THUMB_W = 168

export function Filmstrip(props: {
  deck: Deck
  cur: number
  flash: { ids: string[]; n: number } | null
  onPick(i: number): void
  onMove(from: number, to: number): void
  onContext(e: React.MouseEvent, i: number): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: number; at: number | null } | null>(null)

  useEffect(() => {
    ref.current?.querySelector(`[data-i="${props.cur}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [props.cur, props.deck.slides.length])

  const n = props.deck.slides.length
  return (
    <div className="sl-film" ref={ref} tabIndex={0} aria-label="Slides">
      {props.deck.slides.map((s, i) => {
        const flashing = props.flash?.ids.includes(s.id)
        const dropCls = drag && drag.at === i ? ' drop-before' : drag && drag.at === n && i === n - 1 ? ' drop-after' : ''
        return (
          <div
            key={s.id}
            data-i={i}
            className={`sl-film-item${i === props.cur ? ' current' : ''}${dropCls}`}
            draggable
            onMouseDown={() => props.onPick(i)}
            onContextMenu={e => {
              e.preventDefault()
              props.onPick(i)
              props.onContext(e, i)
            }}
            onDragStart={e => {
              setDrag({ from: i, at: null })
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/x-gd-slide', String(i))
            }}
            onDragOver={e => {
              if (!drag) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              const at = e.clientY < r.top + r.height / 2 ? i : i + 1
              if (at !== drag.at) setDrag({ ...drag, at })
            }}
            onDrop={e => {
              e.preventDefault()
              if (drag && drag.at != null) {
                const to = drag.at > drag.from ? drag.at - 1 : drag.at
                if (to !== drag.from) props.onMove(drag.from, to)
              }
              setDrag(null)
            }}
            onDragEnd={() => setDrag(null)}
          >
            <span className="sl-film-num">{i + 1}</span>
            <div key={flashing ? `f${props.flash!.n}` : 'n'} className={`sl-film-thumb${flashing ? ' agent-ring' : ''}`}>
              <SlideImage slide={s} deck={props.deck} width={THUMB_W} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
