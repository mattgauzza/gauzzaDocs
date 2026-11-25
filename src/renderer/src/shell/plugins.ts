import { escapeHtml, htmlToMarkdown, markdownToHtml } from '../../../shared/convert'
import type { InstalledPlugin } from '../../../shared/types'
import { api } from '../lib'

/**
 * Plugin host for the window. A plugin is an ES module exporting `activate(api)`; see plugins/README.md.
 * Plugins run with the same rights as the app, like Notepad++ plugins do, so only install ones you trust.
 */
export interface EditorAccess {
  path: string
  language: string
  getText(): string
  setText(text: string): void
  getSelection(): string
  replaceSelection(text: string): void
}
export interface PluginFormatter {
  id: string
  name: string
  languages?: string[]
  format(text: string, ctx: { language: string; path?: string }): string | Promise<string>
  plugin: string
}
export interface PluginPreview {
  id: string
  name: string
  languages?: string[]
  render(text: string, el: HTMLElement, ctx: { language: string; path: string }): void | Promise<void>
  plugin: string
}
export interface PluginCommand {
  id: string
  title: string
  languages?: string[]
  run(ctx: { editor: EditorAccess | null; toast(msg: string): void }): void | Promise<void>
  plugin: string
}
export interface LoadedPlugins {
  formatters: PluginFormatter[]
  previews: PluginPreview[]
  commands: PluginCommand[]
  installed: InstalledPlugin[]
  errors: { id: string; error: string }[]
}

export const fits = (x: { languages?: string[] }, language: string) => !x.languages?.length || x.languages.includes(language) || x.languages.includes('*')

let generation = 0

export async function loadPlugins(toast: (msg: string) => void): Promise<LoadedPlugins> {
  const gen = ++generation
  const res: LoadedPlugins = { formatters: [], previews: [], commands: [], installed: [], errors: [] }
  try {
    res.installed = await api.pluginsInstalled()
  } catch (e) {
    res.errors.push({ id: '*', error: (e as Error).message })
    return res
  }
  for (const p of res.installed.filter(x => x.enabled)) {
    const scoped = (id: string) => `${p.id}.${id}`
    const host = {
      version: 1,
      host: 'app' as const,
      registerFormatter: (f: Omit<PluginFormatter, 'plugin'>) => res.formatters.push({ ...f, id: scoped(f.id), plugin: p.id }),
      registerPreview: (v: Omit<PluginPreview, 'plugin'>) => res.previews.push({ ...v, id: scoped(v.id), plugin: p.id }),
      registerCommand: (c: Omit<PluginCommand, 'plugin'>) => res.commands.push({ ...c, id: scoped(c.id), plugin: p.id }),
      markdown: { toHtml: markdownToHtml, fromHtml: htmlToMarkdown },
      escapeHtml,
      ui: { toast }
    }
    try {
      // ?v= busts the module cache so Reload picks up new versions.
      const mod = await import(/* @vite-ignore */ `gdplugin://${p.id}/${p.main}?v=${p.version}-${gen}`)
      await mod.activate?.(host)
    } catch (e) {
      res.errors.push({ id: p.id, error: (e as Error).message || String(e) })
    }
  }
  return res
}
