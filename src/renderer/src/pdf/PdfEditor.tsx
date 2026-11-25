import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { structuralEdits } from '../../../shared/ops/pdf'
import { applyPdfEdits, checkEdits, parsePages } from '../../../shared/pdf/edits'
import { allText, joinPages } from '../../../shared/pdf/text'
import type { AgentOp, PdfEdit } from '../../../shared/types'
import type { EditorHandle, EditorProps, MenuItem, MenuName } from '../editor'
import { Icon } from './icons'
import { DEFAULT_COLORS, type Markup, type Tool, isMarkup, readImage } from './markup'
import PdfPage from './PdfPage'
import { type PdfDoc, fetchAll, openPdf } from './pdfjs'
import Thumbs from './Thumbs'
import './pdf.css'

/** Saved bytes plus markup not yet written into them. Undo/redo step through these. */
// bytes null = the file as it is on disk, streamed by range from `url` (nothing held in memory until needed).
interface Snapshot { bytes: Uint8Array | null; edits: PdfEdit[] }
interface Loaded { proxy: PdfDoc; bytes: Uint8Array | null; sizes: { w: number; h: number; rotation: number }[]; close(): void }

const CSS_PER_PT = 96 / 72 // 100% zoom = real size on a 96 dpi screen
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48]
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'select', icon: 'select', label: 'Select and move markup (V)' },
  { id: 'text', icon: 'text', label: 'Add text (T)' },
  { id: 'highlight', icon: 'highlight', label: 'Highlight an area (H)' },
  { id: 'draw', icon: 'draw', label: 'Draw (D)' },
  { id: 'whiteout', icon: 'whiteout', label: 'Whiteout: cover an area with white (W)' },
  { id: 'rect', icon: 'rect', label: 'Rectangle (R)' }
]
const TOOL_KEYS: Record<string, Tool> = { v: 'select', t: 'text', h: 'highlight', d: 'draw', w: 'whiteout', r: 'rect' }

const editableTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export default function PdfEditor(props: EditorProps) {
  const url = props.payload.kind === 'pdf' ? props.payload.url : undefined
  const initial = props.payload.kind === 'pdf' && !url ? props.payload.bytes : null
  /** Every byte of the current version: from memory after an edit, otherwise read from disk once, on demand. */
  const bytesOf = async (s: Snapshot) => s.bytes ?? (await fetchAll(url!))
  const [snap, setSnapState] = useState<Snapshot>({ bytes: initial, edits: [] })
  const snapRef = useRef(snap)
  const setSnap = (s: Snapshot) => {
    snapRef.current = s
    setSnapState(s)
  }
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const propsRef = useRef(props)
  propsRef.current = props

  const commit = useCallback((next: Snapshot) => {
    past.current.push(snapRef.current)
    if (past.current.length > 200) past.current.shift()
    future.current = []
    setSnap(next)
    propsRef.current.onChange()
  }, [])

  // ---------- loading ----------
  const [doc, setDoc] = useState<Loaded | null>(null)
  const docRef = useRef<Loaded | null>(null)
  const [error, setError] = useState('')
  const textRef = useRef<Promise<{ page: number; text: string }[]> | null>(null)
  const textNow = useRef<string[]>([])
  const [textReady, setTextReady] = useState(0)

  useEffect(() => {
    let cancelled = false
    const task = openPdf(snap.bytes ?? url!)
    task.promise
      .then(async proxy => {
        // Show the document as soon as the first pages are measured; long documents measure the rest in the
        // background (each page's size needs a small read), assuming page 1's size until then.
        const measure = async (i: number) => {
          const page = await proxy.getPage(i)
          const vp = page.getViewport({ scale: 1 })
          const s = { w: vp.width, h: vp.height, rotation: page.rotate }
          page.cleanup()
          return s
        }
        const FIRST = Math.min(proxy.numPages, 20)
        const sizes: Loaded['sizes'] = []
        for (let i = 1; i <= FIRST; i++) sizes.push(await measure(i))
        for (let i = FIRST + 1; i <= proxy.numPages; i++) sizes.push({ ...sizes[0] })
        const close = () => void task.destroy().catch(() => {})
        if (cancelled) return close()
        const old = docRef.current
        const loaded: Loaded = { proxy, bytes: snap.bytes, sizes, close }
        docRef.current = loaded
        setDoc(loaded)
        if (proxy.numPages > FIRST)
          (async () => {
            for (let i = FIRST + 1; i <= proxy.numPages; i++) {
              if (cancelled || docRef.current !== loaded) return
              sizes[i - 1] = await measure(i)
              if (i % 100 === 0 || i === proxy.numPages) setDoc({ ...loaded }) // re-layout in batches
            }
          })().catch(() => {})
        setError('')
        setTimeout(() => old?.close(), 1000) // after the pages have switched to the new document
        // Page text is extracted only when something asks for it (search, agents), not on open.
        textRef.current = null
        textNow.current = []
      })
      .catch(e => {
        if (cancelled) return
        setError(e?.name === 'PasswordException' ? 'This PDF is password protected; it cannot be opened yet.' : `Cannot open this PDF: ${e?.message || e}`)
      })
    return () => {
      cancelled = true
    }
  }, [snap.bytes])
  useEffect(() => () => docRef.current?.close(), [])

  const ensureText = () => {
    const loaded = docRef.current
    if (!loaded) return Promise.resolve([] as { page: number; text: string }[])
    if (!textRef.current) {
      textRef.current = allText(loaded.proxy).then(t => {
        if (docRef.current === loaded) {
          textNow.current = t.map(x => x.text)
          setTextReady(v => v + 1)
        }
        return t
      })
      textRef.current.catch(() => {})
    }
    return textRef.current
  }

  /** Resolves once the document on screen matches the current bytes (agent ops wait for this). */
  const waitDoc = async (): Promise<Loaded> => {
    for (let t = 0; t < 600; t++) {
      const d = docRef.current
      if (d && d.bytes === snapRef.current.bytes) return d
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error('The PDF did not finish loading')
  }

  // ---------- layout: zoom, visible pages, current page ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 900, h: 700 })
  const [zoom, setZoom] = useState<'auto' | 'width' | 'page' | number>('auto')
  const [thumbs, setThumbs] = useState(true)
  const [current, setCurrent] = useState(1)
  const [visible, setVisible] = useState<Set<number>>(new Set([1, 2]))
  const pageEls = useRef(new Map<number, HTMLDivElement>())
  const setEl = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(n, el)
    else pageEls.current.delete(n)
  }, [])

  useEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sizes = doc?.sizes || []
  const count = sizes.length
  const maxW = Math.max(1, ...sizes.map(s => s.w))
  const fitW = (box.w - 64) / maxW
  const fitP = Math.min(fitW, (box.h - 40) / (sizes[current - 1]?.h || 792))
  const scale = Math.min(8, Math.max(0.1,
    zoom === 'auto' ? Math.min(fitW, CSS_PER_PT) : zoom === 'width' ? fitW : zoom === 'page' ? fitP : zoom * CSS_PER_PT))

  // Keep the same spot in view when the zoom changes.
  const ratio = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight) el.scrollTop = ratio.current * el.scrollHeight
  }, [scale])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || !count) return
    const io = new IntersectionObserver(
      entries =>
        setVisible(prev => {
          const next = new Set(prev)
          for (const en of entries) {
            const n = Number((en.target as HTMLElement).dataset.page)
            if (en.isIntersecting) next.add(n)
            else next.delete(n)
          }
          return next
        }),
      { root, rootMargin: '1200px 0px' }
    )
    pageEls.current.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [doc, count])

  const onScroll = () => {
    const el = scrollRef.current!
    ratio.current = el.scrollTop / (el.scrollHeight || 1)
    const line = el.scrollTop + el.clientHeight * 0.3
    let n = 1
    for (let i = 1; i <= count; i++) {
      const p = pageEls.current.get(i)
      if (p && p.offsetTop <= line) n = i
      else break
    }
    if (n !== current) setCurrent(n)
  }

  const jump = (n: number) => {
    const p = pageEls.current.get(Math.min(Math.max(1, n), count))
    if (p && scrollRef.current) scrollRef.current.scrollTop = p.offsetTop - 16
  }

  const flash = (pages: number[]) => {
    if (!pages.length) return
    jump(pages[0])
    for (const n of new Set(pages)) {
      const el = pageEls.current.get(n)
      if (!el) continue
      el.classList.remove('agent-flash')
      void el.offsetWidth
      el.classList.add('agent-flash')
    }
  }

  const zoomStep = (dir: 1 | -1) => {
    const pct = scale / CSS_PER_PT
    const next = dir > 0 ? ZOOMS.find(z => z > pct + 0.01) : [...ZOOMS].reverse().find(z => z < pct - 0.01)
    setZoom(next ?? (dir > 0 ? ZOOMS[ZOOMS.length - 1] : ZOOMS[0]))
  }

  // ---------- markup ----------
  const [tool, setTool] = useState<Tool>('select')
  const [colors, setColors] = useState<Record<string, string>>(DEFAULT_COLORS)
  const [textSize, setTextSize] = useState(12)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const byPage = useMemo(() => {
    const m = new Map<number, { i: number; e: Markup }[]>()
    snap.edits.forEach((e, i) => {
      if (!isMarkup(e)) return
      if (!m.has(e.page)) m.set(e.page, [])
      m.get(e.page)!.push({ i, e })
    })
    return m
  }, [snap.edits])
  const EMPTY = useMemo(() => [] as { i: number; e: Markup }[], [])

  const onAdd = useCallback((e: Markup) => {
    const s = snapRef.current
    commit({ ...s, edits: [...s.edits, e] })
    if (e.type === 'image') setSelected(s.edits.length)
  }, [commit])
  const onUpdate = useCallback((i: number, e: Markup) => {
    const s = snapRef.current
    commit({ ...s, edits: s.edits.map((x, j) => (j === i ? e : x)) })
  }, [commit])
  const onRemove = useCallback((i: number) => {
    const s = snapRef.current
    commit({ ...s, edits: s.edits.filter((_, j) => j !== i) })
    setSelected(null)
  }, [commit])

  /** Page changes (rotate / delete / move) are written into the bytes at once, together with pending markup. */
  const structural = async (edits: PdfEdit[]) => {
    const s = snapRef.current
    setBusy('Updating pages…')
    try {
      const bytes = await applyPdfEdits(await bytesOf(s), [...s.edits, ...edits])
      setSelected(null)
      commit({ bytes, edits: [] })
    } finally {
      setBusy('')
    }
  }

  const rotatePage = (n: number, degrees: number) => structural([{ type: 'rotate', page: n, degrees }])
  const deletePage = (n: number) => {
    if (count <= 1) return setNotice('A PDF needs at least one page.')
    structural([{ type: 'delete', page: n }])
  }
  const movePage = (from: number, to: number) => structural([{ type: 'move', page: from, to }])

  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(snapRef.current)
    setSnap(prev)
    setSelected(null)
    props.onChange()
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(snapRef.current)
    setSnap(next)
    setSelected(null)
    props.onChange()
  }

  const selectedEdit = selected != null ? (snap.edits[selected] as Markup | undefined) : undefined
  const colorKey = selectedEdit
    ? selectedEdit.type === 'ink' ? 'draw' : selectedEdit.type === 'rect' && selectedEdit.fill ? '' : selectedEdit.type
    : tool === 'whiteout' || tool === 'select' ? '' : tool
  const colorValue = selectedEdit && colorKey
    ? (selectedEdit as { color?: string }).color || DEFAULT_COLORS[colorKey]
    : colors[colorKey]
  const setColor = (c: string) => {
    if (selectedEdit && selected != null && colorKey) onUpdate(selected, { ...selectedEdit, color: c } as Markup)
    else if (colorKey) setColors(x => ({ ...x, [colorKey]: c }))
  }
  const showSize = tool === 'text' || selectedEdit?.type === 'text'
  const sizeValue = selectedEdit?.type === 'text' ? selectedEdit.size || 12 : textSize
  const setSize = (n: number) => {
    if (selectedEdit?.type === 'text' && selected != null) onUpdate(selected, { ...selectedEdit, size: n })
    else setTextSize(n)
  }

  // ---------- image / signature ----------
  const fileRef = useRef<HTMLInputElement>(null)
  const addImage = async (f: File) => {
    try {
      const img = await readImage(f)
      const page = sizes[current - 1] || { w: 612, h: 792 }
      const w = Math.min(200, page.w * 0.5, img.w)
      const h = (w * img.h) / img.w
      onAdd({ type: 'image', page: current, x: (page.w - w) / 2, y: (page.h - h) / 2, w, h, png: img.src })
      setTool('select')
    } catch (e) {
      setNotice(`Could not read that image: ${(e as Error).message}`)
    }
  }

  // ---------- search ----------
  const [search, setSearch] = useState<{ open: boolean; q: string; idx: number }>({ open: false, q: '', idx: 0 })
  const searchRef = useRef<HTMLInputElement>(null)
  const hits = useMemo(() => {
    const q = search.q.trim().toLowerCase()
    if (!q) return [] as { page: number; k: number }[]
    if (!textRef.current) void ensureText()
    const out: { page: number; k: number }[] = []
    textNow.current.forEach((t, i) => {
      const low = t.toLowerCase()
      let k = 0
      for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) out.push({ page: i + 1, k: k++ })
    })
    return out
  }, [search.q, textReady])
  const navigated = useRef(false)
  useEffect(() => {
    navigated.current = false
  }, [search.q])
  const goHit = (idx: number) => {
    if (!hits.length) return
    navigated.current = true
    const i = ((idx % hits.length) + hits.length) % hits.length
    setSearch(s => ({ ...s, idx: i }))
    jump(hits[i].page)
    setTimeout(() => {
      const el = pageEls.current.get(hits[i].page)?.querySelectorAll('.pdf-hit')[hits[i].k] as HTMLElement | undefined
      el?.scrollIntoView({ block: 'center' })
    }, 250)
  }
  const openSearch = () => {
    setSearch(s => ({ ...s, open: true }))
    setTimeout(() => searchRef.current?.select(), 0)
  }

  // ---------- keyboard (only while this tab is active) ----------
  useEffect(() => {
    if (!props.active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        return openSearch()
      }
      if (editableTarget(e.target)) return
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo() }
      if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); return redo() }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null) { e.preventDefault(); return onRemove(selected) }
      if (e.key === 'Escape') { setSelected(null); setTool('select'); return }
      if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) return setTool(TOOL_KEYS[e.key.toLowerCase()])
      if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); jump(current + (e.key === 'PageDown' ? 1 : -1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // ---------- the handle the shell and agents use ----------
  const live = useRef({ ensureText, structural, flash, waitDoc, undo, redo, jump, setThumbs, setZoom, zoomStep, rotatePage, deletePage, openSearch, current, count, thumbs, selected, onRemove })
  live.current = { ensureText, structural, flash, waitDoc, undo, redo, jump, setThumbs, setZoom, zoomStep, rotatePage, deletePage, openSearch, current, count, thumbs, selected, onRemove }

  useEffect(() => {
    const handle: EditorHandle = {
      language: 'pdf',
      status: () => {
        const L = live.current
        const pending = snapRef.current.edits.length
        return [
          { text: `Page ${L.current} of ${L.count}`, title: 'PgUp / PgDn' },
          ...(pending ? [{ text: `${pending} unsaved markup`, title: 'Written into the PDF when you save (Ctrl+S)' }] : []),
          ...(textNow.current.length ? [{ text: `${textNow.current.reduce((n, t) => n + (t.match(/\S+/g)?.length || 0), 0).toLocaleString()} words` }] : [])
        ]
      },
      getPayload: async () => {
        const s = snapRef.current
        if (!s.edits.length) return { kind: 'pdf', bytes: await bytesOf(s) }
        const bytes = await applyPdfEdits(await bytesOf(s), s.edits)
        setSelected(null)
        setSnap({ bytes, edits: [] }) // the saved file is the new original; markup is now part of the page
        return { kind: 'pdf', bytes }
      },
      getText: () => (void live.current.ensureText(), textNow.current).map((text, i) => `--- Page ${i + 1} ---\n${text}`).join('\n\n'),
      command: id => {
        if (id === 'undo') live.current.undo()
        else if (id === 'redo') live.current.redo()
        else if (id === 'find' || id === 'replace') live.current.openSearch()
      },
      focus: () => scrollRef.current?.focus(),
      menus: () => {
        const L = live.current
        const m: Partial<Record<MenuName, MenuItem[]>> = {
          Edit: [{ label: 'Delete selected markup', shortcut: 'Del', disabled: L.selected == null, run: () => L.selected != null && L.onRemove(L.selected) }],
          View: [
            { label: 'Page thumbnails', checked: L.thumbs, run: () => L.setThumbs(t => !t) },
            { sep: true, label: '' },
            { label: 'Zoom in', run: () => L.zoomStep(1) },
            { label: 'Zoom out', run: () => L.zoomStep(-1) },
            { label: 'Fit width', run: () => L.setZoom('width') },
            { label: 'Fit page', run: () => L.setZoom('page') },
            { label: 'Actual size', run: () => L.setZoom(1) }
          ],
          Tools: [
            { label: 'Rotate page clockwise', run: () => L.rotatePage(L.current, 90) },
            { label: 'Rotate page counter-clockwise', run: () => L.rotatePage(L.current, -90) },
            { label: 'Rotate all pages clockwise', run: () => L.structural(Array.from({ length: L.count }, (_, i) => ({ type: 'rotate' as const, page: i + 1, degrees: 90 }))) },
            { label: 'Delete page', disabled: L.count <= 1, run: () => L.deletePage(L.current) },
            { sep: true, label: '' },
            { label: 'Find in PDF', shortcut: 'Ctrl+F', run: () => L.openSearch() }
          ]
        }
        return m
      },
      agent: async (op: AgentOp) => {
        const d = await live.current.waitDoc()
        const n = d.sizes.length
        const L = () => live.current
        switch (op.op) {
          case 'info':
            return { pages: n, sizes: d.sizes.map(s => ({ w: Math.round(s.w * 100) / 100, h: Math.round(s.h * 100) / 100, rotation: s.rotation })), pendingEdits: snapRef.current.edits.length }
          case 'read': {
            const pages = parsePages(op.pages as string | number | undefined, n)
            const texts = (await live.current.ensureText()).filter(t => pages.includes(t.page))
            return op.format === 'json' ? { pages: texts } : { content: joinPages(texts) }
          }
          case 'find': {
            const q = String(op.query || '').toLowerCase()
            if (!q) throw new Error('find needs query')
            const texts = await live.current.ensureText()
            return { matches: texts.map(t => ({ page: t.page, count: t.text.toLowerCase().split(q).length - 1 })).filter(m => m.count) }
          }
          case 'annotate': {
            const edits = checkEdits(op.edits)
            for (const e of edits) if (e.page < 1 || e.page > n) throw new Error(`Page ${e.page} is outside 1-${n}`)
            if (edits.every(isMarkup)) {
              const s = snapRef.current
              commit({ ...s, edits: [...s.edits, ...edits] })
              setTimeout(() => L().flash(edits.map(e => e.page)), 50)
              return { ok: true, applied: edits.length, pending: true, note: 'Shown in the app; written into the file on save.' }
            }
            await L().structural(edits)
            await L().waitDoc()
            setTimeout(() => L().flash(edits.map(e => Math.min(e.page, docRef.current?.sizes.length || 1))), 50)
            return { ok: true, applied: edits.length, pages: docRef.current?.sizes.length }
          }
          case 'rotate':
          case 'deletePages':
          case 'movePage': {
            const edits = structuralEdits(op, n)
            await L().structural(edits)
            const after = await L().waitDoc()
            const pages = op.op === 'movePage' ? [Math.min(Number(op.to), after.sizes.length)] : op.op === 'rotate' ? edits.map(e => e.page) : []
            setTimeout(() => L().flash(pages), 50)
            return { ok: true, pages: after.sizes.length }
          }
          case 'merge':
            throw new Error('Merging works on files on disk: run `gdocs pdf merge <out> <inputs...>`, or close the file first.')
          case 'write':
            throw new Error('PDFs cannot be rewritten from text. Use annotate, rotate, deletePages or movePage.')
          default:
            throw new Error(`Unknown op "${op.op}" for PDFs. Try: info, read, find, annotate, rotate, deletePages, movePage`)
        }
      }
    }
    props.setHandle(handle)
    return () => props.setHandle(null)
  }, [])

  const pct = Math.round((scale / CSS_PER_PT) * 100)

  return (
    <div className="pdf-editor">
      <div className="toolbar">
        <button className="tb" title="Undo (Ctrl+Z)" onClick={undo} disabled={!past.current.length}><Icon name="undo" /></button>
        <button className="tb" title="Redo (Ctrl+Y)" onClick={redo} disabled={!future.current.length}><Icon name="redo" /></button>
        <span className="tb-sep" />
        <button className={`tb${thumbs ? ' on' : ''}`} title="Page thumbnails" onClick={() => setThumbs(t => !t)}><Icon name="thumbs" /></button>
        <span className="pdf-pageno">
          <input
            className="tb-input"
            key={current}
            defaultValue={current}
            aria-label="Page"
            onKeyDown={e => {
              if (e.key === 'Enter') jump(Number((e.target as HTMLInputElement).value) || 1)
            }}
            onBlur={e => (e.target.value = String(current))}
          />
          <span className="muted">/ {count || '–'}</span>
        </span>
        <span className="tb-sep" />
        <button className="tb" title="Zoom out" onClick={() => zoomStep(-1)}><Icon name="zoomOut" /></button>
        <select
          className="tb-select"
          value={typeof zoom === 'number' ? String(zoom) : zoom}
          onChange={e => setZoom(['auto', 'width', 'page'].includes(e.target.value) ? (e.target.value as 'width') : Number(e.target.value))}
          title="Zoom"
        >
          <option value="auto">{zoom === 'auto' ? `${pct}%` : 'Automatic'}</option>
          <option value="width">Fit width</option>
          <option value="page">Fit page</option>
          {ZOOMS.map(z => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
          {typeof zoom === 'number' && !ZOOMS.includes(zoom) && <option value={String(zoom)}>{pct}%</option>}
        </select>
        <button className="tb" title="Zoom in" onClick={() => zoomStep(1)}><Icon name="zoomIn" /></button>
        <span className="tb-sep" />
        {TOOLS.map(t => (
          <button key={t.id} className={`tb${tool === t.id ? ' on' : ''}`} title={t.label} onClick={() => { setTool(t.id); setSelected(null) }}>
            <Icon name={t.icon} />
          </button>
        ))}
        <button className="tb" title="Add an image or signature (PNG/JPEG)" onClick={() => fileRef.current?.click()}><Icon name="image" /></button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) addImage(f)
            e.target.value = ''
          }}
        />
        {colorKey && (
          <label className="tb pdf-color" title="Color">
            <span className="swatch-dot" style={{ background: colorValue }} />
            <input type="color" value={colorValue} onChange={e => setColor(e.target.value)} />
          </label>
        )}
        {showSize && (
          <select className="tb-select" title="Text size" value={sizeValue} onChange={e => setSize(Number(e.target.value))}>
            {TEXT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <span className="tb-sep" />
        <button className="tb" title="Rotate page clockwise" onClick={() => rotatePage(current, 90)} disabled={!count}><Icon name="rotate" /></button>
        <button className="tb" title="Delete page" onClick={() => deletePage(current)} disabled={count <= 1}><Icon name="trash" /></button>
        <span className="grow" />
        {snap.edits.length > 0 && <span className="pdf-pending" title="Markup is written into the PDF when you save">{snap.edits.length} unsaved markup</span>}
        <button className={`tb${search.open ? ' on' : ''}`} title="Find (Ctrl+F)" onClick={() => (search.open ? setSearch(s => ({ ...s, open: false, q: '' })) : openSearch())}>
          <Icon name="search" />
        </button>
      </div>

      <div className="pdf-body">
        {thumbs && doc && <Thumbs doc={doc.proxy} sizes={doc.sizes} current={current} onJump={jump} onMove={movePage} />}
        <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={-1} onPointerDown={e => {
          if (tool === 'select' && (e.target as HTMLElement).closest('.pdf-mark') == null) setSelected(null)
        }}>
          {error && <div className="pdf-error">{error}</div>}
          {doc && (
            <div className="pdf-pages">
              {doc.sizes.map((s, i) => (
                <PdfPage
                  key={i + 1}
                  doc={doc.proxy}
                  n={i + 1}
                  size={s}
                  scale={scale}
                  visible={visible.has(i + 1)}
                  markups={byPage.get(i + 1) || EMPTY}
                  tool={tool}
                  color={colors[tool === 'draw' ? 'draw' : tool] || '#000000'}
                  textSize={textSize}
                  inkWidth={2}
                  selected={selected}
                  query={search.open ? search.q : ''}
                  onSelect={setSelected}
                  onAdd={onAdd}
                  onUpdate={onUpdate}
                  onRemove={onRemove}
                  setEl={setEl}
                />
              ))}
            </div>
          )}
          {!doc && !error && <div className="pdf-loading">Opening…</div>}
        </div>
        {search.open && (
          <div className="pdf-search">
            <input
              ref={searchRef}
              placeholder="Find in PDF"
              value={search.q}
              onChange={e => setSearch(s => ({ ...s, q: e.target.value, idx: 0 }))}
              onKeyDown={e => {
                if (e.key === 'Enter') goHit(e.shiftKey ? search.idx - 1 : navigated.current ? search.idx + 1 : search.idx)
                if (e.key === 'Escape') setSearch({ open: false, q: '', idx: 0 })
              }}
            />
            <span className="muted">{search.q ? (hits.length ? `${search.idx + 1} of ${hits.length}` : '0 results') : ''}</span>
            <button className="tb" title="Previous" onClick={() => goHit(search.idx - 1)} disabled={!hits.length}><Icon name="up" /></button>
            <button className="tb" title="Next" onClick={() => goHit(search.idx + 1)} disabled={!hits.length}><Icon name="down" /></button>
            <button className="tb" title="Close" onClick={() => setSearch({ open: false, q: '', idx: 0 })}><Icon name="close" /></button>
          </div>
        )}
        {(busy || notice) && <div className="pdf-toast">{busy || notice}</div>}
      </div>
    </div>
  )
}
