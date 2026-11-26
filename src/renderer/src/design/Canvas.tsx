import { useEffect, useMemo, useRef, useState } from 'react'
import type { FontSource } from '../../../shared/design/fonts'
import { type Box, type Point, fin } from '../../../shared/design/geometry'
import { designToSvg } from '../../../shared/design/render'
import type { Artboard, Design, DesignFile, Layer } from '../../../shared/design/types'
import { resize, shift } from '../../../shared/ops/designLayers'
import type { AgentOp } from '../../../shared/types'
import {
  HANDLES, type Handle, type Placed, apply, corners, deltaIn, handleCursor, handlePoints, hitTest, inside, invert, marquee, placeAll, resizeBox
} from './selection'

/** What's selected: layers on one artboard, and the group a double-click entered (clicks pick inside it). */
export interface Sel { board: string; ids: string[]; scope: string | null }
/** An artboard as the renderer drew it. */
export interface Drawn { a: Artboard; svg: string; error?: string }

interface Props {
  file: DesignFile
  fonts: FontSource
  boards: Drawn[]
  zoom: number
  /** Hidden until the first fit, so nothing jumps. */
  ready: boolean
  pad: number
  gap: number
  sel: Sel
  /** Layers (or artboards) an agent just changed, flashed in its color. */
  flash: { ids: string[]; n: number } | null
  /** Bumped to scroll the selection into view. */
  reveal: number
  active: boolean
  scroller: React.RefObject<HTMLDivElement | null>
  onSelect(sel: Sel): void
  /** Applies ops the person made on one artboard as one undo step; settles once they're in. */
  onOps(board: string, ops: AgentOp[]): Promise<unknown>
}

/** Screen pixels around the pointer that still count as on a layer (thin lines). */
const REACH = 4
const HANDLE = 8
const r2 = (v: number) => Math.round(v * 100) / 100
const pts = (ps: Point[], z: number) => ps.map(p => `${p[0] * z},${p[1] * z}`).join(' ')

/**
 * The design as it would be with some layers changed: only those layers (copied) and the groups holding them are new
 * objects, so a drag can be drawn every frame without copying the whole design.
 */
function edited(design: Design, board: string, edits: Map<string, (l: Layer) => void>): Design {
  const go = (list: Layer[]): Layer[] => {
    let changed = false
    const out = list.map(l => {
      const fn = edits.get(l.id)
      if (fn) {
        const copy = structuredClone(l)
        fn(copy)
        changed = true
        return copy
      }
      if (l.type === 'group') {
        const kids = go(l.children)
        if (kids !== l.children) {
          changed = true
          return { ...l, children: kids }
        }
      }
      return l
    })
    return changed ? out : list
  }
  return { ...design, artboards: design.artboards.map(a => (a.id === board ? { ...a, layers: go(a.layers) } : a)) }
}

/** What `set` with x, y, width and height does to a layer (designLayers.writeProps): resize from its top left, then move. */
function sizeTo(l: Layer, b: Box): void {
  resize(l, b.w, b.h)
  shift(l, b.x - fin(l.x, 0), b.y - fin(l.y, 0))
}

/** Window listeners for one drag, until the pointer is released. */
function track(move: (e: PointerEvent) => void, up: (e: PointerEvent) => void): void {
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

/**
 * The design editor's canvas: every artboard side by side, each drawn by designToSvg (raster), with the selection,
 * handles and agent flashes drawn over it. Click selects (Shift adds), dragging moves, the eight handles resize (Shift
 * keeps the shape), dragging empty canvas draws a marquee, a double-click enters a group, and Space-drag or the middle
 * button pans. A drag shows as a preview and becomes one op when the pointer is released, so it's one undo step.
 */
export function Canvas(p: Props) {
  const pr = useRef(p)
  pr.current = p
  const z = p.zoom
  const rowRef = useRef<HTMLDivElement>(null)
  const boardEls = useRef(new Map<string, HTMLDivElement>())
  /** The design while a drag is under way, and the artboard it changes. */
  const [preview, setPreview] = useState<{ board: string; design: Design } | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const [space, setSpace] = useState(false)
  const spaceRef = useRef(false)
  const [panning, setPanning] = useState(false)

  const design = preview?.design ?? p.file.design
  /** Each artboard's layers by id, where they're drawn (following a drag). */
  const placedBy = useMemo(() => {
    const m = new Map<string, Map<string, Placed>>()
    for (const a of design.artboards) m.set(a.id, new Map(placeAll(a.layers, a).map(x => [x.layer.id, x])))
    return m
  }, [design])
  const previewSvg = useMemo(
    () => (preview ? designToSvg(preview.design, preview.board, { fonts: p.fonts, assets: p.file.assets, mode: 'raster' }) : ''),
    [preview]
  )

  /** Placed layers on the design as committed (what a new drag starts from). */
  const committed = (board: string): Map<string, Placed> => {
    const a = pr.current.file.design.artboards.find(x => x.id === board)
    return new Map(a ? placeAll(a.layers, a).map(x => [x.layer.id, x]) : [])
  }
  const boardOf = (id: string): Artboard | undefined => pr.current.file.design.artboards.find(a => a.id === id)
  const boardAt = (cx: number, cy: number): string | null => {
    for (const [id, el] of boardEls.current) {
      const r = el.getBoundingClientRect()
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return id
    }
    return null
  }
  const toBoard = (id: string, cx: number, cy: number): Point => {
    const r = boardEls.current.get(id)?.getBoundingClientRect()
    const k = pr.current.zoom
    return r ? [(cx - r.left) / k, (cy - r.top) / k] : [0, 0]
  }
  const parentOf = (placed: Map<string, Placed>, id: string): string | null => placed.get(id)?.ancestors.at(-1)?.id ?? null

  // Space held over the canvas turns a drag into a pan (in a field or on a button it keeps typing or pressing).
  useEffect(() => {
    if (!p.active) return
    const elsewhere = (e: KeyboardEvent) => {
      const t = e.target as Node | null
      return !!t && t !== document.body && !pr.current.scroller.current?.contains(t)
    }
    const set = (on: boolean) => {
      spaceRef.current = on
      setSpace(on)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || elsewhere(e)) return
      e.preventDefault()
      if (!e.repeat) set(true)
    }
    const up = (e: KeyboardEvent) => e.key === ' ' && set(false)
    const blur = () => set(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      set(false)
    }
  }, [p.active])

  // A comment clicked (or anything else that bumps reveal): bring the selection into view.
  useEffect(() => {
    if (!p.reveal) return
    const el = rowRef.current?.querySelector('.de-sel')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [p.reveal])

  const pan = (e: React.PointerEvent) => {
    const s = pr.current.scroller.current
    if (!s) return
    e.preventDefault()
    const [x0, y0] = [s.scrollLeft, s.scrollTop]
    setPanning(true)
    track(
      ev => {
        s.scrollLeft = x0 - (ev.clientX - e.clientX)
        s.scrollTop = y0 - (ev.clientY - e.clientY)
      },
      () => setPanning(false)
    )
  }

  const startMove = (e: React.PointerEvent, board: string, ids: string[]): boolean => {
    const placed = committed(board)
    // a layer inside a group that's moving moves with it; locked layers stay
    const movers = ids.map(id => placed.get(id)).filter((x): x is Placed => !!x && !x.locked && !x.ancestors.some(a => ids.includes(a.id)))
    if (!movers.length) return false
    e.preventDefault()
    const start = toBoard(board, e.clientX, e.clientY)
    let deltas: Point[] | null = null
    track(
      ev => {
        if (!deltas && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return
        const now = toBoard(board, ev.clientX, ev.clientY)
        // in each layer's own parent space, so a layer inside a turned group follows the pointer
        const ds = movers.map(m => deltaIn(m.outer, start, now).map(Math.round) as Point)
        deltas = ds
        const edits = new Map(movers.map((m, i) => [m.layer.id, (l: Layer) => shift(l, ds[i][0], ds[i][1])]))
        setPreview({ board, design: edited(pr.current.file.design, board, edits) })
      },
      () => {
        const ds = deltas
        if (!ds) return setPreview(null)
        const ops: AgentOp[] = []
        movers.forEach((m, i) => {
          const [dx, dy] = ds[i]
          const props: Record<string, number> = {}
          if (dx) props.x = fin(m.layer.x, 0) + dx
          if (dy) props.y = fin(m.layer.y, 0) + dy
          if (dx || dy) ops.push({ op: 'set', layer: m.layer.id, props })
        })
        if (!ops.length) return setPreview(null)
        // the preview stays until the op is in, so the layer never jumps back for a frame
        void pr.current.onOps(board, ops).finally(() => setPreview(null))
      }
    )
    return true
  }

  const startResize = (e: React.PointerEvent, board: string, target: Placed, k: Handle) => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    const inv = invert(target.outer)
    if (!inv) return
    const l = target.layer
    const from = apply(inv, toBoard(board, e.clientX, e.clientY))
    let next: Box | null = null
    track(
      ev => {
        const b = resizeBox(l, k, from, apply(inv, toBoard(board, ev.clientX, ev.clientY)), ev.shiftKey)
        const nb = { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) }
        next = nb
        setPreview({ board, design: edited(pr.current.file.design, board, new Map([[l.id, (x: Layer) => sizeTo(x, nb)]])) })
      },
      () => {
        const nb = next
        if (!nb) return setPreview(null)
        // only what changed, so the undo step names it ("set width on Logo")
        const props: Record<string, number> = {}
        if (nb.x !== fin(l.x, 0)) props.x = nb.x
        if (nb.y !== fin(l.y, 0)) props.y = nb.y
        if (nb.w !== fin(l.width, 0)) props.width = nb.w
        if (nb.h !== fin(l.height, 0)) props.height = nb.h
        if (!Object.keys(props).length) return setPreview(null)
        void pr.current.onOps(board, [{ op: 'set', layer: l.id, props }]).finally(() => setPreview(null))
      }
    )
  }

  const startMarquee = (e: React.PointerEvent, board: string, scope: string | null, base: string[]) => {
    const row = rowRef.current
    const b = boardOf(board)
    if (!row || !b) return
    e.preventDefault()
    const a = toBoard(board, e.clientX, e.clientY)
    let moved = false
    let last = base.join('\n')
    track(
      ev => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return
        moved = true
        const r = row.getBoundingClientRect()
        setBox({ x: Math.min(e.clientX, ev.clientX) - r.left, y: Math.min(e.clientY, ev.clientY) - r.top, w: Math.abs(ev.clientX - e.clientX), h: Math.abs(ev.clientY - e.clientY) })
        const c = toBoard(board, ev.clientX, ev.clientY)
        const rect = { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) }
        const ids = [...new Set([...base, ...marquee(b, rect, scope).map(l => l.id)])]
        if (ids.join('\n') === last) return
        last = ids.join('\n')
        pr.current.onSelect({ board, ids, scope })
      },
      () => setBox(null)
    )
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const P = pr.current
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) return pan(e)
    if (e.button !== 0) return
    P.scroller.current?.focus({ preventScroll: true })
    const over = boardAt(e.clientX, e.clientY)
    const board = over ?? P.sel.board
    const b = boardOf(board)
    if (!b) return
    const same = board === P.sel.board
    const scope = same ? P.sel.scope : null
    const current = same ? P.sel.ids : []
    const placed = committed(board)
    const pt = toBoard(board, e.clientX, e.clientY)
    const hit = over ? hitTest(b, pt, { scope, tolerance: REACH / P.zoom }) : null
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (!hit) return startMarquee(e, board, scope, current)
      // Shift-click adds or removes at one level; a layer at another level starts a new selection there
      const level = parentOf(placed, hit.id)
      const base = level === scope ? current : []
      P.onSelect({ board, ids: base.includes(hit.id) ? base.filter(x => x !== hit.id) : [...base, hit.id], scope: level })
      return
    }
    if (hit) {
      const ids = current.includes(hit.id) ? current : [hit.id]
      if (!current.includes(hit.id)) P.onSelect({ board, ids, scope: parentOf(placed, hit.id) })
      startMove(e, board, ids)
      return
    }
    // nothing drawn here, but inside what's selected (between a group's layers): drag the selection
    if (over && current.some(id => placed.get(id) && inside(placed.get(id)!, pt)) && startMove(e, board, current)) return
    P.onSelect({ board, ids: [], scope: null })
    startMarquee(e, board, null, [])
  }

  // A double-click on a group enters it, selecting the layer inside under the pointer.
  const onDoubleClick = (e: React.MouseEvent) => {
    const P = pr.current
    const over = boardAt(e.clientX, e.clientY)
    const b = over ? boardOf(over) : undefined
    if (!over || !b) return
    const scope = over === P.sel.board ? P.sel.scope : null
    const pt = toBoard(over, e.clientX, e.clientY)
    const reach = REACH / P.zoom
    const hit = hitTest(b, pt, { scope, tolerance: reach })
    if (hit?.type !== 'group') return
    const inner = hitTest(b, pt, { scope: hit.id, tolerance: reach })
    P.onSelect({ board: over, ids: inner && inner.id !== hit.id ? [inner.id] : [], scope: hit.id })
  }

  const cls = `de-row${space ? ' panning-ready' : ''}${panning ? ' panning' : ''}`
  return (
    <div
      className={cls}
      ref={rowRef}
      style={{ padding: p.pad, gap: p.gap, visibility: p.ready ? undefined : 'hidden' }}
      onPointerDown={onPointerDown}
      onMouseDown={e => e.button === 1 && e.preventDefault()}
      onDoubleClick={onDoubleClick}
    >
      {p.boards.map(({ a, svg, error }) => {
        const w = a.width * z
        const h = a.height * z
        const placed = placedBy.get(a.id)
        const chosen = p.sel.board === a.id ? p.sel.ids.map(id => placed?.get(id)).filter((x): x is Placed => !!x) : []
        const one = chosen.length === 1 && !chosen[0].locked && chosen[0].layer.type !== 'connector' ? chosen[0] : null
        const scope = p.sel.board === a.id && p.sel.scope ? placed?.get(p.sel.scope) : undefined
        const flashed = p.flash ? p.flash.ids.map(id => placed?.get(id)).filter((x): x is Placed => !!x) : []
        const handles = one ? handlePoints(one) : null
        return (
          <figure key={a.id} className={`de-board-wrap${p.sel.board === a.id ? ' current' : ''}`} style={{ width: w }}>
            <figcaption
              className="de-board-name"
              title={`${a.name}  ${a.width} x ${a.height}`}
              onPointerDown={e => {
                if (e.button !== 0) return
                e.stopPropagation()
                p.onSelect({ board: a.id, ids: [], scope: null })
              }}
            >
              {a.name} <span className="muted">{a.width} x {a.height}</span>
            </figcaption>
            <div
              className="de-board-area"
              data-board={a.id}
              style={{ width: w, height: h }}
              ref={el => {
                if (!el) return
                boardEls.current.set(a.id, el)
                return () => void boardEls.current.delete(a.id)
              }}
            >
              {error ? (
                <div className="de-board de-board-error">{error}</div>
              ) : (
                <div
                  className={`de-board${a.background ? '' : ' clear'}`}
                  data-artboard={a.id}
                  // our own renderer's output: every value in it is escaped, and svg layers are drawn as images
                  dangerouslySetInnerHTML={{ __html: preview?.board === a.id ? previewSvg : svg }}
                />
              )}
              <svg className="de-over" width={w} height={h} aria-hidden>
                {scope && <polygon className="de-scope" points={pts(corners(scope), z)} />}
                {p.flash?.ids.includes(a.id) && <rect key={`b${p.flash.n}`} className="de-flash" width={w} height={h} />}
                {flashed.map(f => (
                  <polygon key={`${f.layer.id}:${p.flash!.n}`} className="de-flash" points={pts(corners(f), z)} />
                ))}
                {chosen.map(c => (
                  <polygon key={c.layer.id} className={`de-sel${c.locked ? ' locked' : ''}`} points={pts(corners(c), z)} />
                ))}
                {one &&
                  handles &&
                  HANDLES.map(k => (
                    <rect
                      key={k}
                      className="de-handle"
                      x={handles[k][0] * z - HANDLE / 2}
                      y={handles[k][1] * z - HANDLE / 2}
                      width={HANDLE}
                      height={HANDLE}
                      rx={2}
                      style={{ cursor: handleCursor(one, k) }}
                      onPointerDown={e => startResize(e, a.id, one, k)}
                    />
                  ))}
              </svg>
            </div>
          </figure>
        )
      })}
      {box && <div className="de-marquee" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
    </div>
  )
}
