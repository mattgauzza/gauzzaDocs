import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

/** The text position beside a point in the page margin: same height, pulled sideways into the text column. */
export function posBeside(editor: Editor, x: number, y: number): number | null {
  const r = editor.view.dom.getBoundingClientRect()
  if (!r.width || !r.height) return null
  const left = Math.min(Math.max(x, r.left + 2), r.right - 2)
  const top = Math.min(Math.max(y, r.top + 2), r.bottom - 2)
  return editor.view.posAtCoords({ left, top })?.pos ?? null
}

/**
 * A press in the page margin, as in Google Docs: the cursor goes on the line beside it (Shift extends the
 * selection) and dragging selects whole stretches of lines. Nothing scrolls, since the line is right there.
 */
export function marginPress(editor: Editor, e: { clientX: number; clientY: number; shiftKey: boolean }) {
  const view = editor.view
  const at = posBeside(editor, e.clientX, e.clientY)
  if (at == null) return
  const anchor = e.shiftKey ? view.state.selection.anchor : at
  const select = (head: number) => {
    const { doc } = view.state
    const a = Math.min(anchor, doc.content.size)
    view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(a), doc.resolve(Math.min(head, doc.content.size)))))
  }
  select(at)
  view.focus()
  const move = (ev: MouseEvent) => {
    const p = posBeside(editor, ev.clientX, ev.clientY)
    if (p != null) select(p)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
