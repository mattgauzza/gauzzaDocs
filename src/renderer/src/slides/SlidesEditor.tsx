import { useEffect, useReducer, useRef, useState } from 'react'
import { stem } from '../../../shared/kinds'
import { applySlidesOp } from '../../../shared/ops/slides'
import { deckPrintHtml } from '../../../shared/slides/html'
import { deckToMarkdown } from '../../../shared/slides/markdown'
import { LAYOUTS, SLIDE_H, SLIDE_W, THEMES, applyTheme, cloneSlide, countWords, elementText, makeSlide, newDeck, newId, r3, slideText } from '../../../shared/slides/model'
import type { AgentOp, Deck, DeckTheme, Slide, SlideElement, SlideLayout, SlidePara, SlideRun } from '../../../shared/types'
import type { EditorHandle, EditorProps, MenuItem, MenuName, StatusItem } from '../editor'
import { ContextMenu } from '../shell/Projects'
import { Canvas, type Editing, type Tool, canHoldText, isLine } from './Canvas'
import { Filmstrip } from './Filmstrip'
import { Present } from './Present'
import { type Fmt, Toolbar, type ToolbarActions } from './Toolbar'
import { caretStyle, parseEdit, selectedBlocks, setSelectionSize } from './textEdit'
import './slides.css'
import { SLIDE_ZOOMS, stepZoom } from '../shell/zoom'

/**
 * Presentation editor (.pptx), in the style of Google Slides: filmstrip on the left, the slide on a canvas, speaker
 * notes below, and a slideshow with a presenter view. The deck is a plain object (shared/types Deck); every change
 * replaces it, so undo is a stack of decks and agent ops (shared/ops/slides.ts) apply here exactly as on disk.
 */
const CLIP = 'application/x-gdslides'
const sep: MenuItem = { label: '', sep: true }
const editableTarget = (t: EventTarget | null) => {
  const e = t as HTMLElement | null
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName || ''))
}
const withSlide = (d: Deck, i: number, s: Slide): Deck => ({ ...d, slides: d.slides.map((x, k) => (k === i ? s : x)) })
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Same text and formatting, with defaults filled in (so reading an untouched box back is not a change). */
function sameParas(a: SlidePara[], b: SlidePara[], th: DeckTheme) {
  const norm = (ps: SlidePara[]) => {
    if (!ps.some(p => p.runs.some(r => r.text))) return '[]'
    return JSON.stringify(
      ps.map(p => ({
        b: p.bullet || '',
        l: p.level || 0,
        a: p.align || 'left',
        r: p.runs.filter(r => r.text).map(r => [r.text, !!r.b, !!r.i, !!r.u, (r.color || th.text).toLowerCase(), r.size ?? 18, r.font || th.bodyFont])
      }))
    )
  }
  return norm(a) === norm(b)
}

/** The slide an op or an undo changed: the current one if it changed, else the first that did. */
function touched(before: Deck, after: Deck, cur: number) {
  const old = new Map(before.slides.map(s => [s.id, s]))
  const curId = before.slides[cur]?.id
  const curNew = after.slides.findIndex(s => s.id === curId)
  const changed = after.slides.filter(s => old.get(s.id) !== s).map(s => s.id)
  let idx = curNew >= 0 && changed.includes(curId) ? curNew : after.slides.findIndex(s => changed.includes(s.id))
  if (idx < 0) idx = curNew >= 0 ? curNew : Math.min(cur, after.slides.length - 1)
  return { idx, changed }
}

export default function SlidesEditor(props: EditorProps) {
  const propsRef = useRef(props)
  propsRef.current = props
  const loaded = props.payload.kind === 'slides' ? props.payload : null
  const [deck, setDeckState] = useState<Deck>(() => loaded?.deck || newDeck())
  const deckRef = useRef(deck)
  const [cur, setCurState] = useState(0)
  const curRef = useRef(0)
  const [sel, setSelState] = useState<string[]>([])
  const selRef = useRef<string[]>([])
  const [editing, setEditingState] = useState<Editing | null>(null)
  const [zoom, setZoom] = useState(100) // percent of the size that fits the window (Ctrl+scroll)
  const editingRef = useRef<Editing | null>(null)
  const editRef = useRef<HTMLDivElement | null>(null)
  const editN = useRef(0)
  const [tool, setTool] = useState<Tool>('select')
  const [notesOpen, setNotesOpen] = useState(true)
  const [notesH, setNotesH] = useState(110)
  const [present, setPresent] = useState<{ start: number; presenter: boolean } | null>(null)
  const presentRef = useRef(present)
  presentRef.current = present
  const [flash, setFlash] = useState<{ ids: string[]; n: number } | null>(null)
  const [canvasFlash, setCanvasFlash] = useState(0)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const past = useRef<Deck[]>([])
  const future = useRef<Deck[]>([])
  const base = useRef<Deck | null>(null) // the deck before a drag that is still in progress
  const group = useRef<{ g: string; t: number } | null>(null)
  const savedRange = useRef<Range | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const clip = useRef<{ els?: SlideElement[]; slide?: Slide } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const setCur = (i: number) => {
    const v = clamp(i, 0, deckRef.current.slides.length - 1)
    curRef.current = v
    setCurState(v)
  }
  const setSel = (ids: string[]) => {
    selRef.current = ids
    setSelState(ids)
  }
  const setEditing = (e: Editing | null) => {
    editingRef.current = e
    setEditingState(e)
  }
  const curSlide = () => deckRef.current.slides[curRef.current]

  // ---------- changes and history ----------
  /** Replaces the deck. live: part of a drag (no history yet); group: typing-like changes that undo together. */
  const setDeck = (next: Deck, o: { live?: boolean; group?: string; silent?: boolean } = {}) => {
    const prev = deckRef.current
    if (next === prev) return
    if (o.live) {
      if (!base.current) base.current = prev
      deckRef.current = next
      setDeckState(next)
      return
    }
    const before = base.current ?? prev
    base.current = null
    const now = Date.now()
    const coalesce = !!o.group && group.current?.g === o.group && now - group.current.t < 1500
    if (!coalesce) {
      past.current.push(before)
      if (past.current.length > 200) past.current.shift()
    }
    group.current = o.group ? { g: o.group, t: now } : null
    future.current = []
    deckRef.current = next
    setDeckState(next)
    if (!o.silent) propsRef.current.onChange()
  }
  const updateSlide = (fn: (s: Slide) => Slide, o?: { group?: string }) => setDeck(withSlide(deckRef.current, curRef.current, fn(curSlide())), o)
  const updateEls = (ids: string[], fn: (e: SlideElement) => SlideElement, o?: { group?: string }) =>
    updateSlide(s => ({ ...s, elements: s.elements.map(e => (ids.includes(e.id) ? fn(e) : e)) }), o)

  /** Writes the text being typed into the deck; exit also leaves the text box. */
  const flushEdit = (exit: boolean, silent = false) => {
    const ed = editingRef.current
    const root = editRef.current
    if (ed && root) {
      const d = deckRef.current
      const si = d.slides.findIndex(s => s.elements.some(e => e.id === ed.id))
      const s = d.slides[si]
      const el = s?.elements.find(e => e.id === ed.id)
      if (el) {
        let paras = parseEdit(root, d.theme.bodyFont)
        // A box whose text all used one font (a title in the heading font) keeps naming it.
        const f = el.paras?.[0]?.runs[0]?.font
        if (f && el.paras!.every(p => p.runs.every(r => r.font === f))) paras = paras.map(p => ({ ...p, runs: p.runs.map(r => (r.font ? r : { ...r, font: f })) }))
        const empty = !paras.some(p => p.runs.some(r => r.text.trim()))
        if (exit && empty && el.type === 'text' && !el.role) {
          setDeck(withSlide(d, si, { ...s, elements: s.elements.filter(e => e.id !== el.id) }), { silent })
          setSel(selRef.current.filter(x => x !== el.id))
        } else if (!sameParas(el.paras || [], paras, d.theme)) {
          setDeck(withSlide(d, si, { ...s, elements: s.elements.map(e => (e.id === el.id ? { ...e, paras: empty && el.type === 'shape' ? undefined : paras } : e)) }), {
            group: `type:${el.id}`,
            silent
          })
        }
      }
    }
    if (exit && ed) {
      setEditing(null)
      editRef.current = null
      savedRange.current = null
    }
  }

  const restore = (d: Deck) => {
    const { idx } = touched(deckRef.current, d, curRef.current)
    group.current = null
    base.current = null
    deckRef.current = d
    setDeckState(d)
    setCur(idx)
    setSel(selRef.current.filter(id => d.slides[curRef.current]?.elements.some(e => e.id === id)))
    propsRef.current.onChange()
  }
  const undo = () => {
    flushEdit(true)
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(deckRef.current)
    restore(prev)
  }
  const redo = () => {
    flushEdit(true)
    const next = future.current.pop()
    if (!next) return
    past.current.push(deckRef.current)
    restore(next)
  }

  // ---------- slides ----------
  const go = (i: number) => {
    flushEdit(true)
    setCur(i)
    setSel([])
  }
  const addSlide = (layout?: SlideLayout) => {
    flushEdit(true)
    const d = deckRef.current
    const at = curRef.current + 1
    const now = d.slides[curRef.current]?.layout
    // Like Google Slides: after a title or section slide comes Title and body; otherwise the same layout again.
    const l = layout || (!now || now === 'title' || now === 'section' ? 'titleBody' : now)
    setDeck({ ...d, slides: [...d.slides.slice(0, at), makeSlide(l, {}, d.theme), ...d.slides.slice(at)] })
    setCur(at)
    setSel([])
  }
  const duplicateSlide = (i = curRef.current) => {
    flushEdit(true)
    const d = deckRef.current
    setDeck({ ...d, slides: [...d.slides.slice(0, i + 1), cloneSlide(d.slides[i]), ...d.slides.slice(i + 1)] })
    setCur(i + 1)
    setSel([])
  }
  const deleteSlide = (i = curRef.current) => {
    flushEdit(true)
    const d = deckRef.current
    if (d.slides.length <= 1) return
    setDeck({ ...d, slides: d.slides.filter((_, k) => k !== i) })
    setCur(Math.min(i, d.slides.length - 2))
    setSel([])
  }
  const moveSlide = (from: number, to: number) => {
    flushEdit(true)
    const d = deckRef.current
    if (to < 0 || to >= d.slides.length || from === to) return
    const slides = [...d.slides]
    const [s] = slides.splice(from, 1)
    slides.splice(to, 0, s)
    setDeck({ ...d, slides })
    setCur(to)
  }

  // ---------- elements ----------
  const selected = () => curSlide().elements.filter(e => selRef.current.includes(e.id))
  const deleteEls = () => {
    const ids = selRef.current
    if (!ids.length) return
    updateSlide(s => ({ ...s, elements: s.elements.filter(e => !ids.includes(e.id)) }))
    setSel([])
  }
  const addEls = (els: SlideElement[]) => {
    if (!els.length) return
    flushEdit(true)
    updateSlide(s => ({ ...s, elements: [...s.elements, ...els] }))
    setSel(els.map(e => e.id))
  }
  const duplicateEls = () => addEls(selected().map(e => ({ ...structuredClone(e), id: newId(), x: r3(e.x + 0.2), y: r3(e.y + 0.2) })))
  const copyEls = (cut = false) => {
    const els = selected()
    if (!els.length) return false
    clip.current = { els: structuredClone(els) }
    if (cut) deleteEls()
    return true
  }
  const paste = () => {
    const c = clip.current
    if (!c) return
    if (c.slide) {
      const d = deckRef.current
      const at = curRef.current + 1
      setDeck({ ...d, slides: [...d.slides.slice(0, at), cloneSlide(c.slide), ...d.slides.slice(at)] })
      setCur(at)
      setSel([])
    } else if (c.els) {
      const here = new Set(curSlide().elements.map(e => e.id))
      addEls(c.els.map(e => ({ ...structuredClone(e), id: newId(), ...(here.has(e.id) ? { x: r3(e.x + 0.2), y: r3(e.y + 0.2) } : {}) })))
    }
  }
  const addTextBox = (text: string) => {
    const th = deckRef.current.theme
    addEls([{ id: newId(), type: 'text', x: 1, y: 1.5, w: 7, h: 1, valign: 'top', paras: text.split(/\r?\n/).map(l => ({ runs: [{ text: l, size: 18, color: th.text }] })) }])
  }
  const addImages = async (files: File[], at?: { x: number; y: number }) => {
    const els: SlideElement[] = []
    for (const f of files) {
      try {
        const src = await new Promise<string>((res, rej) => {
          const r = new FileReader()
          r.onload = () => res(String(r.result))
          r.onerror = () => rej(r.error)
          r.readAsDataURL(f)
        })
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = rej
          i.src = src
        })
        let w = (img.naturalWidth || 480) / 96
        let h = (img.naturalHeight || 360) / 96
        const k = Math.min(1, 6 / w, 4.5 / h)
        w *= k
        h *= k
        const off = els.length * 0.3
        const x = (at ? at.x - w / 2 : (SLIDE_W - w) / 2) + off
        const y = (at ? at.y - h / 2 : (SLIDE_H - h) / 2) + off
        els.push({ id: newId(), type: 'image', x: r3(clamp(x, 0, SLIDE_W - w)), y: r3(clamp(y, 0, SLIDE_H - h)), w: r3(w), h: r3(h), src })
      } catch {
        /* not an image the browser can read */
      }
    }
    addEls(els)
  }
  const order = (kind: 'front' | 'forward' | 'backward' | 'back') =>
    updateSlide(s => {
      const ids = selRef.current
      const picked = s.elements.filter(e => ids.includes(e.id))
      const rest = s.elements.filter(e => !ids.includes(e.id))
      if (kind === 'front') return { ...s, elements: [...rest, ...picked] }
      if (kind === 'back') return { ...s, elements: [...picked, ...rest] }
      const arr = [...s.elements]
      if (kind === 'forward') {
        for (let i = arr.length - 2; i >= 0; i--) if (ids.includes(arr[i].id) && !ids.includes(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
      } else {
        for (let i = 1; i < arr.length; i++) if (ids.includes(arr[i].id) && !ids.includes(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]]
      }
      return { ...s, elements: arr }
    })
  const alignEls = (kind: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    const els = selected()
    if (!els.length) return
    // One element lines up with the slide; several with each other.
    const b =
      els.length > 1
        ? { x0: Math.min(...els.map(e => e.x)), y0: Math.min(...els.map(e => e.y)), x1: Math.max(...els.map(e => e.x + e.w)), y1: Math.max(...els.map(e => e.y + e.h)) }
        : { x0: 0, y0: 0, x1: SLIDE_W, y1: SLIDE_H }
    updateEls(els.map(e => e.id), e => {
      const n = { ...e }
      if (kind === 'left') n.x = b.x0
      if (kind === 'center') n.x = (b.x0 + b.x1) / 2 - e.w / 2
      if (kind === 'right') n.x = b.x1 - e.w
      if (kind === 'top') n.y = b.y0
      if (kind === 'middle') n.y = (b.y0 + b.y1) / 2 - e.h / 2
      if (kind === 'bottom') n.y = b.y1 - e.h
      return { ...n, x: r3(n.x), y: r3(n.y) }
    })
  }
  const rotateEls = (deg: number) =>
    updateEls(selRef.current, e => {
      const r = ((((e.rotation || 0) + deg) % 360) + 360) % 360
      const n: SlideElement = { ...e, rotation: r }
      if (!r) delete n.rotation
      return n
    })
  const arrangeItems = (): MenuItem[] => [
    { label: 'Bring to front', shortcut: 'Ctrl+Shift+Up', run: () => order('front') },
    { label: 'Bring forward', shortcut: 'Ctrl+Up', run: () => order('forward') },
    { label: 'Send backward', shortcut: 'Ctrl+Down', run: () => order('backward') },
    { label: 'Send to back', shortcut: 'Ctrl+Shift+Down', run: () => order('back') },
    sep,
    { label: 'Align left', run: () => alignEls('left') },
    { label: 'Align center', run: () => alignEls('center') },
    { label: 'Align right', run: () => alignEls('right') },
    { label: 'Align top', run: () => alignEls('top') },
    { label: 'Align middle', run: () => alignEls('middle') },
    { label: 'Align bottom', run: () => alignEls('bottom') },
    sep,
    { label: 'Rotate clockwise 90°', run: () => rotateEls(90) },
    { label: 'Rotate counter-clockwise 90°', run: () => rotateEls(-90) },
    sep,
    { label: 'Duplicate', shortcut: 'Ctrl+D', run: duplicateEls },
    { label: 'Delete', shortcut: 'Del', run: deleteEls }
  ]

  // ---------- text editing and formatting ----------
  const startEdit = (e: Omit<Editing, 'n'>) => {
    flushEdit(true)
    setTool('select')
    setSel([e.id])
    setEditing({ ...e, n: ++editN.current })
  }
  const onEditInput = () => propsRef.current.onChange()
  const restoreRange = (root: HTMLElement) => {
    const r = savedRange.current
    if (document.activeElement !== root) root.focus()
    if (r && root.contains(r.startContainer)) {
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    }
  }
  const runFmt = (patch: Partial<SlideRun>, toggle?: 'b' | 'i' | 'u') => {
    const root = editRef.current
    if (editingRef.current && root) {
      restoreRange(root)
      document.execCommand('styleWithCSS', false, 'true')
      if (toggle) document.execCommand({ b: 'bold', i: 'italic', u: 'underline' }[toggle])
      if (patch.color) document.execCommand('foreColor', false, patch.color)
      if (patch.font) document.execCommand('fontName', false, patch.font)
      if (patch.size) setSelectionSize(root, patch.size)
      onEditInput()
      tick()
      return
    }
    const targets = selected().filter(e => e.paras?.length)
    if (!targets.length) return
    const on = toggle ? !targets.every(e => e.paras!.every(p => p.runs.every(r => !r.text || r[toggle]))) : false
    updateEls(
      targets.map(t => t.id),
      e => ({
        ...e,
        paras: e.paras!.map(p => ({
          ...p,
          runs: p.runs.map(r => {
            const n = { ...r, ...patch }
            if (toggle) {
              if (on) n[toggle] = true
              else delete n[toggle]
            }
            return n
          })
        }))
      }),
      { group: patch.color ? 'color' : patch.size ? 'size' : undefined }
    )
  }
  const paraFmt = (patch: { bullet?: SlidePara['bullet'] | null; align?: SlidePara['align']; indent?: 1 | -1 }) => {
    const root = editRef.current
    if (editingRef.current && root) {
      restoreRange(root)
      for (const b of selectedBlocks(root)) {
        if (patch.align) b.dataset.a = patch.align
        if (patch.bullet !== undefined) {
          if (patch.bullet) b.dataset.b = patch.bullet
          else delete b.dataset.b
        }
        if (patch.indent) b.dataset.l = String(clamp(Number(b.dataset.l || 0) + patch.indent, 0, 8))
      }
      onEditInput()
      tick()
      return
    }
    const targets = selected().filter(e => e.paras?.length)
    updateEls(targets.map(t => t.id), e => ({
      ...e,
      paras: e.paras!.map(p => {
        const n = { ...p }
        if (patch.align) n.align = patch.align
        if (patch.bullet !== undefined) {
          if (patch.bullet) (n.bullet = patch.bullet), (n.level = n.level || 0)
          else delete n.bullet
        }
        if (patch.indent) n.level = clamp((n.level || 0) + patch.indent, 0, 8)
        if (!n.bullet && !n.level) delete n.level
        return n
      })
    }))
  }
  const shapeFmt = (patch: { fill?: string | null; stroke?: string | null; strokeWidth?: number }) => {
    const ids = selected().filter(e => e.type === 'shape').map(e => e.id)
    updateEls(
      ids,
      e => {
        const n = { ...e }
        if ('fill' in patch && !isLine(e)) {
          if (patch.fill) n.fill = patch.fill
          else delete n.fill
        }
        if ('stroke' in patch) {
          if (patch.stroke) (n.stroke = patch.stroke), (n.strokeWidth = n.strokeWidth ?? (isLine(e) ? 2 : 1))
          else if (!isLine(e)) delete n.stroke, delete n.strokeWidth
        }
        if (patch.strokeWidth) {
          n.strokeWidth = patch.strokeWidth
          if (!n.stroke) n.stroke = deckRef.current.theme.text
        }
        return n
      },
      { group: 'shape-style' }
    )
  }
  const setBackground = (c: string | null) =>
    updateSlide(s => {
      const n = { ...s }
      if (c && c.toLowerCase() !== deckRef.current.theme.background.toLowerCase()) n.background = c.toLowerCase()
      else delete n.background
      return n
    }, { group: 'background' })
  const setTheme = (name: string) => {
    const t = THEMES.find(x => x.name === name)
    if (t) setDeck(applyTheme(deckRef.current, t))
  }
  const startPresent = (mode: 'start' | 'current' | 'presenter') => {
    flushEdit(true)
    setCtx(null)
    setPresent({ start: mode === 'start' ? 0 : curRef.current, presenter: mode === 'presenter' })
  }

  // ---------- agents ----------
  const agentOp = async (op: AgentOp) => {
    flushEdit(true)
    const before = deckRef.current
    const r = applySlidesOp(before, op)
    if (!r.deck) return r.result
    setDeck(r.deck)
    const res = r.result as { slide?: number }
    const t = touched(before, r.deck, curRef.current)
    const idx = ['moveSlide', 'duplicateSlide', 'addSlide'].includes(op.op) && typeof res?.slide === 'number' ? res.slide - 1 : t.idx
    setCur(idx)
    setSel([])
    const n = Date.now()
    setFlash({ ids: t.changed.length ? t.changed : [r.deck.slides[curRef.current].id], n })
    setCanvasFlash(n)
    return r.result
  }

  // ---------- toolbar state ----------
  const slide = deck.slides[Math.min(cur, deck.slides.length - 1)]
  const selEls = slide.elements.filter(e => sel.includes(e.id))
  const fmt: Fmt | null = (() => {
    const root = editRef.current
    if (editing && root) {
      const c = caretStyle(root, deck.theme.bodyFont)
      return { b: !!c.b, i: !!c.i, u: !!c.u, color: c.color || deck.theme.text, size: c.size || 18, font: c.font, bullet: c.bullet, align: c.align || 'left' }
    }
    const el = selEls.find(e => e.paras?.length)
    if (!el) return null
    const p = el.paras![0]
    const r = p.runs.find(x => x.text) || p.runs[0] || { text: '' }
    return { b: !!r.b, i: !!r.i, u: !!r.u, color: r.color || deck.theme.text, size: r.size || 18, font: r.font || deck.theme.bodyFont, bullet: p.bullet, align: p.align || 'left' }
  })()

  // Toolbar follows the caret while typing.
  useEffect(() => {
    if (!editing) return
    const onSel = () => {
      const root = editRef.current
      const s = getSelection()
      if (root && s && s.rangeCount && root.contains(s.anchorNode)) {
        savedRange.current = s.getRangeAt(0).cloneRange()
        tick()
      }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [editing])

  const menus = (): Partial<Record<MenuName, MenuItem[]>> => {
    const d = deckRef.current
    const i = curRef.current
    const has = selRef.current.length > 0
    return {
      Edit: [
        { label: 'Duplicate', shortcut: 'Ctrl+D', run: () => (has ? duplicateEls() : duplicateSlide()) },
        { label: 'Delete', shortcut: 'Del', disabled: !has, run: deleteEls },
        { label: 'Select all on slide', shortcut: 'Ctrl+A', run: () => setSel(curSlide().elements.map(e => e.id)) },
        sep,
        { label: 'Move slide up', disabled: i === 0, run: () => moveSlide(i, i - 1) },
        { label: 'Move slide down', disabled: i >= d.slides.length - 1, run: () => moveSlide(i, i + 1) },
        { label: 'Delete slide', disabled: d.slides.length <= 1, run: () => deleteSlide() }
      ],
      View: [
        { label: 'Speaker notes', checked: notesOpen, run: () => setNotesOpen(v => !v) },
        sep,
        { label: 'Present from beginning', shortcut: 'F5', run: () => startPresent('start') },
        { label: 'Present from this slide', shortcut: 'Ctrl+Enter', run: () => startPresent('current') },
        { label: 'Presenter view', run: () => startPresent('presenter') }
      ],
      Insert: [
        { label: 'New slide', shortcut: 'Ctrl+M', run: () => addSlide() },
        { label: 'New slide with layout', submenu: LAYOUTS.map(l => ({ label: l.label, run: () => addSlide(l.id) })) },
        { label: 'Duplicate slide', run: () => duplicateSlide() },
        sep,
        { label: 'Text box', run: () => setTool('text') },
        { label: 'Image…', run: () => fileInput.current?.click() },
        {
          label: 'Shape',
          submenu: (['rect', 'roundRect', 'ellipse', 'line', 'arrow'] as Tool[]).map(t => ({
            label: { rect: 'Rectangle', roundRect: 'Rounded rectangle', ellipse: 'Oval', line: 'Line', arrow: 'Arrow' }[t as 'rect'],
            run: () => setTool(t)
          }))
        }
      ],
      Format: [
        { label: 'Theme', submenu: THEMES.map(t => ({ label: t.name, checked: d.theme.name === t.name, run: () => setTheme(t.name) })) },
        { label: 'Reset slide background', disabled: !d.slides[i]?.background, run: () => setBackground(null) },
        sep,
        { label: 'Arrange', disabled: !has, submenu: arrangeItems() }
      ]
    }
  }

  const live = useRef({ agentOp, flushEdit, undo, redo, menus, startPresent })
  live.current = { agentOp, flushEdit, undo, redo, menus, startPresent }
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  const clipEv = useRef<(e: ClipboardEvent) => void>(() => {})

  // ---------- keyboard ----------
  keys.current = (e: KeyboardEvent) => {
    if (presentRef.current || e.defaultPrevented) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key
    const stop = () => e.preventDefault()
    if (key === 'F5') return stop(), startPresent(e.shiftKey ? 'current' : 'start')
    if (mod && key === 'Enter') return stop(), startPresent('current')
    if (editingRef.current) {
      if (key === 'Escape') {
        stop()
        const id = editingRef.current.id
        flushEdit(true)
        if (curSlide().elements.some(x => x.id === id)) setSel([id])
        rootRef.current?.querySelector<HTMLElement>('.sl-view')?.focus({ preventScroll: true })
      } else if (key === 'Tab') {
        stop()
        paraFmt({ indent: e.shiftKey ? -1 : 1 })
      }
      return
    }
    const t = e.target as Element | null
    if (editableTarget(t)) return
    if (t && t !== document.body && !t.closest?.('.sl-editor')) return
    const inFilm = !!t?.closest?.('.sl-film')
    const ids = selRef.current
    const els = ids.length > 0 && !inFilm
    const k = key.toLowerCase()
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) return stop(), undo()
      if (k === 'y' || (k === 'z' && e.shiftKey)) return stop(), redo()
      if (k === 'm') return stop(), addSlide()
      if (k === 'd') return stop(), els ? duplicateEls() : duplicateSlide()
      if (k === 'a' && !inFilm) return stop(), setSel(curSlide().elements.map(x => x.id))
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const up = key === 'ArrowUp'
        if (els) return stop(), order(e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward')
        if (inFilm) return stop(), moveSlide(curRef.current, curRef.current + (up ? -1 : 1))
      }
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      if (els) return stop(), deleteEls()
      if (inFilm) return stop(), deleteSlide()
      return
    }
    if (key === 'Escape') {
      if (tool !== 'select') setTool('select')
      else setSel([])
      return
    }
    if (key.startsWith('Arrow')) {
      stop()
      if (els) {
        const step = e.shiftKey ? 0.01 : 0.1
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
        return updateEls(ids, x => ({ ...x, x: r3(x.x + dx), y: r3(x.y + dy) }), { group: 'nudge' })
      }
      return go(curRef.current + (key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1))
    }
    if (key === 'PageDown' || key === 'PageUp') return stop(), go(curRef.current + (key === 'PageDown' ? 1 : -1))
    if ((key === 'Home' || key === 'End') && !els) return stop(), go(key === 'Home' ? 0 : deckRef.current.slides.length - 1)
    if (key === 'Enter' && ids.length === 1 && !inFilm) {
      const el = curSlide().elements.find(x => x.id === ids[0])
      if (el && canHoldText(el)) return stop(), startEdit({ id: el.id, all: true })
    }
  }

  // Copy, cut and paste of elements (or of a slide, from the filmstrip); images and text paste in from other apps.
  clipEv.current = (e: ClipboardEvent) => {
    if (presentRef.current || editingRef.current || editableTarget(e.target)) return
    const t = e.target as Element | null
    if (t && t !== document.body && !t.closest?.('.sl-editor')) return
    const dt = e.clipboardData
    if (e.type === 'paste') {
      if (!dt) return
      const files = [...dt.files].filter(f => f.type.startsWith('image/'))
      if (files.length) return e.preventDefault(), void addImages(files)
      if (dt.types.includes(CLIP) && clip.current) return e.preventDefault(), paste()
      const text = dt.getData('text/plain')
      if (text.trim()) return e.preventDefault(), addTextBox(text)
      return
    }
    const inFilm = !!t?.closest?.('.sl-film')
    const els = inFilm ? [] : selected()
    if (els.length) {
      e.preventDefault()
      dt?.setData('text/plain', els.map(elementText).filter(Boolean).join('\n'))
      dt?.setData(CLIP, '1')
      copyEls(e.type === 'cut')
    } else if (inFilm) {
      e.preventDefault()
      clip.current = { slide: structuredClone(curSlide()) }
      dt?.setData('text/plain', slideText(curSlide()))
      dt?.setData(CLIP, '1')
      if (e.type === 'cut') deleteSlide()
    }
  }

  useEffect(() => {
    if (!props.active) return
    const k = (e: KeyboardEvent) => keys.current(e)
    const c = (e: ClipboardEvent) => clipEv.current(e)
    window.addEventListener('keydown', k)
    for (const t of ['copy', 'cut', 'paste']) window.addEventListener(t, c as EventListener)
    return () => {
      window.removeEventListener('keydown', k)
      for (const t of ['copy', 'cut', 'paste']) window.removeEventListener(t, c as EventListener)
    }
  }, [props.active])

  // ---------- status bar (cached; the shell polls it) ----------
  const statusRef = useRef<StatusItem[]>([])
  useEffect(() => {
    const words = countWords(deck.slides.map(slideText).join(' '))
    statusRef.current = [
      { text: `Slide ${cur + 1} of ${deck.slides.length}`, title: 'Page Up / Page Down' },
      { text: `${words.toLocaleString()} word${words === 1 ? '' : 's'}` },
      { text: deck.theme.name, title: 'Theme (Format > Theme)' }
    ]
  }, [deck, cur])

  // ---------- the handle the shell and agents use ----------
  useEffect(() => {
    const L = () => live.current
    const handle: EditorHandle = {
      language: 'slides',
      zoomBy: dir => setZoom(z => stepZoom(SLIDE_ZOOMS, z, dir)),
      getPayload: () => {
        L().flushEdit(false, true)
        return { kind: 'slides', deck: deckRef.current, ...(loaded ? { lossy: loaded.lossy, lossyReasons: loaded.lossyReasons } : {}) }
      },
      agent: op => L().agentOp(op),
      getPrintHtml: () => deckPrintHtml(deckRef.current, stem(propsRef.current.path)),
      getText: () => deckToMarkdown(deckRef.current),
      setText: text => void L().agentOp({ op: 'write', content: text }),
      getSelection: () => {
        if (editingRef.current) return getSelection()?.toString() || ''
        const ids = selRef.current
        return deckRef.current.slides[curRef.current].elements.filter(e => ids.includes(e.id)).map(elementText).join('\n')
      },
      command: id => {
        if (id === 'undo') L().undo()
        else if (id === 'redo') L().redo()
        else if (id === 'selectAll' && !editingRef.current) setSel(deckRef.current.slides[curRef.current].elements.map(e => e.id))
        else if (id === 'copy' || id === 'cut') !editingRef.current && document.execCommand(id)
      },
      menus: () => L().menus(),
      focus: () => rootRef.current?.querySelector<HTMLElement>('.sl-view')?.focus({ preventScroll: true }),
      status: () => statusRef.current
    }
    props.setHandle(handle)
    return () => props.setHandle(null)
  }, [])

  // ---------- context menus ----------
  const canvasMenu = (e: React.MouseEvent, id: string | null) => {
    const el = id ? curSlide().elements.find(x => x.id === id) : undefined
    const items: MenuItem[] = el
      ? [
          { label: 'Cut', shortcut: 'Ctrl+X', run: () => copyEls(true) },
          { label: 'Copy', shortcut: 'Ctrl+C', run: () => copyEls() },
          { label: 'Paste', shortcut: 'Ctrl+V', disabled: !clip.current, run: paste },
          { label: 'Delete', shortcut: 'Del', run: deleteEls },
          { label: 'Duplicate', shortcut: 'Ctrl+D', run: duplicateEls },
          ...(canHoldText(el) ? [sep, { label: 'Edit text', shortcut: 'Enter', run: () => startEdit({ id: el.id, all: true }) }] : []),
          sep,
          ...arrangeItems().slice(0, 4)
        ]
      : [
          { label: 'Paste', shortcut: 'Ctrl+V', disabled: !clip.current, run: paste },
          { label: 'Select all', shortcut: 'Ctrl+A', run: () => setSel(curSlide().elements.map(x => x.id)) },
          sep,
          { label: 'New slide', shortcut: 'Ctrl+M', run: () => addSlide() },
          { label: 'Reset background', disabled: !curSlide().background, run: () => setBackground(null) }
        ]
    setCtx({ x: e.clientX, y: e.clientY, items })
  }
  const filmMenu = (e: React.MouseEvent, i: number) => {
    const n = deckRef.current.slides.length
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New slide', shortcut: 'Ctrl+M', run: () => addSlide() },
        { label: 'New slide with layout', submenu: LAYOUTS.map(l => ({ label: l.label, run: () => addSlide(l.id) })) },
        { label: 'Duplicate slide', shortcut: 'Ctrl+D', run: () => duplicateSlide(i) },
        { label: 'Delete slide', shortcut: 'Del', disabled: n <= 1, run: () => deleteSlide(i) },
        sep,
        { label: 'Move slide up', disabled: i === 0, run: () => moveSlide(i, i - 1) },
        { label: 'Move slide down', disabled: i >= n - 1, run: () => moveSlide(i, i + 1) },
        { label: 'Move slide to beginning', disabled: i === 0, run: () => moveSlide(i, 0) },
        { label: 'Move slide to end', disabled: i >= n - 1, run: () => moveSlide(i, n - 1) },
        sep,
        { label: 'Present from this slide', run: () => startPresent('current') }
      ]
    })
  }

  const act: ToolbarActions = {
    undo,
    redo,
    addSlide,
    setTool: t => (flushEdit(true), setTool(t)),
    pickImage: () => fileInput.current?.click(),
    run: runFmt,
    para: paraFmt,
    shape: shapeFmt,
    arrange: arrangeItems,
    background: setBackground,
    theme: setTheme,
    present: startPresent
  }

  const startNotesResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY
    const h0 = notesH
    const mv = (ev: PointerEvent) => setNotesH(clamp(h0 - (ev.clientY - y0), 48, window.innerHeight * 0.6))
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="sl-editor" ref={rootRef}>
      <Toolbar deck={deck} slide={slide} selEls={selEls} fmt={fmt} tool={tool} canUndo={past.current.length > 0} canRedo={future.current.length > 0} act={act} />
      <div className="sl-body">
        <Filmstrip deck={deck} cur={cur} flash={flash} onPick={go} onMove={moveSlide} onContext={filmMenu} />
        <div className="sl-main">
          <Canvas
            zoom={zoom}
            deck={deck}
            slide={slide}
            sel={sel}
            editing={editing}
            tool={tool}
            flashKey={canvasFlash}
            editRef={editRef}
            getSlide={curSlide}
            onSelect={ids => setSel(ids)}
            onEdit={e => (e ? startEdit(e) : flushEdit(true))}
            onSlide={(next, liveDrag) => setDeck(withSlide(deckRef.current, curRef.current, next), { live: liveDrag })}
            onCreate={(el, edit) => {
              updateSlide(s => ({ ...s, elements: [...s.elements, el] }))
              setTool('select')
              setSel([el.id])
              if (edit) setEditing({ id: el.id, n: ++editN.current })
            }}
            onContext={canvasMenu}
            onDropFiles={(files, at) => void addImages(files, at)}
            onEditInput={onEditInput}
          />
          {notesOpen && (
            <div className="sl-notes" style={{ height: notesH }}>
              <div className="sl-notes-grip" onPointerDown={startNotesResize} title="Drag to resize" />
              <textarea
                key={slide.id}
                value={slide.notes}
                placeholder="Click to add speaker notes"
                spellCheck
                onFocus={() => flushEdit(true)}
                onChange={e => {
                  const v = e.target.value
                  updateSlide(s => ({ ...s, notes: v }), { group: `notes:${slide.id}` })
                }}
              />
            </div>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={e => {
          const files = [...(e.target.files || [])]
          e.target.value = ''
          if (files.length) void addImages(files)
        }}
      />
      {ctx && <ContextMenu at={{ x: ctx.x, y: ctx.y }} items={ctx.items} onClose={() => setCtx(null)} />}
      {present && (
        <Present
          deck={deck}
          start={present.start}
          presenter={present.presenter}
          onExit={at => {
            setPresent(null)
            setCur(at)
            setSel([])
          }}
        />
      )}
    </div>
  )
}
