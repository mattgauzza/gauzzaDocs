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

export function MenuList({ items, close, className = '' }: { items: MenuItem[]; close: () => void; className?: string }) {
  const [sub, setSub] = useState<number | null>(null)
  return (
    <div className={`menu ${className}`} onMouseDown={e => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div key={i} className="menu-item-wrap" onMouseEnter={() => setSub(it.submenu ? i : null)}>
            <button
              className="menu-item"
              disabled={it.disabled}
              onClick={() => {
                if (it.submenu) return setSub(i)
                close()
                it.run?.()
              }}
            >
              <span className="menu-check">{it.checked ? '✓' : ''}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
              {it.submenu && <span className="menu-arrow">▸</span>}
            </button>
            {it.submenu && sub === i && <MenuList items={it.submenu} close={close} className="submenu" />}
          </div>
        )
      )}
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
