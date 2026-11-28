import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INSERT_SCALE, type InsertFormat, insertFormat, insertFormats } from '../../../shared/design/insert'
import { baseName, extOf, stem } from '../../../shared/kinds'
import type { RecentFile } from '../../../shared/types'
import { type DesignArtboard, type DesignImage, api, dirOf } from '../lib'
import { Modal } from '../shell/Dialogs'
import { errorText } from '../shell/historyView'
import { KindIcon } from '../shell/icons'

/** What goes into the document: the image as a data URL, as Insert > Image puts one in. */
export interface DesignPick { src: string; alt: string; width?: number }

/** The drawing as a data URL, read the way Insert > Image reads a picked file. */
function dataUrl(data: string | Uint8Array, format: InsertFormat): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('The drawing could not be read.'))
    r.readAsDataURL(new Blob([data as BlobPart], { type: format === 'svg' ? 'image/svg+xml' : 'image/png' }))
  })
}

/** "a, b and c", at most `max` of them, then how many more. */
function listed(items: string[], max = 5): string {
  const shown = items.slice(0, max)
  if (items.length > max) shown.push(`${items.length - max} more`)
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/** What the person should know after an insert: what the format can't hold and the layers the drawing left out. */
function notesOf(img: DesignImage): string[] {
  const out = [...img.downgrades]
  if (img.leftOut.length) out.push(`Left out ${listed(img.leftOut.map(l => `${l.name || l.layer} (${l.reason})`))}.`)
  return out
}

/** A design's card art on the recent list: the thumbnail its file holds, else the kind's icon. */
function Thumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    api.designThumbnail(path).then(url => !gone && setSrc(url), () => {})
    return () => void (gone = true)
  }, [path])
  if (!src) return <KindIcon kind="design" size={40} />
  return <img className="file-card-thumb" src={src} alt="" draggable={false} onError={() => setSrc(null)} />
}

/** An artboard's shape, scaled to fit its card. */
function Shape({ a }: { a: DesignArtboard }) {
  const k = Math.min(120 / Math.max(a.width, 1), 76 / Math.max(a.height, 1))
  return <span className="ins-board" style={{ width: Math.max(4, Math.round(a.width * k)), height: Math.max(4, Math.round(a.height * k)) }} />
}

/**
 * Insert > Design: pick a design from the recent ones or with Browse, then an artboard when it has more than one, and
 * it goes into the document as an image (SVG or PNG by insertFormat; Markdown and HTML may pick PNG instead). The
 * drawing comes from main as an export draws it, from the design's open tab when it's open. If it can't be drawn the
 * error shows here and nothing goes in; what the format couldn't hold shows after it went in.
 */
export function InsertDesign(props: { docPath: string; onInsert(pick: DesignPick): void; onClose(): void }) {
  const formats = insertFormats(props.docPath)
  const [format, setFormat] = useState<InsertFormat>(() => insertFormat(props.docPath))
  const [recent, setRecent] = useState<RecentFile[] | null>(null)
  const [design, setDesign] = useState<{ path: string; artboards: DesignArtboard[] } | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ name: string; notes: string[] } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // closed while a design was being read or drawn: it never goes in
  const gone = useRef(false)
  useEffect(() => () => void (gone.current = true), [])
  useEffect(() => {
    api.recent().then(
      list => !gone.current && setRecent(list.filter(r => r.kind === 'design')),
      () => !gone.current && setRecent([])
    )
  }, [])

  // one read or drawing at a time; a failure shows its plain message and nothing goes in
  const working = useRef(false)
  const run = async (what: string, fn: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(what)
    setError('')
    try {
      await fn()
    } catch (e) {
      if (!gone.current) setError(errorText(e))
    } finally {
      working.current = false
      if (!gone.current) setBusy('')
    }
  }

  /** Draws the artboard and puts it in the document, alt text its name; PNG shown at the artboard's own size. */
  const draw = async (path: string, a: DesignArtboard) => {
    setBusy(`Drawing ${a.name}...`)
    const img = await api.designImage(path, a.id, format)
    const src = await dataUrl(img.data, format)
    if (gone.current) return
    props.onInsert({ src, alt: img.artboard.name, width: format === 'png' ? Math.round(img.width / INSERT_SCALE) : undefined })
    const notes = notesOf(img)
    if (notes.length) setDone({ name: img.artboard.name, notes })
    else props.onClose()
  }

  const insert = (path: string, a: DesignArtboard) => run(`Drawing ${a.name}...`, () => draw(path, a))

  const pick = (path: string) =>
    run(`Opening ${stem(path)}...`, async () => {
      const artboards = await api.designArtboards(path)
      if (gone.current) return
      if (!artboards.length) throw new Error(`${baseName(path)} has no artboards.`)
      if (artboards.length > 1) return setDesign({ path, artboards })
      // one artboard: nothing to pick, it goes straight in
      await draw(path, artboards[0])
    })

  const browsed = (f: File | undefined) => {
    if (!f) return
    const path = window.gd.pathFor(f)
    if (!path || extOf(path) !== 'gdesign') return setError('Pick a design (a .gdesign file).')
    pick(path)
  }

  const footer = done ? (
    <button className="btn primary" autoFocus onClick={props.onClose}>Done</button>
  ) : (
    <>
      {design ? (
        <button className="btn" disabled={!!busy} onClick={() => (setDesign(null), setError(''))}>Back</button>
      ) : (
        <button className="btn" disabled={!!busy} onClick={() => fileInput.current?.click()}>Browse...</button>
      )}
      <button className="btn" onClick={props.onClose}>Cancel</button>
    </>
  )

  return createPortal(
    <div className="ins-design-host" onKeyDown={e => e.key !== 'Escape' && e.stopPropagation()}>
      <Modal title="Insert a design" onClose={props.onClose} wide footer={footer}>
        <div className="ins-design">
          {done ? (
            <>
              <p>{done.name} is in the document.</p>
              {done.notes.map(n => <p key={n} className="small muted">{n}</p>)}
            </>
          ) : design ? (
            <>
              <h3>Pick an artboard in {stem(design.path)}</h3>
              <div className="file-grid">
                {design.artboards.map(a => (
                  <button key={a.id} className="file-card" disabled={!!busy} onClick={() => insert(design.path, a)} title={a.name}>
                    <div className="file-card-art"><Shape a={a} /></div>
                    <div className="file-card-meta"><span className="grow ellipsis">{a.name}</span></div>
                    <small className="muted">{Math.round(a.width)} x {Math.round(a.height)} px</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3>Recent designs</h3>
              {recent && !recent.length && <p className="muted">Designs you open show up here. Use Browse to pick one.</p>}
              <div className="file-grid">
                {(recent ?? []).map(r => (
                  <button key={r.path} className="file-card" disabled={!!busy} onClick={() => pick(r.path)} title={r.path}>
                    <div className="file-card-art design"><Thumb path={r.path} /></div>
                    <div className="file-card-meta">
                      <KindIcon kind="design" size={18} />
                      <span className="grow ellipsis">{stem(r.path)}</span>
                    </div>
                    <small className="muted ellipsis">In {baseName(dirOf(r.path)) || dirOf(r.path)}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {!done && formats.length > 1 && (
            <div className="ins-format">
              <span className="muted">Insert as</span>
              <div className="chips" role="radiogroup" aria-label="Insert as">
                {formats.map(f => (
                  <button key={f} className={`chip${format === f ? ' on' : ''}`} role="radio" aria-checked={format === f} disabled={!!busy} onClick={() => setFormat(f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="small muted">{format === 'svg' ? 'Stays sharp at any size.' : 'Drawn at twice the size, so it stays sharp in print.'}</span>
            </div>
          )}
          {busy && <p className="small muted ins-status">{busy}</p>}
          {error && <p className="small error ins-status">{error}</p>}
          <input ref={fileInput} type="file" accept=".gdesign" hidden onChange={e => (browsed(e.target.files?.[0]), (e.target.value = ''))} />
        </div>
      </Modal>
    </div>,
    document.body
  )
}
