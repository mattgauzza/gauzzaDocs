import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from '@codemirror/language'
import { FrontMatter } from './schema'
import { propertiesHtml, renderMarkdown } from './markdown'

export type MdMode = 'edit' | 'read' | 'split' | 'source'
export const MODES: { id: MdMode; label: string; title: string }[] = [
  { id: 'edit', label: 'Edit', title: 'Rich editing, like Google Docs' },
  { id: 'read', label: 'Read', title: 'Clean reading view (GitHub style)' },
  { id: 'split', label: 'Split', title: 'Markdown source beside the rendered page' },
  { id: 'source', label: 'Source', title: 'The Markdown text itself' }
]

/** Remembered per file, so a README you read stays in reading view next time. */
const modeKey = (path: string) => `mdMode:${path.toLowerCase()}`
export function loadMode(path: string): MdMode {
  try {
    const v = localStorage.getItem(modeKey(path)) as MdMode | null
    return v && MODES.some(m => m.id === v) ? v : 'edit'
  } catch {
    return 'edit'
  }
}
export function saveMode(path: string, mode: MdMode) {
  try {
    localStorage.setItem(modeKey(path), mode)
  } catch { /* storage off */ }
}

export function ModeSwitch({ mode, onMode }: { mode: MdMode; onMode(m: MdMode): void }) {
  return (
    <span className="md-modes" role="tablist" aria-label="Markdown view">
      {MODES.map(m => (
        <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} title={m.title} onMouseDown={e => e.preventDefault()} onClick={() => onMode(m.id)}>
          {m.label}
        </button>
      ))}
    </span>
  )
}

// ---------- front matter in the rich editor: a read-only "Properties" block ----------

export const FrontMatterView = FrontMatter.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'md-fm'
      dom.contentEditable = 'false'
      dom.innerHTML = propertiesHtml(String(node.attrs.yaml || ''))
      dom.title = 'Front matter: edit it in Source or Split view'
      return { dom, ignoreMutation: () => true, stopEvent: e => e.type === 'click' || e.type === 'mousedown' }
    }
  }
})

// ---------- Source: CodeMirror with Markdown highlighting ----------

const isDark = () => {
  const t = document.documentElement.dataset.theme
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

export interface SourceApi {
  getText(): string
  /** Replaces the text from outside (an agent edited the document), keeping the cursor near where it was. */
  setText(text: string): void
  undo(): void
  redo(): void
  find(): void
  focus(): void
  scrollToLine(line: number): void
}

export const MdSource = forwardRef<SourceApi, { initial: string; onChange(text: string): void; onTopLine?(line: number): void; fontSize?: number }>(
  function MdSource(props, ref) {
    const host = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    const external = useRef(false)
    const cb = useRef(props)
    cb.current = props

    useEffect(() => {
      const theme = new Compartment()
      const v = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: props.initial,
          extensions: [
            lineNumbers(),
            foldGutter(),
            history(),
            highlightActiveLine(),
            bracketMatching(),
            search({ top: true }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            theme.of(isDark() ? oneDark : []),
            EditorView.theme({
              '&': { height: '100%', fontSize: `${props.fontSize || 14}px`, backgroundColor: 'var(--surface)' },
              '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
              '.cm-gutters': { backgroundColor: 'var(--surface)', borderRight: '1px solid var(--line-soft)', color: 'var(--muted)' },
              '.cm-content': { padding: '12px 0' }
            }),
            EditorView.updateListener.of(u => {
              if (u.docChanged && !external.current) cb.current.onChange(u.state.doc.toString())
            }),
            EditorView.domEventHandlers({
              scroll: (_e, vw) => {
                const top = vw.lineBlockAtHeight(vw.scrollDOM.scrollTop)
                cb.current.onTopLine?.(vw.state.doc.lineAt(top.from).number - 1)
              }
            })
          ]
        })
      })
      view.current = v
      const retheme = () => v.dispatch({ effects: theme.reconfigure(isDark() ? oneDark : []) })
      const mq = matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', retheme)
      const mo = new MutationObserver(retheme)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      return () => {
        mq.removeEventListener('change', retheme)
        mo.disconnect()
        v.destroy()
        view.current = null
      }
    }, [])

    useImperativeHandle(ref, () => ({
      getText: () => view.current?.state.doc.toString() ?? '',
      setText: text => {
        const v = view.current
        if (!v) return
        const cur = v.state.doc.toString()
        if (cur === text) return
        // Minimal change (common prefix/suffix) so the cursor and scroll stay put.
        let a = 0
        while (a < cur.length && a < text.length && cur[a] === text[a]) a++
        let b = 0
        while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++
        external.current = true
        try {
          v.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) } })
        } finally {
          external.current = false
        }
      },
      undo: () => view.current && undo(view.current),
      redo: () => view.current && redo(view.current),
      find: () => view.current && openSearchPanel(view.current),
      focus: () => view.current?.focus(),
      scrollToLine: line => {
        const v = view.current
        if (!v) return
        const pos = v.state.doc.line(Math.max(1, Math.min(line + 1, v.state.doc.lines))).from
        v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
        v.focus()
      }
    }))

    return <div className="md-source" ref={host} />
  }
)

// ---------- Reading: rendered Markdown ----------

export interface ReaderApi {
  /** Scrolls so the block holding this source line (0-based) is at the top. */
  scrollToLine(line: number, smooth?: boolean): void
  scrollToHeading(index: number): void
}

export const MdReader = forwardRef<ReaderApi, { markdown: string; wide?: boolean; zoom?: number }>(function MdReader(props, ref) {
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (body.current) body.current.innerHTML = renderMarkdown(props.markdown)
  }, [props.markdown])

  useImperativeHandle(ref, () => ({
    scrollToLine: (line, smooth) => {
      const el = box.current
      if (!el || !body.current) return
      const blocks = Array.from(body.current.querySelectorAll<HTMLElement>('.md-block'))
      let target: HTMLElement | null = null
      for (const b of blocks) {
        if (Number(b.dataset.line) <= line) target = b
        else break
      }
      el.scrollTo({ top: target ? target.offsetTop - 16 : 0, behavior: smooth ? 'smooth' : 'auto' })
    },
    scrollToHeading: i => {
      const h = body.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[i]
      if (h && box.current) box.current.scrollTo({ top: h.offsetTop - 16, behavior: 'smooth' })
    }
  }))

  // In-page anchors scroll the reader; other links open in the browser (the app routes them there).
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (href.startsWith('#')) {
      e.preventDefault()
      const t = body.current?.querySelector<HTMLElement>(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
      if (t && box.current) box.current.scrollTo({ top: t.offsetTop - 16, behavior: 'smooth' })
    } else if (!/^https?:|^mailto:/i.test(href)) e.preventDefault() // relative file links: nothing to open them in yet
  }

  return (
    <div className="md-reader-scroll" ref={box} onClick={onClick}>
      <article className={`md-reader${props.wide ? ' wide' : ''}`} ref={body} style={props.zoom && props.zoom !== 100 ? { zoom: props.zoom / 100 } : undefined} />
    </div>
  )
})
