import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Deck, Slide, SlideElement, SlideLayout, SlidePara, SlideRun } from '../../../shared/types'
import { LAYOUTS, THEMES, bg } from '../../../shared/slides/model'
import type { MenuItem } from '../editor'
import { MenuList } from '../shell/Menus'
import { type Tool, isLine } from './Canvas'
import { Icon } from './icons'

export const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Roboto', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana']
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96]
const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  '#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'
]
const SHAPES: { id: Tool; label: string }[] = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'roundRect', label: 'Rounded rectangle' },
  { id: 'ellipse', label: 'Oval' },
  { id: 'line', label: 'Line' },
  { id: 'arrow', label: 'Arrow' }
]

export interface Fmt { b: boolean; i: boolean; u: boolean; color: string; size: number; font: string; bullet?: SlidePara['bullet']; align: NonNullable<SlidePara['align']> }

export interface ToolbarActions {
  undo(): void
  redo(): void
  addSlide(layout?: SlideLayout): void
  setTool(t: Tool): void
  pickImage(): void
  run(patch: Partial<SlideRun>, toggle?: 'b' | 'i' | 'u'): void
  para(patch: { bullet?: SlidePara['bullet'] | null; align?: SlidePara['align']; indent?: 1 | -1 }): void
  shape(patch: { fill?: string | null; stroke?: string | null; strokeWidth?: number }): void
  arrange(): MenuItem[]
  background(c: string | null): void
  theme(name: string): void
  present(mode: 'start' | 'current' | 'presenter'): void
}

/** Closes a popup on a click outside it (and outside the button that opened it) or on Esc. */
function useDismiss(open: boolean, close: () => void, btn: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Element
      if (!t.closest?.('.sl-pop, .sl-drop-menu, .menu-fly') && !btn.current?.contains(t)) close()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
}

/** A toolbar button that opens a menu below it. */
function Drop(props: { title: string; items: () => MenuItem[]; children?: React.ReactNode; disabled?: boolean; className?: string }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useDismiss(!!pos, () => setPos(null), btn)
  return (
    <>
      <button
        ref={btn}
        className={`tb sl-drop${pos ? ' on' : ''} ${props.className || ''}`}
        title={props.title}
        disabled={props.disabled}
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          const r = btn.current!.getBoundingClientRect()
          setPos(pos ? null : { left: Math.min(r.left, window.innerWidth - 280), top: r.bottom + 4 })
        }}
      >
        {props.children}
        <Icon name="caret" size={16} />
      </button>
      {pos && createPortal(<MenuList items={props.items()} close={() => setPos(null)} className="sl-drop-menu" style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 200 }} />, document.body)}
    </>
  )
}

/** Color button with a palette (and a reset choice such as "Transparent"). */
function ColorPick(props: { icon: string; title: string; value?: string; reset?: string; onPick(c: string | null): void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useDismiss(!!pos, () => setPos(null), btn)
  const pick = (c: string | null) => (props.onPick(c), setPos(null))
  return (
    <>
      <button
        ref={btn}
        className={`tb sl-color-tb${pos ? ' on' : ''}`}
        title={props.title}
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          const r = btn.current!.getBoundingClientRect()
          setPos(pos ? null : { left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 4 })
        }}
      >
        <Icon name={props.icon} />
        <span className="swatch" style={{ background: props.value || 'transparent', outline: props.value ? undefined : '1px dashed var(--line)' }} />
      </button>
      {pos &&
        createPortal(
          <div className="sl-pop" style={{ left: pos.left, top: pos.top }} onMouseDown={e => e.target instanceof HTMLInputElement || e.preventDefault()}>
            {props.reset && <button className="sl-pop-reset" onClick={() => pick(null)}>{props.reset}</button>}
            <div className="sl-pop-grid">
              {PALETTE.map(c => (
                <button key={c} title={c} style={{ background: c }} className={c === props.value?.toLowerCase() ? 'on' : ''} onClick={() => pick(c)} />
              ))}
            </div>
            <label className="sl-pop-custom">
              Custom <input type="color" defaultValue={props.value?.startsWith('#') ? props.value : '#000000'} onChange={e => props.onPick(e.target.value)} />
            </label>
          </div>,
          document.body
        )}
    </>
  )
}

function SizeBox({ size, onSize }: { size: number; onSize(n: number): void }) {
  const [text, setText] = useState(String(size))
  useEffect(() => setText(String(size)), [size])
  const step = (d: 1 | -1) => onSize(d > 0 ? (SIZES.find(s => s > size) ?? size + 4) : ([...SIZES].reverse().find(s => s < size) ?? Math.max(1, size - 1)))
  const commit = () => {
    const n = parseFloat(text)
    if (n > 0 && n !== size) onSize(Math.min(400, Math.round(n * 2) / 2))
    else setText(String(size))
  }
  return (
    <>
      <button className="tb" title="Decrease font size" onMouseDown={e => e.preventDefault()} onClick={() => step(-1)}><Icon name="minus" /></button>
      <input className="tb-input" title="Font size" value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), commit())} />
      <button className="tb" title="Increase font size" onMouseDown={e => e.preventDefault()} onClick={() => step(1)}><Icon name="plus" /></button>
    </>
  )
}

export function Toolbar(props: { deck: Deck; slide: Slide; selEls: SlideElement[]; fmt: Fmt | null; tool: Tool; canUndo: boolean; canRedo: boolean; act: ToolbarActions }) {
  const { deck, slide, selEls, fmt, tool, act } = props
  const btn = (icon: string, title: string, run: () => void, on = false, disabled = false) => (
    <button className={`tb${on ? ' on' : ''}`} title={title} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={run}>
      <Icon name={icon} />
    </button>
  )
  const shapes = selEls.filter(e => e.type === 'shape')
  const fillable = shapes.filter(e => !isLine(e))
  const fonts = [...new Set([deck.theme.headFont, deck.theme.bodyFont, ...FONTS, ...(fmt ? [fmt.font] : [])])].sort()
  const shapeTool = SHAPES.find(s => s.id === tool)

  return (
    <div className="toolbar sl-toolbar">
      {btn('slideAdd', 'New slide (Ctrl+M)', () => act.addSlide())}
      <Drop title="New slide with a layout" items={() => LAYOUTS.map(l => ({ label: l.label, run: () => act.addSlide(l.id) }))} className="sl-narrow" />
      <span className="tb-sep" />
      {btn('undo', 'Undo (Ctrl+Z)', act.undo, false, !props.canUndo)}
      {btn('redo', 'Redo (Ctrl+Y)', act.redo, false, !props.canRedo)}
      <span className="tb-sep" />
      {btn('cursor', 'Select (Esc)', () => act.setTool('select'), tool === 'select')}
      {btn('textbox', 'Text box', () => act.setTool(tool === 'text' ? 'select' : 'text'), tool === 'text')}
      {btn('image', 'Image', act.pickImage)}
      <Drop title="Shape" items={() => SHAPES.map(s => ({ label: s.label, checked: tool === s.id, run: () => act.setTool(s.id) }))} className={shapeTool ? 'on' : ''}>
        <Icon name={shapeTool ? shapeTool.id : 'shape'} />
      </Drop>
      <span className="tb-sep" />
      {fmt && (
        <>
          <select className="tb-select sl-font" title="Font" value={fmt.font} onChange={e => act.run({ font: e.target.value })}>
            {fonts.map(f => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </select>
          <span className="tb-sep" />
          <SizeBox size={fmt.size} onSize={n => act.run({ size: n })} />
          <span className="tb-sep" />
          {btn('bold', 'Bold (Ctrl+B)', () => act.run({}, 'b'), fmt.b)}
          {btn('italic', 'Italic (Ctrl+I)', () => act.run({}, 'i'), fmt.i)}
          {btn('underline', 'Underline (Ctrl+U)', () => act.run({}, 'u'), fmt.u)}
          <ColorPick icon="color" title="Text color" value={fmt.color} onPick={c => c && act.run({ color: c })} />
          <span className="tb-sep" />
          {btn('alignLeft', 'Align left', () => act.para({ align: 'left' }), fmt.align === 'left')}
          {btn('alignCenter', 'Center', () => act.para({ align: 'center' }), fmt.align === 'center')}
          {btn('alignRight', 'Align right', () => act.para({ align: 'right' }), fmt.align === 'right')}
          {btn('bullets', 'Bulleted list', () => act.para({ bullet: fmt.bullet === 'bullet' ? null : 'bullet' }), fmt.bullet === 'bullet')}
          {btn('numbers', 'Numbered list', () => act.para({ bullet: fmt.bullet === 'number' ? null : 'number' }), fmt.bullet === 'number')}
          {btn('outdent', 'Decrease indent (Shift+Tab)', () => act.para({ indent: -1 }))}
          {btn('indent', 'Increase indent (Tab)', () => act.para({ indent: 1 }))}
          <span className="tb-sep" />
        </>
      )}
      {shapes.length > 0 && (
        <>
          {fillable.length > 0 && <ColorPick icon="fill" title="Fill color" value={fillable[0].fill} reset="Transparent" onPick={c => act.shape({ fill: c })} />}
          <ColorPick icon="border" title={fillable.length ? 'Border color' : 'Line color'} value={shapes[0].stroke} reset={fillable.length ? 'No border' : undefined} onPick={c => act.shape({ stroke: c })} />
          <Drop title={fillable.length ? 'Border weight' : 'Line weight'} items={() => [1, 2, 3, 4, 6, 8, 12].map(w => ({ label: `${w} pt`, checked: (shapes[0].strokeWidth ?? (shapes[0].stroke ? 1 : 0)) === w, run: () => act.shape({ strokeWidth: w }) }))}>
            <Icon name="weight" />
          </Drop>
          <span className="tb-sep" />
        </>
      )}
      <Drop title="Arrange" items={act.arrange} disabled={!selEls.length}>
        <Icon name="arrange" />
      </Drop>
      <span className="tb-sep" />
      <ColorPick icon="background" title="Slide background" value={bg(slide, deck)} reset="Theme background" onPick={c => act.background(c)} />
      <select className="tb-select" title="Theme" value={deck.theme.name} onChange={e => act.theme(e.target.value)}>
        {!THEMES.some(t => t.name === deck.theme.name) && <option value={deck.theme.name}>{deck.theme.name}</option>}
        {THEMES.map(t => (
          <option key={t.name} value={t.name}>{t.name}</option>
        ))}
      </select>
      <div className="sl-tb-right" data-tb-keep>
        <button className="tb sl-present-btn" title="Present from this slide (Ctrl+Enter); F5 starts at the beginning" onMouseDown={e => e.preventDefault()} onClick={() => act.present('current')}>
          <Icon name="present" /> Present
        </button>
        <Drop
          title="Present options"
          className="sl-narrow sl-present-more"
          items={() => [
            { label: 'Present from beginning', shortcut: 'F5', run: () => act.present('start') },
            { label: 'Present from this slide', shortcut: 'Ctrl+Enter', run: () => act.present('current') },
            { label: 'Presenter view', run: () => act.present('presenter') }
          ]}
        />
      </div>
    </div>
  )
}
