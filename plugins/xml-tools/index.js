// Indents markup one tag per line. Leaves <pre>, <script>, <style>, <textarea>, comments and CDATA untouched.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW = /^<(pre|script|style|textarea)\b/i

function pretty(src, indent = '  ') {
  const tokens = src.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(pre|script|style|textarea)\b[\s\S]*?<\/\1>|<[^>]+>|[^<]+/gi) || []
  let depth = 0
  const out = []
  for (const raw of tokens) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      // Keep short elements like <b>text</b> on one line.
      const text = out[out.length - 1]
      const open = out[out.length - 2]
      if (text !== undefined && open !== undefined && !text.trim().startsWith('<') && /^<[^/!?]/.test(open.trim()) && !open.trim().endsWith('/>')) {
        out.pop()
        out[out.length - 1] += text.trim() + t
        continue
      }
      out.push(indent.repeat(depth) + t)
    } else if (/^<[!?]/.test(t) || t.endsWith('/>') || RAW.test(t)) {
      out.push(indent.repeat(depth) + t)
    } else if (t.startsWith('<')) {
      out.push(indent.repeat(depth) + t)
      const name = (t.match(/^<([\w:-]+)/) || [])[1] || ''
      if (!VOID.has(name.toLowerCase())) depth++
    } else {
      out.push(indent.repeat(depth) + t.replace(/\s+/g, ' '))
    }
  }
  return out.join('\n') + '\n'
}

export function activate(api) {
  api.registerFormatter({ id: 'pretty', name: 'Markup: indent', languages: ['xml', 'html', 'vue'], format: t => pretty(t) })
  api.registerFormatter({ id: 'minify', name: 'XML: minify', languages: ['xml'], format: t => t.replace(/>\s+</g, '><').trim() })
}
