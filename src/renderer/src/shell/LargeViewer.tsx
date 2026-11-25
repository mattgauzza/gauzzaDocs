import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { baseName } from '../../../shared/kinds'
import type { EditorProps } from '../editor'
import { api } from '../lib'
import { Icon } from './icons'

/**
 * Viewer for files too big to load (see core/large.ts): only the lines on screen are read from disk, in chunks,
 * with a small cache. Scrolling a 5 GB log uses a few MB. Text shows with line numbers; CSV/TSV as a table.
 * Agents still edit these files with gdocs, which works on the file on disk.
 */
const ROW = 20
const CHUNK = 500
const MAX_CHUNKS = 40 // ~20k lines cached
const MAX_SCROLL = 8_000_000 // px; browsers cap element heights, so very long files scroll proportionally

export default function LargeViewer(props: EditorProps) {
  const payload = props.payload.kind === 'large' ? props.payload : null
  const [info, setInfo] = useState<{ lines: number; size: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [first, setFirst] = useState(0) // first visible line, 0-based
  const [viewH, setViewH] = useState(600)
  const [, setTick] = useState(0)
  const cache = useRef(new Map<number, string[]>())
  const loading = useRef(new Set<number>())
  const scroller = useRef<HTMLDivElement>(null)
  const statusRef = useRef<{ text: string; title?: string }[]>([])
  const [find, setFind] = useState<{ open: boolean; q: string; results: { line: number; text: string }[]; busy: boolean; i: number }>({ open: false, q: '', results: [], busy: false, i: -1 })
  const [goto, setGoto] = useState('')
  const [hit, setHit] = useState<number | null>(null)
  const csv = payload?.as === 'csv'
  const sep = useRef(',')

  useEffect(() => {
    props.setHandle({
      getPayload: () => props.payload,
      agent: async () => {
        throw new Error('This file is too large to edit in the window; gdocs edits it on disk instead (run the command without --live).')
      },
      language: csv ? 'csv' : 'text',
      status: () => statusRef.current,
      command: id => (id === 'find' || id === 'replace' ? setFind(f => ({ ...f, open: true })) : undefined)
    })
    const off = window.gd.on('large-progress', (file: string, f: number) => file === props.path && setProgress(f))
    api.largeIndex(props.path).then(setInfo, e => setError((e as Error).message))
    return () => {
      off()
      props.setHandle(null)
      cache.current.clear()
    }
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [info])

  const lines = info?.lines || 0
  statusRef.current = info
    ? [{ text: `Line ${(first + 1).toLocaleString()} of ${lines.toLocaleString()}`, title: 'Go to line (Ctrl+G)' }, ...(find.results.length ? [{ text: `${find.results.length}${find.results.length >= 500 ? '+' : ''} matches` }] : [])]
    : [{ text: `Indexing ${Math.round(progress * 100)}%` }]
  const rows = Math.ceil(viewH / ROW) + 1
  const fullH = lines * ROW
  const virtH = Math.min(fullH, MAX_SCROLL)
  const scaled = fullH > MAX_SCROLL

  const onScroll = () => {
    const el = scroller.current!
    const top = el.scrollTop
    const maxTop = Math.max(1, virtH - el.clientHeight)
    const line = scaled ? Math.round((top / maxTop) * Math.max(0, lines - rows + 1)) : Math.floor(top / ROW)
    setFirst(Math.max(0, Math.min(line, Math.max(0, lines - 1))))
  }
  const scrollToLine = (line0: number) => {
    const el = scroller.current
    if (!el) return
    const target = Math.max(0, line0 - Math.floor(rows / 3))
    el.scrollTop = scaled ? (target / Math.max(1, lines - rows + 1)) * Math.max(1, virtH - el.clientHeight) : target * ROW
    setFirst(Math.min(target, Math.max(0, lines - 1)))
  }

  // Fetch the chunks the visible window needs; evict the least recently used beyond the cap.
  useEffect(() => {
    if (!info) return
    const need = new Set<number>()
    for (let c = Math.floor(first / CHUNK); c <= Math.floor((first + rows) / CHUNK); c++) need.add(c)
    if (csv) need.add(0) // header row
    for (const c of need) {
      const hitC = cache.current.get(c)
      if (hitC) {
        cache.current.delete(c)
        cache.current.set(c, hitC) // mark recently used
        continue
      }
      if (loading.current.has(c)) continue
      loading.current.add(c)
      api.largeLines(props.path, c * CHUNK, CHUNK).then(ls => {
        loading.current.delete(c)
        cache.current.set(c, ls)
        if (c === 0 && ls[0]?.includes('\t')) sep.current = '\t'
        while (cache.current.size > MAX_CHUNKS) cache.current.delete(cache.current.keys().next().value!)
        setTick(t => t + 1)
      }, e => {
        loading.current.delete(c)
        setError((e as Error).message)
      })
    }
  }, [first, rows, info])

  const lineAt = (i: number) => cache.current.get(Math.floor(i / CHUNK))?.[i % CHUNK]

  const runFind = async (from: number) => {
    if (!find.q) return
    setFind(f => ({ ...f, busy: true }))
    try {
      const r = await api.largeFind(props.path, find.q, { from, limit: 500, ignoreCase: true })
      setFind(f => ({ ...f, busy: false, results: r.matches, i: r.matches.length ? 0 : -1 }))
      if (r.matches[0]) {
        setHit(r.matches[0].line - 1)
        scrollToLine(r.matches[0].line - 1)
      }
    } catch (e) {
      setFind(f => ({ ...f, busy: false }))
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    if (!props.active) return
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'f') (e.preventDefault(), setFind(f => ({ ...f, open: true })))
      if (e.key.toLowerCase() === 'g') (e.preventDefault(), (document.querySelector('.large-goto') as HTMLInputElement)?.focus())
      if (e.key === 'Home') (e.preventDefault(), scrollToLine(0))
      if (e.key === 'End') (e.preventDefault(), scrollToLine(lines - 1))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const split = (l: string) => {
    // Quoted fields with the separator inside are kept together; quotes spanning lines are not (rare in huge exports).
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < l.length; i++) {
      const c = l[i]
      if (c === '"') {
        if (q && l[i + 1] === '"') (cur += '"', i++)
        else q = !q
      } else if (c === sep.current && !q) (out.push(cur), (cur = ''))
      else cur += c
    }
    out.push(cur)
    return out
  }

  const mb = (n: number) => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(0)} MB`)
  const gutterW = `${Math.max(4, String(lines).length) + 2}ch`
  const visible = Array.from({ length: Math.min(rows, Math.max(0, lines - first)) }, (_, k) => first + k)

  return (
    <div className="large">
      <div className="large-bar">
        <Icon name="sparkle" size={16} />
        <span className="grow">
          {baseName(props.path)} is {payload ? mb(payload.size) : 'large'}, so it opens read-only and is read from disk a screen at a time.
          {info ? ` ${lines.toLocaleString()} lines.` : ` Indexing… ${Math.round(progress * 100)}%`} Agents can still change it with gdocs.
        </span>
        <input className="large-goto tb-input" placeholder="Line" value={goto} onChange={e => setGoto(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && goto && (scrollToLine(Number(goto) - 1), setHit(Number(goto) - 1))} title="Go to line (Ctrl+G)" style={{ width: 80 }} />
        <button className="tb" onClick={() => setFind(f => ({ ...f, open: !f.open }))} title="Find (Ctrl+F)"><Icon name="search" size={18} /></button>
      </div>
      {find.open && (
        <div className="large-find">
          <input autoFocus placeholder="Find in file" value={find.q} onChange={e => setFind(f => ({ ...f, q: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (find.results.length && !e.shiftKey && find.i >= 0) {
                  const i = (find.i + 1) % find.results.length
                  setFind(f => ({ ...f, i }))
                  setHit(find.results[i].line - 1)
                  scrollToLine(find.results[i].line - 1)
                } else runFind(0)
              }
              if (e.key === 'Escape') setFind(f => ({ ...f, open: false }))
            }} />
          <button className="btn sm" onClick={() => runFind(0)} disabled={find.busy}>{find.busy ? 'Searching…' : 'Search'}</button>
          <span className="muted small">{find.results.length ? `${find.i + 1} of ${find.results.length}${find.results.length >= 500 ? '+' : ''}` : ''}</span>
        </div>
      )}
      {error && <p className="error" style={{ padding: '0 16px' }}>{error}</p>}
      <div className={`large-scroll${csv ? ' csv' : ''}`} ref={scroller} onScroll={onScroll} tabIndex={0}>
        <div className="large-view" style={{ height: viewH }}>
          {csv && lineAt(0) !== undefined && (
            <div className="large-row head" style={{ ['--gw' as string]: gutterW }}>
              <span className="large-gutter" />
              {split(lineAt(0)!).map((c, i) => <span key={i} className="large-cell">{c}</span>)}
            </div>
          )}
          {visible.map(i => {
            const t = lineAt(i)
            return (
              <div key={i} className={`large-row${hit === i ? ' hit' : ''}`} style={{ ['--gw' as string]: gutterW }}>
                <span className="large-gutter">{i + 1}</span>
                {t === undefined ? <span className="large-loading" /> : csv ? split(t).map((c, k) => <span key={k} className="large-cell">{c}</span>) : <span className="large-text">{t}</span>}
              </div>
            )
          })}
        </div>
        {/* The sticky view above stays in place; this spacer gives the scrollbar the file's length. */}
        <div style={{ height: Math.max(0, virtH - viewH) }} />
      </div>
    </div>
  )
}
