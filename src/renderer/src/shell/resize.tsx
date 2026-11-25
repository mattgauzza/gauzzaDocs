import { useCallback, useRef, useState } from 'react'

/**
 * Drag-to-resize for side panels and split views (comments, preview, outline, Explorer, PDF thumbnails, Markdown
 * split). Each remembers its size per viewer (localStorage; a missing or blocked store just means the default).
 * Double-clicking the handle puts it back to the default.
 *
 *   const [w, handle] = usePanelSize('comments', 340, { min: 260, max: 720, edge: 'left' })
 *   <aside style={{ width: w }}>{handle}...</aside>
 *
 * `edge` is the side of the panel the handle sits on: 'left' grows the panel when dragged left (right-hand panels),
 * 'right' grows it when dragged right (left-hand panels). `unit: 'ratio'` measures a share of the parent instead of px.
 */
const read = (key: string, fallback: number) => {
  try {
    const v = Number(localStorage.getItem(`size:${key}`))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, v: number) => {
  try {
    localStorage.setItem(`size:${key}`, String(v))
  } catch { /* storage off: size lasts for this session only */ }
}

export function usePanelSize(
  key: string,
  initial: number,
  opts: { min: number; max: number; edge: 'left' | 'right'; unit?: 'px' | 'ratio' }
): [number, React.ReactElement] {
  const [size, setSize] = useState(() => Math.min(opts.max, Math.max(opts.min, read(key, initial))))
  const sizeRef = useRef(size)
  sizeRef.current = size

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const start = sizeRef.current
      const parentW = handle.parentElement?.parentElement?.getBoundingClientRect().width || 1
      document.body.classList.add('resizing')
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const delta = opts.edge === 'left' ? -dx : dx
        const next = opts.unit === 'ratio' ? start + delta / parentW : start + delta
        setSize(Math.min(opts.max, Math.max(opts.min, next)))
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        document.body.classList.remove('resizing')
        write(key, sizeRef.current)
        window.dispatchEvent(new Event('resize')) // editors and the toolbar re-measure
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    },
    [key, opts.edge, opts.min, opts.max, opts.unit]
  )

  const handle = (
    <div
      className={`resize-handle ${opts.edge}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        setSize(initial)
        write(key, initial)
        window.dispatchEvent(new Event('resize'))
      }}
      title="Drag to resize. Double-click to reset."
      role="separator"
      aria-orientation="vertical"
    />
  )
  return [size, handle]
}
