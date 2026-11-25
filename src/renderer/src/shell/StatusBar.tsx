import { useEffect, useRef, useState } from 'react'
import { extOf, languageOf } from '../../../shared/kinds'
import type { FilePayload, Settings } from '../../../shared/types'
import type { EditorHandle, StatusItem } from '../editor'
import { api, when } from '../lib'
import { docId } from '../../../shared/docId'

const FORMAT: Record<string, string> = {
  html: 'HTML document', htm: 'HTML document', md: 'Markdown', markdown: 'Markdown', docx: 'Word document',
  xlsx: 'Excel workbook', csv: 'CSV', tsv: 'TSV', pdf: 'PDF', pptx: 'PowerPoint presentation'
}

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`

/**
 * The bar along the bottom, like a code editor's: on the left, live facts from the editor in focus
 * (Ln/Col, words, pages, selection); on the right, facts about the file (format, encoding, line endings, size, saving).
 */
export function StatusBar(props: {
  path: string
  lossy: boolean
  payload: FilePayload | null
  handle: EditorHandle | undefined
  mtime: number
  saved: number
  dirty: boolean
  settings: Settings
}) {
  const [items, setItems] = useState<StatusItem[]>([])
  const last = useRef('')
  const [stat, setStat] = useState<{ size: number; created: number } | null>(null)

  // Editors keep their items current; poll them cheaply and re-render only when something changed.
  useEffect(() => {
    const tick = () => {
      const next = props.handle?.status?.() || []
      const key = next.map(i => i.text).join('|')
      if (key !== last.current) {
        last.current = key
        setItems(next)
      }
    }
    tick()
    const iv = window.setInterval(tick, 250)
    return () => window.clearInterval(iv)
  }, [props.handle])

  useEffect(() => {
    api.stat(props.path).then(s => setStat(s && { size: s.size, created: s.created }))
  }, [props.path, props.mtime, props.saved])

  const ext = extOf(props.path)
  const large = props.payload?.kind === 'large'
  const right: StatusItem[] = [
    { text: docId(props.path), title: 'Document ID: agents can use it instead of the path (gdocs listen ' + docId(props.path) + '). Click to copy.', run: () => void navigator.clipboard.writeText(docId(props.path)) },
    { text: FORMAT[ext] || (languageOf(props.path) === 'text' ? 'Plain text' : ext.toUpperCase() || 'Text') },
    ...(props.payload?.kind === 'text' ? [{ text: props.payload.eol === '\r\n' ? 'CRLF' : 'LF', title: 'Line endings (kept as they were)' }] : []),
    ...(['pdf', 'xlsx', 'docx', 'pptx'].includes(ext) ? [] : [{ text: 'UTF-8' }]),
    ...(stat ? [{ text: fileSize(stat.size), title: `On disk${stat.created ? `\nCreated ${new Date(stat.created).toLocaleString()}` : ''}`, run: () => api.reveal(props.path) }] : []),
    large
      ? { text: 'Read-only view', title: 'Too large to load; read from disk a screen at a time. gdocs can still edit it.' }
      : props.lossy || !props.settings.autosave
        ? { text: props.dirty ? 'Ctrl+S to save' : props.saved ? `Saved ${when(props.saved)}` : 'Saves on Ctrl+S', title: props.lossy ? 'This file holds things the editor cannot show, so it saves only when you ask (a backup of the original is kept)' : 'Autosave is off (Settings)' }
        : { text: props.dirty ? 'Saving…' : props.saved ? `Saved ${when(props.saved)}` : 'Autosave on', title: 'Changes save a moment after you stop typing' }
  ]

  const render = (it: StatusItem, i: number) =>
    it.run ? (
      <button key={i} className="sb-item link" title={it.title} onClick={it.run}>{it.text}</button>
    ) : (
      <span key={i} className="sb-item" title={it.title}>{it.text}</span>
    )
  return (
    <div className="statusbar">
      {items.map(render)}
      <span className="grow" />
      {right.map(render)}
    </div>
  )
}
