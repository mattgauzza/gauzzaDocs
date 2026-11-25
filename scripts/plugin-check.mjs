// Checks a plugin folder the way the marketplace does. Used by `gdocs plugins validate` and by CI
// (scripts/validate-plugins.mjs) for every plugin in the repo and every external submission.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const CATEGORIES = ['Data', 'Developer', 'Formatting', 'Preview', 'Text', 'Writing', 'Other']
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_BYTES = 512 * 1024

/**
 * Rules a plugin must follow to be listed. Plugins run with the app's access, so the code review in the pull request
 * matters most; these checks catch the mechanical problems and the obvious red flags.
 */
const FORBIDDEN = [
  [/\bfrom\s+['"](node:|fs|child_process|os|net|http|https|electron)\b/, 'imports a Node or Electron module (plugins get everything they need from the api object)'],
  [/\brequire\s*\(/, 'uses require()'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'uses eval / new Function'],
  [/\bwindow\.gd\b/, 'reaches into the app bridge (window.gd)'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, 'makes network requests (not allowed for listed plugins)'],
  [/\bimport\s*\(\s*['"`]https?:/, 'imports code from the internet']
]

/** Returns { manifest, problems, registered } for a plugin folder. */
export async function checkPlugin(dir, { requireFolderMatch = true } = {}) {
  const problems = []
  const mf = path.join(dir, 'plugin.json')
  if (!fs.existsSync(mf)) return { problems: ['no plugin.json'], registered: [] }
  let m
  try {
    m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  } catch (e) {
    return { problems: [`plugin.json is not valid JSON: ${e.message}`], registered: [] }
  }
  if (!SAFE_ID.test(m.id || '')) problems.push('"id" must be lower-case letters, digits, . _ - (max 64)')
  if (requireFolderMatch && m.id !== path.basename(dir)) problems.push(`"id" (${m.id}) must match the folder name (${path.basename(dir)})`)
  for (const k of ['name', 'version', 'description', 'main', 'category']) if (!m[k]) problems.push(`missing "${k}"`)
  if (m.version && !/^\d+\.\d+\.\d+$/.test(m.version)) problems.push('"version" must be x.y.z')
  if (m.category && !CATEGORIES.includes(m.category)) problems.push(`"category" must be one of ${CATEGORIES.join(', ')}`)
  if (m.description && m.description.length > 200) problems.push('"description" is over 200 characters')
  if (m.languages && !Array.isArray(m.languages)) problems.push('"languages" must be an array')
  const files = [...new Set(['plugin.json', m.main, ...(m.files || [])].filter(Boolean))]
  let total = 0
  for (const f of files) {
    if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) {
      problems.push(`file "${f}" is outside the plugin folder`)
      continue
    }
    const p = path.join(dir, f)
    if (!fs.existsSync(p)) {
      problems.push(`lists "${f}", which does not exist`)
      continue
    }
    total += fs.statSync(p).size
    if (/\.(m?js)$/.test(f)) {
      const code = fs.readFileSync(p, 'utf8')
      for (const [re, why] of FORBIDDEN) if (re.test(code)) problems.push(`${f} ${why}`)
    }
  }
  if (total > MAX_BYTES) problems.push(`plugin is ${Math.round(total / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB`)

  // Load it against a stub of the plugin API and make sure it registers something.
  const registered = []
  if (m.main && fs.existsSync(path.join(dir, m.main)) && !problems.some(p => p.startsWith(m.main))) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, m.main)).href + `?check=${Date.now()}`)
      if (typeof mod.activate !== 'function') problems.push(`${m.main} must export function activate(api)`)
      else {
        const reg = kind => def => {
          if (!def || !def.id || (kind === 'command' ? !def.title || typeof def.run !== 'function' : !def.name)) problems.push(`a ${kind} is missing id/name/title or its function`)
          if (kind === 'formatter' && typeof def.format !== 'function') problems.push(`formatter ${def.id} has no format()`)
          if (kind === 'preview' && typeof def.render !== 'function') problems.push(`preview ${def.id} has no render()`)
          registered.push(`${kind}:${def?.id}`)
        }
        await mod.activate({
          version: 1,
          host: 'cli',
          registerFormatter: reg('formatter'),
          registerPreview: reg('preview'),
          registerCommand: reg('command'),
          markdown: { toHtml: s => s, fromHtml: s => s },
          escapeHtml: s => String(s),
          ui: { toast: () => {} }
        })
        if (!registered.length) problems.push('activate() registered nothing')
        // Formatters, previews and commands are separate lists, so only a clash within one kind matters.
        if (new Set(registered).size !== registered.length) problems.push('two formatters, previews or commands share an id')
      }
    } catch (e) {
      problems.push(`failed to load: ${e.message}`)
    }
  }
  return { manifest: m, problems, registered }
}

/** A starter plugin folder, for `gdocs plugins new`. */
export function scaffold(dir, id, name = id) {
  if (!SAFE_ID.test(id)) throw new Error('id must be lower-case letters, digits, . _ -')
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { id, name, version: '0.1.0', description: 'What it does, in one sentence.', author: '', category: 'Text', tags: [], icon: '🧩', main: 'index.js', languages: ['*'] }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `// ${name}: see https://github.com/mattgauzza/gauzzaDocs/blob/main/plugins/README.md for the plugin API.

export function activate(api) {
  // Reformat a whole file: Tools → Format document (Ctrl+Shift+F), and \`gdocs format\` from the terminal.
  api.registerFormatter({
    id: 'trim',
    name: '${name}: trim trailing spaces',
    format: text => text.split('\\n').map(line => line.replace(/\\s+$/, '')).join('\\n')
  })

  // A command under the Plugins menu (window only). Works on the selection, or the whole text.
  api.registerCommand({
    id: 'upper',
    title: '${name}: UPPER CASE',
    run({ editor, toast }) {
      if (!editor) return toast('Open a file first')
      const sel = editor.getSelection()
      sel ? editor.replaceSelection(sel.toUpperCase()) : editor.setText(editor.getText().toUpperCase())
    }
  })

  // A live view beside the editor: View → Preview pane (window only).
  api.registerPreview({
    id: 'count',
    name: '${name}: counts',
    render(text, el) {
      el.textContent = \`\${text.split('\\n').length} lines, \${text.length} characters\`
    }
  })
}
`
  )
  return dir
}
