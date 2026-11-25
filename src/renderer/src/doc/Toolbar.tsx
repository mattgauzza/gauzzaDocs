import type { Editor } from '@tiptap/core'
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

export const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Roboto', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana']
export const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96]
export const ZOOMS = [50, 75, 90, 100, 125, 150, 200]
export const DEFAULT_SIZE = 11

const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  '#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'
]

/** Current font size in pt at the selection (TipTap stores "14pt" or "14px"). */
export function currentSize(editor: Editor) {
  const s = String(editor.getAttributes('textStyle').fontSize || '')
  const n = parseFloat(s)
  if (!n) return DEFAULT_SIZE
  return s.endsWith('px') ? Math.round(n * 0.75) : n
}

export function styleOf(editor: Editor) {
  if (editor.isActive('heading')) {
    const a = editor.getAttributes('heading')
    return a.title ? 'title' : `h${a.level}`
  }
  return 'p'
}

export function applyStyle(editor: Editor, v: string) {
  const c = editor.chain().focus()
  if (v === 'p') c.setParagraph().run()
  else if (v === 'title') c.setTitle().run()
  else c.setNode('heading', { level: Number(v.slice(1)), title: false }).run()
}

function ColorButton({ icon, title, value, onPick, onReset }: { icon: string; title: string; value: string; onPick: (c: string) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="tb color-tb" title={title} onMouseDown={e => e.preventDefault()} onClick={() => setOpen(o => !o)}>
        <Icon name={icon} />
        <span className="swatch" style={{ background: value }} />
      </button>
      {open && (
        <div className="color-pop" onMouseDown={e => e.preventDefault()}>
          <button className="color-reset" onClick={() => (onReset(), setOpen(false))}>Reset</button>
          <div className="color-grid">
            {PALETTE.map(c => (
              <button key={c} title={c} style={{ background: c }} className={c === value ? 'on' : ''} onClick={() => (onPick(c), setOpen(false))} />
            ))}
          </div>
          <label className="color-custom">
            Custom <input type="color" defaultValue={value.startsWith('#') ? value : '#000000'} onChange={e => onPick(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  )
}

interface Props {
  editor: Editor
  zoom: number
  setZoom: (z: number) => void
  onLink: () => void
  onImage: () => void
  outlineOpen: boolean
  toggleOutline: () => void
  /** Shown at the right end (the Markdown view-mode switch). */
  extra?: React.ReactNode
}

export function Toolbar({ editor, zoom, setZoom, onLink, onImage, outlineOpen, toggleOutline, extra }: Props) {
  const size = currentSize(editor)
  const [sizeText, setSizeText] = useState(String(size))
  useEffect(() => setSizeText(String(size)), [size])
  const setSize = (n: number) => {
    const v = Math.max(1, Math.min(400, Math.round(n)))
    editor.chain().focus().setFontSize(`${v}pt`).run()
  }
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? SIZES.find(s => s > size) ?? size + 1 : [...SIZES].reverse().find(s => s < size) ?? Math.max(1, size - 1)
    setSize(next)
  }
  const font = String(editor.getAttributes('textStyle').fontFamily || 'Arial').replace(/["']/g, '').split(',')[0]
  const color = String(editor.getAttributes('textStyle').color || '#000000')
  const hl = String(editor.getAttributes('highlight').color || 'transparent')
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => fn(editor.chain().focus()).run()
  const btn = (icon: string, title: string, onClick: () => void, on = false, disabled = false) => (
    <button className={`tb${on ? ' on' : ''}`} title={title} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
  const inTable = editor.isActive('table')
  const inList = editor.isActive('listItem') || editor.isActive('taskItem')
  const listItem = editor.isActive('taskItem') ? 'taskItem' : 'listItem'

  return (
    <div className="toolbar doc-toolbar">
      {btn('outline', outlineOpen ? 'Hide document outline' : 'Show document outline', toggleOutline, outlineOpen)}
      <span className="tb-sep" />
      {btn('undo', 'Undo (Ctrl+Z)', run(c => c.undo()), false, !editor.can().undo())}
      {btn('redo', 'Redo (Ctrl+Y)', run(c => c.redo()), false, !editor.can().redo())}
      <select className="tb-select" title="Zoom" value={zoom} onChange={e => setZoom(Number(e.target.value))}>
        {ZOOMS.map(z => (
          <option key={z} value={z}>{z}%</option>
        ))}
      </select>
      <span className="tb-sep" />
      <select className="tb-select style-select" title="Styles" value={styleOf(editor)} onChange={e => applyStyle(editor, e.target.value)}>
        <option value="p">Normal text</option>
        <option value="title">Title</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
      </select>
      <span className="tb-sep" />
      <select className="tb-select font-select" title="Font" value={FONTS.includes(font) ? font : ''} onChange={e => editor.chain().focus().setFontFamily(e.target.value).run()}>
        {!FONTS.includes(font) && <option value="">{font}</option>}
        {FONTS.map(f => (
          <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
        ))}
      </select>
      <span className="tb-sep" />
      {btn('minus', 'Decrease font size (Ctrl+Shift+,)', () => step(-1))}
      <input
        className="tb-input"
        title="Font size"
        value={sizeText}
        onChange={e => setSizeText(e.target.value.replace(/[^\d.]/g, ''))}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            setSize(Number(sizeText) || size)
          }
        }}
        onBlur={() => setSizeText(String(size))}
      />
      {btn('plus', 'Increase font size (Ctrl+Shift+.)', () => step(1))}
      <span className="tb-sep" />
      {btn('bold', 'Bold (Ctrl+B)', run(c => c.toggleBold()), editor.isActive('bold'))}
      {btn('italic', 'Italic (Ctrl+I)', run(c => c.toggleItalic()), editor.isActive('italic'))}
      {btn('underline', 'Underline (Ctrl+U)', run(c => c.toggleUnderline()), editor.isActive('underline'))}
      <ColorButton icon="color" title="Text color" value={color} onPick={c => editor.chain().focus().setColor(c).run()} onReset={() => editor.chain().focus().unsetColor().run()} />
      <ColorButton icon="highlight" title="Highlight color" value={hl} onPick={c => editor.chain().focus().setHighlight({ color: c }).run()} onReset={() => editor.chain().focus().unsetHighlight().run()} />
      <span className="tb-sep" />
      {btn('link', 'Insert link (Ctrl+K)', onLink, editor.isActive('link'))}
      {btn('image', 'Insert image', onImage)}
      <span className="tb-sep" />
      {btn('alignLeft', 'Left align (Ctrl+Shift+L)', run(c => c.setTextAlign('left')), editor.isActive({ textAlign: 'left' }))}
      {btn('alignCenter', 'Center align (Ctrl+Shift+E)', run(c => c.setTextAlign('center')), editor.isActive({ textAlign: 'center' }))}
      {btn('alignRight', 'Right align (Ctrl+Shift+R)', run(c => c.setTextAlign('right')), editor.isActive({ textAlign: 'right' }))}
      {btn('alignJustify', 'Justify (Ctrl+Shift+J)', run(c => c.setTextAlign('justify')), editor.isActive({ textAlign: 'justify' }))}
      <span className="tb-sep" />
      {btn('checklist', 'Checklist (Ctrl+Shift+9)', run(c => c.toggleTaskList()), editor.isActive('taskList'))}
      {btn('bullets', 'Bulleted list (Ctrl+Shift+8)', run(c => c.toggleBulletList()), editor.isActive('bulletList'))}
      {btn('numbers', 'Numbered list (Ctrl+Shift+7)', run(c => c.toggleOrderedList()), editor.isActive('orderedList'))}
      {btn('outdent', 'Decrease indent (Ctrl+[)', inList ? run(c => c.liftListItem(listItem)) : run(c => c.indent(-1)))}
      {btn('indent', 'Increase indent (Ctrl+])', inList ? run(c => c.sinkListItem(listItem)) : run(c => c.indent(1)))}
      {btn('clear', 'Clear formatting (Ctrl+\\)', run(c => c.unsetAllMarks().setBlockLineHeight(null).unsetTextAlign()))}
      {inTable && (
        <>
          <span className="tb-sep" />
          <span className="tb-label">Table</span>
          <button className="tb text" onClick={run(c => c.addRowBefore())}>+ Row above</button>
          <button className="tb text" onClick={run(c => c.addRowAfter())}>+ Row below</button>
          <button className="tb text" onClick={run(c => c.addColumnBefore())}>+ Col left</button>
          <button className="tb text" onClick={run(c => c.addColumnAfter())}>+ Col right</button>
          <button className="tb text" onClick={run(c => c.deleteRow())}>− Row</button>
          <button className="tb text" onClick={run(c => c.deleteColumn())}>− Col</button>
          <button className="tb text danger" onClick={run(c => c.deleteTable())}>Delete table</button>
        </>
      )}
      {extra && <span className="tb-extra">{extra}</span>}
    </div>
  )
}
