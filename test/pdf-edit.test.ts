import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib'
import { pdfLines, pdfOps, pdfText, replaceTextEdits } from '../src/core/ops/pdf'
import { removeTextInBoxes, tokenize } from '../src/shared/pdf/content'
import { applyPdfEdits, emptiedFirst, standardFontName } from '../src/shared/pdf/edits'
import { fillFields, listFields } from '../src/shared/pdf/forms'
import { applyPlan, guessFont, lineEdit, linesToHtml, paragraphsOf, planReplace } from '../src/shared/pdf/lines'
import { fitParagraph } from '../src/shared/pdf/wrap'
import type { FilePayload, PdfEdit } from '../src/shared/types'

async function letter() {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const times = await doc.embedFont(StandardFonts.TimesRomanBold)
  const p = doc.addPage([612, 792])
  p.drawText('Quarterly Report', { x: 72, y: 720, size: 24, font: times })
  p.drawText('Revenue grew 12 percent in Q3.', { x: 72, y: 680, size: 12, font: helv })
  p.drawText('The team shipped the editor', { x: 72, y: 664, size: 12, font: helv })
  p.drawText('on time and under budget.', { x: 72, y: 648, size: 12, font: helv })
  p.drawText('Total: 1,200', { x: 400, y: 680, size: 12, font: helv }) // a second column on the same baseline
  return doc.save()
}

async function contentOf(bytes: Uint8Array, page = 0) {
  const doc = await PDFDocument.load(bytes)
  const pg = doc.getPage(page)
  const c = pg.node.get(PDFName.of('Contents'))
  const looked = c && 'asArray' in (doc.context.lookup(c) as object) ? (doc.context.lookup(c) as unknown as { asArray(): unknown[] }).asArray() : [c]
  return looked
    .map(r => doc.context.lookup(r as never))
    .map(s => (s instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) : ''))
    .join('\n')
}

test('lines: grouped by baseline, split at column gaps, fonts guessed', async () => {
  const [lines] = await pdfLines(await letter(), 1)
  assert.deepEqual(lines.map(l => l.text), ['Quarterly Report', 'Revenue grew 12 percent in Q3.', 'Total: 1,200', 'The team shipped the editor', 'on time and under budget.'])
  const title = lines[0]
  assert.equal(title.font, 'serif')
  assert.equal(title.bold, true)
  assert.equal(Math.round(title.size), 24)
  assert.equal(lines[1].font, 'sans')
  assert.ok(Math.abs(lines[1].base - (792 - 680)) < 0.5, 'baseline in display coordinates')
  assert.ok(lines[1].y < lines[1].base && lines[1].y + lines[1].h > lines[1].base)
  assert.deepEqual(guessFont({ name: 'ABCDEF+CourierNewPS-BoldItalicMT' }), { font: 'mono', bold: true, italic: true })
})

test('replaceText removes the old words from the file and draws the new ones', async () => {
  const bytes = await letter()
  const [lines] = await pdfLines(bytes, 1)
  const out = await applyPdfEdits(bytes, [lineEdit(lines[1], 'Revenue grew 15 percent in Q3.', { bg: '#ff0000', color: '#0000ff' })])
  const text = (await pdfText(out))[0].text
  assert.doesNotMatch(text, /12 percent/, 'old text is gone from the content, not only covered')
  assert.match(text, /Revenue grew 15 percent in Q3\./)
  assert.match(text, /Total: 1,200/, 'the other column on the same baseline is untouched')
  assert.match(text, /The team shipped the editor/)
  const content = await contentOf(out)
  assert.match(content, /1 0 0 rg/, 'the sampled background color paints the cover')
  assert.match(content, /0 0 1 rg/, 'the new text uses the text color')
  // The redrawn line keeps its look: same baseline and a matching standard font.
  const [after] = await pdfLines(out, 1)
  const redrawn = after.find(l => l.text.startsWith('Revenue grew 15'))!
  assert.ok(Math.abs(redrawn.base - lines[1].base) < 0.5)
  assert.equal(standardFontName('serif', true, false), 'Times-Bold')
  const title = await applyPdfEdits(out, [lineEdit(lines[0], 'Annual Report')])
  const t = (await pdfLines(title, 1))[0].find(l => l.text === 'Annual Report')!
  assert.equal(t.font, 'serif')
  assert.equal(t.bold, true)
  // Deleting all the text removes the line.
  const gone = await applyPdfEdits(bytes, [lineEdit(lines[3], '')])
  assert.doesNotMatch((await pdfText(gone))[0].text, /shipped the editor/)
})

test('replaceText op: find within a line, all, and a clear error across paragraphs', async () => {
  const payload: FilePayload = { kind: 'pdf', bytes: await letter() }
  const r = await pdfOps(payload, { op: 'replaceText', page: 1, find: 'Q3', with: 'Q4' }, { path: 'x.pdf' })
  assert.match((await pdfText((r.payload as { bytes: Uint8Array }).bytes))[0].text, /percent in Q4\./)
  await assert.rejects(async () => pdfOps(payload, { op: 'replaceText', find: 'Report Revenue', with: 'x' }, { path: 'x.pdf' }), /aren't one paragraph/)
  await assert.rejects(async () => pdfOps(payload, { op: 'replaceText', find: 'nowhere', with: 'x' }, { path: 'x.pdf' }), /not found/)
  const all = await replaceTextEdits(payload.bytes, 'e', 'E', { all: true })
  assert.ok(all.count > 5 && all.edits.length >= 3)
  const tl = (await pdfOps(payload, { op: 'textLines', page: 1 }, { path: 'x.pdf' })).result as { lines: { id: string; text: string }[] }
  assert.equal(tl.lines[0].id, '1:0')
  const lines = (await pdfLines(payload.bytes, 1))[0]
  assert.throws(() => planReplace(lines, 'budget. extra', 'x'), /not found/)
})

test('paragraphs: a match across lines, or words that outgrow their line, rewrite and rewrap the paragraph', async () => {
  const bytes = await letter()
  const [lines] = await pdfLines(bytes, 1)
  const paras = paragraphsOf(lines)
  assert.deepEqual(paras.map(p => p.length), [1, 3, 1], 'title, the three body lines, the second column')
  // The left column's text in reading order (the "Total" column sits on the first body line's baseline).
  const flat = async (b: Uint8Array) => (await pdfLines(b, 1))[0].filter(l => l.x < 300).map(l => l.text).join(' ').replace(/\s+/g, ' ')
  const all = (b: Uint8Array) => pdfText(b).then(t => t[0].text)

  // Across two lines.
  const payload: FilePayload = { kind: 'pdf', bytes }
  const r = await pdfOps(payload, { op: 'replaceText', find: 'editor on time', with: 'new app ahead of time' }, { path: 'x.pdf' })
  const out = (r.payload as { bytes: Uint8Array }).bytes
  assert.match(await flat(out), /Revenue grew 12 percent in Q3\. The team shipped the new app ahead of time and under budget\./)
  assert.doesNotMatch(await flat(out), /editor/)
  assert.match(await all(out), /Total: 1,200/, 'the other column is untouched')

  // Inside one line, but too long for it now: the paragraph rewraps within its old width, more lines if it needs them.
  const plan = planReplace(lines, 'Q3', 'the third quarter, ahead of every forecast we made')
  assert.equal(plan[0].para?.length, 3)
  const right = Math.max(...plan[0].para!.map(l => l.x + l.w))
  const edits = applyPlan([], plan)
  const first = edits[0] as Extract<PdfEdit, { type: 'replaceText' }>
  const fit = fitParagraph(first)
  assert.ok(fit.lines.length >= 3 && fit.lines.length <= 4)
  const wrapped = await applyPdfEdits(bytes, edits)
  const after = (await pdfLines(wrapped, 1))[0].filter(l => l.x < 300 && l.size < 20) // the body, not the title
  assert.ok(after.every(l => l.x + l.w <= right + 1), 'no line runs past the old right edge')
  assert.match(await flat(wrapped), /in the third quarter, ahead of every forecast we made\. The team shipped the editor on time and under budget\./)

  // The emptied lines are written before the paragraph's new words, or they'd paint over them.
  const order = emptiedFirst([edits[0], ...edits.slice(1), { type: 'rotate', page: 1, degrees: 90 }, edits[0]])
  assert.deepEqual(order.map(e => (e.type === 'replaceText' ? (e.text ? 'para' : 'empty') : e.type)), ['empty', 'empty', 'para', 'rotate', 'para'])

  // A short change that still fits keeps every other line as it was.
  const small = planReplace(lines, 'Q3', 'Q4')
  assert.equal(small[0].para, undefined)
})

test('forms: list, fill, read back, flatten', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  const name = form.createTextField('applicant.name')
  name.addToPage(page, { x: 72, y: 700, width: 200, height: 20 })
  const agree = form.createCheckBox('agree')
  agree.addToPage(page, { x: 72, y: 660, width: 14, height: 14 })
  const size = form.createRadioGroup('size')
  size.addOptionToPage('S', page, { x: 72, y: 620, width: 14, height: 14 })
  size.addOptionToPage('L', page, { x: 100, y: 620, width: 14, height: 14 })
  const color = form.createDropdown('color')
  color.addOptions(['Red', 'Blue'])
  color.addToPage(page, { x: 72, y: 580, width: 120, height: 20 })
  const bytes = await doc.save()

  const fields = await listFields(bytes)
  assert.deepEqual(fields.map(f => [f.name, f.type]), [['applicant.name', 'text'], ['agree', 'checkbox'], ['size', 'radio'], ['color', 'dropdown']])
  const nameBox = fields[0].widgets[0]
  // pdf-lib widens the widget by half its 1pt border, so allow a point either way.
  assert.equal(nameBox.page, 1)
  for (const [got, want] of [[nameBox.x, 72], [nameBox.y, 792 - 720], [nameBox.w, 200], [nameBox.h, 20]]) assert.ok(Math.abs(got - want) <= 1, `${got} ~ ${want}`)
  assert.deepEqual(fields[2].options, ['S', 'L'])

  const payload: FilePayload = { kind: 'pdf', bytes }
  const r = await pdfOps(payload, { op: 'fillForm', fields: { 'applicant.name': 'Matt', agree: 'yes', size: 'L', color: 'Blue' } }, { path: 'f.pdf' })
  const filled = (r.payload as { bytes: Uint8Array }).bytes
  const back = Object.fromEntries((await listFields(filled)).map(f => [f.name, f.value]))
  assert.deepEqual(back, { 'applicant.name': 'Matt', agree: true, size: 'L', color: 'Blue' })
  await assert.rejects(() => fillFields(bytes, { nope: 'x' }), /No form field "nope"/)
  await assert.rejects(() => fillFields(bytes, { size: 'XL' }), /no option "XL"/)

  const flat = await fillFields(bytes, { 'applicant.name': 'Flat Name' }, { flatten: true })
  assert.equal((await listFields(flat)).length, 0, 'flatten removes the fields')
  assert.match((await pdfText(flat))[0].text, /Flat Name/, 'and keeps the value on the page')
})

test('content stream tokenizer survives strings, hex, dicts and inline images', () => {
  const src = new TextEncoder().encode(
    'q 1 0 0 1 0 0 cm BT /F1 12 Tf 72 700 Td (a \\) tricky (nested) string) Tj [(x) -20 <4142>] TJ ET ' +
      '/P <</MCID 0 /Alt <3c3e>>> BDC EMC BI /W 1 /H 1 /CS /G /BPC 8 ID \x00EI\x01 EI Q BT 1 0 0 1 72 600 Tm (keep) Tj ET'
  )
  const ops = tokenize(src).map(o => o.op)
  assert.deepEqual(ops, ['q', 'cm', 'BT', 'Tf', 'Td', 'Tj', 'TJ', 'ET', 'BDC', 'EMC', 'BI', 'Q', 'BT', 'Tm', 'Tj', 'ET'])
  const { bytes, removed } = removeTextInBoxes(src, [{ x0: 70, y0: 695, x1: 300, y1: 715 }])
  assert.equal(removed, 2)
  const out = new TextDecoder().decode(bytes)
  assert.doesNotMatch(out, /tricky/)
  assert.match(out, /\(keep\) Tj/)
})

test('open as document: paragraphs, headings and lists from lines', async () => {
  const doc = await PDFDocument.create()
  const f = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  const draw = (t: string, y: number, size = 11) => p.drawText(t, { x: 72, y, size, font: f, color: rgb(0, 0, 0) })
  draw('Launch plan', 720, 22)
  draw('We ship the editor in two weeks. The plan has three', 690)
  draw('parts and each one has an owner.', 676)
  draw('• Write the docs', 650)
  draw('• Record the demo', 636)
  draw('A new paragraph after a gap.', 600)
  p.drawText('Page 2 of 9', { x: 450, y: 600, size: 11, font: f }) // another column on the same line
  draw('Thanks again,', 570)
  draw('Matt', 556)
  const html = linesToHtml(await pdfLines(await doc.save()))
  assert.match(html, /<h1>Launch plan<\/h1>/)
  assert.match(html, /<p>We ship the editor in two weeks\. The plan has three parts and each one has an owner\.<\/p>/)
  assert.match(html, /<ul><li><p>Write the docs<\/p><\/li><li><p>Record the demo<\/p><\/li><\/ul>/)
  assert.match(html, /<p>A new paragraph after a gap\.<\/p>\n<p>Page 2 of 9<\/p>/)
  assert.match(html, /<p>Thanks again,<\/p>\n<p>Matt<\/p>/, 'a short line ends its paragraph')
})
