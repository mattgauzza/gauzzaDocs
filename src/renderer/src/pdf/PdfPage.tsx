import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormValue } from '../../../shared/pdf/forms'
import { type PdfJsPageLike, type PdfLine, lineEdit, pageLines, paraEdits, paragraphsOf } from '../../../shared/pdf/lines'
import { fitParagraph } from '../../../shared/pdf/wrap'
import type { PdfEdit } from '../../../shared/types'
import { type Markup, type ReplaceEdit, type Tool, bbox, cssFamily, lineTop, paraLeft, resize, sampleColors, translate } from './markup'
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
  formValues: Record<string, FormValue>
  onSelect(i: number | null): void
  onAdd(e: Markup): void
  /** Several edits as one undo step (a paragraph: its first line with the new words, the rest emptied). */
  onAddAll(es: Markup[]): void
  onUpdate(i: number, e: Markup): void
  onRemove(i: number): void
  onFormChange(name: string, value: FormValue): void
  setEl(n: number, el: HTMLDivElement | null): void
}

type Drag =
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ink'; points: [number, number][] }
  | { kind: 'move'; i: number; sx: number; sy: number; dx: number; dy: number }
  | { kind: 'resize'; i: number; sx: number; sy: number; cx: number; cy: number; keep: boolean }

/** A form field's box on this page, from pdf.js annotations (display points). */
interface Widget {
  key: string
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'choice'
  x: number
  y: number
  w: number
  h: number
  value: FormValue | null
  onValue?: string // checkbox export value / radio button value
  options?: { value: string; label: string }[]
  multiline?: boolean
  multiSelect?: boolean
  readOnly?: boolean
  maxLen?: number
}

/** One page: canvas, selectable text layer, form fields, and the editable markup overlay. */
function PdfPage(p: PageProps) {
  const { doc, n, scale, visible } = p
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [textVersion, setTextVersion] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [editing, setEditing] = useState<{ i: number | null; x: number; y: number; text: string; size: number; color: string } | null>(null)
  const [lineEditing, setLineEditing] = useState<{ i: number | null; e: ReplaceEdit; original: string; rest?: ReplaceEdit[] } | null>(null)
  const [lines, setLines] = useState<PdfLine[] | null>(null)
  const [widgets, setWidgets] = useState<Widget[] | null>(null)
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
      canvas.getContext('2d', { willReadFrequently: true })!.drawImage(off, 0, 0)
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

  // ---- form fields: read once per document version, only for pages near the screen ----
  useEffect(() => setWidgets(null), [doc])
  useEffect(() => {
    if (!visible || widgets) return
    let cancelled = false
    ;(async () => {
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const annots = await page.getAnnotations()
      const out: Widget[] = []
      for (const a of annots as Record<string, any>[]) {
        if (a.subtype !== 'Widget' || !a.fieldName || a.pushButton || a.fieldType === 'Sig' || a.hidden) continue
        const kind: Widget['kind'] | null = a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : a.fieldType === 'Ch' ? 'choice' : a.fieldType === 'Tx' ? 'text' : null
        if (!kind) continue
        const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1])
        const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3])
        out.push({
          key: a.id || `${a.fieldName}-${out.length}`,
          name: a.fieldName,
          kind,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          value:
            kind === 'checkbox' ? !!a.fieldValue && a.fieldValue !== 'Off'
            : kind === 'choice' && a.multiSelect ? (Array.isArray(a.fieldValue) ? a.fieldValue : a.fieldValue ? [a.fieldValue] : [])
            : Array.isArray(a.fieldValue) ? a.fieldValue[0] ?? '' : a.fieldValue ?? '',
          onValue: kind === 'checkbox' ? a.exportValue : kind === 'radio' ? a.buttonValue : undefined,
          options: kind === 'choice' ? (a.options || []).map((o: { exportValue: string; displayValue: string }) => ({ value: o.exportValue, label: o.displayValue })) : undefined,
          multiline: !!a.multiLine,
          multiSelect: !!a.multiSelect,
          readOnly: !!a.readOnly,
          maxLen: a.maxLen || undefined
        })
      }
      if (!cancelled) setWidgets(out)
    })().catch(() => !cancelled && setWidgets([]))
    return () => {
      cancelled = true
    }
  }, [doc, n, visible, widgets])

  // ---- lines of existing text, for the Edit text tool (read after the page has rendered, so real font names are known) ----
  useEffect(() => setLines(null), [doc])
  useEffect(() => {
    if (p.tool !== 'edittext' || !visible || lines) return
    let cancelled = false
    ;(async () => {
      const page = await doc.getPage(n)
      const ls = await pageLines(page as unknown as PdfJsPageLike, n)
      if (!cancelled) setLines(ls)
    })().catch(() => !cancelled && setLines([]))
    return () => {
      cancelled = true
    }
  }, [p.tool, visible, doc, n, lines, textVersion])

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
    if (e.button !== 0 || p.tool === 'select' || p.tool === 'edittext') return
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
  const onItemDown = (i: number, e: Markup, ev: React.PointerEvent) => {
    if (ev.button !== 0) return
    if (p.tool === 'edittext' && e.type === 'replaceText') {
      ev.stopPropagation()
      ev.preventDefault()
      return setLineEditing({ i, e, original: e.text })
    }
    if (p.tool !== 'select') return
    ev.stopPropagation()
    ev.preventDefault()
    p.onSelect(i)
    const [x, y] = pt(ev)
    overlayRef.current!.setPointerCapture(ev.pointerId)
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
    const value = text.replace(/ /g, ' ').replace(/\n$/, '')
    if (ed.i == null) {
      if (value.trim()) p.onAdd({ type: 'text', page: n, x: ed.x, y: ed.y, text: value, size: ed.size, color: ed.color })
    } else {
      const m = p.markups.find(m => m.i === ed.i)
      if (!m) return
      if (!value.trim()) p.onRemove(ed.i)
      else if (value !== (m.e as TextEdit).text) p.onUpdate(ed.i, { ...(m.e as TextEdit), text: value })
    }
  }

  // ---- editing a line that is already in the PDF ----
  const openLine = (line: PdfLine) => {
    const colors = canvasRef.current ? sampleColors(canvasRef.current, line, p.size.w) : {}
    // A line in a paragraph opens the whole paragraph, so new words can flow onto the next lines.
    const para = paragraphsOf(lines || []).find(g => g.includes(line))
    if (para && para.length > 1 && !para.some(covered)) {
      const text = para.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim()
      const [first, ...rest] = paraEdits(para, text, colors)
      return setLineEditing({ i: null, e: first, original: text, rest })
    }
    setLineEditing({ i: null, e: lineEdit(line, line.text, colors), original: line.text })
  }
  const finishLine = (text: string | null) => {
    const ed = lineEditing
    setLineEditing(null)
    if (!ed || text == null) return // cancelled
    const value = text.replace(/ /g, ' ').replace(/\n+$/, '')
    if (ed.i == null) {
      if (value !== ed.original) p.onAddAll([{ ...ed.e, text: value }, ...(ed.rest || [])])
    } else if (value !== ed.e.text) p.onUpdate(ed.i, { ...ed.e, text: value })
  }
  // Lines already edited (pending) are reached through their edit, not the original line.
  const covered = (l: PdfLine) => p.markups.some(m => m.e.type === 'replaceText' && Math.abs(m.e.x - l.x) < 0.5 && Math.abs(m.e.y - l.y) < 0.5)
  /** The pending paragraph edit a line was emptied for (it opens that paragraph instead). */
  const paragraphOf = (l: PdfLine) => {
    const emptied = p.markups.some(m => m.e.type === 'replaceText' && !m.e.text && Math.abs(m.e.x - l.x) < 0.5 && Math.abs(m.e.y - l.y) < 0.5)
    if (!emptied) return null
    let best: { i: number; e: ReplaceEdit } | null = null
    for (const m of p.markups) {
      if (m.e.type !== 'replaceText' || m.e.wrapRight == null || m.e.y >= l.y) continue
      if (Math.abs((m.e.hang ?? m.e.x) - l.x) > m.e.size && Math.abs(m.e.x - l.x) > m.e.size) continue
      if (l.y - m.e.y > (m.e.maxLines || 1) * (m.e.lineHeight ?? m.e.size * 1.2) + 1) continue
      if (!best || m.e.y > best.e.y) best = { i: m.i, e: m.e }
    }
    return best
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

  const formLive = p.tool === 'select' || p.tool === 'edittext'

  return (
    <div className={`pdf-page tool-${p.tool}`} data-page={n} ref={el => p.setEl(n, el)} style={{ width: W, height: H }}>
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      <div ref={textRef} className="textLayer" />
      {widgets && widgets.length > 0 && (
        <div className={`pdf-forms${formLive ? '' : ' inert'}`}>
          {widgets.map(w => (
            <FormInput key={w.key} w={w} scale={scale} value={p.formValues[w.name]} onChange={v => p.onFormChange(w.name, v)} />
          ))}
        </div>
      )}
      <div
        ref={overlayRef}
        className="pdf-overlay"
        onPointerDown={onOverlayDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      >
        {/* Covers for edited lines sit where the old words were, even after the new text is moved. */}
        {p.markups.map(({ i, e }) =>
          e.type === 'replaceText' ? (
            <div key={`c${i}`} className="pdf-cover" style={{ left: (e.x - 0.6) * scale, top: (e.y - 0.6) * scale, width: (e.w + 1.2) * scale, height: (e.h + 1.2) * scale, background: e.bg || '#fff' }} />
          ) : null
        )}
        {p.tool === 'edittext' &&
          lines
            ?.map(l => ({ l, para: covered(l) ? paragraphOf(l) : null }))
            .filter(({ l, para }) => !covered(l) || para)
            .map(({ l, para }) => (
              <div
                key={l.id}
                className="pdf-line"
                title={para ? 'Click to edit this paragraph' : 'Click to edit this line'}
                style={{ left: l.x * scale - 2, top: l.y * scale - 1, width: l.w * scale + 4, height: l.h * scale + 2 }}
                onPointerDown={ev => {
                  if (ev.button !== 0) return
                  ev.preventDefault()
                  ev.stopPropagation()
                  if (para) setLineEditing({ i: para.i, e: para.e, original: para.e.text })
                  else openLine(l)
                }}
              />
            ))}
        {p.markups.map(({ i, e: raw }) => {
          if (editing?.i === i || lineEditing?.i === i) return null
          const e = shown(i, raw)
          const b = bbox(e)
          const sel = p.selected === i
          return (
            <div
              key={i}
              className={`pdf-mark mark-${e.type}${sel ? ' selected' : ''}${e.type === 'replaceText' && !e.text ? ' emptied' : ''}`}
              style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
              onPointerDown={ev => onItemDown(i, raw, ev)}
              onDoubleClick={() => (e.type === 'text' ? startEditText(i, e) : e.type === 'replaceText' ? setLineEditing({ i, e: raw as ReplaceEdit, original: (raw as ReplaceEdit).text }) : undefined)}
            >
              <MarkBody e={e} b={b} scale={scale} />
              {sel && e.type !== 'text' && e.type !== 'ink' && e.type !== 'replaceText' && (
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
            style={{ fontSize: editing.size * scale, color: editing.color }}
            initial={editing.text}
            onDone={t => finishEditing(t ?? editing.text)}
          />
        )}
        {lineEditing?.i == null &&
          lineEditing &&
          [lineEditing.e, ...(lineEditing.rest || [])].map((c, k) => (
            <div
              key={`lc${k}`}
              className="pdf-cover"
              style={{ left: (c.x - 0.6) * scale, top: (c.y - 0.6) * scale, width: (c.w + 1.2) * scale, height: (c.h + 1.2) * scale, background: c.bg || '#fff' }}
            />
          ))}
        {lineEditing && (
          <TextBox
            key={`line-${lineEditing.i}-${lineEditing.e.x}-${lineEditing.e.y}`}
            className="pdf-linebox"
            left={((lineEditing.e.wrapRight != null ? paraLeft(lineEditing.e) : lineEditing.e.x) + (lineEditing.e.dx || 0)) * scale}
            top={lineTop(lineEditing.e) * scale}
            style={{
              fontFamily: cssFamily(lineEditing.e.font),
              fontWeight: lineEditing.e.bold ? 700 : 400,
              fontStyle: lineEditing.e.italic ? 'italic' : 'normal',
              fontSize: lineEditing.e.size * scale,
              lineHeight: `${(lineEditing.e.wrapRight != null ? lineEditing.e.lineHeight ?? lineEditing.e.size * 1.2 : lineEditing.e.size * 1.2) * scale}px`,
              minWidth: lineEditing.e.w * scale,
              color: lineEditing.e.color,
              background: lineEditing.e.bg,
              // A paragraph wraps at its old right edge while you type, its first line indented as before.
              ...(lineEditing.e.wrapRight != null
                ? {
                    width: (lineEditing.e.wrapRight - paraLeft(lineEditing.e)) * scale,
                    whiteSpace: 'pre-wrap',
                    textIndent: (lineEditing.e.x - paraLeft(lineEditing.e)) * scale
                  }
                : {})
            }}
            initial={lineEditing.e.text}
            selectAll={lineEditing.i == null}
            singleLine
            onDone={finishLine}
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
    case 'replaceText':
      if (e.wrapRight != null) {
        const fit = fitParagraph(e)
        const left = paraLeft(e)
        return (
          <div
            className="mark-text-body"
            style={{
              fontFamily: cssFamily(e.font),
              fontWeight: e.bold ? 700 : 400,
              fontStyle: e.italic ? 'italic' : 'normal',
              fontSize: fit.size * scale,
              lineHeight: `${fit.lineHeight * scale}px`,
              color: e.color || '#000'
            }}
          >
            {fit.lines.map((l, k) => (
              <div key={k} style={{ paddingLeft: ((k ? (e.hang ?? e.x) : e.x) - left) * scale }}>{l || ' '}</div>
            ))}
          </div>
        )
      }
      return (
        <div
          className="mark-text-body"
          style={{
            fontFamily: cssFamily(e.font),
            fontWeight: e.bold ? 700 : 400,
            fontStyle: e.italic ? 'italic' : 'normal',
            fontSize: e.size * scale,
            lineHeight: `${e.size * 1.2 * scale}px`,
            color: e.color || '#000'
          }}
        >
          {e.text}
        </div>
      )
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

/** One form field, drawn over its box. Values live in the editor (pending until save). */
function FormInput({ w, scale, value, onChange }: { w: Widget; scale: number; value: FormValue | undefined; onChange(v: FormValue): void }) {
  const style: React.CSSProperties = { left: w.x * scale, top: w.y * scale, width: w.w * scale, height: w.h * scale }
  const v = value ?? w.value
  const fontSize = Math.max(8, Math.min(w.h * 0.62, 13)) * scale
  if (w.kind === 'checkbox')
    return (
      <button
        className={`pdf-field pdf-check${v === true ? ' on' : ''}`}
        style={style}
        disabled={w.readOnly}
        title={w.name}
        onPointerDown={e => e.stopPropagation()}
        onClick={() => onChange(v !== true)}
      />
    )
  if (w.kind === 'radio')
    return (
      <button
        className={`pdf-field pdf-radio${v === w.onValue ? ' on' : ''}`}
        style={style}
        disabled={w.readOnly}
        title={`${w.name}: ${w.onValue}`}
        onPointerDown={e => e.stopPropagation()}
        onClick={() => w.onValue && onChange(w.onValue)}
      />
    )
  if (w.kind === 'choice')
    return (
      <select
        className="pdf-field"
        style={{ ...style, fontSize }}
        multiple={w.multiSelect}
        disabled={w.readOnly}
        title={w.name}
        value={w.multiSelect ? (Array.isArray(v) ? v : []) : String(v ?? '')}
        onPointerDown={e => e.stopPropagation()}
        onChange={e => onChange(w.multiSelect ? [...e.target.selectedOptions].map(o => o.value) : e.target.value)}
      >
        {!w.multiSelect && <option value="" />}
        {w.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  const common = {
    className: 'pdf-field',
    style: { ...style, fontSize },
    disabled: w.readOnly,
    title: w.name,
    maxLength: w.maxLen,
    value: String(v ?? ''),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value)
  }
  return w.multiline ? <textarea {...common} /> : <input {...common} />
}

/** The inline editor for a text box or an edited line. Uncontrolled, so typing never fights React. */
function TextBox(props: {
  left: number
  top: number
  style: React.CSSProperties
  initial: string
  className?: string
  selectAll?: boolean
  singleLine?: boolean
  onDone(text: string | null): void // null = cancelled (single-line edits only)
}) {
  const ref = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current!
    el.textContent = props.initial
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    if (!props.selectAll) r.collapse(false)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(r)
  }, [])
  const finish = (cancel = false) => {
    if (done.current) return
    done.current = true
    props.onDone(cancel ? null : ref.current?.innerText ?? '')
  }
  return (
    <div
      ref={ref}
      className={`pdf-textbox ${props.className || ''}`}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      style={{ left: props.left, top: props.top, ...props.style }}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (props.singleLine && e.key === 'Escape') {
          e.preventDefault()
          finish(true)
          ref.current?.blur()
        } else if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey || props.singleLine))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
      onBlur={() => finish()}
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
