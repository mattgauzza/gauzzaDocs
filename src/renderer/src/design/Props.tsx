import { useEffect, useRef, useState } from 'react'
import { fin } from '../../../shared/design/geometry'
import { walk } from '../../../shared/design/model'
import type { BlendMode, Design, Layer, Override, Paint } from '../../../shared/design/types'
import { list } from '../../../shared/ops/designLayers'
import { api } from '../lib'

const BLENDS: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
]
/** "color-dodge" as "Color dodge". */
const said = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ')
const SHAPES = new Set(['rect', 'ellipse', 'line', 'path'])
const fmt = (v: number) => String(Math.round(v * 100) / 100)

/** Installed font families for the picker, asked of the worker once (its first font scan takes a few seconds). */
let families: Promise<string[]> | null = null
function useFamilies(): string[] | null {
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    families ??= api.fontFaces().then(
      faces => [...new Set(faces.map(f => f.family))].sort((a, b) => a.localeCompare(b)),
      () => ((families = null), [])
    )
    families.then(n => alive && setNames(n))
    return () => void (alive = false)
  }, [])
  return names
}

/**
 * A text field that commits when it loses focus or on Enter (Ctrl+Enter when it holds lines), and goes back on Escape.
 * The panel keys its fields by layer, so a field always commits to the layer it was opened on, even when the selection
 * moves on before it lets go.
 */
function Field(p: { value: string; onCommit(v: string): void; lines?: boolean; label: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const live = useRef({ draft, value: p.value, onCommit: p.onCommit })
  live.current = { draft, value: p.value, onCommit: p.onCommit }
  const done = () => {
    const { draft: d, value, onCommit } = live.current
    live.current.draft = null
    setDraft(null)
    if (d !== null && d !== value) onCommit(d)
  }
  useEffect(() => () => done(), [])
  const props = {
    className: p.className,
    'aria-label': p.label,
    value: draft ?? p.value,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: done,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        live.current.draft = null
        setDraft(null)
        e.currentTarget.blur()
      } else if (e.key === 'Enter' && (!p.lines || e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.currentTarget.blur()
      }
    }
  }
  return p.lines ? <textarea rows={3} {...props} /> : <input {...props} />
}

/** A number field: what's typed is read as a number, and anything else puts the old value back. */
function Num(p: { value: number; onCommit(v: number): void; label: string; suffix?: string }) {
  return (
    <label className="de-num" title={p.label}>
      <span>{p.label}</span>
      <Field
        label={p.label}
        value={fmt(p.value)}
        onCommit={v => {
          const n = Number(v.trim())
          if (v.trim() && Number.isFinite(n)) p.onCommit(n)
        }}
      />
      {p.suffix && <i>{p.suffix}</i>}
    </label>
  )
}

/** A paint's color as #rrggbb for a color input, with the style's color for a style paint. */
function colorOf(design: Design, paint: Paint | null | undefined): string | null {
  if (!paint) return null
  if (paint.type === 'color') return paint.color
  if (paint.type === 'style') return design.styles?.colors?.find(c => c.name === paint.ref)?.color ?? null
  return paint.stops?.[0]?.color ?? null
}
const six = (c: string | null) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : '#000000')
/** The picked color, keeping the old one's transparency (a color input has none). */
const keepAlpha = (picked: string, old: string | null) => (old && old.length === 9 ? picked + old.slice(7) : picked)

function PaintRow(p: { design: Design; label: string; paint: Paint | null | undefined; onPaint(v: string | null, live?: boolean): void }) {
  const c = colorOf(p.design, p.paint)
  const note = p.paint?.type === 'style' ? `Style ${p.paint.ref}` : p.paint?.type === 'linear' || p.paint?.type === 'radial' ? 'Gradient' : ''
  return (
    <div className="de-prop-row">
      <label className="de-check">
        <input type="checkbox" checked={!!p.paint} onChange={e => p.onPaint(e.target.checked ? six(c) : null)} />
        {p.label}
      </label>
      <input type="color" aria-label={`${p.label} color`} value={six(c)} disabled={!p.paint} onChange={e => p.onPaint(keepAlpha(e.target.value, c), true)} />
      {note && <span className="muted de-note" title={note}>{note}</span>}
    </div>
  )
}

/** One override as words: "text, fill and hidden". */
function overrideWords(o: Override): string {
  const parts: string[] = []
  if (o.text !== undefined) parts.push('text')
  if (o.fill) parts.push('fill')
  if (o.stroke) parts.push('stroke')
  if (o.visible !== undefined) parts.push(o.visible ? 'shown' : 'hidden')
  if (o.asset) parts.push('image')
  return list(parts)
}

interface Props {
  design: Design
  layers: Layer[]
  /** Writes props onto layers as one undo step; `live` changes to the same thing within a second share one. */
  onSet(ids: string[], props: Record<string, unknown>, live?: boolean): void
}

/**
 * The properties panel: the selected layer's name, position, size, opacity and blend; fill, stroke, stroke width and
 * corner radius for shapes; text, font, size and color for text; and an instance's overrides with Reset overrides.
 */
export function Props(p: Props) {
  const l = p.layers.length === 1 ? p.layers[0] : null
  return (
    <aside className="de-panel de-props">
      <header>
        <b>Properties</b>
      </header>
      <div className="de-props-body">
        {!p.layers.length && <p className="de-empty">Select a layer to see its properties</p>}
        {p.layers.length > 1 && <p className="de-empty">{p.layers.length} layers selected</p>}
        {l && <LayerProps key={l.id} design={p.design} layer={l} onSet={p.onSet} />}
      </div>
    </aside>
  )
}

function LayerProps({ design, layer: l, onSet }: { design: Design; layer: Layer; onSet: Props['onSet'] }) {
  const set = (props: Record<string, unknown>, live?: boolean) => onSet([l.id], props, live)
  const fams = useFamilies()
  const text = l.type === 'text' ? l : null
  const run = text?.runs?.[0]
  const family = run?.font?.family ?? ''
  const comp = l.type === 'instance' ? design.components?.find(c => c.id === l.component) : undefined
  const names = new Map<string, string>()
  if (comp?.root) walk([comp.root], x => names.set(x.id, x.name))
  const overrides = l.type === 'instance' ? Object.entries(l.overrides ?? {}) : []
  return (
    <>
      <section>
        <Field className="de-name" label="Name" value={l.name} onCommit={v => set({ name: v })} />
        <div className="de-grid">
          <Num label="X" value={fin(l.x, 0)} onCommit={v => set({ x: v })} />
          <Num label="Y" value={fin(l.y, 0)} onCommit={v => set({ y: v })} />
          <Num label="W" value={fin(l.width, 0)} onCommit={v => set({ width: v })} />
          <Num label="H" value={fin(l.height, 0)} onCommit={v => set({ height: v })} />
        </div>
      </section>
      <section>
        <h4>Appearance</h4>
        <div className="de-grid">
          <Num label="Opacity" suffix="%" value={fin(l.opacity, 1) * 100} onCommit={v => set({ opacity: Math.min(100, Math.max(0, v)) / 100 })} />
          <label className="de-num" title="Blend">
            <span>Blend</span>
            <select aria-label="Blend" value={l.blend || 'normal'} onChange={e => set({ blend: e.target.value })}>
              {BLENDS.map(b => (
                <option key={b} value={b}>
                  {said(b)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {SHAPES.has(l.type) && (
        <section>
          <h4>Fill and stroke</h4>
          {l.type !== 'line' && <PaintRow design={design} label="Fill" paint={l.fill} onPaint={(v, live) => set({ fill: v }, live)} />}
          <PaintRow design={design} label="Stroke" paint={l.type === 'line' ? (l.stroke ?? l.fill) : l.stroke} onPaint={(v, live) => set({ stroke: v }, live)} />
          <div className="de-grid">
            <Num label="Stroke width" value={fin(l.strokeWidth, l.type === 'line' ? 1 : 0)} onCommit={v => set({ strokeWidth: v })} />
            {l.type === 'rect' && <Num label="Corner radius" value={fin(l.radius, 0)} onCommit={v => set({ radius: v })} />}
          </div>
        </section>
      )}
      {text && (
        <section>
          <h4>Text</h4>
          <Field lines className="de-text" label="Text" value={text.runs.map(r => r.text).join('')} onCommit={v => set({ text: v })} />
          <label className="de-num de-wide" title="Font">
            <span>Font</span>
            <select aria-label="Font" value={family} onChange={e => set({ font: e.target.value })}>
              {!fams && <option value={family}>{family}</option>}
              {fams && !fams.includes(family) && <option value={family}>{family} (not installed)</option>}
              {fams?.map(f => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <div className="de-grid">
            <Num label="Size" value={fin(run?.size, 24)} onCommit={v => set({ size: v })} />
            <div className="de-prop-row">
              <span className="de-label">Color</span>
              <input
                type="color"
                aria-label="Text color"
                value={six(colorOf(design, run?.color ?? l.fill))}
                onChange={e => set({ color: keepAlpha(e.target.value, colorOf(design, run?.color ?? l.fill)) }, true)}
              />
            </div>
          </div>
        </section>
      )}
      {l.type === 'instance' && (
        <section>
          <h4>Component</h4>
          <p className="de-line">{comp?.name ?? 'Missing component'}</p>
          {overrides.length ? (
            <ul className="de-overrides">
              {overrides.map(([id, o]) => (
                <li key={id}>
                  <b>{names.get(id) ?? id}</b> <span className="muted">{overrideWords(o)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="de-line muted">No overrides</p>
          )}
          <button className="btn sm" disabled={!overrides.length} onClick={() => set({ overrides: {} })}>
            Reset overrides
          </button>
        </section>
      )}
    </>
  )
}
