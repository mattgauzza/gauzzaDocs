import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { htmlToMarkdown, markdownToHtml, wrapHtml } from '../../../shared/convert'
import { extOf, stem } from '../../../shared/kinds'
import { countWords } from '../../../shared/ops/doc'
import type { EditorHandle, EditorProps, MenuItem, StatusItem } from '../editor'
import { AgentFlash, FindMatches, findKey } from './extensions'
import { FrontMatter, schemaExtensions } from './schema'
import { MODES, type MdMode, MdReader, MdSource, ModeSwitch, FrontMatterView, type ReaderApi, type SourceApi, loadMode, saveMode } from './MdViews'
import { GAP, PAGE_H, type PageInfo, Pagination, pageAt, setPageless } from './pagination'
import { Icon } from './icons'
import { flash, outline, replaceRanges, runDocOp, searchDoc } from './live'
import { FONTS, Toolbar, ZOOMS, applyStyle, currentSize } from './Toolbar'
import './doc.css'

const PRINT_CSS = `
h1.title { font-size: 26pt; font-weight: 400; margin: 0 0 3pt; }
h1 { font-size: 20pt; font-weight: 400; } h2 { font-size: 16pt; font-weight: 400; } h3 { font-size: 14pt; font-weight: 400; color: #434343; }
ul[data-type="taskList"] { list-style: none; padding-left: 4px; } ul[data-type="taskList"] li { display: flex; gap: 8px; }
.page-break { page-break-after: always; height: 0; }
mark { padding: 0; }
`

// ---------- find & replace bar ----------
function FindBar({ editor, onClose, startReplace }: { editor: Editor; onClose: () => void; startReplace: boolean }) {
  const [q, setQ] = useState(() => {
    const { from, to } = editor.state.selection
    return from !== to ? editor.state.doc.textBetween(from, to).slice(0, 200) : ''
  })
  const [rep, setRep] = useState('')
  const [showRep, setShowRep] = useState(startReplace)
  const [ci, setCi] = useState(true)
  const [cur, setCur] = useState(0)
  const [, tick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const ranges = searchDoc(editor.state.doc, q, { ignoreCase: ci })
  const idx = ranges.length ? Math.min(cur, ranges.length - 1) : 0

  useEffect(() => input.current?.select(), [])
  useEffect(() => {
    const t = () => tick(n => n + 1)
    editor.on('update', t)
    return () => void editor.off('update', t)
  }, [editor])
  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { ranges, current: idx }).setMeta('addToHistory', false))
  })
  useEffect(() => () => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(findKey, { ranges: [], current: -1 }).setMeta('addToHistory', false))
  }, [])

  const go = (dir: 1 | -1) => {
    if (!ranges.length) return
    const n = (idx + dir + ranges.length) % ranges.length
    setCur(n)
    const [a, b] = ranges[n]
    editor.commands.setTextSelection({ from: a, to: b })
    editor.commands.scrollIntoView()
  }
  const replaceOne = () => {
    if (!ranges.length) return
    replaceRanges(editor, [ranges[idx]], () => rep)
  }
  const replaceAll = () => replaceRanges(editor, ranges, () => rep)

  return (
    <div className="doc-find" onKeyDown={e => e.key === 'Escape' && (e.preventDefault(), onClose())}>
      <div className="doc-find-row">
        <input
          ref={input}
          placeholder="Find in document"
          value={q}
          onChange={e => (setQ(e.target.value), setCur(0))}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), go(e.shiftKey ? -1 : 1))}
        />
        <span className="doc-find-count">{q ? (ranges.length ? `${idx + 1} of ${ranges.length}` : '0 of 0') : ''}</span>
        <button className="tb" title="Previous (Shift+Enter)" onClick={() => go(-1)}><Icon name="up" /></button>
        <button className="tb" title="Next (Enter)" onClick={() => go(1)}><Icon name="down" /></button>
        <button className={`tb text${ci ? '' : ' on'}`} title="Match case" onClick={() => setCi(v => !v)}>Aa</button>
        <button className={`tb text${showRep ? ' on' : ''}`} title="Replace" onClick={() => setShowRep(v => !v)}>Replace</button>
        <button className="tb" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      {showRep && (
        <div className="doc-find-row">
          <input placeholder="Replace with" value={rep} onChange={e => setRep(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), replaceOne())} />
          <button className="tb text" onClick={replaceOne} disabled={!ranges.length}>Replace</button>
          <button className="tb text" onClick={replaceAll} disabled={!ranges.length}>Replace all</button>
        </div>
      )}
    </div>
  )
}

// ---------- link popover ----------
function LinkBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [href, setHref] = useState(String(editor.getAttributes('link').href || ''))
  const [text, setText] = useState(() => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to)
  })
  const hadSelection = !editor.state.selection.empty
  const apply = () => {
    const url = href.trim()
    if (!url) return onClose()
    const full = /^[a-z][\w+.-]*:/i.test(url) || url.startsWith('#') ? url : `https://${url}`
    const c = editor.chain().focus().extendMarkRange('link')
    if (!hadSelection && !editor.isActive('link')) c.insertContent({ type: 'text', text: text || url, marks: [{ type: 'link', attrs: { href: full } }] }).run()
    else c.setLink({ href: full }).run()
    onClose()
  }
  return (
    <div className="doc-pop link-pop" onKeyDown={e => e.key === 'Escape' && onClose()}>
      {!hadSelection && !editor.isActive('link') && <input placeholder="Text" value={text} onChange={e => setText(e.target.value)} />}
      <input autoFocus placeholder="Paste a link" value={href} onChange={e => setHref(e.target.value)} onKeyDown={e => e.key === 'Enter' && apply()} />
      <button className="btn-primary" onClick={apply}>Apply</button>
      {editor.isActive('link') && (
        <button className="tb text" onClick={() => (editor.chain().focus().extendMarkRange('link').unsetLink().run(), onClose())}>Remove</button>
      )}
    </div>
  )
}

// ---------- word count ----------
function WordCount({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { from, to, empty } = editor.state.selection
  const all = editor.getText({ blockSeparator: '\n' })
  const sel = empty ? '' : editor.state.doc.textBetween(from, to, '\n')
  const rows = (t: string) => [
    ['Pages', String(Math.max(1, Math.ceil(countWords(t) / 500)))],
    ['Words', countWords(t).toLocaleString()],
    ['Characters', t.length.toLocaleString()],
    ['Characters excluding spaces', t.replace(/\s/g, '').length.toLocaleString()]
  ]
  return (
    <div className="doc-modal-back" onMouseDown={onClose}>
      <div className="doc-modal" onMouseDown={e => e.stopPropagation()}>
        <h3>Word count</h3>
        <table>
          <tbody>
            {rows(all).map(([k, v], i) => (
              <tr key={k}>
                <td>{k}</td>
                {!empty && <td className="num">{rows(sel)[i][1]}</td>}
                <td className="num">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!empty && <p className="muted small">Selection, then whole document.</p>}
        <div className="doc-modal-actions">
          <button className="btn-primary" autoFocus onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  )
}

export default function DocEditor(props: EditorProps) {
  const isMd = ['md', 'markdown'].includes(extOf(props.path))
  const [zoom, setZoom] = useState(100)
  const [find, setFind] = useState<null | 'find' | 'replace'>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [wc, setWc] = useState(false)
  const [heads, setHeads] = useState<{ level: number; text: string; pos: number }[]>([])
  const [outlineOpen, setOutlineOpen] = useState<boolean | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange

  // ---------- Markdown view modes: Edit (rich), Read, Split (source | rendered), Source ----------
  // The rich editor stays the one document underneath (agents, saving, undo in Edit); the other modes show its
  // Markdown. Source edits flow into it shortly after typing pauses, and its changes (an agent's) flow back.
  const [mode, setModeState] = useState<MdMode>(() => (isMd ? loadMode(props.path) : 'edit'))
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [mdText, setMdText] = useState('')
  const sourceRef = useRef<SourceApi>(null)
  const readerRef = useRef<ReaderApi>(null)
  const fromSource = useRef(false)
  const sourceTimer = useRef(0)
  const pendingSource = useRef<string | null>(null)
  const regenTimer = useRef(0)
  const previewTimer = useRef(0)

  // Status bar counts: recomputed shortly after typing stops; the selection count follows the cursor.
  const [stats, setStats] = useState({ words: 0, chars: 0, charsNoSpaces: 0, paras: 0, tables: 0, images: 0 })
  const [sel, setSel] = useState({ words: 0, chars: 0, pos: 0 })
  // Pages as laid out on screen (see pagination.ts), and whether pages are drawn at all.
  const [pageInfo, setPageInfo] = useState<PageInfo>({ pages: 1, breaks: [] })
  const [pageless, setPagelessState] = useState(() => {
    try {
      return localStorage.getItem('docPageless') === '1'
    } catch {
      return false
    }
  })
  const setPagelessPref = (on: boolean) => {
    setPagelessState(on)
    try {
      localStorage.setItem('docPageless', on ? '1' : '0')
    } catch { /* storage off */ }
  }
  const statsTimer = useRef(0)
  const statusItems = useRef<StatusItem[]>([])
  const measure = (e: { state: { doc: any } }) => {
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => {
      const doc = e.state.doc
      const text: string = doc.textBetween(0, doc.content.size, '\n', ' ')
      let paras = 0
      let tables = 0
      let images = 0
      doc.descendants((n: any) => {
        if (n.type.name === 'paragraph' && n.content.size) paras++
        else if (n.type.name === 'table') tables++
        else if (n.type.name === 'image') images++
        return true
      })
      setStats({ words: countWords(text), chars: text.replace(/\n/g, '').length, charsNoSpaces: text.replace(/\s/g, '').length, paras, tables, images })
    }, 250)
  }

  const editor = useEditor({
    extensions: [
      ...schemaExtensions().map(e => (e === FrontMatter ? FrontMatterView : e)),
      Placeholder.configure({ placeholder: 'Type here, or ask an agent: gdocs append <file> --md "..."' }),
      AgentFlash,
      FindMatches,
      Pagination.configure({ onPages: info => setPageInfo(info) })
    ],
    content: props.payload.kind === 'doc' ? props.payload.html : '',
    shouldRerenderOnTransaction: true,
    immediatelyRender: true,
    onCreate: ({ editor: e }) => measure(e),
    onSelectionUpdate: ({ editor: e }) => {
      const { from, to } = e.state.selection
      const t = from === to ? '' : e.state.doc.textBetween(from, to, ' ', ' ')
      setSel({ words: t ? countWords(t) : 0, chars: t.length, pos: from })
    },
    onUpdate: ({ editor: e }) => {
      measure(e)
      onChange.current()
      setHeads(outline(e.state.doc))
      if (modeRef.current !== 'edit' && !fromSource.current) {
        window.clearTimeout(regenTimer.current)
        regenTimer.current = window.setTimeout(() => {
          const text = htmlToMarkdown(e.getHTML())
          setMdText(text)
          sourceRef.current?.setText(text)
        }, 120)
      }
    },
    editorProps: { attributes: { spellcheck: 'true', class: 'doc-prose' } }
  })

  useEffect(() => {
    if (editor) setHeads(outline(editor.state.doc))
    if (editor && modeRef.current !== 'edit') setMdText(htmlToMarkdown(editor.getHTML()))
  }, [editor])

  /** Pushes typed Markdown into the document now (before a save or an agent op) instead of after the pause. */
  const flushSource = () => {
    window.clearTimeout(sourceTimer.current)
    const text = pendingSource.current
    pendingSource.current = null
    if (text === null || !editor || editor.isDestroyed) return
    fromSource.current = true
    try {
      editor.commands.setContent(markdownToHtml(text), { emitUpdate: true })
    } finally {
      fromSource.current = false
    }
  }
  const onSourceChange = (text: string) => {
    pendingSource.current = text
    window.clearTimeout(sourceTimer.current)
    sourceTimer.current = window.setTimeout(flushSource, 300)
    window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => setMdText(text), 120)
  }
  const setMode = (m: MdMode) => {
    if (!isMd || !editor || m === modeRef.current) return
    flushSource()
    setMdText(htmlToMarkdown(editor.getHTML()))
    setModeState(m)
    saveMode(props.path, m)
    if (m === 'edit') requestAnimationFrame(() => {
      // Pages were measured while hidden; measure again now they are visible.
      try {
        if (!editor.isDestroyed) setPageless(editor.view, pageless)
      } catch { /* not mounted */ }
    })
  }
  const live = useRef({ setMode, flushSource })
  live.current = { setMode, flushSource }
  /** Source lines (0-based) of the Markdown headings, in order, for the outline in Source mode. */
  const headingLines = (text: string) => {
    const out: number[] = []
    let fence = false
    text.split('\n').forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence
      else if (!fence && /^#{1,6}\s/.test(l)) out.push(i)
    })
    return out
  }
  const showOutline = outlineOpen ?? heads.length > 1

  const pickImage = () => fileInput.current?.click()
  const onImageFile = (f: File | undefined) => {
    if (!f || !editor) return
    const r = new FileReader()
    r.onload = () => editor.chain().focus().setImage({ src: String(r.result), alt: f.name }).run()
    r.readAsDataURL(f)
  }
  const insertTable = (rows: number, cols: number) => editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()

  // Google Docs shortcuts StarterKit does not already cover.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editor || modeRef.current !== 'edit') return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && !e.shiftKey && !e.altKey && k === 'k') return e.preventDefault(), setLinkOpen(true)
    if (mod && !e.altKey && k === 'f') return e.preventDefault(), setFind('find')
    if (mod && !e.altKey && k === 'h') return e.preventDefault(), setFind('replace')
    if (mod && e.key === '\\') return e.preventDefault(), editor.chain().focus().unsetAllMarks().run()
    if (mod && e.shiftKey && k === 'c') return e.preventDefault(), setWc(true)
    if (mod && e.altKey && k === '0') return e.preventDefault(), applyStyle(editor, 'p')
    if (mod && e.shiftKey && (e.key === '>' || e.key === '.')) {
      e.preventDefault()
      editor.chain().focus().setFontSize(`${currentSize(editor) + 1}pt`).run()
    }
    if (mod && e.shiftKey && (e.key === '<' || e.key === ',')) {
      e.preventDefault()
      editor.chain().focus().setFontSize(`${Math.max(1, currentSize(editor) - 1)}pt`).run()
    }
    if (mod && !e.shiftKey && (e.key === ']' || e.key === '[')) {
      e.preventDefault()
      const d = e.key === ']' ? 1 : -1
      const li = editor.isActive('taskItem') ? 'taskItem' : 'listItem'
      if (editor.isActive(li)) (d > 0 ? editor.chain().focus().sinkListItem(li) : editor.chain().focus().liftListItem(li)).run()
      else editor.chain().focus().indent(d).run()
    }
  }

  // ---------- handle for the shell ----------
  const title = stem(props.path)
  useEffect(() => {
    if (!editor) return
    const handle: EditorHandle = {
      language: isMd ? 'markdown' : 'html',
      status: () => statusItems.current,
      getPayload: () => (live.current.flushSource(), { kind: 'doc', html: editor.getHTML() }),
      getPrintHtml: () => wrapHtml(editor.getHTML(), title).replace('</style>', `${PRINT_CSS}</style>`),
      agent: async op => (live.current.flushSource(), runDocOp(editor, op)),
      getText: () => (isMd ? htmlToMarkdown(editor.getHTML()) : editor.getHTML()),
      setText: text => {
        const html = text.trimStart().startsWith('<') ? text : markdownToHtml(text)
        editor.chain().setContent(html, { emitUpdate: true }).run()
      },
      getSelection: () => {
        const { from, to } = editor.state.selection
        return editor.state.doc.textBetween(from, to, '\n')
      },
      replaceSelection: text => {
        const { from } = editor.state.selection
        editor.chain().focus().insertContent(text).run()
        flash(editor, from, editor.state.selection.to)
      },
      focus: () => editor.commands.focus(),
      command: id => {
        const m = modeRef.current
        if ((m === 'source' || m === 'split') && sourceRef.current && ['undo', 'redo', 'find', 'replace'].includes(id)) {
          const s = sourceRef.current
          return void (id === 'undo' ? s.undo() : id === 'redo' ? s.redo() : s.find())
        }
        const c = editor.chain().focus()
        if (id === 'undo') c.undo().run()
        else if (id === 'redo') c.redo().run()
        else if (id === 'find') setFind('find')
        else if (id === 'replace') setFind('replace')
        else if (id === 'selectAll') c.selectAll().run()
        else if (id === 'cut' || id === 'copy' || id === 'paste') document.execCommand(id)
      },
      menus: () => {
        const r = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => fn(editor.chain().focus()).run()
        const tableSizes: MenuItem[] = [
          [2, 2], [3, 3], [4, 3], [4, 4], [5, 5], [8, 4]
        ].map(([rr, cc]) => ({ label: `${cc} × ${rr}`, run: () => insertTable(rr, cc) }))
        const insert: MenuItem[] = [
          { label: 'Image…', run: pickImage },
          { label: 'Table', submenu: tableSizes },
          { label: 'Link', shortcut: 'Ctrl+K', run: () => setLinkOpen(true) },
          { sep: true, label: '' },
          { label: 'Horizontal line', run: r(c => c.setHorizontalRule()) },
          { label: 'Page break', shortcut: 'Ctrl+Enter', run: r(c => c.setPageBreak()) },
          { label: 'Checklist', shortcut: 'Ctrl+Shift+9', run: r(c => c.toggleTaskList()) },
          { label: 'Quote', run: r(c => c.toggleBlockquote()) },
          { label: 'Code block', run: r(c => c.toggleCodeBlock()) },
          { label: 'Date', run: r(c => c.insertContent(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))) }
        ]
        const inTable = editor.isActive('table')
        const format: MenuItem[] = [
          {
            label: 'Text',
            submenu: [
              { label: 'Bold', shortcut: 'Ctrl+B', checked: editor.isActive('bold'), run: r(c => c.toggleBold()) },
              { label: 'Italic', shortcut: 'Ctrl+I', checked: editor.isActive('italic'), run: r(c => c.toggleItalic()) },
              { label: 'Underline', shortcut: 'Ctrl+U', checked: editor.isActive('underline'), run: r(c => c.toggleUnderline()) },
              { label: 'Strikethrough', shortcut: 'Ctrl+Shift+S', checked: editor.isActive('strike'), run: r(c => c.toggleStrike()) },
              { label: 'Code', shortcut: 'Ctrl+E', checked: editor.isActive('code'), run: r(c => c.toggleCode()) }
            ]
          },
          {
            label: 'Paragraph styles',
            submenu: [
              { label: 'Normal text', shortcut: 'Ctrl+Alt+0', run: () => applyStyle(editor, 'p') },
              { label: 'Title', run: () => applyStyle(editor, 'title') },
              { label: 'Heading 1', shortcut: 'Ctrl+Alt+1', run: () => applyStyle(editor, 'h1') },
              { label: 'Heading 2', shortcut: 'Ctrl+Alt+2', run: () => applyStyle(editor, 'h2') },
              { label: 'Heading 3', shortcut: 'Ctrl+Alt+3', run: () => applyStyle(editor, 'h3') }
            ]
          },
          {
            label: 'Align & indent',
            submenu: [
              { label: 'Left', shortcut: 'Ctrl+Shift+L', run: r(c => c.setTextAlign('left')) },
              { label: 'Center', shortcut: 'Ctrl+Shift+E', run: r(c => c.setTextAlign('center')) },
              { label: 'Right', shortcut: 'Ctrl+Shift+R', run: r(c => c.setTextAlign('right')) },
              { label: 'Justified', shortcut: 'Ctrl+Shift+J', run: r(c => c.setTextAlign('justify')) },
              { sep: true, label: '' },
              { label: 'Increase indent', shortcut: 'Ctrl+]', run: r(c => c.indent(1)) },
              { label: 'Decrease indent', shortcut: 'Ctrl+[', run: r(c => c.indent(-1)) }
            ]
          },
          {
            label: 'Line & paragraph spacing',
            submenu: [
              ['Single', '1'], ['1.15', '1.15'], ['1.5', '1.5'], ['Double', '2']
            ].map(([label, v]) => ({ label, run: r(c => c.setBlockLineHeight(v)) }))
          },
          {
            label: 'Bullets & numbering',
            submenu: [
              { label: 'Bulleted list', shortcut: 'Ctrl+Shift+8', run: r(c => c.toggleBulletList()) },
              { label: 'Numbered list', shortcut: 'Ctrl+Shift+7', run: r(c => c.toggleOrderedList()) },
              { label: 'Checklist', shortcut: 'Ctrl+Shift+9', run: r(c => c.toggleTaskList()) }
            ]
          },
          {
            label: 'Table',
            disabled: !inTable,
            submenu: [
              { label: 'Insert row above', run: r(c => c.addRowBefore()) },
              { label: 'Insert row below', run: r(c => c.addRowAfter()) },
              { label: 'Insert column left', run: r(c => c.addColumnBefore()) },
              { label: 'Insert column right', run: r(c => c.addColumnAfter()) },
              { sep: true, label: '' },
              { label: 'Delete row', run: r(c => c.deleteRow()) },
              { label: 'Delete column', run: r(c => c.deleteColumn()) },
              { label: 'Delete table', run: r(c => c.deleteTable()) }
            ]
          },
          { sep: true, label: '' },
          { label: 'Clear formatting', shortcut: 'Ctrl+\\', run: r(c => c.unsetAllMarks().setBlockLineHeight(null).unsetTextAlign()) }
        ]
        const view: MenuItem[] = [
          ...(isMd
            ? [...MODES.map(md => ({ label: `${md.label === 'Read' ? 'Reading' : md.label} view`, checked: modeRef.current === md.id, run: () => live.current.setMode(md.id) })), { sep: true, label: '' }]
            : []),
          { label: 'Show outline', checked: showOutline, run: () => setOutlineOpen(!showOutline) },
          { label: 'Zoom', submenu: ZOOMS.map(z => ({ label: `${z}%`, checked: z === zoom, run: () => setZoom(z) })) },
          { label: 'Pageless', checked: pageless, run: () => setPagelessPref(!pageless) }
        ]
        const tools: MenuItem[] = [{ label: 'Word count', shortcut: 'Ctrl+Shift+C', run: () => setWc(true) }]
        return { Insert: insert, Format: format, View: view, Tools: tools }
      }
    }
    props.setHandle(handle)
  }, [editor, zoom, showOutline, title, pageless, mode])
  // Pages on or off (View → Pageless), remembered across files and sessions.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    try {
      setPageless(editor.view, pageless)
    } catch { /* view not mounted yet; the next effect run applies it */ }
  }, [editor, pageless])
  useEffect(() => () => props.setHandle(null), [])
  useEffect(() => {
    // After mount (the view may not exist yet), and never on an editor React has already torn down.
    if (!props.active || !editor || find) return
    const r = requestAnimationFrame(() => {
      try {
        if (modeRef.current === 'source' || modeRef.current === 'split') sourceRef.current?.focus()
        else if (modeRef.current === 'edit' && !editor.isDestroyed) editor.commands.focus()
      } catch { /* not mounted yet */ }
    })
    return () => cancelAnimationFrame(r)
  }, [props.active, editor, mode])

  const fontList = useMemo(() => FONTS, [])
  void fontList
  const n = (x: number) => x.toLocaleString()
  const mins = Math.max(1, Math.round(stats.words / 238))
  const modeLabel = { edit: 'Editing', read: 'Reading', split: 'Split view', source: 'Markdown source' }[mode]
  statusItems.current = [
    ...(isMd ? [{ text: modeLabel, title: 'Markdown view: click to switch (Edit, Read, Split, Source)', run: () => setMode(MODES[(MODES.findIndex(m => m.id === mode) + 1) % MODES.length].id) }] : []),
    ...(sel.chars ? [{ text: `${n(sel.words)} of ${n(stats.words)} words`, title: `${n(sel.chars)} characters selected` }] : [{ text: `${n(stats.words)} words` }]),
    { text: `${n(stats.chars)} characters`, title: `${n(stats.charsNoSpaces)} without spaces` },
    { text: `${n(stats.paras)} ${stats.paras === 1 ? 'paragraph' : 'paragraphs'}` },
    pageless
      ? { text: `~${Math.max(1, Math.ceil(stats.words / 500))} ${stats.words > 500 ? 'pages' : 'page'}`, title: 'Pageless view; at about 500 words a page', run: () => setPagelessPref(false) }
      : { text: `Page ${pageAt(pageInfo.breaks, sel.pos)} of ${pageInfo.pages}`, title: 'Letter, 1in margins. View → Pageless to turn pages off', run: () => setPagelessPref(true) },
    { text: `${mins} min read` },
    ...(heads.length ? [{ text: `${heads.length} ${heads.length > 1 ? 'headings' : 'heading'}`, title: 'Show the outline', run: () => setOutlineOpen(true) }] : []),
    ...(stats.tables ? [{ text: `${stats.tables} ${stats.tables > 1 ? 'tables' : 'table'}` }] : []),
    ...(stats.images ? [{ text: `${stats.images} ${stats.images > 1 ? 'images' : 'image'}` }] : []),
    { text: `${zoom}%`, title: 'Zoom' }
  ]

  if (!editor) return null

  return (
    <div className={`doc-editor md-mode-${mode}`} onKeyDown={onKeyDown}>
      {mode === 'edit' ? (
        <Toolbar
          editor={editor}
          zoom={zoom}
          setZoom={setZoom}
          onLink={() => setLinkOpen(true)}
          onImage={pickImage}
          outlineOpen={showOutline}
          toggleOutline={() => setOutlineOpen(!showOutline)}
          extra={isMd ? <ModeSwitch mode={mode} onMode={setMode} /> : undefined}
        />
      ) : (
        <div className="toolbar doc-toolbar md-bar">
          <button className={`tb${showOutline ? ' on' : ''}`} title={showOutline ? 'Hide outline' : 'Show outline'} onClick={() => setOutlineOpen(!showOutline)}><Icon name="outline" /></button>
          <span className="md-bar-title">{mode === 'read' ? 'Reading view' : mode === 'split' ? 'Markdown, rendered live on the right' : 'Markdown source'}</span>
          <span className="grow" />
          <ModeSwitch mode={mode} onMode={setMode} />
        </div>
      )}
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={e => (onImageFile(e.target.files?.[0]), (e.target.value = ''))} />
      <div className="doc-body">
        {showOutline && (
          <aside className="doc-outline">
            <div className="doc-outline-head">
              <span>Outline</span>
              <button className="tb" title="Close outline" onClick={() => setOutlineOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            {heads.length === 0 && <p className="muted small">Headings you add to the document will appear here.</p>}
            {heads.map((h, i) => (
              <button
                key={i}
                className={`doc-outline-item l${h.level}`}
                title={h.text}
                onClick={() => {
                  if (mode === 'read' || mode === 'split') return readerRef.current?.scrollToHeading(i)
                  if (mode === 'source') return sourceRef.current?.scrollToLine(headingLines(sourceRef.current.getText())[i] ?? 0)
                  editor.chain().focus().setTextSelection(h.pos + 1).run()
                  const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
                  dom?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                }}
              >
                {h.text}
              </button>
            ))}
          </aside>
        )}
        <div className="doc-canvas" style={mode === 'edit' ? undefined : { display: 'none' }}>
          {(find || linkOpen) && (
            <div className="doc-floating">
              {find && <FindBar key={find} editor={editor} startReplace={find === 'replace'} onClose={() => (setFind(null), editor.commands.focus())} />}
              {linkOpen && <LinkBar editor={editor} onClose={() => setLinkOpen(false)} />}
            </div>
          )}
          <div
            className={`doc-page${pageless ? '' : ' paged'}`}
            style={{ zoom: zoom / 100, ...(pageless ? {} : { minHeight: pageInfo.pages * PAGE_H + (pageInfo.pages - 1) * GAP }) }}
            onMouseDown={e => {
            // Clicks in the page margins put the cursor in the text, as in Google Docs.
            if (e.target === e.currentTarget) {
              e.preventDefault()
              editor.commands.focus('end')
            }
          }}>
            <EditorContent editor={editor} />
          </div>
        </div>
        {mode === 'read' && <MdReader ref={readerRef} markdown={mdText} zoom={zoom} />}
        {mode === 'split' && (
          <div className="md-split">
            <MdSource ref={sourceRef} initial={mdText} onChange={onSourceChange} onTopLine={line => readerRef.current?.scrollToLine(line)} />
            <MdReader ref={readerRef} markdown={mdText} wide />
          </div>
        )}
        {mode === 'source' && <MdSource ref={sourceRef} initial={mdText} onChange={onSourceChange} />}
      </div>
      {wc && <WordCount editor={editor} onClose={() => setWc(false)} />}
    </div>
  )
}
