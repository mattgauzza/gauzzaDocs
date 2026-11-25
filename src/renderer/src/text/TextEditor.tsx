import { useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { copyLineDown, indentWithTab, redo, selectAll, toggleComment, undo } from '@codemirror/commands'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { baseName, extOf, languageOf } from '../../../shared/kinds'
import { applyTextOp } from '../../../shared/ops/text'
import type { EditorHandle, EditorProps, MenuItem, StatusItem } from '../editor'
import { countWords } from '../../../shared/ops/doc'
import { focusThread, useQuotedThreads } from '../shell/Comments'
import './text.css'

const BIG = 5 * 1024 * 1024 // above this, skip syntax highlighting so huge logs stay fast

// ---------- agent flash: a short-lived highlight on lines an agent changed ----------
const flashEffect = StateEffect.define<{ from: number; to: number } | null>()
const flashMark = Decoration.line({ class: 'cm-agent-flash' })
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue
      if (!e.value) return Decoration.none
      const doc = tr.state.doc
      const a = doc.lineAt(Math.min(e.value.from, doc.length)).number
      const b = doc.lineAt(Math.min(e.value.to, doc.length)).number
      const ranges = []
      for (let n = a; n <= Math.min(b, a + 2000); n++) ranges.push(flashMark.range(doc.line(n).from))
      deco = Decoration.set(ranges)
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f)
})

// ---------- comment highlights: the text each open thread quotes ----------
type Quoted = { id: string; quote: string; color?: string }
const commentEffect = StateEffect.define<Quoted[]>()
function commentDecos(doc: EditorState['doc'], threads: Quoted[]): DecorationSet {
  if (!threads.length || doc.length > 2_000_000) return Decoration.none
  const text = doc.toString()
  const ranges = threads
    .map(t => {
      const at = text.indexOf(t.quote)
      return at < 0 ? null : Decoration.mark({ class: 'cm-comment-mark', attributes: { 'data-thread': t.id, ...(t.color ? { style: `--cmc: ${t.color}` } : {}) } }).range(at, at + t.quote.length)
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => a.from - b.from)
  return Decoration.set(ranges)
}
const commentField = StateField.define<{ threads: Quoted[]; deco: DecorationSet }>({
  create: () => ({ threads: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(commentEffect)) return { threads: e.value, deco: commentDecos(tr.state.doc, e.value) }
    if (!tr.docChanged || !value.threads.length) return value
    return { threads: value.threads, deco: commentDecos(tr.state.doc, value.threads) }
  },
  provide: f => EditorView.decorations.from(f, v => v.deco)
})

/** Replaces the whole text with `next` as one minimal change (common prefix/suffix kept), so undo and cursors behave. */
function applyText(view: EditorView, next: string, flash = false) {
  const cur = view.state.doc.toString()
  if (cur === next) return
  let a = 0
  const max = Math.min(cur.length, next.length)
  while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++
  let b = 0
  while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++
  const insert = next.slice(a, next.length - b)
  view.dispatch({
    changes: { from: a, to: cur.length - b, insert },
    effects: flash ? flashEffect.of({ from: a, to: a + insert.length }) : [],
    scrollIntoView: flash,
    selection: flash ? EditorSelection.cursor(a + insert.length) : undefined,
    userEvent: 'input.agent'
  })
  if (flash) {
    view.dispatch({ effects: EditorView.scrollIntoView(a, { y: 'center' }) })
    setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1600)
  }
}

/** Transforms each selected line range (or the whole document when nothing is selected) with fn. */
function mapLines(view: EditorView, fn: (lines: string[]) => string[]) {
  const s = view.state
  const sel = s.selection.main
  const whole = sel.empty
  const from = whole ? 0 : s.doc.lineAt(sel.from).from
  const to = whole ? s.doc.length : s.doc.lineAt(sel.to).to
  const text = fn(s.sliceDoc(from, to).split('\n')).join('\n')
  view.dispatch({ changes: { from, to, insert: text }, userEvent: 'input' })
}
function mapSelection(view: EditorView, fn: (s: string) => string) {
  view.dispatch(view.state.changeByRange(r => {
    const text = fn(view.state.sliceDoc(r.from, r.to))
    return { changes: { from: r.from, to: r.to, insert: text }, range: EditorSelection.range(r.from, r.from + text.length) }
  }))
}

const isDark = () => {
  const t = document.documentElement.dataset.theme
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

const baseTheme = (size: number) =>
  EditorView.theme({
    '&': { height: '100%', fontSize: `${size}px`, backgroundColor: 'var(--surface)' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', borderRight: '1px solid var(--line-soft)', color: 'var(--muted)' },
    '.cm-agent-flash': { animation: 'agent-flash 1.6s ease-out' }
  })

export default function TextEditor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [status, setStatus] = useState({ line: 1, col: 1, sel: 0, selLines: 0, lines: 1, lineLen: 0 })
  // Whole-document counts are recomputed shortly after typing stops, not on every keystroke.
  const [stats, setStats] = useState<{ chars: number; words: number | null; longest: number; longestAt: number }>({ chars: 0, words: null, longest: 0, longestAt: 1 })
  const statsTimer = useRef(0)
  const computeStats = (doc: EditorState['doc']) => {
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => {
      let longest = 0
      let longestAt = 1
      for (let i = 1; i <= doc.lines; i++) {
        const n = doc.line(i).length
        if (n > longest) (longest = n), (longestAt = i)
      }
      const chars = doc.length
      setStats({ chars, words: chars < 5_000_000 ? countWords(doc.toString()) : null, longest, longestAt })
    }, 300)
  }
  const statusItems = useRef<StatusItem[]>([])
  const [wrap, setWrap] = useState(props.settings.textWrap)
  const [gutter, setGutter] = useState(true)
  const [size, setSize] = useState(props.settings.fontSize || 14)
  const [langName, setLangName] = useState('Plain text')
  const eol = props.payload.kind === 'text' ? props.payload.eol || '\n' : '\n'
  const comp = useRef({ lang: new Compartment(), wrap: new Compartment(), theme: new Compartment(), size: new Compartment(), gutter: new Compartment() })
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  const language = languageOf(props.path)
  // Spelling is checked in prose (Markdown, plain text), not in code.
  const prose = language === 'markdown' || language === 'text'
  const pathRef = useRef(props.path)
  pathRef.current = props.path
  const quoted = useQuotedThreads(props.path)
  useEffect(() => {
    viewRef.current?.dispatch({ effects: commentEffect.of(quoted) })
  }, [quoted])

  // ---------- create the view once ----------
  useEffect(() => {
    const text = props.payload.kind === 'text' ? props.payload.text : ''
    const c = comp.current
    const extensions: Extension[] = [
      basicSetup,
      keymap.of([
        indentWithTab,
        { key: 'Mod-=', run: () => (setSize(s => Math.min(40, s + 1)), true) },
        { key: 'Mod-+', run: () => (setSize(s => Math.min(40, s + 1)), true) },
        { key: 'Mod--', run: () => (setSize(s => Math.max(8, s - 1)), true) },
        { key: 'Mod-0', run: () => (setSize(props.settings.fontSize || 14), true) },
        { key: 'Mod-g', run: gotoLine },
        { key: 'Mod-h', run: openSearchPanel },
        { key: 'Mod-d', run: copyLineDown }
      ]),
      EditorState.allowMultipleSelections.of(true),
      flashField,
      commentField,
      EditorView.contentAttributes.of({ spellcheck: prose ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.domEventHandlers({
        mousedown: e => {
          const id = (e.target as HTMLElement | null)?.closest?.('.cm-comment-mark')?.getAttribute('data-thread')
          if (id) focusThread(pathRef.current, id)
          return false
        }
      }),
      c.lang.of([]),
      c.wrap.of(wrap ? EditorView.lineWrapping : []),
      c.theme.of(isDark() ? oneDark : []),
      c.size.of(baseTheme(size)),
      c.gutter.of([]),
      EditorView.updateListener.of(u => {
        if (u.docChanged) onChange.current()
        if (u.docChanged || u.selectionSet) {
          const s = u.state
          const head = s.selection.main.head
          const line = s.doc.lineAt(head)
          const sel = s.selection.ranges.reduce((n, r) => n + r.to - r.from, 0)
          const m = s.selection.main
          setStatus({
            line: line.number,
            col: head - line.from + 1,
            sel,
            selLines: sel ? s.doc.lineAt(m.to).number - s.doc.lineAt(m.from).number + 1 : 0,
            lines: s.doc.lines,
            lineLen: line.length
          })
        }
        if (u.docChanged) computeStats(u.state.doc)
      })
    ]
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host.current! })
    viewRef.current = view
    setStatus(st => ({ ...st, lines: view.state.doc.lines, lineLen: view.state.doc.line(1).length }))
    computeStats(view.state.doc)

    // Syntax highlighting, loaded on demand (skipped for very large files).
    if (text.length < BIG) {
      const desc =
        LanguageDescription.matchFilename(languages, baseName(props.path)) ||
        (language !== 'text' ? LanguageDescription.matchLanguageName(languages, language, true) : null)
      if (desc) {
        setLangName(desc.name)
        desc.load().then(support => view.dispatch({ effects: c.lang.reconfigure(support) })).catch(() => {})
      } else setLangName(language === 'text' ? 'Plain text' : language)
    } else setLangName(`${language} (large file, no highlighting)`)

    // Follow the app's light/dark theme.
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => view.dispatch({ effects: c.theme.reconfigure(isDark() ? oneDark : []) })
    mq.addEventListener('change', retheme)
    const mo = new MutationObserver(retheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', retheme)
      mo.disconnect()
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.size.reconfigure(baseTheme(size)) })
  }, [size])
  useEffect(() => {
    // basicSetup includes line numbers; hiding them is done with CSS on the host.
    host.current?.classList.toggle('no-gutter', !gutter)
    void lineNumbers
  }, [gutter])
  useEffect(() => {
    if (props.active) viewRef.current?.focus()
  }, [props.active])

  // ---------- the handle the shell uses ----------
  useEffect(() => {
    const v = () => viewRef.current!
    const run = (fn: (view: EditorView) => unknown) => () => {
      fn(v())
      v().focus()
    }
    const handle: EditorHandle = {
      language,
      status: () => statusItems.current,
      getPayload: () => ({ kind: 'text', text: v().state.doc.toString(), eol }),
      agent: async op => {
        const r = applyTextOp(v().state.doc.toString(), op)
        if (r.text !== undefined) applyText(v(), r.text, true)
        return r.result
      },
      getText: () => v().state.doc.toString(),
      setText: text => applyText(v(), text),
      getSelection: () => {
        const s = v().state
        return s.sliceDoc(s.selection.main.from, s.selection.main.to)
      },
      replaceSelection: text => v().dispatch(v().state.replaceSelection(text)),
      focus: () => v().focus(),
      command: id => {
        const view = v()
        if (id === 'undo') undo(view)
        else if (id === 'redo') redo(view)
        else if (id === 'find' || id === 'replace') openSearchPanel(view)
        else if (id === 'selectAll') selectAll(view)
        else if (id === 'copy' || id === 'cut' || id === 'paste') {
          view.focus()
          document.execCommand(id)
        }
        view.focus()
      },
      menus: () => {
        const edit: MenuItem[] = [
          { label: 'Go to line…', shortcut: 'Ctrl+G', run: run(gotoLine) },
          { label: 'Toggle comment', shortcut: 'Ctrl+/', run: run(toggleComment) },
          { label: 'Duplicate line', shortcut: 'Ctrl+D', run: run(copyLineDown) },
          { sep: true, label: '' },
          { label: 'Sort lines', run: run(view => mapLines(view, l => [...l].sort((x, y) => x.localeCompare(y)))) },
          { label: 'Remove duplicate lines', run: run(view => mapLines(view, l => [...new Set(l)])) },
          { label: 'Trim trailing whitespace', run: run(view => mapLines(view, l => l.map(x => x.replace(/[ \t]+$/, '')))) },
          { label: 'UPPERCASE', run: run(view => mapSelection(view, s => s.toUpperCase())) },
          { label: 'lowercase', run: run(view => mapSelection(view, s => s.toLowerCase())) }
        ]
        const view: MenuItem[] = [
          { label: 'Word wrap', shortcut: 'Alt+Z', checked: wrap, run: () => setWrap(w => !w) },
          { label: 'Line numbers', checked: gutter, run: () => setGutter(g => !g) },
          { sep: true, label: '' },
          { label: 'Zoom in', shortcut: 'Ctrl+=', run: () => setSize(s => Math.min(40, s + 1)) },
          { label: 'Zoom out', shortcut: 'Ctrl+-', run: () => setSize(s => Math.max(8, s - 1)) },
          { label: 'Reset zoom', shortcut: 'Ctrl+0', run: () => setSize(props.settings.fontSize || 14) }
        ]
        return { Edit: edit, View: view }
      }
    }
    props.setHandle(handle)
    return () => props.setHandle(null)
  }, [wrap, gutter, eol])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (props.active && e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        setWrap(w => !w)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.active])

  const goLine = (n: number) => {
    const v = viewRef.current
    if (!v) return
    const pos = v.state.doc.line(Math.min(n, v.state.doc.lines)).from
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    v.focus()
  }
  const fmt = (n: number) => n.toLocaleString()
  statusItems.current = [
    { text: `Ln ${fmt(status.line)}, Col ${status.col}`, title: 'Go to line (Ctrl+G)', run: () => viewRef.current && gotoLine(viewRef.current) },
    { text: `Line length ${status.lineLen}`, title: 'Characters on the current line' },
    ...(status.sel ? [{ text: `${fmt(status.sel)} selected${status.selLines > 1 ? ` (${status.selLines} lines)` : ''}` }] : []),
    { text: `${fmt(status.lines)} lines` },
    ...(stats.words !== null ? [{ text: `${fmt(stats.words)} words` }] : []),
    { text: `${fmt(stats.chars)} chars` },
    { text: `Longest line ${fmt(stats.longest)}`, title: `Line ${stats.longestAt}; click to go there`, run: () => goLine(stats.longestAt) },
    { text: langName },
    { text: extOf(props.path) === 'go' || baseName(props.path).toLowerCase() === 'makefile' ? 'Tabs' : 'Spaces: 2' },
    { text: `${size}px`, title: 'Text size (Ctrl+= / Ctrl+- / Ctrl+0)' }
  ]

  return (
    <div className="text-editor">
      <div className="text-host" ref={host} />
    </div>
  )
}
