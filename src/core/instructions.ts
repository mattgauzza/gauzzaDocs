import fs from 'node:fs'
import path from 'node:path'
import { extOf } from '../shared/kinds'
import { type WriteContext, guardedWrite, writeAtomic } from './history'
import { HOME, norm, samePath } from './paths'

/**
 * Standing instructions for agents, in two layers:
 *  - global: ~/.gauzzadocs/agent.md, applies to every file (e.g. "look up my writing voice first").
 *  - per file: stored invisibly inside the file where the format allows, so they travel with it:
 *      .html  <script type="text/x-gdocs-instructions"> in <head> (never runs, never shows)
 *      .md    a leading <!-- gdocs:instructions ... --> comment (hidden when rendered)
 *    Other formats (docx, xlsx, pdf, code) keep them in ~/.gauzzadocs/instructions.json, keyed by path.
 * Agents read both with `gdocs instructions <file>`; `gdocs read --json` includes them too.
 */
export const GLOBAL_FILE = path.join(HOME, 'agent.md')
const STORE = path.join(HOME, 'instructions.json')

const HTML_RE = /<script type="text\/x-gdocs-instructions">([\s\S]*?)<\/script>\s*/i
const MD_RE = /^\s*<!--\s*gdocs:instructions\r?\n([\s\S]*?)\r?\n-->[ \t]*\r?\n?/

const FRONT = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
/** YAML front matter (kept first, as tools expect) and everything after it. */
const splitHead = (text: string) => {
  const m = text.match(FRONT)
  return m ? { head: m[0], body: text.slice(m[0].length) } : { head: '', body: text }
}

export const inFile = (file: string) => ['html', 'htm', 'md', 'markdown'].includes(extOf(file))

export function getGlobal(): string {
  try {
    return fs.readFileSync(GLOBAL_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}
export function setGlobal(text: string) {
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, text.trim() ? text.trim() + '\n' : '')
}

const readStore = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}
const storeKey = (store: Record<string, string>, file: string) => Object.keys(store).find(k => samePath(k, file))

/** Instructions held in an HTML or Markdown file's text (and the text without them). */
export function splitInstructions(file: string, text: string): { instructions: string; rest: string } {
  const ext = extOf(file)
  if (ext === 'md' || ext === 'markdown') {
    // The block sits at the top, or right after YAML front matter (which must stay on line 1).
    const { head, body } = splitHead(text)
    const m = body.match(MD_RE)
    return m ? { instructions: m[1].trim(), rest: head + body.slice(m[0].length) } : { instructions: '', rest: text }
  }
  const m = text.match(HTML_RE)
  return m ? { instructions: m[1].replace(/<\\\//g, '</').trim(), rest: text.replace(HTML_RE, '') } : { instructions: '', rest: text }
}

/** Puts instructions into HTML/Markdown text (replacing any there), or removes them when empty. */
export function withInstructions(file: string, text: string, instructions: string): string {
  const { rest } = splitInstructions(file, text)
  const t = instructions.trim()
  if (!t) return rest
  const ext = extOf(file)
  if (ext === 'md' || ext === 'markdown') {
    const { head, body } = splitHead(rest)
    return `${head}<!-- gdocs:instructions\n${t.replace(/-->/g, '-- >')}\n-->\n${body}`
  }
  const block = `<script type="text/x-gdocs-instructions">\n${t.replace(/<\//g, '<\\/')}\n</script>\n`
  if (/<\/head>/i.test(rest)) return rest.replace(/<\/head>/i, `${block}</head>`)
  if (/<html[^>]*>/i.test(rest)) return rest.replace(/(<html[^>]*>)/i, `$1\n<head>\n${block}</head>`)
  return block + rest
}

export function getDocInstructions(file: string): string {
  const p = norm(file)
  if (inFile(p)) {
    try {
      return splitInstructions(p, fs.readFileSync(p, 'utf8')).instructions
    } catch {
      return ''
    }
  }
  const store = readStore()
  const k = storeKey(store, p)
  return k ? store[k] : ''
}

/** HTML and Markdown files are rewritten through the recorder (a version is kept); other kinds use the store. Resolves with the file's new mtime, or 0 for the store. */
export async function setDocInstructions(file: string, text: string, ctx: WriteContext = { authors: [{ name: 'Agent', by: 'agent' }] }): Promise<number> {
  const p = norm(file)
  if (inFile(p)) {
    const st = await guardedWrite(p, ctx, async () => {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
      const bytes = Buffer.from(withInstructions(p, cur, text))
      await writeAtomic(p, bytes)
      return bytes
    })
    return st.mtime
  }
  const store = readStore()
  const k = storeKey(store, p)
  if (k) delete store[k]
  if (text.trim()) store[p] = text.trim()
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2))
  return 0
}

/** Keeps store-held instructions with a file when the app renames it. */
export function renameInstructions(from: string, to: string) {
  if (inFile(to)) return
  const store = readStore()
  const k = storeKey(store, from)
  if (!k) return
  store[norm(to)] = store[k]
  delete store[k]
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2))
}

export function instructionsFor(file?: string) {
  return {
    global: getGlobal(),
    file: file ? getDocInstructions(file) : '',
    stored: file ? (inFile(file) ? 'in the file' : 'in app data') : undefined
  }
}
