import { useEffect, useRef, useState } from 'react'

const KEY = 'gd.pdf.signature'
const W = 520
const H = 180

export interface Signature { src: string; w: number; h: number }

const remembered = (): Signature | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    return s && typeof s.src === 'string' ? s : null
  } catch {
    return null
  }
}

/**
 * A pad to draw a signature with the mouse, pen or a finger. Placing it trims the empty space around the ink and hands
 * back a transparent PNG, which goes on the page as an image you can move and resize.
 */
export default function SignaturePad({ color = '#1a2b6b', onPlace, onClose }: { color?: string; onPlace(s: Signature): void; onClose(): void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<{ x: number; y: number } | null>(null)
  const [ink, setInk] = useState(false)
  const [remember, setRemember] = useState(true)
  const [saved, setSaved] = useState<Signature | null>(remembered)
  const [pen, setPen] = useState(color)

  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    c.width = W * dpr
    c.height = H * dpr
    c.getContext('2d')!.scale(dpr, dpr)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }
  }
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }, pressure: number) => {
    const ctx = ref.current!.getContext('2d')!
    ctx.strokeStyle = pen
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 1.6 + 1.6 * (pressure || 0.5)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  const clear = () => {
    const c = ref.current!
    c.getContext('2d')!.clearRect(0, 0, W, H)
    setInk(false)
  }

  const place = () => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    let x0 = width, y0 = height, x1 = -1, y1 = -1
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    if (x1 < 0) return
    const pad = 4
    x0 = Math.max(0, x0 - pad)
    y0 = Math.max(0, y0 - pad)
    x1 = Math.min(width - 1, x1 + pad)
    y1 = Math.min(height - 1, y1 + pad)
    const out = document.createElement('canvas')
    out.width = x1 - x0 + 1
    out.height = y1 - y0 + 1
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
    const sig = { src: out.toDataURL('image/png'), w: out.width, h: out.height }
    try {
      if (remember) localStorage.setItem(KEY, JSON.stringify(sig))
      else localStorage.removeItem(KEY)
    } catch { /* storage full or blocked: placing still works */ }
    onPlace(sig)
  }

  return (
    <div className="pdf-modal-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="pdf-modal sig-pad" role="dialog" aria-label="Sign">
        <div className="sig-head">
          <b>Draw your signature</b>
          <span className="grow" />
          {['#1a2b6b', '#000000', '#1a73e8'].map(c => (
            <button key={c} className={`sig-ink${pen === c ? ' on' : ''}`} style={{ background: c }} title="Ink color" onClick={() => setPen(c)} />
          ))}
        </div>
        <canvas
          ref={ref}
          className="sig-canvas"
          style={{ width: W, height: H }}
          onPointerDown={e => {
            if (e.button !== 0) return
            ref.current!.setPointerCapture(e.pointerId)
            drawing.current = at(e)
            stroke(drawing.current, { x: drawing.current.x + 0.1, y: drawing.current.y }, e.pressure)
            setInk(true)
          }}
          onPointerMove={e => {
            if (!drawing.current) return
            const p = at(e)
            stroke(drawing.current, p, e.pressure)
            drawing.current = p
          }}
          onPointerUp={() => (drawing.current = null)}
          onPointerCancel={() => (drawing.current = null)}
        />
        <div className="sig-line">Sign above the line</div>
        <div className="sig-foot">
          <label className="sig-remember">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember on this computer
          </label>
          <span className="grow" />
          {saved && !ink && (
            <button className="btn" title="Place the signature you saved last time" onClick={() => onPlace(saved)}>
              Use saved
            </button>
          )}
          {saved && !ink && (
            <button
              className="btn"
              title="Forget the saved signature"
              onClick={() => {
                try {
                  localStorage.removeItem(KEY)
                } catch { /* nothing saved */ }
                setSaved(null)
              }}
            >
              Forget saved
            </button>
          )}
          <button className="btn" onClick={clear} disabled={!ink}>Clear</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={place} disabled={!ink}>Place</button>
        </div>
      </div>
    </div>
  )
}
