import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type FontSource, fontsFor, newFonts } from '../../../shared/design/fonts'
import { newDesign, walk } from '../../../shared/design/model'
import { type Downgrade, designToSvg } from '../../../shared/design/render'
import type { Design, DesignFile, FontRef } from '../../../shared/design/types'
import { applyDesignOp } from '../../../shared/ops/design'
import type { OpServices } from '../../../shared/ops/types'
import type { AgentInfo, AgentOp, FilePayload } from '../../../shared/types'
import type { EditorHandle, EditorProps, MenuItem, StatusItem } from '../editor'
import { api } from '../lib'
import { stepZoom } from '../shell/zoom'
import { DesignSaves } from './saves'
import './design.css'

/**
 * The design editor (.gdesign), first version: every artboard side by side on a neutral canvas, drawn by the one
 * renderer (designToSvg, raster mode) as inline SVG, with zoom (Ctrl+scroll, the toolbar or View) and scrolling. Agent
 * ops (shared/ops/design.ts) apply here exactly as on disk, one at a time, each one undo step named for the agent
 * ("Claude: added 3 layers"). Undo keeps 100 designs. Fonts are measured with the installed faces the worker finds,
 * and diagrams are laid out by the worker too (ELK can't run in this window).
 */

/** Zoom levels, as a share of the design's own pixels. */
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const MAX_UNDO = 100
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

export default function DesignEditor(props: EditorProps) {
  const propsRef = useRef(props)
  propsRef.current = props
  const loaded = props.payload.kind === 'design' ? props.payload : null
  const [file, setFileState] = useState<DesignFile>(() => loaded?.file ?? { design: newDesign('instagram'), assets: {} })
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
  /** What the file on disk holds: a save sends only the other assets. */
  const saves = useRef(new DesignSaves(loaded?.file.assets ?? {}))
  /** Changed since it was opened: the thumbnail in the file no longer matches (only export draws thumbnails). */
  const changed = useRef(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const scroller = useRef<HTMLDivElement>(null)

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
  const commit = (next: DesignFile, label: string) => {
    past.current.push({ file: fileRef.current, label })
    if (past.current.length > MAX_UNDO) past.current.shift()
    future.current = []
    setFile(next)
  }
  const undo = () => {
    const step = past.current.pop()
    if (!step) return
    future.current.push({ file: fileRef.current, label: step.label })
    setFile(step.file)
  }
  const redo = () => {
    const step = future.current.pop()
    if (!step) return
    past.current.push({ file: fileRef.current, label: step.label })
    setFile(step.file)
  }
  // Undo or redo can bring back a font the loaded ones don't cover: load it (the drawing uses the fallback meanwhile).
  useEffect(() => {
    const built = fontsRef.current?.built
    if (built && newFonts(built, file.design)) void loadFonts(file).catch(() => {})
  }, [file])

  // ---------- agent ops: one at a time, each one undo step ----------
  /**
   * Works an op out on the design as it is, then applies the result in one step. An op that brings in a font not loaded
   * yet (a new text family, an svg import) is worked out again once it's loaded, so its text is measured in it. If the
   * person undid or redid while an op waited (layout, fonts), it's worked out again on what's there now.
   */
  const applyAgentOp = async (op: AgentOp, agent: AgentInfo): Promise<unknown> => {
    if (failedRef.current) throw new Error(failedRef.current)
    for (let tries = 0; ; tries++) {
      const before = fileRef.current
      // the fonts this op measures with, and the design they were loaded for
      let { source: fonts, built } = fontsRef.current!
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
      if (r.file) commit(r.file, `${agent?.name || 'Agent'}: ${r.summary}`)
      return r.result
    }
  }
  const agentOp = (op: AgentOp, agent: AgentInfo): Promise<unknown> => {
    const run = queue.current.then(() => applyAgentOp(op, agent))
    queue.current = run.catch(() => {})
    return run
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
    const boards = file.design.artboards.map(a => {
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

  // ---------- keyboard: undo and redo while this tab is in front ----------
  useEffect(() => {
    if (!props.active) return
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        live.current.undo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        live.current.redo()
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props.active])

  // ---------- the handle the shell and agents use ----------
  /** The design as saved: marked when its thumbnail no longer matches. */
  const stamped = (): Design => (changed.current ? { ...fileRef.current.design, thumbnailStale: true } : fileRef.current.design)
  const menus = (): Partial<Record<'View', MenuItem[]>> => ({
    View: [
      { label: 'Zoom in', run: () => zoomBy(1) },
      { label: 'Zoom out', run: () => zoomBy(-1) },
      { label: 'Fit artboards', run: fit }
    ]
  })
  const live = useRef({ agentOp, undo, redo, zoomBy, fit, menus })
  live.current = { agentOp, undo, redo, zoomBy, fit, menus }

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
      },
      menus: () => L().menus(),
      zoomBy: dir => L().zoomBy(dir),
      focus: () => scroller.current?.focus({ preventScroll: true }),
      status: () => statusRef.current
    }
    // Ready for agents (and for gdocs look to picture it) once the fonts are in; a failure is reported to each op.
    loadFonts(fileRef.current)
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
  return (
    <div className="de-editor">
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
      <div className="de-canvas" ref={scroller} tabIndex={-1}>
        {failed ? (
          <div className="editor-placeholder">{failed}</div>
        ) : !drawn ? (
          <div className="editor-placeholder">Loading fonts</div>
        ) : (
          <div className="de-row" style={{ padding: PAD, gap: GAP, visibility: zoom === null ? 'hidden' : undefined }}>
            {drawn.boards.map(({ a, svg, error }) => (
              <figure key={a.id} className="de-board-wrap" style={{ width: a.width * z }}>
                <figcaption className="de-board-name" title={`${a.name}  ${a.width} x ${a.height}`}>
                  {a.name} <span className="muted">{a.width} x {a.height}</span>
                </figcaption>
                {error ? (
                  <div className="de-board de-board-error" style={{ width: a.width * z, height: a.height * z }}>
                    {error}
                  </div>
                ) : (
                  <div
                    className={`de-board${a.background ? '' : ' clear'}`}
                    data-artboard={a.id}
                    style={{ width: a.width * z, height: a.height * z }}
                    // our own renderer's output: every value in it is escaped, and svg layers are drawn as images
                    dangerouslySetInnerHTML={{ __html: svg }}
                  />
                )}
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
