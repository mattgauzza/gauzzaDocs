import { useEffect, useRef, useState } from 'react'
import type { Artboard, Design, Layer } from '../../../shared/design/types'
import { contains, locate } from '../../../shared/ops/designLayers'
import type { Sel } from './Canvas'

/** 24px glyphs: filled ones (eye, lock, caret) and outlined ones for each layer type. */
const FILLED: Record<string, string> = {
  eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  eyeOff:
    'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  unlock: 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z',
  caret: 'M10 17l5-5-5-5z'
}
const OUTLINED: Record<string, string> = {
  rect: 'M5 6h14v12H5z',
  ellipse: 'M5 12a7 6 0 1 0 14 0a7 6 0 1 0-14 0',
  line: 'M5 19L19 5',
  path: 'M4 18C6 7 18 17 20 6',
  text: 'M6 6h12M12 6v13M9 19h6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5',
  paint: 'M14 4l6 6-8 8-6-6zM6 12l-2 8 8-2',
  group: 'M3 6h7l2 2h9v11H3z',
  instance: 'M12 3l8 9-8 9-8-9z',
  connector: 'M4 17h8V7h8M17 4l3 3-3 3',
  svg: 'M9 7l-5 5 5 5M15 7l5 5-5 5'
}
export function Glyph({ name, size = 16 }: { name: string; size?: number }) {
  const filled = FILLED[name]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {filled ? <path d={filled} fill="currentColor" /> : <path d={OUTLINED[name] ?? OUTLINED.rect} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />}
    </svg>
  )
}

type Zone = 'before' | 'after' | 'into'

interface Props {
  design: Design
  board: Artboard
  sel: Sel
  onSelect(sel: Sel): void
  onBoard(id: string): void
  onSet(ids: string[], props: Record<string, unknown>): void
  /** Puts a layer into `parent` (a group's id, or '' for the artboard) at `index` (0 is the back). */
  onMove(id: string, parent: string, index: number): void
}

/**
 * The layers panel: the current artboard's layers as a tree, front to back like the canvas stacks them. Click selects
 * (Shift or Ctrl adds), a double-click renames, the eye hides and the lock locks, and dragging a row moves the layer in
 * front of or behind another, or into a group.
 */
export function Layers(p: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; zone: Zone } | null>(null)
  const dragging = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ids = p.sel.board === p.board.id ? p.sel.ids : []

  // What's selected on the canvas shows here: its groups open and its row scrolled into view.
  useEffect(() => {
    const add = new Set<string>(p.sel.scope ? [p.sel.scope] : [])
    for (const id of [...ids, ...add]) {
      try {
        for (let at = locate(p.board, id); at.parent; at = locate(p.board, at.parent.id)) add.add(at.parent.id)
      } catch {
        // gone already
      }
    }
    setOpen(o => ([...add].every(id => o.has(id)) ? o : new Set([...o, ...add])))
    const f = requestAnimationFrame(() => listRef.current?.querySelector('.de-layer.on')?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(f)
    // only when the selection changes: a group closed by hand stays closed while edits come in
  }, [p.sel])

  const pick = (e: React.MouseEvent, l: Layer, parent: string | null) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) p.onSelect({ board: p.board.id, ids: ids.includes(l.id) ? ids.filter(x => x !== l.id) : [...ids, l.id], scope: parent })
    else p.onSelect({ board: p.board.id, ids: [l.id], scope: parent })
  }
  const toggle = (id: string) => {
    const next = new Set(open)
    if (!next.delete(id)) next.add(id)
    setOpen(next)
  }

  /** Where a layer sits now, or null when it's gone (an agent deleted it while it was being dragged). */
  const where = (id: string) => {
    try {
      return locate(p.board, id)
    } catch {
      return null
    }
  }

  /**
   * Where the dragged layer lands: in front of (above) or behind (below) a row, or at the front inside a group. Nothing
   * happens when either layer is gone.
   */
  const land = (from: string, target: Layer, zone: Zone) => {
    let parent: string
    let index: number
    if (zone === 'into' && target.type === 'group') {
      parent = target.id
      index = target.children.length
    } else {
      const at = where(target.id)
      if (!at) return
      parent = at.parent?.id ?? ''
      index = zone === 'before' ? at.index + 1 : at.index
    }
    const was = where(from)
    if (!was) return
    // the move takes the layer out first, so a place after it in the same list is one less
    if ((was.parent?.id ?? '') === parent) {
      if (was.index < index) index--
      if (was.index === index) return
    }
    p.onMove(from, parent, index)
  }

  const zoneOf = (e: React.DragEvent, l: Layer): Zone | null => {
    const from = dragging.current
    if (!from || from === l.id) return null
    const src = where(from)
    // a group can't go inside itself
    if (!src || contains(src.list[src.index], l.id)) return null
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const f = (e.clientY - r.top) / r.height
    if (l.type === 'group' && ((f > 0.25 && f < 0.75) || (f >= 0.75 && open.has(l.id)))) return 'into'
    return f < 0.5 ? 'before' : 'after'
  }

  const row = (l: Layer, depth: number, parent: string | null, dim: boolean): React.ReactNode => {
    const on = ids.includes(l.id)
    const group = l.type === 'group'
    const expanded = group && open.has(l.id)
    const hiddenHere = dim || !l.visible
    const mark = drop?.id === l.id ? ` drop-${drop.zone}` : ''
    return (
      <div key={l.id}>
        <div
          className={`de-layer${on ? ' on' : ''}${hiddenHere ? ' dim' : ''}${p.sel.scope === l.id ? ' scope' : ''}${mark}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={renaming !== l.id}
          onClick={e => pick(e, l, parent)}
          onDoubleClick={() => setRenaming(l.id)}
          onDragStart={e => {
            dragging.current = l.id
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', l.name)
          }}
          onDragEnd={() => {
            dragging.current = null
            setDrop(null)
          }}
          onDragOver={e => {
            const zone = zoneOf(e, l)
            if (!zone) return
            e.preventDefault()
            e.stopPropagation()
            if (drop?.id !== l.id || drop.zone !== zone) setDrop({ id: l.id, zone })
          }}
          onDrop={e => {
            const zone = zoneOf(e, l)
            const from = dragging.current
            e.preventDefault()
            e.stopPropagation()
            setDrop(null)
            if (zone && from) land(from, l, zone)
          }}
        >
          {group ? (
            <button
              className={`de-caret${expanded ? ' open' : ''}`}
              title={expanded ? 'Collapse' : 'Expand'}
              onClick={e => (e.stopPropagation(), toggle(l.id))}
            >
              <Glyph name="caret" />
            </button>
          ) : (
            <span className="de-caret" />
          )}
          <span className="de-type">
            <Glyph name={l.type} />
          </span>
          {renaming === l.id ? (
            <input
              className="de-rename"
              autoFocus
              defaultValue={l.name}
              onClick={e => e.stopPropagation()}
              onFocus={e => e.target.select()}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  e.currentTarget.value = l.name
                  e.currentTarget.blur()
                }
              }}
              onBlur={e => {
                const name = e.target.value.trim()
                setRenaming(null)
                if (name && name !== l.name) p.onSet([l.id], { name })
              }}
            />
          ) : (
            <span className="de-layer-name" title={l.name}>
              {l.name || l.type}
            </span>
          )}
          <button
            className={`de-toggle${l.visible ? '' : ' set'}`}
            title={l.visible ? 'Hide' : 'Show'}
            onClick={e => (e.stopPropagation(), p.onSet([l.id], { visible: !l.visible }))}
          >
            <Glyph name={l.visible ? 'eye' : 'eyeOff'} />
          </button>
          <button
            className={`de-toggle${l.locked ? ' set' : ''}`}
            title={l.locked ? 'Unlock' : 'Lock'}
            onClick={e => (e.stopPropagation(), p.onSet([l.id], { locked: !l.locked }))}
          >
            <Glyph name={l.locked ? 'lock' : 'unlock'} />
          </button>
        </div>
        {expanded && [...l.children].reverse().map(k => row(k, depth + 1, l.id, hiddenHere))}
      </div>
    )
  }

  const boards = p.design.artboards
  return (
    <aside className="de-panel de-layers">
      <header>
        <b>Layers</b>
        {boards.length > 1 && (
          <select className="de-boards" value={p.board.id} title="Artboard" onChange={e => p.onBoard(e.target.value)}>
            {boards.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </header>
      <div
        className={`de-layer-list${drop?.id === '' ? ' drop-end' : ''}`}
        ref={listRef}
        onDragOver={e => {
          // below the last row: to the back of the artboard
          if (!dragging.current) return
          e.preventDefault()
          if (drop?.id !== '') setDrop({ id: '', zone: 'after' })
        }}
        onDragLeave={e => e.target === e.currentTarget && setDrop(null)}
        onDrop={e => {
          e.preventDefault()
          const from = dragging.current
          setDrop(null)
          const was = from ? where(from) : null
          if (from && was && (was.parent || was.index !== 0)) p.onMove(from, '', 0)
        }}
      >
        {p.board.layers.length ? [...p.board.layers].reverse().map(l => row(l, 0, null, false)) : <p className="de-empty">No layers yet</p>}
      </div>
    </aside>
  )
}
