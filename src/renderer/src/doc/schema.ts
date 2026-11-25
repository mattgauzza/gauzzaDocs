import { Node } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import { BackgroundColor, Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { BlockAttrs, PageBreak } from './extensions'

/**
 * The document schema: every extension that decides what a document can hold. The editor adds its UI-only
 * extensions (pagination, find, agent flash, placeholder) on top; tests use this list on its own to check that
 * Markdown survives a trip through the editor.
 */
export const lowlight = createLowlight(common)

/** YAML front matter, kept as an opaque block at the top and shown as a "Properties" table (see markdown.ts). */
export const FrontMatter = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      yaml: {
        default: '',
        parseHTML: el => (el.querySelector('pre')?.textContent ?? el.textContent ?? '').replace(/\n$/, ''),
        rendered: false
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-front-matter]' }]
  },
  renderHTML({ node }) {
    return ['div', { 'data-front-matter': '' }, ['pre', {}, node.attrs.yaml as string]]
  }
})

export function schemaExtensions() {
  return [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    TextStyle,
    Color,
    BackgroundColor,
    FontFamily,
    FontSize,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: true }),
    Image.configure({ allowBase64: true, inline: false }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    BlockAttrs,
    PageBreak,
    FrontMatter
  ]
}
