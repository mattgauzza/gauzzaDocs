import fs from 'node:fs'
import path from 'node:path'
import { extOf, stem } from '../../shared/kinds'
import { bodyOf, htmlToMarkdown, joinFrontMatter, markdownToHtml, splitFrontMatter, wrapHtml } from '../../shared/convert'
import { splitInstructions, withInstructions } from '../instructions'

type DocPayload = { kind: 'doc'; html: string; lossy?: boolean; lossyReasons?: string[] }

/** Documents are edited as HTML. Markdown and Word files are converted on open and on save. */
export async function loadDoc(file: string): Promise<DocPayload> {
  const ext = extOf(file)
  if (ext === 'docx') return loadDocx(file)
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  // Agent instructions ride along in the file (see core/instructions.ts) but are not part of the editable text.
  if (ext === 'md' || ext === 'markdown') return { kind: 'doc', html: markdownToHtml(mdParts(file, text).markdown) || '<p></p>' }
  return { kind: 'doc', html: bodyOf(text) || '<p></p>' }
}

/**
 * A Markdown file's agent instructions and the Markdown without them. The instructions comment sits right after the
 * front matter when there is one (where this app writes it), or first in the file (where older versions wrote it).
 */
export function mdParts(file: string, text: string): { instructions: string; markdown: string } {
  const first = splitInstructions(file, text)
  if (first.instructions) return { instructions: first.instructions, markdown: first.rest }
  const { frontMatter, body } = splitFrontMatter(text)
  if (frontMatter === null) return { instructions: '', markdown: text }
  const inner = splitInstructions(file, body)
  return { instructions: inner.instructions, markdown: inner.instructions ? joinFrontMatter(frontMatter, inner.rest) : text }
}

// ---------------------------------------------------------------------------------------------------------------
// Word (.docx)
//
// mammoth turns the document into clean HTML but ignores text color, and has no way to emit inline styles. So before
// handing the file to mammoth, run formatting (font, size, color) and paragraph alignment are encoded into style
// names the style map turns into classes, and those classes are turned back into inline styles afterwards.
// ---------------------------------------------------------------------------------------------------------------

const ALIGN: Record<string, string> = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }
const BASE_STYLE_MAP = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => h2.subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "r[style-name='Code'] => code",
  "r[style-name='HTML Code'] => code",
  'u => u',
  'strike => s',
  'highlight => mark',
  "br[type='page'] => div.page-break"
]

type JSZipT = InstanceType<typeof import('jszip')>
const loadZip = async (bytes: Buffer): Promise<JSZipT> => {
  const JSZip = (await import('jszip')).default
  return JSZip.loadAsync(bytes)
}
const attr = (xml: string, tag: string, name: string) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

/** Rewrites document.xml so mammoth carries run formatting and alignment through as style names. */
function encodeFormatting(xml: string) {
  const runStyles: string[] = [] // index -> css
  const runKey = new Map<string, number>()
  // Runs: <w:r ...><w:rPr>...</w:rPr>
  xml = xml.replace(/(<w:r\b[^>]*>\s*)<w:rPr>([\s\S]*?)<\/w:rPr>/g, (_m, open: string, rpr: string) => {
    const css: string[] = []
    const font = attr(rpr, 'w:rFonts', 'w:ascii') || attr(rpr, 'w:rFonts', 'w:hAnsi')
    const sz = attr(rpr, 'w:sz', 'w:val')
    const color = attr(rpr, 'w:color', 'w:val')
    const shd = attr(rpr, 'w:shd', 'w:fill')
    if (font) css.push(`font-family: ${font}`)
    if (sz && /^\d+$/.test(sz)) css.push(`font-size: ${Number(sz) / 2}pt`)
    if (color && /^[0-9a-f]{6}$/i.test(color)) css.push(`color: #${color.toLowerCase()}`)
    if (shd && /^[0-9a-f]{6}$/i.test(shd) && !/<w:highlight\b/.test(rpr)) css.push(`background-color: #${shd.toLowerCase()}`)
    if (!css.length) return `${open}<w:rPr>${rpr}</w:rPr>`
    const key = css.join('; ')
    let n = runKey.get(key)
    if (n === undefined) {
      n = runStyles.length
      runStyles.push(key)
      runKey.set(key, n)
    }
    // The style name is what mammoth sees; a run's own character style (rare in practice) gives way to it.
    const cleaned = rpr.replace(/<w:rStyle\b[^>]*\/>/g, '')
    return `${open}<w:rPr><w:rStyle w:val="gdR${n}"/>${cleaned}</w:rPr>`
  })
  return { xml, runStyles }
}

/** styles.xml needs entries for the encoded style ids, or mammoth reports them as unknown and drops the name. */
function addStyles(stylesXml: string, runStyles: string[]) {
  const extra = runStyles.map((_, n) => `<w:style w:type="character" w:styleId="gdR${n}"><w:name w:val="gdR${n}"/></w:style>`).join('')
  return stylesXml.replace(/<\/w:styles>\s*$/, `${extra}</w:styles>`)
}

/** What this editor cannot keep from a Word file. An empty list means saving gives back an equivalent document. */
export async function docxLoss(zip: JSZipT, messages: { type: string; message: string }[] = []): Promise<string[]> {
  const reasons = new Set<string>()
  const text = async (name: string) => (zip.file(name) ? await zip.file(name)!.async('string') : '')
  const doc = await text('word/document.xml')
  const hasText = (xml: string) => /<w:t[^>]*>[^<]*\S[^<]*<\/w:t>/.test(xml) || /<w:drawing\b|<w:pict\b|PAGE/.test(xml)

  for (const name of Object.keys(zip.files)) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name) && hasText(await text(name))) reasons.add('headers or footers')
  }
  const notes = (await text('word/footnotes.xml')) + (await text('word/endnotes.xml'))
  if (/<w:(footnote|endnote)\b(?![^>]*w:type="(separator|continuationSeparator|continuationNotice)")[^>]*>/.test(notes)) reasons.add('footnotes or endnotes')
  if (/<w:comment\b/.test(await text('word/comments.xml'))) reasons.add('comments')
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(doc)) reasons.add('tracked changes')
  if (/<w:txbxContent\b/.test(doc)) reasons.add('text boxes')
  if (/<(wps:wsp|v:shape|v:rect|v:oval|v:line)\b/.test(doc) && !/<v:shape\b[^>]*>\s*<v:imagedata\b/.test(doc)) reasons.add('shapes')
  if (/<c:chart\b/.test(doc)) reasons.add('charts')
  if (/<dgm:relIds\b/.test(doc)) reasons.add('SmartArt')
  if (/<m:oMath\b/.test(doc)) reasons.add('equations')
  if (/<(w:object|o:OLEObject)\b/.test(doc)) reasons.add('embedded objects')
  if (/<w:instrText[^>]*>\s*TOC\b/.test(doc) || /<w:docPartGallery w:val="Table of Contents"/.test(doc)) reasons.add('a table of contents')
  else if (/<w:fldSimple\b|<w:instrText\b/.test(doc)) reasons.add('fields (page numbers, cross-references)')
  if (/<w:sdt>[\s\S]*?<w:(text|dropDownList|comboBox|date|checkbox|w14:checkbox)\b/.test(doc)) reasons.add('form fields')
  if ((doc.match(/<w:sectPr\b/g) || []).length > 1) reasons.add('multiple sections')
  const cols = doc.match(/<w:cols\b[^>]*w:num="(\d+)"/)
  if (cols && Number(cols[1]) > 1) reasons.add('columns')
  if (/<w:framePr\b/.test(doc)) reasons.add('positioned frames')
  for (const m of messages) if (/unrecognised element/i.test(m.message) && !/w:(proofErr|lastRenderedPageBreak|bookmark)/.test(m.message)) reasons.add('content this editor does not support')
  return [...reasons]
}

async function loadDocx(file: string): Promise<DocPayload> {
  const mammoth = await import('mammoth')
  const zip = await loadZip(fs.readFileSync(file))
  const docXml = await zip.file('word/document.xml')?.async('string')
  if (!docXml) throw new Error('This .docx has no document body')
  const { xml, runStyles } = encodeFormatting(docXml)
  zip.file('word/document.xml', xml)
  const styles = await zip.file('word/styles.xml')?.async('string')
  if (styles) zip.file('word/styles.xml', addStyles(styles, runStyles))
  else zip.file('word/styles.xml', addStyles('<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>', runStyles))
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })

  // Alignment: mammoth reads it into the paragraph model but never writes it. A marker run is put at the start of
  // each aligned paragraph and turned into text-align on the block afterwards.
  const styleMap = [...BASE_STYLE_MAP, ...runStyles.map((_, n) => `r[style-name='gdR${n}'] => span.gdr${n}`)]
  const marker = (a: string) => `⟦gda:${a}⟧`
  const plainRun = (text: string) => ({
    type: 'run', children: [{ type: 'text', value: text }], styleId: null, styleName: null, isBold: false, isItalic: false,
    isUnderline: false, isStrikethrough: false, isAllCaps: false, isSmallCaps: false, verticalAlignment: 'baseline', font: null, fontSize: null, highlight: null
  })
  const transformDocument = (mammoth as any).transforms.paragraph((p: any) => {
    const a = ALIGN[p.alignment]
    return a ? { ...p, children: [plainRun(marker(a)), ...p.children] } : p
  })

  const result = await mammoth.convertToHtml({ buffer }, { styleMap, transformDocument, includeDefaultStyleMap: true } as any)
  let html = result.value || '<p></p>'
  // Run formatting classes -> inline styles the editor understands.
  html = html.replace(/<span class="gdr(\d+)">/g, (_m, n) => `<span style="${runStyles[Number(n)]}">`)
  html = html.replace(/<(p|h[1-6])((?:\s[^>]*)?)>((?:<[^>]+>)*)⟦gda:(center|right|justify)⟧/g, (_m, tag: string, attrs: string, inner: string, a: string) => {
    const at = /style="/.test(attrs) ? attrs.replace(/style="/, `style="text-align: ${a}; `) : `${attrs} style="text-align: ${a}"`
    return `<${tag}${at}>${inner}`
  })
  html = html.replace(/⟦gda:\w+⟧/g, '')
  const lossyReasons = await docxLoss(await loadZip(fs.readFileSync(file)), result.messages as any)
  return { kind: 'doc', html, lossy: lossyReasons.length > 0, lossyReasons }
}

/** Editor HTML -> what html-to-docx reads best: highlights as background colors, strike as <del>, page breaks it knows. */
function forDocx(html: string) {
  return html
    .replace(/<mark\b([^>]*)>/g, (_m, attrs: string) => {
      const color = attrs.match(/background-color:\s*([^;"]+)/)?.[1] || attrs.match(/data-color="([^"]+)"/)?.[1] || '#ffff00'
      return `<span style="background-color: ${color}">`
    })
    .replace(/<\/mark>/g, '</span>')
    .replace(/<s>/g, '<del>')
    .replace(/<\/s>/g, '</del>')
    .replace(/<div class="page-break"[^>]*><\/div>/g, '<div class="page-break" style="page-break-after: always;"></div>')
}

export async function docBytes(file: string, html: string): Promise<Buffer> {
  const ext = extOf(file)
  if (ext === 'docx') {
    const { default: htmlToDocx } = await import('@turbodocx/html-to-docx')
    const out = await htmlToDocx(wrapHtml(forDocx(html), stem(file)), null, {
      title: stem(file),
      font: 'Arial',
      fontSize: 22, // half-points: 11pt, the editor's default
      margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
      table: { row: { cantSplit: true } },
      pageBreak: true
    })
    if (Buffer.isBuffer(out)) return out
    if (out instanceof ArrayBuffer) return Buffer.from(out)
    return Buffer.from(await (out as Blob).arrayBuffer())
  }
  if (ext === 'md' || ext === 'markdown') {
    let instructions = ''
    try {
      instructions = mdParts(file, fs.readFileSync(file, 'utf8')).instructions
    } catch { /* new file */ }
    // Front matter stays on line 1 (static-site tools and skill loaders look only there); instructions follow it.
    const { frontMatter, body } = splitFrontMatter(htmlToMarkdown(html))
    return Buffer.from(joinFrontMatter(frontMatter, withInstructions(file, body, instructions)))
  }
  // An existing HTML file keeps its own <head>; only the body is replaced.
  let page = wrapHtml(html, stem(file))
  try {
    const old = fs.readFileSync(file, 'utf8')
    if (/<body[^>]*>[\s\S]*<\/body>/i.test(old)) page = old.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i, (_m, a, b) => `${a}\n${html}\n${b}`)
  } catch { /* new file */ }
  return Buffer.from(page)
}

/** Where the untouched original of a Word file is kept before the first save that could lose something. */
export const backupPath = (file: string) => path.join(path.dirname(file), `${stem(file)}.original.docx`)

/** Keeps the untouched Word file beside it, once, when it holds things this editor would drop. Runs before the first save. */
export async function backupDocOriginal(file: string) {
  if (extOf(file) === 'docx' && fs.existsSync(file) && !fs.existsSync(backupPath(file))) {
    // Only when the file on disk holds something this editor drops; once saved here it no longer does, so this runs once.
    try {
      const reasons = await docxLoss(await loadZip(fs.readFileSync(file)))
      if (reasons.length) fs.copyFileSync(file, backupPath(file))
    } catch { /* not a readable docx: nothing worth backing up as Word */ }
  }
}

/** Saves through saveFile, so every write is atomic and keeps a version. */
export async function saveDoc(file: string, html: string) {
  const { saveFile } = await import('../files')
  await saveFile(file, { kind: 'doc', html })
}
