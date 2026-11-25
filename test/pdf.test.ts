import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pdfInfo, pdfOps, pdfText } from '../src/core/ops/pdf'
import { applyPdfEdits, parsePages } from '../src/shared/pdf/edits'
import type { FilePayload } from '../src/shared/types'

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function sample(pages = 3) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Page ${i} heading`, { x: 72, y: 720, size: 18, font })
    p.drawText(`Body text on page ${i}`, { x: 72, y: 690, size: 12, font })
  }
  return doc.save()
}

test('parsePages', () => {
  assert.deepEqual(parsePages('1-3,5', 6), [1, 2, 3, 5])
  assert.deepEqual(parsePages(undefined, 2), [1, 2])
  assert.deepEqual(parsePages('2-end', 4), [2, 3, 4])
  assert.throws(() => parsePages('9', 3))
  assert.throws(() => parsePages('x', 3))
})

test('every edit type applies', async () => {
  const bytes = await sample(3)
  const out = await applyPdfEdits(bytes, [
    { type: 'text', page: 1, x: 72, y: 100, text: 'Approved by agent\nsecond line ✓', size: 14, color: '#d93025' },
    { type: 'highlight', page: 1, x: 70, y: 60, w: 200, h: 22 },
    { type: 'rect', page: 1, x: 300, y: 300, w: 100, h: 50 },
    { type: 'rect', page: 2, x: 72, y: 95, w: 200, h: 20, fill: '#ffffff' },
    { type: 'ink', page: 1, points: [[100, 400], [150, 420], [200, 400]], width: 3 },
    { type: 'image', page: 1, x: 400, y: 500, w: 50, h: 50, png: PNG_1x1 },
    { type: 'rotate', page: 2, degrees: 90 },
    { type: 'text', page: 2, x: 50, y: 50, text: 'On rotated page' },
    { type: 'move', page: 3, to: 1 },
    { type: 'delete', page: 3 }
  ])
  const info = await pdfInfo(out)
  assert.equal(info.pages, 2)
  // old page 3 moved to the front; old page 1 is now page 2; old page 2 (rotated) was deleted
  assert.equal(info.sizes[0].rotation, 0)
  const text = await pdfText(out)
  assert.match(text[0].text, /Page 3 heading/)
  assert.match(text[1].text, /Page 1 heading/)
  assert.match(text[1].text, /Approved by agent/)
  assert.match(text[1].text, /second line \?/) // non-WinAnsi glyph replaced, not fatal
})

test('rotated page text lands upright and inside the page', async () => {
  const out = await applyPdfEdits(await sample(1), [
    { type: 'rotate', page: 1, degrees: 90 },
    { type: 'text', page: 1, x: 40, y: 40, text: 'Corner note' }
  ])
  const info = await pdfInfo(out)
  assert.deepEqual([info.sizes[0].w, info.sizes[0].h, info.sizes[0].rotation], [792, 612, 90])
  assert.match((await pdfText(out))[0].text, /Corner note/)
})

test('offline op handler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpdf-'))
  const other = path.join(dir, 'other.pdf')
  fs.writeFileSync(other, await sample(2))
  const payload: FilePayload = { kind: 'pdf', bytes: await sample(3) }
  const ctx = { path: path.join(dir, 'main.pdf') }

  const info = (await pdfOps(payload, { op: 'info' }, ctx)).result as { pages: number }
  assert.equal(info.pages, 3)
  const read = (await pdfOps(payload, { op: 'read', pages: '2' }, ctx)).result as { content: string }
  assert.match(read.content, /--- Page 2 ---\nPage 2 heading\nBody text on page 2/)

  const rot = await pdfOps(payload, { op: 'rotate', pages: '1,3', degrees: 180 }, ctx)
  assert.deepEqual((await pdfInfo((rot.payload as { bytes: Uint8Array }).bytes)).sizes.map(s => s.rotation), [180, 0, 180])

  const del = await pdfOps(payload, { op: 'deletePages', pages: '1-2' }, ctx)
  assert.equal((del.result as { pages: number }).pages, 1)
  await assert.rejects(async () => pdfOps(payload, { op: 'deletePages', pages: '1-3' }, ctx))

  const merged = await pdfOps(payload, { op: 'merge', files: ['other.pdf'] }, ctx)
  assert.equal((merged.result as { pages: number }).pages, 5)

  const ann = await pdfOps(payload, { op: 'annotate', edits: [{ type: 'text', page: 1, x: 72, y: 200, text: 'Signed' }] }, ctx)
  assert.match((await pdfText((ann.payload as { bytes: Uint8Array }).bytes, '1'))[0].text, /Signed/)
  await assert.rejects(async () => pdfOps(payload, { op: 'annotate', edits: [{ type: 'oops', page: 1 }] }, ctx), /Unknown edit type/)
  await assert.rejects(async () => pdfOps(payload, { op: 'write', content: 'x' }, ctx))
})
