import assert from 'node:assert/strict'
import { test } from 'node:test'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pdfLines } from '../src/core/ops/pdf'
import { systemFontBytes, systemFontFile } from '../src/core/systemFonts'
import { applyPdfEdits } from '../src/shared/pdf/edits'
import { baseFontName, fontKey } from '../src/shared/pdf/fontNames'
import { applyPlan, planReplace } from '../src/shared/pdf/lines'

test('font names: a PDF font name matches the installed font it came from', () => {
  assert.equal(baseFontName('ABCDEF+Calibri-Bold'), 'Calibri-Bold')
  assert.equal(baseFontName('ArialMT-9750'), 'ArialMT', 'the number pdf-lib adds to fonts it embeds')
  for (const [pdf, installed] of [
    ['ABCDEF+Calibri-Bold', 'Calibri Bold (TrueType)'],
    ['Calibri,Bold', 'Calibri Bold (TrueType)'],
    ['Arial-BoldItalicMT', 'Arial Bold Italic (TrueType)'],
    ['TimesNewRomanPSMT', 'Times New Roman (TrueType)'],
    ['SegoeUI-Semibold', 'Segoe UI Semibold (TrueType)'],
    ['Calibri-Regular', 'Calibri (TrueType)'],
    ['Helvetica-Oblique', 'Helvetica Italic']
  ])
    assert.equal(fontKey(pdf), fontKey(installed), `${pdf} ~ ${installed}`)
  assert.notEqual(fontKey('Calibri-Bold'), fontKey('Calibri'))
})

test('installed fonts: edited text is written in the PDF font when it is on this PC', async t => {
  const arial = await systemFontBytes('ArialMT')
  if (!arial) return t.skip('Arial is not installed here')
  assert.match(String(await systemFontFile('Arial-BoldMT')), /\.ttf$/i)

  // The preview measures with fontkit the way pdf-lib does when it embeds the font, so lines wrap the same.
  const probe = await PDFDocument.create()
  probe.registerFontkit(fontkit)
  const embedded = await probe.embedFont(arial, { subset: true })
  const font = fontkit.create(arial)
  const text = 'Walled engagements keep each client apart.'
  let units = 0
  for (const g of font.layout(text).glyphs) units += g.advanceWidth
  assert.ok(Math.abs((units * 15) / font.unitsPerEm - embedded.widthOfTextAtSize(text, 15)) < 0.001)

  // A line whose font is Arial: the replacement is drawn in Arial, not Helvetica.
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const f = await doc.embedFont(arial, { subset: true })
  const p = doc.addPage([612, 792])
  p.drawText('Revenue grew 12 percent in Q3.', { x: 72, y: 680, size: 12, font: f })
  p.drawText('The team shipped the editor', { x: 72, y: 664, size: 12, font: f })
  p.drawText('on time and under budget.', { x: 72, y: 648, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) })
  const bytes = await doc.save()
  const [lines] = await pdfLines(bytes, 1)
  assert.match(String(lines[0].fontName), /Arial/)
  const out = await applyPdfEdits(bytes, applyPlan([], planReplace(lines, 'Q3', 'Q4')), { fontFile: systemFontBytes })
  const after = (await pdfLines(out, 1))[0].find(l => l.text.includes('Q4'))!
  assert.match(String(after.fontName), /Arial/, 'written in the installed Arial')
  const plain = await applyPdfEdits(bytes, applyPlan([], planReplace(lines, 'Q3', 'Q4')))
  assert.match(String((await pdfLines(plain, 1))[0].find(l => l.text.includes('Q4'))!.fontName), /Helvetica/, 'no provider: the standard font')
})
