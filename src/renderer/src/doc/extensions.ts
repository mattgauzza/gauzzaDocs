import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockAttrs: {
      /** Moves the current paragraphs/headings right (+1) or left (-1) by one indent step (0.5in). */
      indent: (delta: number) => ReturnType
      setBlockLineHeight: (value: string | null) => ReturnType
      setTitle: () => ReturnType
    }
    pageBreak: {
      setPageBreak: () => ReturnType
    }
  }
}

const BLOCKS = ['paragraph', 'heading']

/** Block-level attributes Google Docs has and StarterKit lacks: indent, line spacing, and the "Title" style. */
export const BlockAttrs = Extension.create({
  name: 'blockAttrs',
  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          indent: {
            default: 0,
            parseHTML: el => Math.round((parseFloat(el.style.marginLeft) || 0) / 48),
            renderHTML: a => (a.indent ? { style: `margin-left: ${a.indent * 48}px` } : {})
          },
          lineHeight: {
            default: null,
            parseHTML: el => el.style.lineHeight || null,
            renderHTML: a => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {})
          }
        }
      },
      {
        types: ['heading'],
        attributes: {
          title: {
            default: false,
            parseHTML: el => el.classList.contains('title'),
            renderHTML: a => (a.title ? { class: 'title' } : {})
          }
        }
      }
    ]
  },
  addCommands() {
    const each = (fn: (attrs: Record<string, unknown>) => Record<string, unknown>) => ({ tr, state, dispatch }: any) => {
      const { from, to } = state.selection
      let changed = false
      state.doc.nodesBetween(from, to, (node: any, pos: number) => {
        if (!BLOCKS.includes(node.type.name)) return
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs) })
        changed = true
        return false
      })
      if (changed && dispatch) dispatch(tr)
      return changed
    }
    return {
      indent: (delta: number) => each(a => ({ indent: Math.max(0, Math.min(10, (Number(a.indent) || 0) + delta)) })),
      setBlockLineHeight: (value: string | null) => each(() => ({ lineHeight: value })),
      setTitle:
        () =>
        ({ commands }: any) =>
          commands.setNode('heading', { level: 1, title: true })
    }
  },
  addKeyboardShortcuts() {
    return {
      // Tab indents a paragraph (lists handle Tab themselves through their own shortcuts, which run first).
      Tab: () => (this.editor.isActive('listItem') || this.editor.isActive('taskItem') || this.editor.isActive('table') ? false : this.editor.commands.indent(1)),
      'Shift-Tab': () => (this.editor.isActive('listItem') || this.editor.isActive('taskItem') || this.editor.isActive('table') ? false : this.editor.commands.indent(-1))
    }
  }
})

/** A page break: prints as a new page, shows as a dashed line. */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div.page-break' }, { tag: 'div[style*="page-break-after"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: 'page-break', style: 'page-break-after: always' })],
  addCommands() {
    return { setPageBreak: () => ({ commands }) => commands.insertContent({ type: this.name }) }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() }
  }
})

// ---------- decorations: agent flash and find matches ----------
export const flashKey = new PluginKey<DecorationSet>('agentFlash')
export const findKey = new PluginKey<{ deco: DecorationSet }>('findMatches')

/** Briefly highlights blocks an agent changed. Set meta { from, to } on flashKey; null clears. */
export const AgentFlash = Extension.create({
  name: 'agentFlash',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: flashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, deco) {
            const meta = tr.getMeta(flashKey) as { from: number; to: number } | null | undefined
            if (meta === null) return DecorationSet.empty
            if (meta) {
              const decos: Decoration[] = []
              tr.doc.nodesBetween(Math.max(0, meta.from), Math.min(tr.doc.content.size, Math.max(meta.from, meta.to)), (node, pos) => {
                if (node.isBlock && (node.isTextblock || node.isAtom)) {
                  decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'agent-flash' }))
                  return false
                }
                return true
              })
              return DecorationSet.create(tr.doc, decos)
            }
            return deco.map(tr.mapping, tr.doc)
          }
        },
        props: { decorations: state => flashKey.getState(state) }
      })
    ]
  }
})

/** Highlights find matches. Set meta { ranges: [from, to][], current } on findKey. */
export const FindMatches = Extension.create({
  name: 'findMatches',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ deco: DecorationSet }>({
        key: findKey,
        state: {
          init: () => ({ deco: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(findKey) as { ranges: [number, number][]; current: number } | undefined
            if (meta)
              return {
                deco: DecorationSet.create(
                  tr.doc,
                  meta.ranges.map(([a, b], i) => Decoration.inline(a, b, { class: i === meta.current ? 'find-hit current' : 'find-hit' }))
                )
              }
            return { deco: value.deco.map(tr.mapping, tr.doc) }
          }
        },
        props: { decorations: state => findKey.getState(state)?.deco }
      })
    ]
  }
})
