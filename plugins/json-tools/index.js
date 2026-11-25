// JSON tools: formatters (pretty / minify / sort keys) and a tree preview.
const parse = text => {
  try {
    return JSON.parse(text)
  } catch {
    // Tolerate JSONC-style comments and trailing commas.
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'))
  }
}
const sortKeys = v =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v

export function activate(api) {
  const languages = ['json']
  api.registerFormatter({ id: 'pretty', name: 'JSON: pretty print', languages, format: t => JSON.stringify(parse(t), null, 2) + '\n' })
  api.registerFormatter({ id: 'minify', name: 'JSON: minify', languages, format: t => JSON.stringify(parse(t)) })
  api.registerFormatter({ id: 'sort', name: 'JSON: sort keys', languages, format: t => JSON.stringify(sortKeys(parse(t)), null, 2) + '\n' })
  api.registerPreview({
    id: 'tree',
    name: 'JSON tree',
    languages,
    render(text, el) {
      const esc = api.escapeHtml
      const node = (v, key) => {
        const label = key === undefined ? '' : `<span style="color:#a142f4">${esc(String(key))}</span>: `
        if (v && typeof v === 'object') {
          const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)
          const sum = Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`
          return `<details open><summary>${label}<span style="opacity:.6">${sum}</span></summary><div style="padding-left:18px">${entries.map(([k, x]) => node(x, k)).join('')}</div></details>`
        }
        const color = typeof v === 'string' ? '#188038' : typeof v === 'number' ? '#1967d2' : '#b06000'
        return `<div>${label}<span style="color:${color}">${esc(JSON.stringify(v))}</span></div>`
      }
      el.style.font = '13px/1.6 var(--mono)'
      el.innerHTML = node(parse(text))
    }
  })
}
