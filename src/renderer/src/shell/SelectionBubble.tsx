import './selection.css'
import { useEffect, useRef, useState } from 'react'

/**
 * The "add comment" button that appears in the margin beside selected text, like Google Docs. Works in documents
 * (ProseMirror) and the code editor (CodeMirror). Pressing it does what Ctrl+Alt+M does: opens the comments panel
 * with the selection quoted.
 */
export function SelectionBubble({ enabled, onComment }: { enabled: boolean; onComment(): void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const frame = useRef(0)

  useEffect(() => {
    if (!enabled) return setPos(null)
    const measure = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return setPos(null)
        const node = sel.anchorNode
        const el = (node?.nodeType === 1 ? node : node?.parentElement) as HTMLElement | null
        const editorRoot = el?.closest('.ProseMirror, .cm-content') as HTMLElement | null
        const host = editorRoot?.closest('.editor-host') as HTMLElement | null
        if (!editorRoot || !host || host.style.display === 'none') return setPos(null)
        const r = sel.getRangeAt(0).getBoundingClientRect()
        if (!r.width && !r.height) return setPos(null)
        const box = host.getBoundingClientRect()
        // Documents: just outside the page's right edge. Code: inside the editor's right edge.
        const page = editorRoot.closest('.doc-page') as HTMLElement | null
        const right = page ? page.getBoundingClientRect().right + 10 : (editorRoot.closest('.cm-scroller') as HTMLElement | null)?.getBoundingClientRect().right ?? box.right
        const x = Math.min(page ? right : right - 46, box.right - 46)
        const y = Math.max(box.top + 4, Math.min(r.top - 4, box.bottom - 44))
        if (r.bottom < box.top || r.top > box.bottom) return setPos(null)
        setPos({ x, y })
      })
    }
    document.addEventListener('selectionchange', measure)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    measure()
    return () => {
      cancelAnimationFrame(frame.current)
      document.removeEventListener('selectionchange', measure)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [enabled])

  if (!pos) return null
  return (
    <button
      className="sel-bubble"
      style={{ left: pos.x, top: pos.y }}
      title="Add a comment (Ctrl+Alt+M)"
      // Keep the editor's selection: a mousedown on a button would otherwise clear it.
      onMouseDown={e => e.preventDefault()}
      onClick={onComment}
    >
      <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M22 4c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4zm-5 7h-4v4h-2v-4H7V9h4V5h2v4h4v2z" />
      </svg>
    </button>
  )
}
