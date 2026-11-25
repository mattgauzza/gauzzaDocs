import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CF_LABELS, CF_TYPES, CHART_TYPES, type CfStyle, type CfType, type ConditionalRule, type SheetChart, chartData, chartSvg, checkRule, describeRule
} from '../../../shared/sheet/extras'
import type { Sheet } from '../../../shared/types'

// ---------------- conditional formatting panel (like Format → Conditional formatting in Sheets) ----------------

const PRESETS: CfStyle[] = [
  { bg: '#b7e1cd', color: '#0d652d' },
  { bg: '#f4c7c3', color: '#a50e0e' },
  { bg: '#fce8b2', color: '#7a4f01' },
  { bg: '#c6dafc', color: '#174ea6' },
  { b: true },
  { s: true, color: '#80868b' }
]

interface Draft {
  range: string
  type: CfType
  value: string
  value2: string
  formula: string
  style: CfStyle
  min: string
  max: string
}
const toDraft = (r: ConditionalRule): Draft => ({
  range: r.range,
  type: r.type,
  value: r.value === undefined ? '' : String(r.value),
  value2: r.value2 === undefined ? '' : String(r.value2),
  formula: r.formula ? '=' + r.formula : '',
  style: r.style || PRESETS[0],
  min: r.scale?.min || '#ffffff',
  max: r.scale?.max || '#57bb8a'
})
const styleCss = (s: CfStyle | undefined) => ({
  background: s?.bg, color: s?.color, fontWeight: s?.b ? 700 : undefined, fontStyle: s?.i ? 'italic' : undefined, textDecoration: s?.s ? 'line-through' : undefined
})

export function CfPanel(props: {
  rules: ConditionalRule[]
  defaultRange: string
  onAdd(rule: ConditionalRule): void
  onUpdate(index: number, rule: ConditionalRule): void
  onDelete(index: number): void
  onClose(): void
}) {
  const [editing, setEditing] = useState<number | 'new' | null>(props.rules.length ? null : 'new')
  const [draft, setDraft] = useState<Draft>(() => toDraft({ range: props.defaultRange, type: 'gt', value: '' }))
  const [error, setError] = useState('')
  const set = (p: Partial<Draft>) => setDraft(d => ({ ...d, ...p }))

  const open = (i: number | 'new') => {
    setError('')
    setEditing(i)
    setDraft(i === 'new' ? toDraft({ range: props.defaultRange, type: 'gt', value: '' }) : toDraft(props.rules[i]))
  }
  const done = () => {
    try {
      const rule = checkRule({
        range: draft.range,
        type: draft.type,
        value: draft.value,
        value2: draft.value2,
        formula: draft.formula,
        style: draft.style,
        scale: { min: draft.min, max: draft.max }
      })
      if (editing === 'new') props.onAdd(rule)
      else if (typeof editing === 'number') props.onUpdate(editing, rule)
      setEditing(null)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const needsValue = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains', 'notContains'].includes(draft.type)

  return (
    <aside className="sg-panel" onKeyDown={e => e.key === 'Escape' && props.onClose()}>
      <header>
        <b>Conditional format rules</b>
        <button className="tb" title="Close" onClick={props.onClose}>✕</button>
      </header>
      {editing === null ? (
        <div className="sg-panel-body">
          {props.rules.map((r, i) => (
            <div key={i} className="sg-rule" onClick={() => open(i)} role="button">
              <span className="sg-rule-swatch" style={r.type === 'scale' ? { background: `linear-gradient(90deg, ${r.scale?.min}, ${r.scale?.max})` } : styleCss(r.style)}>
                {r.type === 'scale' ? '' : '123'}
              </span>
              <span className="grow">
                <div>{describeRule(r)}</div>
                <small className="muted">{r.range}</small>
              </span>
              <button className="tb" title="Delete rule" onClick={e => (e.stopPropagation(), props.onDelete(i))}>🗑</button>
            </div>
          ))}
          {!props.rules.length && <p className="muted">No rules on this sheet yet.</p>}
          <button className="sg-addrule" onClick={() => open('new')}>+ Add another rule</button>
          <p className="muted small">The first rule that matches a cell decides its look, like Google Sheets.</p>
        </div>
      ) : (
        <div className="sg-panel-body sg-form">
          <label>Apply to range<input value={draft.range} onChange={e => set({ range: e.target.value.toUpperCase() })} /></label>
          <label>
            Format cells if…
            <select value={draft.type} onChange={e => set({ type: e.target.value as CfType })}>
              {CF_TYPES.map(t => <option key={t} value={t}>{CF_LABELS[t]}</option>)}
            </select>
          </label>
          {needsValue && <input placeholder={draft.type === 'between' ? 'From' : 'Value or number'} value={draft.value} onChange={e => set({ value: e.target.value })} />}
          {draft.type === 'between' && <input placeholder="To" value={draft.value2} onChange={e => set({ value2: e.target.value })} />}
          {draft.type === 'formula' && (
            <>
              <input placeholder="=$C2>100" value={draft.formula} onChange={e => set({ formula: e.target.value })} />
              <small className="muted">Write it for the top-left cell of the range; it shifts for every other cell.</small>
            </>
          )}
          {draft.type === 'scale' ? (
            <div className="sg-scale">
              <label>Lowest<input type="color" value={draft.min} onChange={e => set({ min: e.target.value })} /></label>
              <span className="sg-scale-bar" style={{ background: `linear-gradient(90deg, ${draft.min}, ${draft.max})` }} />
              <label>Highest<input type="color" value={draft.max} onChange={e => set({ max: e.target.value })} /></label>
            </div>
          ) : (
            <>
              <div className="sg-subhead">Formatting style</div>
              <div className="sg-presets">
                {PRESETS.map((p, i) => (
                  <button key={i} className={JSON.stringify(p) === JSON.stringify(draft.style) ? 'on' : ''} style={styleCss(p)} onClick={() => set({ style: p })}>123</button>
                ))}
              </div>
              <div className="sg-stylebar">
                <button className={'tb' + (draft.style.b ? ' on' : '')} title="Bold" onClick={() => set({ style: { ...draft.style, b: !draft.style.b || undefined } })}><b>B</b></button>
                <button className={'tb' + (draft.style.i ? ' on' : '')} title="Italic" onClick={() => set({ style: { ...draft.style, i: !draft.style.i || undefined } })}><i>I</i></button>
                <button className={'tb' + (draft.style.s ? ' on' : '')} title="Strikethrough" onClick={() => set({ style: { ...draft.style, s: !draft.style.s || undefined } })}><s>S</s></button>
                <label title="Text color">A<input type="color" value={draft.style.color || '#000000'} onChange={e => set({ style: { ...draft.style, color: e.target.value } })} /></label>
                <label title="Fill color">Fill<input type="color" value={draft.style.bg || '#ffffff'} onChange={e => set({ style: { ...draft.style, bg: e.target.value } })} /></label>
                <button className="tb" title="No fill" onClick={() => set({ style: { ...draft.style, bg: undefined } })}>⌀</button>
              </div>
              <div className="sg-preview" style={styleCss(draft.style)}>Preview 1,234</div>
            </>
          )}
          {error && <p className="error small">{error}</p>}
          <div className="sg-panel-actions">
            <button className="btn" onClick={() => (setEditing(null), setError(''))}>Cancel</button>
            <button className="btn primary" onClick={done}>Done</button>
          </div>
        </div>
      )}
    </aside>
  )
}

// ---------------- chart editor panel ----------------

export function ChartPanel(props: { chart: SheetChart; onChange(patch: Partial<SheetChart>): void; onDelete(): void; onClose(): void }) {
  const c = props.chart
  const [range, setRange] = useState(c.range)
  const [title, setTitle] = useState(c.title || '')
  useEffect(() => (setRange(c.range), setTitle(c.title || '')), [c.id, c.range, c.title])
  return (
    <aside className="sg-panel">
      <header>
        <b>Chart editor</b>
        <button className="tb" title="Close" onClick={props.onClose}>✕</button>
      </header>
      <div className="sg-panel-body sg-form">
        <div className="sg-subhead">Chart type</div>
        <div className="sg-charttypes">
          {CHART_TYPES.map(t => (
            <button key={t.type} className={c.type === t.type ? 'on' : ''} onClick={() => props.onChange({ type: t.type })}>{t.label}</button>
          ))}
        </div>
        <label>
          Data range
          <input value={range} onChange={e => setRange(e.target.value.toUpperCase())} onBlur={() => range !== c.range && props.onChange({ range })}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
        <label>
          Title
          <input value={title} placeholder="Chart title" onChange={e => setTitle(e.target.value)} onBlur={() => title !== (c.title || '') && props.onChange({ title: title || undefined })}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
        <label className="row"><input type="checkbox" checked={c.headers ?? true} onChange={e => props.onChange({ headers: e.target.checked })} /> Use row 1 as headers (series names)</label>
        {c.type !== 'scatter' && <label className="row"><input type="checkbox" checked={c.labels ?? true} onChange={e => props.onChange({ labels: e.target.checked })} /> Use column A as labels</label>}
        <p className="muted small">Charts are saved in the .xlsx for this app. Excel and Google Sheets do not show them.</p>
        <div className="sg-panel-actions">
          <button className="btn" onClick={props.onDelete}>Delete chart</button>
        </div>
      </div>
    </aside>
  )
}

// ---------------- a chart floating over the grid ----------------

/**
 * Draws a chart as SVG. The drawing is recomputed only when the sheet's cells or the chart itself change.
 * Drag the body to move it; drag the corner to resize; double click to edit.
 */
export function ChartBox(props: {
  sheet: Sheet
  chart: SheetChart
  left: number
  top: number
  selected: boolean
  onSelect(): void
  onEdit(): void
  onDelete(): void
  onMoved(left: number, top: number): void
  onResized(w: number, h: number): void
}) {
  const { chart } = props
  const [drag, setDrag] = useState<{ dx: number; dy: number; dw: number; dh: number } | null>(null)
  const w = chart.w + (drag?.dw || 0), h = chart.h + (drag?.dh || 0)
  const svg = useMemo(() => chartSvg(chart, chartData(props.sheet, chart)), [props.sheet.cells, chart])
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  const start = (e: React.MouseEvent, mode: 'move' | 'size') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    props.onSelect()
    const x0 = e.clientX, y0 = e.clientY
    let last = { dx: 0, dy: 0, dw: 0, dh: 0 }
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0
      last = mode === 'move' ? { dx, dy, dw: 0, dh: 0 } : { dx: 0, dy: 0, dw: Math.max(160 - chart.w, dx), dh: Math.max(120 - chart.h, dy) }
      setDrag(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      cleanup.current = null
      setDrag(null)
      if (mode === 'move' && (last.dx || last.dy)) props.onMoved(Math.max(0, props.left + last.dx), Math.max(0, props.top + last.dy))
      if (mode === 'size' && (last.dw || last.dh)) props.onResized(Math.round(chart.w + last.dw), Math.round(chart.h + last.dh))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    cleanup.current = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }

  return (
    <div
      className={'sg-chart' + (props.selected ? ' on' : '')}
      style={{ left: props.left + (drag?.dx || 0), top: props.top + (drag?.dy || 0), width: w, height: h }}
      onMouseDown={e => start(e, 'move')}
      onDoubleClick={e => (e.stopPropagation(), props.onEdit())}
      onContextMenu={e => e.stopPropagation()}
    >
      <div className="sg-chart-svg" dangerouslySetInnerHTML={{ __html: drag?.dw || drag?.dh ? svg.replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}" preserveAspectRatio="none"`) : svg }} />
      {props.selected && (
        <div className="sg-chart-tools" onMouseDown={e => e.stopPropagation()}>
          <button title="Edit chart" onClick={props.onEdit}>✎</button>
          <button title="Delete chart" onClick={props.onDelete}>🗑</button>
        </div>
      )}
      {props.selected && <div className="sg-chart-size" onMouseDown={e => start(e, 'size')} />}
    </div>
  )
}
