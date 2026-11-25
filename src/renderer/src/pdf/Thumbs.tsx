import { useEffect, useRef, useState } from 'react'
import type { PdfDoc } from './pdfjs'

const THUMB_W = 120

/** Page thumbnails. Click to jump; drag to reorder (applied as a page move). */
export default function Thumbs(props: {
  doc: PdfDoc
  sizes: { w: number; h: number }[]
  current: number
  onJump(n: number): void
  onMove(from: number, to: number): void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<Set<number>>(new Set())
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  useEffect(() => {
    const io = new IntersectionObserver(
      entries =>
        setVisible(prev => {
          const next = new Set(prev)
          for (const en of entries) {
            const n = Number((en.target as HTMLElement).dataset.n)
            if (en.isIntersecting) next.add(n)
          }
          return next
        }),
      { root: listRef.current, rootMargin: '400px 0px' }
    )
    listRef.current?.querySelectorAll('.pdf-thumb').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [props.sizes.length, props.doc])

  useEffect(() => setVisible(new Set()), [props.doc])

  useEffect(() => {
    listRef.current?.querySelector(`.pdf-thumb[data-n="${props.current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [props.current])

  return (
    <div className="pdf-thumbs" ref={listRef}>
      {props.sizes.map((s, i) => {
        const n = i + 1
        return (
          <div
            key={n}
            data-n={n}
            className={`pdf-thumb${n === props.current ? ' current' : ''}${dropAt === n && dragFrom !== n ? ' drop' : ''}`}
            draggable
            onClick={() => props.onJump(n)}
            onDragStart={e => {
              setDragFrom(n)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/x-gd-page', String(n))
            }}
            onDragOver={e => {
              if (dragFrom == null) return
              e.preventDefault()
              setDropAt(n)
            }}
            onDragLeave={() => setDropAt(d => (d === n ? null : d))}
            onDrop={e => {
              e.preventDefault()
              if (dragFrom != null && dragFrom !== n) props.onMove(dragFrom, n)
              setDragFrom(null)
              setDropAt(null)
            }}
            onDragEnd={() => {
              setDragFrom(null)
              setDropAt(null)
            }}
          >
            <Thumb doc={props.doc} n={n} size={s} show={visible.has(n)} />
            <span>{n}</span>
          </div>
        )
      })}
    </div>
  )
}

function Thumb({ doc, n, size, show }: { doc: PdfDoc; n: number; size: { w: number; h: number }; show: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scale = THUMB_W / size.w
  useEffect(() => {
    if (!show) return
    let cancelled = false
    let task: { cancel(): void; promise: Promise<void> } | null = null
    doc.getPage(n).then(page => {
      if (cancelled || !ref.current) return
      const dpr = window.devicePixelRatio || 1
      const vp = page.getViewport({ scale: scale * dpr })
      ref.current.width = Math.floor(vp.width)
      ref.current.height = Math.floor(vp.height)
      task = page.render({ canvas: ref.current, viewport: vp })
      task.promise.catch(() => {})
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, n, show, scale])
  return <canvas ref={ref} style={{ width: THUMB_W, height: size.h * scale }} />
}
