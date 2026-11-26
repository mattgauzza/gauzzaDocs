import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type FontSource, fontsFor, newFonts } from '../../../shared/design/fonts'
import { fin } from '../../../shared/design/geometry'
import { DEFAULT_DESIGN_PRESET, newDesign, walk } from '../../../shared/design/model'
import { type Downgrade, designToSvg } from '../../../shared/design/render'
import type { Artboard, Design, DesignFile, FontRef, Layer } from '../../../shared/design/types'
import { applyDesignOp } from '../../../shared/ops/design'
import type { OpServices } from '../../../shared/ops/types'
import type { AgentInfo, AgentOp, CommentAnchor, FilePayload } from '../../../shared/types'
import type { EditorHandle, EditorProps, MenuItem, StatusItem } from '../editor'
import { api } from '../lib'
import { stepZoom } from '../shell/zoom'
import { Canvas, type Drawn, type Sel } from './Canvas'
import { Layers } from './Layers'
import { Props } from './Props'
import { DesignSaves } from './saves'
import { type Placed, deltaIn, placeAll } from './selection'
import './design.css'

/**
 * The design editor (.gdesign): every artboard side by side on a neutral canvas, drawn by the one renderer
 * (designToSvg, raster mode) as inline SVG, with zoom (Ctrl+scroll, the toolbar or View), the layers panel on the left
 * and the selected layer's properties on the right. Everything that changes the design, the person's clicks and drags
 * as much as an agent's ops, goes through applyDesignOp (shared/ops/design.ts) exactly as on disk, one at a time, each
 * one undo step: an agent's named for it ("Claude: added 3 layers"), the person's for what it did ("set fill on Logo").
 * Undo keeps 100 designs. Fonts are measured with the installed faces the worker finds, and diagrams are laid out by the
 * worker too (ELK can't run in this window). Layers an agent touches flash in its color.
 */

/** Zoom levels, as a share of the design's own pixels. */
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const MAX_UNDO = 100
/** Changes of one kind (a run of arrow nudges, a color being picked) closer together than this are one undo step. */
const MERGE_MS = 1000
/** How far Ctrl+D puts a copy from its layer. */
const COPY_OFFSET = 10
/** Screen pixels around and between artboards, and the height of a name above one. */
const PAD = 48
const GAP = 48
const LABEL = 24

interface Step { file: DesignFile; label: string }

const P = {
  undo: 'M7 19v-2h7.1q1.58 0 2.74-1T18 13.5T16.84 11T14.1 10H7.8l2.6 2.6L9 14L4 9l5-5l1.4 1.4L7.8 8h6.3q2.43 0 4.16 1.58T20 13.5t-1.74 3.93T14.1 19z',
  redo: 'M9.9 19q-2.43 0-4.16-1.58T4 13.5t1.74-3.92T9.9 8h6.3l-2.6-2.6L15 4l5 5l-5 5l-1.4-1.4l2.6-2.6H9.9q-1.58 0-2.74 1T6 13.5T7.16 16t2.74 1H17v2z',
  out: 'M19 13H5v-2h14v2z',
  in: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
}
const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
)

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
const r2 = (v: number) => Math.round(v * 100) / 100

/** Every layer on every artboard, groups' children included. */
function layerTotal(design: Design): number {
  let n = 0
  for (const a of design.artboards) walk(a.layers, () => void n++)
  return n
}

/** The fit zoom: every artboard side by side inside the canvas, never larger than 100%. */
function fitZoom(design: Design, width: number, height: number): number {
  const boards = design.artboards
  const sumW = boards.reduce((s, a) => s + a.width, 0)
  const maxH = Math.max(1, ...boards.map(a => a.height))
  // a pixel to spare and rounded down, so a fraction of a pixel never makes the canvas scroll
  const w = (width - 2 * PAD - GAP * (boards.length - 1) - 1) / Math.max(1, sumW)
  const h = (height - 2 * PAD - LABEL - 1) / maxH
  return Math.max(0.02, Math.floor(Math.min(1, w, h) * 1000) / 1000)
}

const fontKey = (r: FontRef) => `${r.family.toLowerCase()}|${r.weight}|${r.style}|${r.postscript ?? ''}`

/** The layers and artboards an op's result names ({ ids }, { id }, an apply's results), to flash. */
function touched(result: unknown): string[] {
  const out = new Set<string>()
  const go = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 3) return
    if (Array.isArray(v)) return v.forEach(x => go(x, depth + 1))
    const o = v as Record<string, unknown>
    if (Array.isArray(o.ids)) for (const id of o.ids) if (typeof id === 'string') out.add(id)
    if (typeof o.id === 'string') out.add(o.id)
    if (Array.isArray(o.results)) go(o.results, depth + 1)
  }
  go(result, 0)
  return [...out]
}

/** Whether a key went to a place the person types in. */
const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))
}

export default function DesignEditor(props: EditorProps) {
  const propsRef = useRef(props)
  propsRef.current = props
  const loaded = props.payload.kind === 'design' ? props.payload : null
  const [file, setFileState] = useState<DesignFile>(() => loaded?.file ?? { design: newDesign(DEFAULT_DESIGN_PRESET), assets: {} })
  const fileRef = useRef(file)
  const [fonts, setFonts] = useState<FontSource | null>(null)
  /** The fonts the drawing and the ops measure with, and the design they were loaded for. */
  const fontsRef = useRef<{ source: FontSource; built: Design } | null>(null)
  const [failed, setFailed] = useState('')
  const failedRef = useRef('')
  const [zoom, setZoomState] = useState<number | null>(null) // null until the first fit
  const zoomRef = useRef(1)
  const anchor = useRef<{ x: number; y: number } | null>(null)
  const [notes, setNotes] = useState<string[]>(loaded?.notes ?? [])
  const [notesOpen, setNotesOpen] = useState(false)
  const past = useRef<Step[]>([])
  const future = useRef<Step[]>([])
  /** The last change that a following one of the same kind may join (see MERGE_MS). */
  const lastMerge = useRef<{ key: string; at: number } | null>(null)
  /** What the file on disk holds: a save sends only the other assets. */
  const saves = useRef(new DesignSaves(loaded?.file.assets ?? {}))
  /** Changed since it was opened: the thumbnail in the file no longer matches (only export draws thumbnails). */
  const changed = useRef(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [sel, setSelState] = useState<Sel>(() => ({ board: file.design.artboards[0]?.id ?? '', ids: [], scope: null }))
  const selRef = useRef(sel)
  const select = (s: Sel) => {
    selRef.current = s
    setSelState(s)
  }
  const [flash, setFlash] = useState<{ ids: string[]; n: number } | null>(null)
  const [reveal, setReveal] = useState(0)
  const [msg, setMsg] = useState('')
  const msgTimer = useRef(0)
  const say = (m: string) => {
    setMsg(m)
    window.clearTimeout(msgTimer.current)
    msgTimer.current = window.setTimeout(() => setMsg(''), 4000)
  }

  // ---------- fonts (installed faces and the fallback come from the worker; bytes fetched once per face) ----------
  const fallback = useRef<Promise<Uint8Array> | null>(null)
  const faces = useRef(new Map<string, Promise<Uint8Array | null>>())
  const fetchFace = (ref: FontRef): Promise<Uint8Array | null> => {
    const k = fontKey(ref)
    let p = faces.current.get(k)
    if (!p) faces.current.set(k, (p = api.designFontBytes(ref).catch(() => null)))
    return p
  }
  const loads = useRef(0)
  /** The first load of the design's fonts (settled either way): ops wait for it. */
  const firstFonts = useRef<Promise<unknown> | null>(null)
  /** Loads every font `f` names; the newest load wins. */
  const loadFonts = async (f: DesignFile): Promise<FontSource> => {
    const n = ++loads.current
    if (!fallback.current) {
      const p = api.designFallbackFont()
      fallback.current = p
      p.catch(() => (fallback.current = null))
    }
    const source = await fontsFor(f.design, f.assets, fetchFace, await fallback.current)
    if (n === loads.current) {
      fontsRef.current = { source, built: f.design }
      setFonts(source)
    }
    return source
  }

  // ---------- changes and history ----------
  const setFile = (next: DesignFile) => {
    fileRef.current = next
    changed.current = true
    setFileState(next)
    propsRef.current.onChange()
  }
  /** One undo step; `merge` joins it to the step before when that was the same kind of change a moment ago. */
  const commit = (next: DesignFile, label: string, merge?: string) => {
    const now = Date.now()
    const last = lastMerge.current
    const top = past.current.at(-1)
    if (merge && top && last?.key === merge && now - last.at < MERGE_MS) top.label = label
    else {
      past.current.push({ file: fileRef.current, label })
      if (past.current.length > MAX_UNDO) past.current.shift()
    }
    lastMerge.current = merge ? { key: merge, at: now } : null
    future.current = []
    setFile(next)
  }
  const undo = () => {
    const step = past.current.pop()
    if (!step) return
    lastMerge.current = null
    future.current.push({ file: fileRef.current, label: step.label })
    setFile(step.file)
  }
  const redo = () => {
    const step = future.current.pop()
    if (!step) return
    lastMerge.current = null
    past.current.push({ file: fileRef.current, label: step.label })
    setFile(step.file)
  }
  // Undo or redo can bring back a font the loaded ones don't cover: load it (the drawing uses the fallback meanwhile).
  useEffect(() => {
    const built = fontsRef.current?.built
    if (built && newFonts(built, file.design)) void loadFonts(file).catch(() => {})
  }, [file])
  // What's selected and gone (an agent deleted it, an undo) drops out of the selection.
  useEffect(() => {
    const s = selRef.current
    const board = file.design.artboards.find(a => a.id === s.board) ?? file.design.artboards[0]
    if (!board) return
    const have = new Set<string>()
    walk(board.layers, l => have.add(l.id))
    const ids = s.ids.filter(id => have.has(id))
    const scope = s.scope && have.has(s.scope) ? s.scope : null
    if (board.id !== s.board || ids.length !== s.ids.length || scope !== s.scope) select({ board: board.id, ids, scope })
  }, [file])
  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(t)
  }, [flash])

  // ---------- ops: the person's and agents', one at a time, each one undo step ----------
  /**
   * Works an op out on the design as it is, then applies the result in one step. An op that brings in a font not loaded
   * yet (a new text family, an svg import) is worked out again once it's loaded, so its text is measured in it. If the
   * design changed while an op waited (layout, fonts), it's worked out again on what's there now. An op made while the
   * design's fonts are still loading (the panels show before the canvas) waits for them.
   */
  const applyOp = async (op: AgentOp, name: (summary: string) => string, merge?: string) => {
    if (!fontsRef.current) await firstFonts.current
    if (failedRef.current) throw new Error(failedRef.current)
    const ready = fontsRef.current
    if (!ready) throw new Error('The fonts for this design are still loading. Try again in a moment.')
    for (let tries = 0; ; tries++) {
      const before = fileRef.current
      // the fonts this op measures with, and the design they were loaded for
      let { source: fonts, built } = fontsRef.current ?? ready
      const load = async (f: DesignFile) => {
        fonts = await loadFonts(f)
        built = f.design
      }
      const services = (): OpServices => ({ fonts, layout: api.designLayout })
      if (newFonts(built, before.design)) await load(before)
      let r = await applyDesignOp(before, op, services())
      if (r.file && newFonts(built, r.file.design)) {
        await load(r.file)
        r = await applyDesignOp(before, op, services())
      }
      if (fileRef.current !== before) {
        if (tries < 3) continue
        throw new Error('The design kept changing while this ran. Try again.')
      }
      if (r.file) commit(r.file, name(r.summary), merge)
      return r
    }
  }
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(fn)
    queue.current = run.catch(() => {})
    return run
  }
  const agentOp = (op: AgentOp, agent: AgentInfo): Promise<unknown> =>
    enqueue(async () => {
      const r = await applyOp(op, s => `${agent?.name || 'Agent'}: ${s}`)
      if (r.file) {
        const ids = touched(r.result)
        if (ids.length) setFlash({ ids, n: Date.now() })
      }
      return r.result
    })
  /**
   * The person's ops on one artboard, as one undo step named for what they did; several go as one apply. A refusal shows
   * as a message. Resolves with the result, or null when nothing changed.
   */
  const userOps = (board: string, ops: AgentOp[], merge?: string): Promise<unknown> => {
    if (!ops.length) return Promise.resolve(null)
    const op: AgentOp = ops.length === 1 ? { ...ops[0], artboard: board } : { op: 'apply', artboard: board, ops }
    return enqueue(() => applyOp(op, s => s, merge)).then(
      r => r.result,
      e => {
        say((e as Error)?.message || String(e))
        return null
      }
    )
  }

  // ---------- the selection and what it can do ----------
  const boardOf = (id: string): Artboard | undefined => fileRef.current.design.artboards.find(a => a.id === id)
  /** The selected layers that can be acted on: any inside a selected group goes with it. */
  const tops = (): { board: string; layers: Placed[] } => {
    const s = selRef.current
    const b = boardOf(s.board)
    if (!b) return { board: s.board, layers: [] }
    const placed = new Map(placeAll(b.layers, b).map(p => [p.layer.id, p]))
    const layers = s.ids.map(id => placed.get(id)).filter((p): p is Placed => !!p && !p.ancestors.some(a => s.ids.includes(a.id)))
    return { board: s.board, layers }
  }
  const idsIn = (r: unknown): string[] => touched(r).filter(id => id !== selRef.current.board)
  const nudge = (dx: number, dy: number) => {
    const { board, layers } = tops()
    const ops: AgentOp[] = []
    for (const p of layers.filter(x => !x.locked)) {
      // along the screen, in the layer's own parent space (a group may be turned)
      const [x, y] = deltaIn(p.outer, [0, 0], [dx, dy])
      const props: Record<string, number> = {}
      if (r2(x)) props.x = r2(fin(p.layer.x, 0) + x)
      if (r2(y)) props.y = r2(fin(p.layer.y, 0) + y)
      if (Object.keys(props).length) ops.push({ op: 'set', layer: p.layer.id, props })
    }
    void userOps(board, ops, `nudge:${layers.map(p => p.layer.id).join(',')}`)
  }
  const remove = () => {
    const { board, layers } = tops()
    void userOps(board, layers.map(p => ({ op: 'delete', layer: p.layer.id })))
  }
  const duplicate = async () => {
    const { board, layers } = tops()
    const r = await userOps(board, layers.map(p => ({ op: 'duplicate', layer: p.layer.id, dx: COPY_OFFSET, dy: COPY_OFFSET })))
    if (r) select({ ...selRef.current, board, ids: idsIn(r) })
  }
  const group = async () => {
    const { board, layers } = tops()
    if (!layers.length) return
    const r = await userOps(board, [{ op: 'group', layers: layers.map(p => p.layer.id) }])
    if (r) select({ ...selRef.current, board, ids: idsIn(r) })
  }
  const ungroup = async () => {
    const { board, layers } = tops()
    const groups = layers.filter(p => p.layer.type === 'group')
    const r = await userOps(board, groups.map(p => ({ op: 'ungroup', layer: p.layer.id })))
    if (r) select({ ...selRef.current, board, ids: idsIn(r) })
  }
  const selectAll = () => {
    const s = selRef.current
    const b = boardOf(s.board)
    if (!b) return
    const ids = placeAll(b.layers, b)
      .filter(p => (s.scope ? p.ancestors.at(-1)?.id === s.scope : !p.ancestors.length) && !p.hidden && !p.locked)
      .map(p => p.layer.id)
    select({ ...s, ids })
  }
  /** Escape: out of the group entered (selecting it), else nothing selected. */
  const escape = () => {
    const s = selRef.current
    if (!s.scope) return select({ ...s, ids: [] })
    const b = boardOf(s.board)
    const up = b ? placeAll(b.layers, b).find(p => p.layer.id === s.scope)?.ancestors.at(-1)?.id ?? null : null
    select({ board: s.board, ids: [s.scope], scope: up })
  }
  /** The selected layers on the current artboard, as they are now. */
  const chosen = (): Layer[] => {
    const s = selRef.current
    const b = boardOf(s.board)
    const out: Layer[] = []
    if (b) walk(b.layers, l => s.ids.includes(l.id) && out.push(l))
    return out
  }
  /** Selects what a comment points at, and shows it. */
  const showAnchor = (a: CommentAnchor) => {
    const boards = fileRef.current.design.artboards
    let board = boards.find(b => b.id === a.artboard)
    let found: Placed | undefined
    for (const b of board ? [board, ...boards.filter(x => x !== board)] : boards) {
      found = a.layer ? placeAll(b.layers, b).find(p => p.layer.id === a.layer) : undefined
      if (found) {
        board = b
        break
      }
    }
    if (a.layer && !found) say('The layer this comment is on was deleted.')
    if (!board) return
    select({ board: board.id, ids: found ? [found.layer.id] : [], scope: found?.ancestors.at(-1)?.id ?? null })
    setReveal(n => n + 1)
  }

  // ---------- zoom ----------
  const setZoom = (z: number) => {
    const el = scroller.current
    if (el && el.scrollWidth && el.scrollHeight) {
      // keep the middle of the view where it is
      anchor.current = { x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight }
    }
    zoomRef.current = z
    setZoomState(z)
  }
  const zoomBy = (dir: 1 | -1) => setZoom(stepZoom(ZOOMS, zoomRef.current, dir))
  const fit = () => {
    const el = scroller.current
    if (el) setZoom(fitZoom(fileRef.current.design, el.clientWidth, el.clientHeight))
  }
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = a.x * el.scrollWidth - el.clientWidth / 2
    el.scrollTop = a.y * el.scrollHeight - el.clientHeight / 2
  }, [zoom])

  // ---------- the drawing ----------
  const drawn = useMemo(() => {
    if (!fonts) return null
    const downgrades: Downgrade[] = []
    const boards: Drawn[] = file.design.artboards.map(a => {
      try {
        return { a, svg: designToSvg(file.design, a.id, { fonts, assets: file.assets, mode: 'raster', downgrades }) }
      } catch (e) {
        return { a, svg: '', error: (e as Error).message }
      }
    })
    return { boards, downgrades }
  }, [file, fonts])
  // The first fit, once there is something to fit and a canvas to fit it in.
  useLayoutEffect(() => {
    if (zoom !== null || !drawn || !scroller.current) return
    const el = scroller.current
    const z = fitZoom(fileRef.current.design, el.clientWidth, el.clientHeight)
    zoomRef.current = z
    setZoomState(z)
  }, [drawn, zoom])

  // ---------- status bar (cached; the shell polls it) ----------
  const statusRef = useRef<StatusItem[]>([])
  useEffect(() => {
    const boards = file.design.artboards.length
    const left = drawn?.downgrades ?? []
    statusRef.current = [
      { text: plural(boards, 'artboard') },
      { text: plural(layerTotal(file.design), 'layer') },
      ...(zoom !== null ? [{ text: `${Math.round(zoom * 100)}%`, title: 'Zoom (Ctrl+scroll)', run: () => live.current.fit() }] : []),
      ...(left.length
        ? [{ text: `${plural(left.length, 'layer')} not drawn`, title: left.map(d => `${d.name || d.layer}: ${d.reason}`).join('\n') }]
        : [])
    ]
  }, [file, zoom, drawn])

  // ---------- keyboard while this tab is in front ----------
  useEffect(() => {
    if (!props.active) return
    const k = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      const L = live.current
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      // the editor's own keys only while focus is in it (not in the explorer or a dialog)
      const here = !document.activeElement || document.activeElement === document.body || !!root.current?.contains(document.activeElement)
      let run: (() => void) | null = null
      if (mod && !e.altKey) {
        if (key === 'z' && !e.shiftKey) run = L.undo
        else if (key === 'y' || (key === 'z' && e.shiftKey)) run = L.redo
        else if (here && key === 'g') run = e.shiftKey ? L.ungroup : L.group
        else if (here && key === 'd' && !e.shiftKey) run = L.duplicate
        else if (here && key === 'a' && !e.shiftKey) run = L.selectAll
      } else if (here && !mod && !e.altKey) {
        // with nothing selected these keys keep doing what they do (the arrows scroll the canvas)
        const s = selRef.current
        const step = e.shiftKey ? 10 : 1
        if (key === 'escape') run = s.ids.length || s.scope ? L.escape : null
        else if (!s.ids.length) run = null
        else if (key === 'delete' || key === 'backspace') run = L.remove
        else if (key === 'arrowleft') run = () => L.nudge(-step, 0)
        else if (key === 'arrowright') run = () => L.nudge(step, 0)
        else if (key === 'arrowup') run = () => L.nudge(0, -step)
        else if (key === 'arrowdown') run = () => L.nudge(0, step)
      }
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props.active])

  // ---------- the handle the shell and agents use ----------
  /** The design as saved: marked when its thumbnail no longer matches. */
  const stamped = (): Design => (changed.current ? { ...fileRef.current.design, thumbnailStale: true } : fileRef.current.design)
  // (the shell builds its menus once per tab, not per selection, so these act on whatever is selected when run)
  const menus = (): Partial<Record<'Edit' | 'View', MenuItem[]>> => ({
    Edit: [
      { label: 'Duplicate', shortcut: 'Ctrl+D', run: () => void live.current.duplicate() },
      { label: 'Delete', shortcut: 'Del', run: () => live.current.remove() },
      { label: '', sep: true },
      { label: 'Group', shortcut: 'Ctrl+G', run: () => void live.current.group() },
      { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', run: () => void live.current.ungroup() }
    ],
    View: [
      { label: 'Zoom in', run: () => zoomBy(1) },
      { label: 'Zoom out', run: () => zoomBy(-1) },
      { label: 'Fit artboards', run: fit }
    ]
  })
  const live = useRef({ agentOp, undo, redo, zoomBy, fit, menus, nudge, remove, duplicate, group, ungroup, selectAll, escape, showAnchor, chosen })
  live.current = { agentOp, undo, redo, zoomBy, fit, menus, nudge, remove, duplicate, group, ungroup, selectAll, escape, showAnchor, chosen }

  useEffect(() => {
    let gone = false
    const L = () => live.current
    const handle: EditorHandle = {
      language: 'design',
      // Only the assets the file on disk doesn't hold yet go along: the worker copies the rest from the file.
      getPayload: (): FilePayload => saves.current.partial({ ...fileRef.current, design: stamped() }),
      // Everything: for a copy somewhere else (save as, a version kept before a restore, gdocs look), and for a save
      // again when a partial one failed (the file was replaced from outside).
      peekPayload: (): FilePayload => saves.current.full({ ...fileRef.current, design: stamped() }),
      saved: p => saves.current.saved(p),
      agent: (op, agent) => L().agentOp(op, agent),
      command: id => {
        if (id === 'undo') L().undo()
        else if (id === 'redo') L().redo()
        else if (id === 'selectAll') L().selectAll()
      },
      menus: () => L().menus(),
      zoomBy: dir => L().zoomBy(dir),
      focus: () => scroller.current?.focus({ preventScroll: true }),
      status: () => statusRef.current,
      // a comment on the first selected layer, quoted by its name
      commentAnchor: () => {
        const l = L().chosen()[0]
        return l ? { anchor: { artboard: selRef.current.board, layer: l.id }, quote: l.name } : null
      },
      showAnchor: a => L().showAnchor(a)
    }
    // Ready for agents (and for gdocs look to picture it) once the fonts are in; a failure is reported to each op.
    firstFonts.current = loadFonts(fileRef.current)
      .catch(e => {
        const msg = `Could not load fonts for this design: ${(e as Error)?.message || e}`
        failedRef.current = msg
        setFailed(msg)
      })
      .finally(() => {
        if (!gone) props.setHandle(handle)
      })
    return () => {
      gone = true
      props.setHandle(null)
    }
  }, [])

  const z = zoom ?? 1
  const canUndo = past.current.length > 0
  const canRedo = future.current.length > 0
  const board = file.design.artboards.find(a => a.id === sel.board) ?? file.design.artboards[0]
  const picked = board ? (() => {
    const out: Layer[] = []
    walk(board.layers, l => sel.ids.includes(l.id) && out.push(l))
    return out
  })() : []
  return (
    <div className="de-editor" ref={root}>
      <div className="toolbar de-toolbar">
        <button className="tb" disabled={!canUndo} title={canUndo ? `Undo ${past.current.at(-1)!.label} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} onClick={undo}>
          <Glyph d={P.undo} />
        </button>
        <button className="tb" disabled={!canRedo} title={canRedo ? `Redo ${future.current.at(-1)!.label} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} onClick={redo}>
          <Glyph d={P.redo} />
        </button>
        <span className="tb-sep" />
        <button className="tb" title="Zoom out" onClick={() => zoomBy(-1)}>
          <Glyph d={P.out} />
        </button>
        <button className="tb de-zoom" title="Fit artboards" onClick={fit}>
          {Math.round(z * 100)}%
        </button>
        <button className="tb" title="Zoom in" onClick={() => zoomBy(1)}>
          <Glyph d={P.in} />
        </button>
      </div>
      {notes.length > 0 && (
        <div className="de-notes" role="status">
          <div className="de-notes-row">
            <span className="grow">
              {notes.length === 1 ? `Opening this design fixed ${notes[0]}.` : `Opening this design fixed ${notes.length} things.`}
            </span>
            {notes.length > 1 && (
              <button className="de-link" onClick={() => setNotesOpen(!notesOpen)}>
                {notesOpen ? 'Hide' : 'Show'}
              </button>
            )}
            <button className="icon-btn sm" title="Dismiss" onClick={() => setNotes([])}>
              <Glyph d={P.close} />
            </button>
          </div>
          {notesOpen && (
            <ul>
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="de-body">
        {board && (
          <Layers
            design={file.design}
            board={board}
            sel={sel}
            onSelect={select}
            onBoard={id => select({ board: id, ids: [], scope: null })}
            onSet={(ids, p) => void userOps(board.id, ids.map(id => ({ op: 'set', layer: id, props: p })))}
            onMove={(id, parent, index) => void userOps(board.id, [{ op: 'move', layer: id, to: { parent, index } }])}
          />
        )}
        <div className="de-canvas" ref={scroller} tabIndex={-1}>
          {failed ? (
            <div className="editor-placeholder">{failed}</div>
          ) : !drawn || !fonts ? (
            <div className="editor-placeholder">Loading fonts</div>
          ) : (
            <Canvas
              file={file}
              fonts={fonts}
              boards={drawn.boards}
              zoom={z}
              ready={zoom !== null}
              pad={PAD}
              gap={GAP}
              sel={sel}
              flash={flash}
              reveal={reveal}
              active={props.active}
              scroller={scroller}
              onSelect={select}
              onOps={userOps}
            />
          )}
        </div>
        <Props
          design={file.design}
          layers={picked}
          onSet={(ids, p, liveChange) =>
            board && void userOps(board.id, ids.map(id => ({ op: 'set', layer: id, props: p })), liveChange ? `props:${ids.join(',')}:${Object.keys(p).join(',')}` : undefined)
          }
        />
      </div>
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </div>
  )
}
