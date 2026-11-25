import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PdfEdit } from '../../../shared/types'
import { type Markup, type Tool, bbox, resize, translate } from './markup'
import { type PdfDoc, pdfjs } from './pdfjs'

type TextEdit = Extract<PdfEdit, { type: 'text' }>

export interface PageProps {
  doc: PdfDoc
  n: number
  size: { w: number; h: number }
  scale: number
  visible: boolean
  markups: { i: number; e: Markup }[]
  tool: Tool
  color: string
  textSize: number
  inkWidth: number
  selected: number | null
  query: string
  onSelect(i: number | null): void
  onAdd(e: Markup): void
  onUpdate(i: number, e: Markup): void
  onRemove(i: number): void
  setEl(n: number, el: HTMLDivElement | null): void
}

type Drag =
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ink'; points: [number, number][] }
  | { kind: 'move'; i: number; sx: number; sy: number; dx: number; dy: number }
  | { kind: 'resize'; i: number; sx: number; sy: number; cx: number; cy: number; keep: boolean }

/** One page: canvas, selectable text layer, and the editable markup overlay. */
function PdfPage(p: PageProps) {
  const { doc, n, scale, visible } = p
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [textVersion, setTextVersion] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [editing, setEditing] = useState<{ i: number | null; x: number; y: number; text: string; size: number; color: string } | null>(null)
  const W = p.size.w * scale
  const H = p.size.h * scale

  // ---- render canvas + text layer when visible; release the bitmap when far away ----
  useEffect(() => {
    const canvas = canvasRef.current!
    const textDiv = textRef.current!
    if (!visible) {
      canvas.width = canvas.height = 0
      textDiv.replaceChildren()
      return
    }
    let cancelled = false
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | null = null
    let textLayer: pdfjs.TextLayer | null = null
    ;(async () => {
      const page = await doc.getPage(n)
      if (cancelled) return
      const vp = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      // Render into an offscreen canvas and swap, so zooming never flashes a blank page.
      const off = document.createElement('canvas')
      off.width = Math.floor(vp.width * dpr)
      off.height = Math.floor(vp.height * dpr)
      task = page.render({ canvas: off, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      try {
        await task.promise
      } catch {
        return // cancelled
      }
      if (cancelled) return
      canvas.width = off.width
      canvas.height = off.height
      canvas.getContext('2d')!.drawImage(off, 0, 0)
      off.width = off.height = 0
      textDiv.replaceChildren()
      textDiv.style.setProperty('--total-scale-factor', String(scale))
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp })
      try {
        await textLayer.render()
        if (!cancelled) setTextVersion(v => v + 1)
      } catch { /* cancelled */ }
    })().catch(() => { /* document replaced or destroyed while rendering */ })
    return () => {
      cancelled = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [doc, n, scale, visible])

  // ---- search hits in the text layer ----
  useEffect(() => {
    const q = p.query.trim().toLowerCase()
    textRef.current?.querySelectorAll('span').forEach(s => s.classList.toggle('pdf-hit', !!q && (s.textContent || '').toLowerCase().includes(q)))
  }, [p.query, textVersion])

  const pt = (e: { clientX: number; clientY: number }) => {
    const r = overlayRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale] as [number, number]
  }

  // ---- drawing tools on the overlay ----
  const onOverlayDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || p.tool === 'select') return
    e.preventDefault()
    const [x, y] = pt(e)
    if (p.tool === 'text') {
      if (editing) return // the blur of the open box finishes it first
      setEditing({ i: null, x, y: y - p.textSize * 0.6, text: '', size: p.textSize, color: p.color })
      return
    }
    overlayRef.current!.setPointerCapture(e.pointerId)
    p.onSelect(null)
    setDrag(p.tool === 'draw' ? { kind: 'ink', points: [[x, y]] } : { kind: 'box', x0: x, y0: y, x1: x, y1: y })
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const [x, y] = pt(e)
    if (drag.kind === 'box') setDrag({ ...drag, x1: x, y1: y })
    else if (drag.kind === 'ink') setDrag({ ...drag, points: [...drag.points, [x, y]] })
    else if (drag.kind === 'move') setDrag({ ...drag, dx: x - drag.sx, dy: y - drag.sy })
    else setDrag({ ...drag, cx: x, cy: y })
  }
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return
    const [x, y] = pt(e)
    setDrag(null)
    if (drag.kind === 'box') {
      const bx = Math.min(drag.x0, x), by = Math.min(drag.y0, y)
      const w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0)
      if (w < 3 || h < 3) return
      if (p.tool === 'highlight') p.onAdd({ type: 'highlight', page: n, x: bx, y: by, w, h, color: p.color })
      else if (p.tool === 'whiteout') p.onAdd({ type: 'rect', page: n, x: bx, y: by, w, h, fill: '#ffffff' })
      else p.onAdd({ type: 'rect', page: n, x: bx, y: by, w, h, color: p.color })
    } else if (drag.kind === 'ink') {
      if (drag.points.length) p.onAdd({ type: 'ink', page: n, points: simplify(drag.points), color: p.color, width: p.inkWidth })
    } else if (drag.kind === 'move') {
      const m = p.markups.find(m => m.i === drag.i)
      if (m && (Math.abs(drag.dx) > 0.5 || Math.abs(drag.dy) > 0.5)) p.onUpdate(drag.i, translate(m.e, drag.dx, drag.dy))
    } else {
      const m = p.markups.find(m => m.i === drag.i)
      if (m) {
        const b = bbox(m.e)
        p.onUpdate(drag.i, resize(m.e, b.w + (x - drag.sx), b.h + (y - drag.sy), drag.keep))
      }
    }
  }

  // ---- selecting / moving existing markup ----
  const onItemDown = (i: number, e: React.PointerEvent) => {
    if (p.tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    p.onSelect(i)
    const [x, y] = pt(e)
    overlayRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'move', i, sx: x, sy: y, dx: 0, dy: 0 })
  }
  const onHandleDown = (i: number, keep: boolean, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const [x, y] = pt(e)
    overlayRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', i, sx: x, sy: y, cx: x, cy: y, keep })
  }
  const startEditText = (i: number, t: TextEdit) => setEditing({ i, x: t.x, y: t.y, text: t.text, size: t.size || 12, color: t.color || '#000000' })

  const finishEditing = (text: string) => {
    const ed = editing
    setEditing(null)
    if (!ed) return
    const value = text.replace(/ /g, ' ').replace(/\n$/, '')
    if (ed.i == null) {
      if (value.trim()) p.onAdd({ type: 'text', page: n, x: ed.x, y: ed.y, text: value, size: ed.size, color: ed.color })
    } else {
      const m = p.markups.find(m => m.i === ed.i)
      if (!m) return
      if (!value.trim()) p.onRemove(ed.i)
      else if (value !== (m.e as TextEdit).text) p.onUpdate(ed.i, { ...(m.e as TextEdit), text: value })
    }
  }

  // Live preview of a move / resize in progress.
  const shown = (i: number, e: Markup): Markup => {
    if (drag?.kind === 'move' && drag.i === i) return translate(e, drag.dx, drag.dy)
    if (drag?.kind === 'resize' && drag.i === i) {
      const b = bbox(e)
      return resize(e, b.w + (drag.cx - drag.sx), b.h + (drag.cy - drag.sy), drag.keep)
    }
    return e
  }

  return (
    <div className={`pdf-page tool-${p.tool}`} data-page={n} ref={el => p.setEl(n, el)} style={{ width: W, height: H }}>
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      <div ref={textRef} className="textLayer" />
      <div
        ref={overlayRef}
        className="pdf-overlay"
        onPointerDown={onOverlayDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      >
        {p.markups.map(({ i, e: raw }) => {
          if (editing?.i === i) return null
          const e = shown(i, raw)
          const b = bbox(e)
          const sel = p.selected === i
          return (
            <div
              key={i}
              className={`pdf-mark mark-${e.type}${sel ? ' selected' : ''}`}
              style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
              onPointerDown={ev => onItemDown(i, ev)}
              onDoubleClick={() => e.type === 'text' && startEditText(i, e)}
            >
              <MarkBody e={e} b={b} scale={scale} />
              {sel && e.type !== 'text' && e.type !== 'ink' && (
                <span className="pdf-handle" onPointerDown={ev => onHandleDown(i, e.type === 'image', ev)} />
              )}
            </div>
          )
        })}
        {drag?.kind === 'box' && (
          <div
            className={`pdf-draft draft-${p.tool}`}
            style={{
              left: Math.min(drag.x0, drag.x1) * scale,
              top: Math.min(drag.y0, drag.y1) * scale,
              width: Math.abs(drag.x1 - drag.x0) * scale,
              height: Math.abs(drag.y1 - drag.y0) * scale,
              ...(p.tool === 'highlight' ? { background: p.color } : p.tool === 'rect' ? { borderColor: p.color } : {})
            }}
          />
        )}
        {drag?.kind === 'ink' && (
          <svg className="pdf-draft-ink" width={W} height={H}>
            <polyline points={drag.points.map(([x, y]) => `${x * scale},${y * scale}`).join(' ')} stroke={p.color} strokeWidth={p.inkWidth * scale} />
          </svg>
        )}
        {editing && (
          <TextBox
            key={`${editing.i}-${editing.x}-${editing.y}`}
            left={editing.x * scale}
            top={editing.y * scale}
            fontSize={editing.size * scale}
            color={editing.color}
            initial={editing.text}
            onDone={finishEditing}
          />
        )}
      </div>
      <div className="pdf-page-num">{n}</div>
    </div>
  )
}

function MarkBody({ e, b, scale }: { e: Markup; b: { x: number; y: number; w: number; h: number }; scale: number }) {
  switch (e.type) {
    case 'text':
      return <div className="mark-text-body" style={{ fontSize: (e.size || 12) * scale, color: e.color || '#000' }}>{e.text}</div>
    case 'highlight':
      return <div className="fill" style={{ background: e.color || '#ffeb3b', opacity: 0.35 }} />
    case 'rect':
      return (
        <div
          className="fill"
          style={{
            background: e.fill || 'transparent',
            border: e.color || !e.fill ? `${2 * scale}px solid ${e.color || '#d93025'}` : undefined
          }}
        />
      )
    case 'image':
      return <img className="fill" src={e.png.startsWith('data:') ? e.png : `data:image/png;base64,${e.png}`} draggable={false} alt="" />
    case 'ink':
      return (
        <svg width={b.w * scale} height={b.h * scale} className="fill">
          <polyline
            points={e.points.map(([x, y]) => `${(x - b.x) * scale},${(y - b.y) * scale}`).join(' ')}
            stroke={e.color || '#1a73e8'}
            strokeWidth={(e.width || 2) * scale}
          />
        </svg>
      )
  }
}

/** The inline editor for a text box. Uncontrolled, so typing never fights React. */
function TextBox(props: { left: number; top: number; fontSize: number; color: string; initial: string; onDone(text: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current!
    el.textContent = props.initial
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(r)
  }, [])
  const finish = () => {
    if (done.current) return
    done.current = true
    props.onDone(ref.current?.innerText ?? '')
  }
  return (
    <div
      ref={ref}
      className="pdf-textbox"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      style={{ left: props.left, top: props.top, fontSize: props.fontSize, color: props.color }}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
      onBlur={finish}
    />
  )
}

/** Drops points closer than half a point to the previous one: smaller files, same look. */
function simplify(points: [number, number][]) {
  const out: [number, number][] = []
  for (const pt of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.5) out.push([Math.round(pt[0] * 10) / 10, Math.round(pt[1] * 10) / 10])
  }
  return out
}

export default memo(PdfPage)
