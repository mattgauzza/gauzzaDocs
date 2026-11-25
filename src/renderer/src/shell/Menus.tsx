import { useEffect, useRef, useState } from 'react'
import type { MenuItem } from '../editor'

/** Google Docs style menu bar: click to open, hover to switch between open menus, Esc / click outside closes. */
export function MenuBar({ menus }: { menus: { name: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div className="menubar" ref={ref}>
      {menus.filter(m => m.items.length).map(m => (
        <div key={m.name} className="menu-root">
          <button
            className={`menu-title${open === m.name ? ' open' : ''}`}
            onMouseDown={e => {
              e.preventDefault() // keep the editor's selection
              setOpen(open === m.name ? null : m.name)
            }}
            onMouseEnter={() => open && setOpen(m.name)}
          >
            {m.name}
          </button>
          {open === m.name && <MenuList items={m.items} close={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  )
}

export function MenuList({ items, close, className = '', style }: { items: MenuItem[]; close: () => void; className?: string; style?: React.CSSProperties }) {
  const [sub, setSub] = useState<{ i: number; top: number; left: number; flip: boolean } | null>(null)
  // Submenus are positioned on screen (fixed) instead of inside this list: the list scrolls when it is tall, and a
  // scrolling box clips anything that sticks out of it, which hid every submenu.
  const openSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const flip = r.right + 280 > window.innerWidth
    setSub({ i, top: Math.max(8, Math.min(r.top - 6, window.innerHeight - 360)), left: flip ? r.left : r.right, flip })
  }
  return (
    <div className={`menu ${className}`} style={style} onMouseDown={e => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className="menu-item-wrap"
            onMouseEnter={e => (it.submenu || it.grid ? openSub(i, e.currentTarget) : setSub(null))}
          >
            <button
              className={`menu-item${sub?.i === i ? ' open' : ''}`}
              disabled={it.disabled}
              onClick={e => {
                if (it.submenu || it.grid) return openSub(i, e.currentTarget.parentElement as HTMLElement)
                close()
                it.run?.()
              }}
            >
              <span className="menu-check">{it.checked ? '✓' : ''}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
              {(it.submenu || it.grid) && <span className="menu-arrow">▸</span>}
            </button>
            {sub?.i === i && !it.disabled && (it.submenu || it.grid) && (
              <div
                className="menu-fly"
                style={{ position: 'fixed', top: sub.top, left: sub.left, transform: sub.flip ? 'translateX(-100%)' : undefined }}
              >
                {it.grid ? (
                  <GridPicker {...it.grid} close={close} />
                ) : (
                  <MenuList items={it.submenu!} close={close} className="submenu" />
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}

/** Google Docs style size picker: hover across the grid to choose rows x columns. */
function GridPicker({ rows, cols, pick, close }: { rows: number; cols: number; pick(r: number, c: number): void; close(): void }) {
  const [at, setAt] = useState<[number, number]>([1, 1])
  return (
    <div className="menu grid-picker" onMouseDown={e => e.preventDefault()}>
      <div className="grid-cells" style={{ gridTemplateColumns: `repeat(${cols}, 18px)` }} onMouseLeave={() => setAt([1, 1])}>
        {Array.from({ length: rows * cols }, (_, k) => {
          const r = Math.floor(k / cols) + 1
          const c = (k % cols) + 1
          return (
            <button
              key={k}
              className={`grid-cell${r <= at[0] && c <= at[1] ? ' on' : ''}`}
              onMouseEnter={() => setAt([r, c])}
              onClick={() => (close(), pick(r, c))}
              aria-label={`${c} by ${r}`}
            />
          )
        })}
      </div>
      <div className="grid-size">{at[1]} x {at[0]}</div>
    </div>
  )
}

/** A dropdown anchored to a button, for toolbar-style menus outside the menu bar. */
export function Dropdown({ button, items, className }: { button: React.ReactNode; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [open])
  return (
    <div className={`menu-root ${className || ''}`} ref={ref}>
      <span onClick={() => setOpen(!open)}>{button}</span>
      {open && <MenuList items={items} close={() => setOpen(false)} />}
    </div>
  )
}
