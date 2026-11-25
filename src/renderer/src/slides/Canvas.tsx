import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Deck, Slide, SlideElement } from '../../../shared/types'
import { cssFont, elementInner } from '../../../shared/slides/html'
import { SLIDE_H, SLIDE_W, bg, r3 } from '../../../shared/slides/model'
import { editHtml } from './textEdit'

export const PX = 96 // CSS px per inch
export type Tool = 'select' | 'text' | 'rect' | 'roundRect' | 'ellipse' | 'line' | 'arrow'
export interface Editing { id: string; at?: { x: number; y: number }; all?: boolean; n: number }

export const isLine = (el: SlideElement) => el.shape === 'line' || el.shape === 'arrow'
export const canHoldText = (el: SlideElement) => el.type === 'text' || (el.type === 'shape' && !isLine(el))

const boxStyle = (el: SlideElement): React.CSSProperties => ({
  left: `${el.x}in`,
  top: `${el.y}in`,
  width: `${el.w}in`,
  height: `${el.h}in`,
  transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined
})

/** One element, drawn with the same HTML as thumbnails and print. Re-renders only when the element changes. */
const ElView = memo(
  function ElView({ el, deck, noText }: { el: SlideElement; deck: Deck; noText?: boolean }) {
    const html = useMemo(() => elementInner(noText ? { ...el, paras: undefined } : el, deck), [el, deck.theme, noText])
    return <div className={`sl-el${isLine(el) ? ' sl-line' : ''}`} data-id={el.id} style={boxStyle(el)} dangerouslySetInnerHTML={{ __html: html }} />
  },
  (a, b) => a.el === b.el && a.deck.theme === b.deck.theme && a.noText === b.noText
)

/** The text of the element being edited, as a contentEditable box laid out like the rendered text. */
function EditBox(props: { el: SlideElement; deck: Deck; editing: Editing; editRef: React.MutableRefObject<HTMLDivElement | null>; onInput(): void }) {
  const { el, deck, editing } = props
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const d = ref.current!
    const start = el.paras?.length ? el.paras : [{ runs: [{ text: '', size: 18, color: deck.theme.text }], align: el.type === 'shape' ? ('center' as const) : undefined }]
    d.innerHTML = editHtml(start, deck.theme)
    props.editRef.current = d
    d.focus()
    const sel = getSelection()!
    let r: Range | null = editing.at ? document.caretRangeFromPoint(editing.at.x, editing.at.y) : null
    if (r && !d.contains(r.startContainer)) r = null
    if (!r || editing.all) {
      r = document.createRange()
      r.selectNodeContents(d)
      if (!editing.all) r.collapse(false)
    }
    sel.removeAllRanges()
    sel.addRange(r)
    return () => {
      if (props.editRef.current === d) props.editRef.current = null
    }
  }, [])
  const justify = el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start'
  return (
    <div className="sl-el sl-editing" style={boxStyle(el)}>
      <div className="sl-edit-wrap" style={{ justifyContent: justify, fontFamily: cssFont(deck.theme.bodyFont), color: deck.theme.text }}>
        <div ref={ref} className="sl-edit" contentEditable suppressContentEditableWarning spellCheck onInput={props.onInput} />
      </div>
    </div>
  )
}

interface Props {
  /** Percent of the size that fits the window (Ctrl+scroll). Above 100 the view scrolls. */
  zoom?: number
  deck: Deck
  slide: Slide
  sel: string[]
  editing: Editing | null
  tool: Tool
  flashKey: number
  editRef: React.MutableRefObject<HTMLDivElement | null>
  onSelect(ids: string[]): void
  onEdit(e: Omit<Editing, 'n'> | null): void
  onSlide(next: Slide, live?: boolean): void
  onCreate(el: SlideElement, edit: boolean): void
  onContext(e: React.MouseEvent, id: string | null): void
  onDropFiles(files: File[], at: { x: number; y: number }): void
  onEditInput(): void
  /** The slide as it is right now (props can lag a commit made in the same event, e.g. leaving a text edit). */
  getSlide(): Slide
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function Canvas(p: Props) {
  const viewRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fitScale, setScale] = useState(0.5)
  const scale = fitScale * ((p.zoom || 100) / 100)
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; kind: 'marquee' | 'draw' } | null>(null)
  const pr = useRef(p)
  pr.current = p

  useLayoutEffect(() => {
    const v = viewRef.current!
    const fit = () => setScale(Math.max(0.05, Math.min((v.clientWidth - 56) / (SLIDE_W * PX), (v.clientHeight - 48) / (SLIDE_H * PX))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(v)
    return () => ro.disconnect()
  }, [])

  const k = PX * scale // screen px per inch
  const toIn = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: (cx - r.left) / k, y: (cy - r.top) / k }
  }
  const idAt = (t: EventTarget | null) => ((t as Element | null)?.closest?.('.sl-el[data-id]') as HTMLElement | null)?.dataset.id || null

  /** Window listeners for one drag; returns when the pointer is released. */
  const track = (move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) => {
    const mv = (e: PointerEvent) => move(e)
    const u = (e: PointerEvent) => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', u)
      window.removeEventListener('pointercancel', u)
      up(e)
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', u)
    window.addEventListener('pointercancel', u)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('.sl-edit')) return // typing and selecting text
    if (t.closest('.sl-h, .sl-rot')) return
    const { sel, tool, editing } = pr.current
    if (editing) p.onEdit(null)
    const slide = pr.current.getSlide()
    viewRef.current?.focus({ preventScroll: true })
    const start = toIn(e.clientX, e.clientY)

    // Drawing a new text box or shape.
    if (tool !== 'select') {
      e.preventDefault()
      let end = start
      track(
        ev => {
          end = toIn(ev.clientX, ev.clientY)
          if (ev.shiftKey && tool !== 'text') {
            const s = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
            end = { x: start.x + Math.sign(end.x - start.x || 1) * s, y: start.y + Math.sign(end.y - start.y || 1) * s }
          }
          setBox({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y), kind: 'draw' })
        },
        () => {
          setBox(null)
          create(tool, start, end)
        }
      )
      return
    }

    const id = idAt(t)
    if (!id) {
      // Empty canvas: click clears the selection, drag selects with a rectangle.
      const base = e.shiftKey ? sel : []
      if (!e.shiftKey) p.onSelect([])
      let moved = false
      track(
        ev => {
          const cur = toIn(ev.clientX, ev.clientY)
          const r = { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) }
          if (!moved && r.w * k < 3 && r.h * k < 3) return
          moved = true
          setBox({ ...r, kind: 'marquee' })
          const hit = slide.elements.filter(el => el.x < r.x + r.w && el.x + el.w > r.x && el.y < r.y + r.h && el.y + el.h > r.y).map(el => el.id)
          pr.current.onSelect([...new Set([...base, ...hit])])
        },
        () => setBox(null)
      )
      return
    }

    // An element: select it (Shift / Ctrl add or remove) and drag the selection.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      p.onSelect(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id])
      return
    }
    const ids = sel.includes(id) ? sel : [id]
    if (!sel.includes(id)) p.onSelect(ids)
    e.preventDefault()
    const starts = new Map(slide.elements.filter(el => ids.includes(el.id)).map(el => [el.id, el]))
    const others = slide.elements.filter(el => !starts.has(el.id))
    const bx0 = Math.min(...[...starts.values()].map(el => el.x))
    const by0 = Math.min(...[...starts.values()].map(el => el.y))
    const bx1 = Math.max(...[...starts.values()].map(el => el.x + el.w))
    const by1 = Math.max(...[...starts.values()].map(el => el.y + el.h))
    const xs = [0, SLIDE_W / 2, SLIDE_W, ...others.flatMap(o => [o.x, o.x + o.w / 2, o.x + o.w])]
    const ys = [0, SLIDE_H / 2, SLIDE_H, ...others.flatMap(o => [o.y, o.y + o.h / 2, o.y + o.h])]
    let last: Slide | null = null
    track(
      ev => {
        let dx = (ev.clientX - e.clientX) / k
        let dy = (ev.clientY - e.clientY) / k
        if (!last && Math.hypot(dx * k, dy * k) < 3) return
        const gx: number[] = []
        const gy: number[] = []
        if (!ev.altKey) {
          const tol = 6 / k
          const snap = (edges: number[], targets: number[], out: number[]) => {
            let best: { d: number; at: number } | null = null
            for (const a of edges) for (const b of targets) if (Math.abs(b - a) < tol && (!best || Math.abs(b - a) < Math.abs(best.d))) best = { d: b - a, at: b }
            if (best) out.push(best.at)
            return best ? best.d : 0
          }
          dx += snap([bx0 + dx, (bx0 + bx1) / 2 + dx, bx1 + dx], xs, gx)
          dy += snap([by0 + dy, (by0 + by1) / 2 + dy, by1 + dy], ys, gy)
        }
        setGuides({ x: gx, y: gy })
        last = { ...slide, elements: slide.elements.map(el => (starts.has(el.id) ? { ...el, x: r3(el.x + dx), y: r3(el.y + dy) } : el)) }
        pr.current.onSlide(last, true)
      },
      () => {
        setGuides({ x: [], y: [] })
        if (last) pr.current.onSlide(last)
      }
    )
  }

  const create = (tool: Tool, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const { deck } = pr.current
    const th = deck.theme
    let x = Math.min(a.x, b.x)
    let y = Math.min(a.y, b.y)
    let w = Math.abs(b.x - a.x)
    let h = Math.abs(b.y - a.y)
    const click = w < 0.1 && h < 0.1
    const line = tool === 'line' || tool === 'arrow'
    if (click) {
      ;[w, h] = tool === 'text' ? [4, 0.6] : line ? [2.5, 0] : [2, 2]
      x = a.x - (tool === 'text' ? 0 : w / 2)
      y = a.y - (tool === 'text' ? 0 : h / 2)
    }
    if (tool === 'text') h = Math.max(h, 0.6)
    const base = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, x: r3(x), y: r3(y), w: r3(w), h: r3(h) }
    if (tool === 'text') {
      p.onCreate({ ...base, type: 'text', valign: 'top', paras: [{ runs: [{ text: '', size: 18, color: th.text }] }] }, true)
    } else if (line) {
      p.onCreate({ ...base, type: 'shape', shape: tool, stroke: th.accent, strokeWidth: 2 }, false)
    } else {
      p.onCreate({ ...base, type: 'shape', shape: tool as SlideElement['shape'], fill: th.accent, valign: 'middle' }, false)
    }
  }

  const startResize = (e: React.PointerEvent, el: SlideElement, dir: string) => {
    e.stopPropagation()
    e.preventDefault()
    const slide = pr.current.getSlide()
    const rad = ((el.rotation || 0) * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const ax = dir.includes('e') ? -1 : dir.includes('w') ? 1 : 0
    const ay = dir.includes('s') ? -1 : dir.includes('n') ? 1 : 0
    const cx0 = el.x + el.w / 2
    const cy0 = el.y + el.h / 2
    const anchorX = cx0 + ((ax * el.w) / 2) * cos - ((ay * el.h) / 2) * sin
    const anchorY = cy0 + ((ax * el.w) / 2) * sin + ((ay * el.h) / 2) * cos
    let last: Slide | null = null
    track(
      ev => {
        const dx = (ev.clientX - e.clientX) / k
        const dy = (ev.clientY - e.clientY) / k
        const lx = dx * cos + dy * sin
        const ly = -dx * sin + dy * cos
        let w = el.w + (dir.includes('e') ? lx : dir.includes('w') ? -lx : 0)
        let h = el.h + (dir.includes('s') ? ly : dir.includes('n') ? -ly : 0)
        const min = isLine(el) ? 0 : 0.05
        w = Math.max(min, w)
        h = Math.max(min, h)
        if ((ev.shiftKey || el.type === 'image') && dir.length === 2 && el.w > 0 && el.h > 0) {
          const f = Math.max(w / el.w, h / el.h)
          w = el.w * f
          h = el.h * f
        }
        const cx = anchorX - (((ax * w) / 2) * cos - ((ay * h) / 2) * sin)
        const cy = anchorY - (((ax * w) / 2) * sin + ((ay * h) / 2) * cos)
        const next = { ...el, x: r3(cx - w / 2), y: r3(cy - h / 2), w: r3(w), h: r3(h) }
        last = { ...slide, elements: slide.elements.map(x => (x.id === el.id ? next : x)) }
        pr.current.onSlide(last, true)
      },
      () => last && pr.current.onSlide(last)
    )
  }

  const startRotate = (e: React.PointerEvent, el: SlideElement) => {
    e.stopPropagation()
    e.preventDefault()
    const slide = pr.current.getSlide()
    const r = wrapRef.current!.getBoundingClientRect()
    const cx = r.left + (el.x + el.w / 2) * k
    const cy = r.top + (el.y + el.h / 2) * k
    let last: Slide | null = null
    track(
      ev => {
        let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90
        if (ev.shiftKey) a = Math.round(a / 15) * 15
        else if (Math.abs(a - Math.round(a / 90) * 90) < 3) a = Math.round(a / 90) * 90
        a = Math.round((((a % 360) + 360) % 360) * 10) / 10
        const next: SlideElement = { ...el, rotation: a || undefined }
        if (!a) delete next.rotation
        last = { ...slide, elements: slide.elements.map(x => (x.id === el.id ? next : x)) }
        pr.current.onSlide(last, true)
      },
      () => last && pr.current.onSlide(last)
    )
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = idAt(e.target)
    const el = id && p.slide.elements.find(x => x.id === id)
    if (el && canHoldText(el)) p.onEdit({ id: el.id, at: { x: e.clientX, y: e.clientY } })
  }

  const selEls = p.slide.elements.filter(el => p.sel.includes(el.id))
  const single = selEls.length === 1 ? selEls[0] : null
  const editingEl = p.editing ? p.slide.elements.find(el => el.id === p.editing!.id) : undefined

  return (
    <div
      ref={viewRef}
      className={`sl-view${p.tool !== 'select' ? ' drawing' : ''}${(p.zoom || 100) > 100 ? ' zoomed' : ''}`}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => {
        if ((e.target as Element).closest('.sl-edit')) return
        e.preventDefault()
        const id = idAt(e.target)
        if (id && !p.sel.includes(id)) p.onSelect([id])
        p.onContext(e, id)
      }}
      onDragOver={e => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={e => {
        const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'))
        if (!files.length) return
        e.preventDefault()
        p.onDropFiles(files, toIn(e.clientX, e.clientY))
      }}
    >
      <div ref={wrapRef} className="sl-stage-wrap" style={{ width: SLIDE_W * k, height: SLIDE_H * k }}>
        <div className="sl-stage" style={{ transform: `scale(${scale})`, width: `${SLIDE_W}in`, height: `${SLIDE_H}in`, background: bg(p.slide, p.deck), color: p.deck.theme.text, fontFamily: cssFont(p.deck.theme.bodyFont) }}>
          {p.slide.elements.map(el => (
            <ElView key={el.id} el={el} deck={p.deck} noText={editingEl?.id === el.id} />
          ))}
          {editingEl && <EditBox key={`${editingEl.id}:${p.editing!.n}`} el={editingEl} deck={p.deck} editing={p.editing!} editRef={p.editRef} onInput={p.onEditInput} />}
        </div>
        {p.flashKey > 0 && <div key={p.flashKey} className="sl-flash" />}
        {selEls.map(el => (
          <div
            key={el.id}
            className={`sl-sel${editingEl?.id === el.id ? ' editing' : ''}${isLine(el) ? ' line' : ''}`}
            style={{ left: el.x * k, top: el.y * k, width: el.w * k, height: el.h * k, transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined }}
          >
            {single === el &&
              (isLine(el) ? ['nw', 'se'] : HANDLES).map(d => <div key={d} className={`sl-h ${d}`} onPointerDown={e => startResize(e, el, d)} />)}
            {single === el && !isLine(el) && <div className="sl-rot" title="Rotate (Shift: 15° steps)" onPointerDown={e => startRotate(e, el)} />}
          </div>
        ))}
        {guides.x.map(x => <div key={`x${x}`} className="sl-guide v" style={{ left: x * k }} />)}
        {guides.y.map(y => <div key={`y${y}`} className="sl-guide h" style={{ top: y * k }} />)}
        {box && <div className={`sl-box ${box.kind}`} style={{ left: box.x * k, top: box.y * k, width: box.w * k, height: box.h * k }} />}
      </div>
    </div>
  )
}

