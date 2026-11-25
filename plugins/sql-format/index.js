// SQL formatter: tokenises (keeping strings, quoted names and comments intact) and lays out clauses one per line.

const KEYWORDS = new Set(('select from where and or not in is null like between exists as on join inner left right full outer cross ' +
  'group by order having limit offset union all distinct insert into values update set delete create table alter drop index view ' +
  'primary key foreign references default case when then else end asc desc with returning over partition window fetch first next rows only ' +
  'coalesce count sum avg min max cast true false if replace begin commit rollback transaction').split(' '))
const NEWLINE_BEFORE = ['select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset', 'union', 'union all', 'insert into', 'values', 'update', 'set', 'delete from', 'with', 'returning', 'window']
const JOINS = ['join', 'inner join', 'left join', 'right join', 'full join', 'left outer join', 'right outer join', 'full outer join', 'cross join']

function tokenize(sql) {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])|(\d+(?:\.\d+)?)|([A-Za-z_][\w$]*)|(<>|<=|>=|!=|::|\|\||[(),;.*=<>+\-/%])|(\s+)/g
  const out = []
  let m
  while ((m = re.exec(sql))) {
    if (m[7]) continue
    if (m[1]) out.push({ t: 'comment', v: m[1] })
    else if (m[2] || m[3]) out.push({ t: 'lit', v: m[0] })
    else if (m[4]) out.push({ t: 'num', v: m[4] })
    else if (m[5]) out.push({ t: KEYWORDS.has(m[5].toLowerCase()) ? 'kw' : 'id', v: m[5] })
    else out.push({ t: 'op', v: m[6] })
  }
  return out
}

export function formatSql(sql, { indent = '  ', upper = true } = {}) {
  const toks = tokenize(sql)
  const lines = []
  let line = ''
  let depth = 0
  // Clause lines start at the current depth; JOIN / AND / OR lines carry one extra indent (kept by flush).
  const flush = () => {
    if (line.trim()) {
      const extra = line.match(/^ */)[0]
      lines.push(indent.repeat(Math.max(0, depth)) + extra + line.trim())
    }
    line = ''
  }
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]
    let v = tok.t === 'kw' && upper ? tok.v.toUpperCase() : tok.v
    const low = tok.v.toLowerCase()
    // multi-word keywords
    const two = tok.t === 'kw' && toks[i + 1]?.t === 'kw' ? `${low} ${toks[i + 1].v.toLowerCase()}` : ''
    const three = two && toks[i + 2]?.t === 'kw' ? `${two} ${toks[i + 2].v.toLowerCase()}` : ''
    const phrase = [three, two, low].find(p => p && (NEWLINE_BEFORE.includes(p) || JOINS.includes(p)))
    if (tok.t === 'comment') {
      flush()
      lines.push(indent.repeat(depth) + v)
      continue
    }
    if (phrase) {
      const n = phrase.split(' ').length
      v = toks.slice(i, i + n).map(t => (upper ? t.v.toUpperCase() : t.v)).join(' ')
      i += n - 1
      flush()
      line = (JOINS.includes(phrase) ? indent : '') + v + ' '
      continue
    }
    if (tok.t === 'kw' && (low === 'and' || low === 'or') && depth >= 0) {
      flush()
      line = indent + v + ' '
      continue
    }
    if (v === '(') {
      const sub = toks[i + 1]?.t === 'kw' && ['select', 'with'].includes(toks[i + 1].v.toLowerCase())
      line += '('
      if (sub) {
        flush()
        depth++
      }
      continue
    }
    if (v === ')') {
      if (depth > 0 && !line.includes('(')) {
        flush()
        depth--
        line = ')'
      } else line = line.replace(/ $/, '') + ')'
      line += ' '
      continue
    }
    if (v === ',') {
      line = line.replace(/ $/, '') + ', '
      continue
    }
    if (v === ';') {
      line = line.replace(/ $/, '') + ';'
      flush()
      lines.push('')
      depth = 0
      continue
    }
    if (v === '.') {
      line = line.replace(/ $/, '') + '.'
      continue
    }
    // Words are followed by a space unless a "." or "(" comes next (a.b, COUNT(x)).
    line += v
    if (toks[i + 1]?.v !== '.' && toks[i + 1]?.v !== '(') line += ' '
  }
  flush()
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export const minifySql = sql =>
  tokenize(sql).filter(t => t.t !== 'comment').map(t => t.v).join(' ').replace(/\s*([(),;.=<>])\s*/g, '$1').replace(/\b(AND|OR|ON|AS)\b/gi, ' $1 ').replace(/\s+/g, ' ').trim()

export function activate(api) {
  api.registerFormatter({ id: 'pretty', name: 'SQL: format', languages: ['sql'], format: t => formatSql(t) })
  api.registerFormatter({ id: 'lower', name: 'SQL: format (lower-case keywords)', languages: ['sql'], format: t => formatSql(t, { upper: false }) })
  api.registerFormatter({ id: 'minify', name: 'SQL: minify', languages: ['sql'], format: minifySql })
}
