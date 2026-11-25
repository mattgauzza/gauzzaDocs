import type { AgentInfo, AgentOp, FilePayload, Settings } from '../../shared/types'

/**
 * Contract between the app shell (tabs, title bar, menus, autosave, agent routing, plugins) and the four editors
 * (doc/DocEditor, sheet/SheetEditor, pdf/PdfEditor, text/TextEditor). Each editor is a React component taking
 * EditorProps; it renders its own toolbar and canvas, and hands the shell an EditorHandle through setHandle().
 */
export interface MenuItem {
  label: string
  shortcut?: string
  run?: () => void
  checked?: boolean
  disabled?: boolean
  submenu?: MenuItem[]
  sep?: boolean // a divider; label ignored
}
export type MenuName = 'Edit' | 'View' | 'Insert' | 'Format' | 'Tools'

export interface EditorHandle {
  /** Current content, for Save / autosave / export. */
  getPayload(): FilePayload | Promise<FilePayload>
  /**
   * An agent op on the live editor (routed here from the CLI when the file is open). Implement 'read', 'write',
   * 'info' and the kind's ops (src/shared/ops.md). Edits must go through the editor so they are undoable and visible,
   * and must call props.onChange(). Throw an Error with a helpful message for bad input. The shell handles 'save'.
   */
  agent(op: AgentOp, agent: AgentInfo): Promise<unknown>
  /** HTML for Print and Export → PDF (doc and sheet). */
  getPrintHtml?(): string
  /** Plain-text access, used by plugin formatters, previews and commands. */
  getText?(): string
  setText?(text: string): void // one undoable change
  getSelection?(): string
  replaceSelection?(text: string): void
  /** Language id for plugins (text editor: from the extension; doc: 'html'; sheet: 'csv'). */
  language?: string
  /** Shared commands: 'undo' | 'redo' | 'find' | 'replace' | 'selectAll' | 'cut' | 'copy' | 'paste'. */
  command?(id: string): void
  /** Extra menu items the editor adds to the shell's menu bar. */
  menus?(): Partial<Record<MenuName, MenuItem[]>>
  focus?(): void
  /**
   * Live facts for the status bar at the bottom of the window (Ln/Col, words, pages, ...). The shell calls this
   * several times a second while the tab is in focus, so return values cached on change, never computed here.
   */
  status?(): StatusItem[]
}

export interface StatusItem {
  text: string
  title?: string // tooltip with more detail
  run?: () => void // clicking it does this (e.g. go to line)
}

export interface EditorProps {
  path: string
  payload: FilePayload
  settings: Settings
  active: boolean
  /** Call on every content change (user or agent). Marks the tab dirty and schedules autosave. */
  onChange(): void
  setHandle(h: EditorHandle | null): void
}

/** Text editor helpers for agents to see where a change landed: flash a region for a moment. */
export const AGENT_COLOR = '#8e44ef'
