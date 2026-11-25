import fs from 'node:fs'
import path from 'node:path'
import { extOf, stem } from '../../shared/kinds'
import { deckToMarkdown, markdownToDeck } from '../../shared/slides/markdown'
import { DEFAULT_THEME, SLIDE_H, SLIDE_W, bg, newDeck, newId, r3 } from '../../shared/slides/model'
import type { Deck, DeckTheme, Slide, SlideElement, SlideLayout, SlidePara, SlideRun } from '../../shared/types'

/**
 * PowerPoint (.pptx) <-> Deck.
 *  - Writing uses pptxgenjs. Every element is named "gd|<id>|<role>|<layout>|<type>" and the theme, slide ids and
 *    layouts go in a standard custom document property ("gdocsDeck"), so a deck made here reads back exactly.
 *  - Reading is a small OOXML parser: slide order, text boxes and placeholders (with positions inherited from the
 *    layout and master), paragraphs, runs, bullets, pictures, basic shapes, lines, slide backgrounds and speaker notes.
 *  - Anything else (charts, SmartArt, tables, media, animations, ...) makes the payload lossy, with reasons; such files
 *    save only on Ctrl+S, and the first save keeps <name>.original.pptx.
 */
const EMU = 914400
const ZWSP = '​' // stands in for an empty paragraph's run, so its size and color survive the round trip

type JSZipT = InstanceType<typeof import('jszip')>
const loadZip = async (bytes: Buffer): Promise<JSZipT> => (await import('jszip')).default.loadAsync(bytes)

// ============================== writing ==============================

const hex = (c: string | undefined, fallback: string) => (c || fallback).replace('#', '').toUpperCase().slice(0, 6)

/** A picture as pptxgenjs wants it ("image/png;base64,..."); local paths and http(s) links are embedded. */
async function imageData(src: string, baseDir: string): Promise<string | null> {
  if (src.startsWith('data:')) return src.slice(5)
  const mimeOf = (p: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' })[extOf(p)] || 'image/png'
  try {
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) return null
      const type = res.headers.get('content-type')?.split(';')[0] || mimeOf(src)
      return `${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
    }
    const p = path.resolve(baseDir, src.replace(/^file:\/\//, ''))
    if (!fs.existsSync(p)) return null
    return `${mimeOf(p)};base64,${fs.readFileSync(p).toString('base64')}`
  } catch {
    return null
  }
}

export async function deckToPptx(deck: Deck, baseDir = process.cwd()): Promise<Buffer> {
  const { default: PptxGen } = await import('pptxgenjs')
  const pres = new PptxGen()
  pres.layout = 'LAYOUT_WIDE' // 13.333 x 7.5 in
  pres.theme = { headFontFace: deck.theme.headFont, bodyFontFace: deck.theme.bodyFont }
  for (const s of deck.slides) {
    const slide = pres.addSlide()
    slide.background = { color: hex(bg(s, deck), 'FFFFFF') }
    for (const el of s.elements) {
      const base = {
        x: el.x, y: el.y, w: el.w, h: el.h,
        rotate: el.rotation || 0,
        objectName: `gd|${el.id}|${el.role || ''}|${s.layout}|${el.type}`
      }
      const fill = el.fill ? { color: hex(el.fill, 'FFFFFF') } : undefined
      const line = el.stroke
        ? { color: hex(el.stroke, '000000'), width: el.strokeWidth ?? 1, ...(el.shape === 'arrow' ? { endArrowType: 'triangle' as const } : {}) }
        : el.shape === 'line' || el.shape === 'arrow'
          ? { color: '5F6368', width: el.strokeWidth ?? 1, ...(el.shape === 'arrow' ? { endArrowType: 'triangle' as const } : {}) }
          : undefined
      const shapeName = el.shape === 'arrow' ? 'line' : el.shape || 'rect'
      if (el.type === 'image') {
        const data = el.src ? await imageData(el.src, baseDir) : null
        if (data) slide.addImage({ data, ...base })
        continue
      }
      if (el.paras && el.paras.length) {
        slide.addText(runsFor(el.paras, deck), {
          ...base,
          valign: el.valign || 'top',
          ...(el.type === 'shape' ? { shape: shapeName as never, fill, line } : fill ? { fill } : {}),
          ...(el.type === 'text' && el.stroke ? { line } : {})
        })
      } else if (el.type === 'shape') slide.addShape(shapeName as never, { ...base, fill, line })
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  const raw = (await pres.write({ outputType: 'nodebuffer' })) as Buffer
  return withDeckProperty(raw, deck)
}

function runsFor(paras: SlidePara[], deck: Deck) {
  const out: { text: string; options: Record<string, unknown> }[] = []
  paras.forEach((p, pi) => {
    const runs = p.runs.length ? p.runs : [{ text: '' }]
    runs.forEach((r, ri) => {
      const last = ri === runs.length - 1
      out.push({
        text: r.text || (runs.length === 1 ? ZWSP : ''),
        options: {
          bold: !!r.b,
          italic: !!r.i,
          ...(r.u ? { underline: { style: 'sng' } } : {}),
          color: hex(r.color, deck.theme.text),
          fontSize: r.size ?? 18,
          ...(r.font ? { fontFace: r.font } : {}),
          ...(p.align ? { align: p.align } : {}),
          bullet: p.bullet === 'number' ? { type: 'number' } : p.bullet === 'bullet' ? true : false,
          ...(p.level ? { indentLevel: p.level } : {}),
          ...(last && pi < paras.length - 1 ? { breakLine: true } : {})
        }
      })
    })
  })
  return out
}

/** Adds the gdocsDeck custom document property (theme, slide ids, layouts) to a written .pptx. */
async function withDeckProperty(buf: Buffer, deck: Deck): Promise<Buffer> {
  const zip = await loadZip(buf)
  const meta = JSON.stringify({ v: 1, theme: deck.theme, ids: deck.slides.map(s => s.id), layouts: deck.slides.map(s => s.layout) })
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  zip.file(
    'docProps/custom.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="gdocsDeck"><vt:lpwstr>${xmlEsc(meta)}</vt:lpwstr></property></Properties>`
  )
  const ct = await zip.file('[Content_Types].xml')!.async('string')
  if (!ct.includes('/docProps/custom.xml'))
    zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'))
  const rels = await zip.file('_rels/.rels')!.async('string')
  if (!rels.includes('docProps/custom.xml'))
    zip.file('_rels/.rels', rels.replace('</Relationships>', '<Relationship Id="rIdGdocsCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ============================== reading ==============================

type El = Element
const kids = (n: El | null | undefined, local?: string): El[] => {
  const out: El[] = []
  if (!n) return out
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!local || (c as El).localName === local)) out.push(c as El)
  return out
}
const kid = (n: El | null | undefined, local: string) => kids(n, local)[0] || null
const path1 = (n: El | null | undefined, ...locals: string[]) => locals.reduce<El | null>((acc, l) => kid(acc, l), n || null)
const attr = (n: El | null | undefined, name: string) => (n && n.getAttribute(name)) || ''
const num0 = (s: string) => (s ? Number(s) : 0)

async function parseXml(zip: JSZipT, name: string): Promise<Document | null> {
  const f = zip.file(name)
  if (!f) return null
  const { DOMParser } = await import('@xmldom/xmldom')
  return new DOMParser().parseFromString(await f.async('string'), 'text/xml') as unknown as Document
}

async function relsOf(zip: JSZipT, part: string): Promise<Map<string, { type: string; target: string }>> {
  const dir = path.posix.dirname(part)
  const doc = await parseXml(zip, `${dir}/_rels/${path.posix.basename(part)}.rels`)
  const out = new Map<string, { type: string; target: string }>()
  if (!doc) return out
  for (const r of kids(doc.documentElement, 'Relationship')) {
    const t = attr(r, 'Target')
    out.set(attr(r, 'Id'), { type: attr(r, 'Type').split('/').pop() || '', target: attr(r, 'TargetMode') === 'External' ? t : path.posix.normalize(path.posix.join(dir, t)) })
  }
  return out
}

interface ThemeColors { [scheme: string]: string }

function colorOf(fillParent: El | null, scheme: ThemeColors): string | undefined {
  const solid = kid(fillParent, 'solidFill')
  if (!solid) return undefined
  const srgb = kid(solid, 'srgbClr')
  if (srgb) return `#${attr(srgb, 'val').toLowerCase()}`
  const sch = kid(solid, 'schemeClr')
  if (sch) {
    const v = attr(sch, 'val')
    const map: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }
    return scheme[map[v] || v]
  }
  const sys = kid(solid, 'sysClr')
  if (sys) return `#${(attr(sys, 'lastClr') || '000000').toLowerCase()}`
  return undefined
}

interface Ctx {
  zip: JSZipT
  scheme: ThemeColors
  scale: number
  reasons: Set<string>
  media: Map<string, string>
}

/** Position of a placeholder that has no xfrm of its own: from the slide's layout, then the master. */
async function inheritedXfrm(ctx: Ctx, slidePart: string, ph: El): Promise<El | null> {
  const type = attr(ph, 'type') || 'body'
  const idx = attr(ph, 'idx')
  const rels = await relsOf(ctx.zip, slidePart)
  const layout = [...rels.values()].find(r => r.type === 'slideLayout')?.target
  for (const part of [layout, layout ? [...(await relsOf(ctx.zip, layout)).values()].find(r => r.type === 'slideMaster')?.target : undefined]) {
    if (!part) continue
    const doc = await parseXml(ctx.zip, part)
    const tree = path1(doc?.documentElement as El, 'cSld', 'spTree')
    for (const sp of kids(tree, 'sp')) {
      const p = path1(sp, 'nvSpPr', 'nvPr', 'ph')
      if (!p) continue
      const t = attr(p, 'type') || 'body'
      const same = (idx && attr(p, 'idx') === idx) || t === type || (type === 'ctrTitle' && t === 'title') || (type === 'subTitle' && t === 'body')
      const x = path1(sp, 'spPr', 'xfrm')
      if (same && x) return x
    }
  }
  return null
}

/** One text run (a:r or a:fld). */
function readRun(r: El, ctx: Ctx): SlideRun {
  {
    const rPr = kid(r, 'rPr')
    const text = kids(r, 't').map(t => t.textContent || '').join('').replace(new RegExp(ZWSP, 'g'), '')
    const run: SlideRun = { text }
    if (attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true') run.b = true
    if (attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true') run.i = true
    const u = attr(rPr, 'u')
    if (u && u !== 'none') run.u = true
    const sz = attr(rPr, 'sz')
    if (sz) run.size = Number(sz) / 100
    const color = colorOf(rPr, ctx.scheme)
    if (color) run.color = color
    const latin = attr(kid(rPr, 'latin'), 'typeface')
    if (latin && !latin.startsWith('+')) run.font = latin
    return run
  }
}

function readParas(txBody: El | null, ctx: Ctx, defaultBullet: boolean): SlidePara[] {
  const paras: SlidePara[] = []
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr')
    const para: SlidePara = { runs: [] }
    const algn = attr(pPr, 'algn')
    if (algn) para.align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left'
    const lvl = num0(attr(pPr, 'lvl'))
    if (kid(pPr, 'buAutoNum')) para.bullet = 'number'
    else if (kid(pPr, 'buChar') || kid(pPr, 'buBlip')) para.bullet = 'bullet'
    else if (!kid(pPr, 'buNone') && defaultBullet) para.bullet = 'bullet'
    if (para.bullet) para.level = lvl
    else if (lvl) para.level = lvl
    // Line breaks inside a paragraph become paragraphs of their own (the model has no soft breaks).
    let current: SlideRun[] = []
    const flush = () => {
      const runs = current.length ? current : [{ text: '', ...(endSize(p) ? { size: endSize(p) } : {}) }]
      paras.push({ ...para, runs })
      current = []
    }
    for (const c of kids(p)) {
      if (c.localName === 'br') flush()
      else if (c.localName === 'r' || c.localName === 'fld') current.push(readRun(c, ctx))
    }
    flush()
  }
  return paras
}
const endSize = (p: El) => {
  const s = attr(kid(p, 'endParaRPr'), 'sz')
  return s ? Number(s) / 100 : undefined
}

function xfrmBox(x: El | null, ctx: Ctx) {
  const off = kid(x, 'off')
  const ext = kid(x, 'ext')
  const k = ctx.scale / EMU
  return {
    x: r3(num0(attr(off, 'x')) * k),
    y: r3(num0(attr(off, 'y')) * k),
    w: r3(num0(attr(ext, 'cx')) * k),
    h: r3(num0(attr(ext, 'cy')) * k),
    rotation: attr(x, 'rot') ? Math.round((Number(attr(x, 'rot')) / 60000) * 100) / 100 : undefined
  }
}

const SHAPES: Record<string, SlideElement['shape']> = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', line: 'line', straightConnector1: 'line' }

async function readTree(tree: El | null, slidePart: string, ctx: Ctx, out: SlideElement[], layoutHint: { layout?: SlideLayout; titles: number; bodies: number; ctr: boolean }) {
  const rels = await relsOf(ctx.zip, slidePart)
  for (const n of kids(tree)) {
    switch (n.localName) {
      case 'sp':
      case 'cxnSp': {
        const nv = kid(n, n.localName === 'sp' ? 'nvSpPr' : 'nvCxnSpPr')
        const name = attr(kid(nv, 'cNvPr'), 'name')
        const ours = name.startsWith('gd|') ? name.split('|') : null
        const ph = path1(nv, 'nvPr', 'ph')
        const phType = ph ? attr(ph, 'type') || 'body' : ''
        if (['dt', 'ftr', 'sldNum', 'hdr'].includes(phType)) {
          if (kids(kid(n, 'txBody'), 'p').some(p => (p.textContent || '').trim())) ctx.reasons.add('footers or slide numbers')
          break
        }
        const spPr = kid(n, 'spPr')
        let x: El | null = kid(spPr, 'xfrm')
        if (!x && ph) x = await inheritedXfrm(ctx, slidePart, ph)
        const box = xfrmBox(x, ctx)
        const prst = attr(kid(spPr, 'prstGeom'), 'prst') || (n.localName === 'cxnSp' ? 'line' : 'rect')
        if (kid(spPr, 'custGeom')) ctx.reasons.add('custom shapes')
        else if (!SHAPES[prst]) ctx.reasons.add(`shapes this editor draws as rectangles (${prst})`)
        if (kid(spPr, 'gradFill') || kid(spPr, 'pattFill') || kid(spPr, 'blipFill')) ctx.reasons.add('gradient or picture fills')
        const fill = colorOf(spPr, ctx.scheme)
        const ln = kid(spPr, 'ln')
        const stroke = ln && !kid(ln, 'noFill') ? colorOf(ln, ctx.scheme) : undefined
        const tail = attr(kid(ln, 'tailEnd'), 'type')
        let shape: SlideElement['shape'] = SHAPES[prst] || 'rect'
        if (shape === 'line' && tail && tail !== 'none') shape = 'arrow'
        const role: SlideElement['role'] = ours
          ? ((ours[2] || undefined) as SlideElement['role'])
          : phType === 'title' || phType === 'ctrTitle' ? 'title' : phType === 'subTitle' ? 'subtitle' : ph ? 'body' : undefined
        if (!ours && ph) {
          if (role === 'title') layoutHint.titles++
          if (role === 'body') layoutHint.bodies++
          if (phType === 'ctrTitle' || phType === 'subTitle') layoutHint.ctr = true
        }
        if (ours?.[3]) layoutHint.layout = ours[3] as SlideLayout
        const txBody = kid(n, 'txBody')
        const anchor = attr(kid(txBody, 'bodyPr'), 'anchor')
        const paras = txBody ? readParas(txBody, ctx, role === 'body' && !ours) : undefined
        const hasText = !!paras?.some(p => p.runs.some(r => r.text))
        const plainBox = !fill && !stroke && shape === 'rect'
        const type: SlideElement['type'] = (ours?.[4] as SlideElement['type']) || (plainBox || (ph && !fill) ? 'text' : 'shape')
        if (type === 'text' && !txBody) break
        const el: SlideElement = { id: ours?.[1] || newId(), type, ...box }
        if (el.rotation === undefined) delete el.rotation
        if (role) el.role = role
        if (txBody && (hasText || type === 'text' || paras?.length)) {
          el.paras = paras
          el.valign = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'
        }
        if (type === 'shape') {
          el.shape = shape
          if (fill) el.fill = fill
          if (stroke) el.stroke = stroke
          if (ln && attr(ln, 'w')) el.strokeWidth = Math.round((Number(attr(ln, 'w')) / 12700) * 100) / 100
          if (!el.paras || (!hasText && !ours)) delete el.paras, delete el.valign
        } else if (fill) el.fill = fill
        out.push(el)
        break
      }
      case 'pic': {
        const nv = kid(n, 'nvPicPr')
        const name = attr(kid(nv, 'cNvPr'), 'name')
        const ours = name.startsWith('gd|') ? name.split('|') : null
        const nvPr = kid(nv, 'nvPr')
        if (kids(nvPr).some(c => /videoFile|audioFile|media/i.test(c.localName))) ctx.reasons.add('video or audio')
        const embed = attr(path1(n, 'blipFill', 'blip'), 'r:embed')
        const target = rels.get(embed)?.target
        const src = target ? await mediaUrl(ctx, target) : undefined
        if (!src) {
          ctx.reasons.add('pictures in formats this editor cannot show')
          break
        }
        const el: SlideElement = { id: ours?.[1] || newId(), type: 'image', ...xfrmBox(path1(n, 'spPr', 'xfrm'), ctx), src }
        if (el.rotation === undefined) delete el.rotation
        if (ours?.[2]) el.role = ours[2] as SlideElement['role']
        if (ours?.[3]) layoutHint.layout = ours[3] as SlideLayout
        out.push(el)
        break
      }
      case 'grpSp': {
        ctx.reasons.add('grouped shapes (saved ungrouped)')
        // Flatten: child positions are in the group's child space; map them into the slide.
        const g = path1(n, 'grpSpPr', 'xfrm')
        const off = kid(g, 'off'), ext = kid(g, 'ext'), chOff = kid(g, 'chOff'), chExt = kid(g, 'chExt')
        const sx = num0(attr(chExt, 'cx')) ? num0(attr(ext, 'cx')) / num0(attr(chExt, 'cx')) : 1
        const sy = num0(attr(chExt, 'cy')) ? num0(attr(ext, 'cy')) / num0(attr(chExt, 'cy')) : 1
        const inner: SlideElement[] = []
        await readTree(n, slidePart, ctx, inner, layoutHint)
        const k = ctx.scale
        for (const el of inner) {
          el.x = r3(((el.x / k) * EMU - num0(attr(chOff, 'x'))) * sx / EMU * k + (num0(attr(off, 'x')) / EMU) * k)
          el.y = r3(((el.y / k) * EMU - num0(attr(chOff, 'y'))) * sy / EMU * k + (num0(attr(off, 'y')) / EMU) * k)
          el.w = r3(el.w * sx)
          el.h = r3(el.h * sy)
          out.push(el)
        }
        break
      }
      case 'graphicFrame': {
        const uri = attr(path1(n, 'graphic', 'graphicData'), 'uri')
        ctx.reasons.add(/table/.test(uri) ? 'tables' : /chart/.test(uri) ? 'charts' : /diagram/.test(uri) ? 'SmartArt' : 'embedded objects')
        break
      }
      case 'AlternateContent':
        ctx.reasons.add('content this editor cannot show')
        break
    }
  }
}

async function mediaUrl(ctx: Ctx, target: string) {
  if (ctx.media.has(target)) return ctx.media.get(target)
  const f = ctx.zip.file(target)
  if (!f) return undefined
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' } as Record<string, string>)[extOf(target)]
  if (!mime) return undefined // emf / wmf / tiff
  const url = `data:${mime};base64,${await f.async('base64')}`
  ctx.media.set(target, url)
  return url
}

async function readNotes(zip: JSZipT, slidePart: string): Promise<string> {
  const rels = await relsOf(zip, slidePart)
  const notesPart = [...rels.values()].find(r => r.type === 'notesSlide')?.target
  if (!notesPart) return ''
  const doc = await parseXml(zip, notesPart)
  const tree = path1(doc?.documentElement as El, 'cSld', 'spTree')
  for (const sp of kids(tree, 'sp')) {
    const ph = path1(sp, 'nvSpPr', 'nvPr', 'ph')
    if (attr(ph, 'type') !== 'body') continue
    return kids(kid(sp, 'txBody'), 'p').map(p => kids(p, 'r').map(r => kids(r, 't').map(t => t.textContent || '').join('')).join('')).join('\n').trim()
  }
  return ''
}

async function readTheme(zip: JSZipT, presPart: string): Promise<{ theme: DeckTheme; scheme: ThemeColors }> {
  const rels = await relsOf(zip, presPart)
  const themePart = [...rels.values()].find(r => r.type === 'theme')?.target
  const doc = themePart ? await parseXml(zip, themePart) : null
  const scheme: ThemeColors = {}
  const clr = doc ? (doc.getElementsByTagNameNS('*', 'clrScheme')[0] as El | undefined) : undefined
  for (const c of kids(clr)) {
    const srgb = kid(c, 'srgbClr')
    const sys = kid(c, 'sysClr')
    scheme[c.localName] = `#${(srgb ? attr(srgb, 'val') : attr(sys, 'lastClr') || '000000').toLowerCase()}`
  }
  const font = (tag: string) => {
    const f = doc?.getElementsByTagNameNS('*', tag)[0] as El | undefined
    return attr(kid(f, 'latin'), 'typeface') || DEFAULT_THEME.bodyFont
  }
  return {
    scheme,
    theme: {
      name: 'From file',
      headFont: font('majorFont'),
      bodyFont: font('minorFont'),
      text: scheme.dk1 || DEFAULT_THEME.text,
      accent: scheme.accent1 || DEFAULT_THEME.accent,
      background: scheme.lt1 || DEFAULT_THEME.background
    }
  }
}

async function readDeckProperty(zip: JSZipT): Promise<{ theme?: DeckTheme; ids?: string[]; layouts?: SlideLayout[] } | null> {
  const doc = await parseXml(zip, 'docProps/custom.xml')
  if (!doc) return null
  for (const p of kids(doc.documentElement, 'property')) {
    if (attr(p, 'name') !== 'gdocsDeck') continue
    try {
      return JSON.parse(kids(p)[0]?.textContent || '')
    } catch {
      return null
    }
  }
  return null
}

/** What this editor can't keep from a .pptx (charts, media, ...). Cheap: looks at part names and slide XML only. */
export async function pptxLoss(zip: JSZipT): Promise<string[]> {
  const reasons = new Set<string>()
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
  if (names.some(n => /^ppt\/charts\/chart\d*\.xml$/.test(n))) reasons.add('charts')
  if (names.some(n => /^ppt\/diagrams\//.test(n))) reasons.add('SmartArt')
  if (names.some(n => /^ppt\/embeddings\//.test(n))) reasons.add('embedded objects')
  if (names.some(n => /^ppt\/(comments|commentAuthors)/.test(n))) reasons.add('PowerPoint comments')
  if (names.some(n => /^ppt\/media\/.*\.(mp4|mov|wmv|avi|m4v|mp3|wav|m4a)$/i.test(n))) reasons.add('video or audio')
  for (const n of names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const x = await zip.file(n)!.async('string')
    if (/<p:timing\b/.test(x)) reasons.add('animations')
    if (/<p:transition\b/.test(x)) reasons.add('slide transitions')
    if (/<a:tbl\b/.test(x)) reasons.add('tables')
    if (/<p:grpSp\b/.test(x)) reasons.add('grouped shapes (saved ungrouped)')
    if (/<a:custGeom\b/.test(x)) reasons.add('custom shapes')
    if (/<a:gradFill\b/.test(x)) reasons.add('gradient or picture fills')
  }
  for (const n of names.filter(n => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n))) {
    if (/<p:pic\b/.test(await zip.file(n)!.async('string'))) reasons.add('pictures on the slide master (logos)')
  }
  return [...reasons]
}

export async function pptxToDeck(bytes: Buffer): Promise<{ deck: Deck; reasons: string[] }> {
  const zip = await loadZip(bytes)
  const presPart = 'ppt/presentation.xml'
  const pres = await parseXml(zip, presPart)
  if (!pres) throw new Error('This .pptx has no presentation part')
  const root = pres.documentElement as El
  const sz = kid(root, 'sldSz')
  const cx = num0(attr(sz, 'cx')) || SLIDE_W * EMU
  const cy = num0(attr(sz, 'cy')) || SLIDE_H * EMU
  const scale = SLIDE_W / (cx / EMU)
  const { theme: fileTheme, scheme } = await readTheme(zip, presPart)
  const meta = await readDeckProperty(zip)
  const ctx: Ctx = { zip, scheme, scale, reasons: new Set(await pptxLoss(zip)), media: new Map() }
  if (Math.abs(cx / cy - SLIDE_W / SLIDE_H) > 0.01) ctx.reasons.add('a slide size other than 16:9 (fitted to widescreen)')
  const theme = meta?.theme || fileTheme
  const rels = await relsOf(zip, presPart)
  const order = kids(kid(root, 'sldIdLst'), 'sldId').map(s => rels.get(attr(s, 'r:id'))?.target).filter((t): t is string => !!t)
  const slides: Slide[] = []
  for (const [i, part] of order.entries()) {
    const doc = await parseXml(zip, part)
    if (!doc) continue
    const cSld = kid(doc.documentElement as El, 'cSld')
    const bgPr = path1(cSld, 'bg', 'bgPr')
    if (kid(bgPr, 'blipFill') || kid(bgPr, 'gradFill')) ctx.reasons.add('background pictures or gradients')
    const background = colorOf(bgPr, scheme)
    const hint = { titles: 0, bodies: 0, ctr: false } as { layout?: SlideLayout; titles: number; bodies: number; ctr: boolean }
    const elements: SlideElement[] = []
    await readTree(kid(cSld, 'spTree'), part, ctx, elements, hint)
    const layout: SlideLayout =
      meta?.layouts && meta.layouts.length === order.length ? meta.layouts[i]
        : hint.layout || (hint.ctr ? 'title' : hint.bodies >= 2 ? 'twoColumn' : hint.titles && hint.bodies ? 'titleBody' : hint.titles ? 'section' : 'blank')
    const slide: Slide = {
      id: meta?.ids && meta.ids.length === order.length ? meta.ids[i] : newId('s'),
      layout,
      elements,
      notes: await readNotes(zip, part)
    }
    if (background && background.toLowerCase() !== theme.background.toLowerCase()) slide.background = background
    slides.push(slide)
  }
  return { deck: { size: { w: SLIDE_W, h: SLIDE_H }, theme, slides: slides.length ? slides : newDeck(theme).slides }, reasons: [...ctx.reasons] }
}

// ============================== files ==============================

export async function loadSlides(file: string): Promise<{ kind: 'slides'; deck: Deck; lossy?: boolean; lossyReasons?: string[] }> {
  const buf = fs.readFileSync(file)
  if (!buf.length) return { kind: 'slides', deck: newDeck(), lossy: false, lossyReasons: [] }
  const { deck, reasons } = await pptxToDeck(buf)
  return { kind: 'slides', deck, lossy: reasons.length > 0, lossyReasons: reasons }
}

/** Where the untouched original of a presentation is kept before the first save that could lose something. */
export const slidesBackupPath = (file: string) => path.join(path.dirname(file), `${stem(file)}.original.pptx`)

export async function saveSlides(file: string, deck: Deck) {
  const ext = extOf(file)
  if (ext === 'md' || ext === 'markdown') return fs.writeFileSync(file, deckToMarkdown(deck))
  if (ext === 'pptx' && fs.existsSync(file) && fs.statSync(file).size && !fs.existsSync(slidesBackupPath(file))) {
    try {
      // Files this editor wrote (they carry the gdocsDeck property) only need the cheap check; others get a full read.
      const buf = fs.readFileSync(file)
      const zip = await loadZip(buf)
      let lose = (await pptxLoss(zip)).length > 0
      if (!lose && !(await readDeckProperty(zip))) lose = (await pptxToDeck(buf)).reasons.length > 0
      if (lose) fs.copyFileSync(file, slidesBackupPath(file))
    } catch { /* not a readable pptx: nothing worth keeping */ }
  }
  const tmp = `${file}.gd-${process.pid}.tmp`
  fs.writeFileSync(tmp, await deckToPptx(deck, path.dirname(file)))
  fs.renameSync(tmp, file)
}

/** A deck from Markdown (gdocs slides from-md). */
export const deckFromMarkdown = (md: string, theme?: DeckTheme) => markdownToDeck(md, theme)
