// JSON <-> YAML for everyday config files. Supports block maps and lists, scalars, quoted strings, comments,
// inline [a, b] / {a: 1} collections and | / > block strings. Anchors, tags and multi-document streams are not.

const needsQuote = s =>
  s === '' || /^[\s]|[\s]$/.test(s) || /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/i.test(s) || /[:#{}\[\],&*!|>'"%@`]/.test(s) || s.startsWith('- ')

export function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent)
  const scalar = v =>
    v === null ? 'null' : typeof v === 'string' ? (v.includes('\n') ? `|\n${v.split('\n').map(l => pad + '  ' + l).join('\n')}` : needsQuote(v) ? JSON.stringify(v) : v) : String(v)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return value
      .map(v => (v && typeof v === 'object' && Object.keys(v).length ? `${pad}- ${toYaml(v, indent + 1).trimStart()}` : `${pad}- ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`))
      .join('\n')
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) return '{}'
    return keys
      .map(k => {
        const v = value[k]
        const key = needsQuote(k) ? JSON.stringify(k) : k
        if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, Array.isArray(v) ? indent : indent + 1)}`
        return `${pad}${key}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`
      })
      .join('\n')
  }
  return pad + scalar(value)
}

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true' || s === 'True') return true
  if (s === 'false' || s === 'False') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"')) return JSON.parse(s)
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('[') || s.startsWith('{')) return flow(s)
  return s
}
function flow(s) {
  // Inline collections: quote bare words, then read as JSON.
  const json = s.replace(/("(?:[^"\\]|\\.)*"|'[^']*')|([^\s,:\[\]{}][^,:\[\]{}]*?)(?=\s*[,:\]}])/g, (m, q, bare) => {
    if (q) return q.startsWith("'") ? JSON.stringify(q.slice(1, -1)) : q
    const v = parseScalar(bare)
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)
  })
  return JSON.parse(json)
}
const stripComment = l => {
  let q = ''
  for (let i = 0; i < l.length; i++) {
    const c = l[i]
    if (q) {
      if (c === q) q = ''
    } else if (c === '"' || c === "'") q = c
    else if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i)
  }
  return l
}

export function fromYaml(text) {
  const lines = text.replace(/\t/g, '  ').split('\n').map(l => ({ raw: l, s: stripComment(l).replace(/\s+$/, '') }))
  let i = 0
  const ind = l => l.s.length - l.s.trimStart().length
  const skip = () => {
    while (i < lines.length && (!lines[i].s.trim() || lines[i].s.trim() === '---')) i++
  }
  function block(minIndent) {
    skip()
    if (i >= lines.length) return null
    const first = lines[i]
    const base = ind(first)
    if (base < minIndent) return null
    if (first.s.trimStart().startsWith('- ') || first.s.trim() === '-') {
      const arr = []
      while (i < lines.length) {
        skip()
        if (i >= lines.length || ind(lines[i]) !== base || !/^\s*-(\s|$)/.test(lines[i].s)) break
        const rest = lines[i].s.trimStart().slice(1)
        if (!rest.trim()) {
          i++
          arr.push(block(base + 1))
        } else if (/^\s*[^"'\[{][^:]*:(\s|$)/.test(rest) || /^\s*"[^"]*":(\s|$)/.test(rest)) {
          // "- key: value" starts a map indented at the item's content column
          lines[i] = { raw: lines[i].raw, s: ' '.repeat(base + 1 + (rest.length - rest.trimStart().length)) + rest.trimStart() }
          arr.push(block(base + 1))
        } else {
          i++
          arr.push(blockString(rest.trim(), base) ?? parseScalar(rest))
        }
      }
      return arr
    }
    const obj = {}
    while (i < lines.length) {
      skip()
      if (i >= lines.length || ind(lines[i]) !== base) break
      const m = lines[i].s.trim().match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/)
      if (!m) throw new Error(`Cannot read line ${i + 1}: ${lines[i].raw.trim()}`)
      const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].startsWith("'") ? m[1].slice(1, -1) : m[1]
      i++
      const v = m[2]
      if (v === undefined || v === '') {
        // A list may sit at the key's own indent ("tags:\n- a"), which is common and valid YAML.
        skip()
        const next = lines[i]
        obj[key] = next && ind(next) === base && /^\s*-(\s|$)/.test(next.s) ? block(base) : block(base + 1) ?? null
      } else obj[key] = blockString(v.trim(), base) ?? parseScalar(v)
    }
    return obj
  }
  function blockString(v, base) {
    if (v !== '|' && v !== '>' && v !== '|-' && v !== '>-') return undefined
    const out = []
    let inner = -1
    while (i < lines.length && (!lines[i].raw.trim() || ind({ s: lines[i].raw }) > base)) {
      const r = lines[i].raw
      if (inner < 0 && r.trim()) inner = r.length - r.trimStart().length
      out.push(r.slice(Math.max(0, inner)))
      i++
    }
    while (out.length && !out[out.length - 1].trim()) out.pop()
    const joined = v.startsWith('>') ? out.join(' ').replace(/\s+/g, ' ') : out.join('\n')
    return v.endsWith('-') ? joined : joined + '\n'
  }
  const value = block(0)
  return value
}

export function activate(api) {
  api.registerFormatter({ id: 'json2yaml', name: 'Convert JSON → YAML', languages: ['json'], format: t => toYaml(JSON.parse(t)) + '\n' })
  api.registerFormatter({ id: 'yaml2json', name: 'Convert YAML → JSON', languages: ['yaml'], format: t => JSON.stringify(fromYaml(t), null, 2) + '\n' })
  api.registerFormatter({ id: 'normalize', name: 'YAML: normalise indentation', languages: ['yaml'], format: t => toYaml(fromYaml(t)) + '\n' })
}
