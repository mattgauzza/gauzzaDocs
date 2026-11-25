import { type BrowserWindow, Menu, type MenuItemConstructorOptions, app, ipcMain, session } from 'electron'

/**
 * The right-click menu: a native menu, so it looks like the rest of the OS and gets Chromium's spelling data.
 * Order: spelling suggestions (when the word is misspelled), Cut / Copy / Paste, then app actions that go back to the
 * window as 'context-command' ({ id, prompt? }): comment, formatting for documents, and "Ask the agent".
 * Editors with their own menu (sheet grid, PDF pages, tab strip) prevent the DOM contextmenu event, and Chromium then
 * never asks for this one.
 */

/** What the window told us about the element under the pointer (sent from its contextmenu listener). */
interface Target {
  kind: 'doc' | 'text' | 'other'
  at: number
}
let target: Target = { kind: 'other', at: 0 }
ipcMain.on('context-target', (_e, t: Omit<Target, 'at'>) => {
  target = { ...t, at: Date.now() }
})

const ASK: { id: string; label: string; prompt: string }[] = [
  { id: 'rewrite', label: 'Rewrite', prompt: 'rewrite this so it reads better' },
  { id: 'shorter', label: 'Make shorter', prompt: 'make this shorter without losing anything important' },
  { id: 'grammar', label: 'Fix spelling and grammar', prompt: 'fix the spelling and grammar in this' },
  { id: 'explain', label: 'Explain', prompt: 'explain this (reply in the comment, do not edit the file)' }
]

export function attachContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_e, p) => {
    const send = (id: string, extra: Record<string, unknown> = {}) => win.webContents.send('context-command', { id, ...extra })
    // The window's note about the target arrives just before this event; an old note means it was not an editor.
    const fresh = Date.now() - target.at < 1500
    const kind = fresh ? target.kind : 'other'
    const items: MenuItemConstructorOptions[] = []
    const hasText = !!p.selectionText.trim()

    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
      if (!p.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false })
      items.push({
        label: `Add "${p.misspelledWord}" to dictionary`,
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord)
      })
      items.push({ type: 'separator' })
    }

    if (p.isEditable || hasText) {
      const f = p.editFlags
      items.push(
        { label: 'Cut', role: 'cut', accelerator: 'CmdOrCtrl+X', enabled: f.canCut && p.isEditable },
        { label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C', enabled: f.canCopy },
        { label: 'Paste', role: 'paste', accelerator: 'CmdOrCtrl+V', enabled: f.canPaste && p.isEditable },
        { label: 'Paste as plain text', accelerator: 'CmdOrCtrl+Shift+V', enabled: f.canPaste && p.isEditable, click: () => win.webContents.pasteAndMatchStyle() },
        { label: 'Select all', role: 'selectAll', accelerator: 'CmdOrCtrl+A', enabled: f.canSelectAll }
      )
    }

    if (kind !== 'other') {
      items.push({ type: 'separator' }, { label: 'Comment', accelerator: 'CmdOrCtrl+Alt+M', click: () => send('comment') })
      if (kind === 'doc' && p.isEditable) {
        items.push(
          { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => send('bold') },
          { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => send('italic') },
          { label: 'Link', accelerator: 'CmdOrCtrl+K', click: () => send('link') },
          { label: 'Clear formatting', accelerator: 'CmdOrCtrl+\\', click: () => send('clearFormatting') }
        )
      }
      if (hasText) {
        items.push({ type: 'separator' }, {
          label: 'Ask the agent',
          submenu: [
            ...ASK.map(a => ({ label: a.label, click: () => send('ask', { prompt: a.prompt }) })),
            { type: 'separator' as const },
            { label: 'Something else...', click: () => send('ask-custom') }
          ]
        })
      }
    }

    // Spelling on or off, for any editable place.
    if (p.isEditable) {
      const on = win.webContents.session.isSpellCheckerEnabled()
      items.push({ type: 'separator' }, { label: 'Check spelling', type: 'checkbox', checked: on, click: () => send('toggle-spelling') })
    }

    if (!items.length) return
    // No leading, trailing or doubled separators.
    const clean = items.filter((it, i, a) => it.type !== 'separator' || (i > 0 && i < a.length - 1 && a[i - 1].type !== 'separator'))
    Menu.buildFromTemplate(clean).popup({ window: win, x: p.x, y: p.y })
  })
}

/**
 * Spelling uses the operating system's checker on Windows and macOS. On Linux, Chromium's dictionaries are used,
 * picked from the system language. `enabled` follows Settings (View > Check spelling).
 */
export function setupSpelling(enabled: boolean) {
  const ses = session.defaultSession
  ses.setSpellCheckerEnabled(enabled)
  if (process.platform === 'linux') {
    try {
      const want = [app.getLocale(), app.getLocale().split('-')[0], 'en-US']
      const have = new Set(ses.availableSpellCheckerLanguages)
      const pick = want.find(l => have.has(l))
      if (pick) ses.setSpellCheckerLanguages([pick])
    } catch { /* keep Chromium's default */ }
  }
}
