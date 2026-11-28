import type { FontSource } from '../../../shared/design/fonts'
import { type Box, type Point, boundsOf } from '../../../shared/design/geometry'
import { cleanText, layoutText } from '../../../shared/design/text'
import type { Design, Layer } from '../../../shared/design/types'
import { type Matrix, apply, placeAll } from './selection'

// What `gdocs look` says about a design next to its pictures: problems an agent should fix, in plain sentences, naming
// each layer by name and id. Pure (no DOM), so it's tested on its own.

/** Most notes given; past it, one line says how many more there are. */
const MAX_NOTES = 20
/** How far past an edge counts as past it, in px (less is rounding). */
const SLACK = 0.5

const oneLine = (s: unknown): string => cleanText(String(s ?? '')).replace(/\s+/g, ' ').trim()
const clip = (s: string): string => (s.length > 48 ? `${s.slice(0, 45).trimEnd()}...` : s)
const named = (l: Layer): string => `layer ${oneLine(l.name) || l.type} (${l.id})`

/** A layer's box on the artboard, through its own and its groups' rotation and scale. */
function outline(box: Box, m: Matrix): Box {
  const corners: Point[] = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]]
  return boundsOf(corners.map(p => apply(m, p)))
}

/**
 * Notes for every artboard, in drawing order: visible text that doesn't fit its box (it runs past it), and visible
 * layers at the top of an artboard that go past its edge or sit wholly outside it (and so don't show).
 */
export function designNotes(design: Design, fonts: FontSource): string[] {
  const notes: string[] = []
  design.artboards.forEach((board, i) => {
    const where = `Artboard ${oneLine(board.name) || i + 1}`
    for (const p of placeAll(board.layers, board)) {
      if (p.hidden) continue
      const l = p.layer
      if (l.type === 'text' && layoutText(l, fonts).overflow) {
        const text = oneLine((l.runs ?? []).map(r => r?.text ?? '').join(''))
        notes.push(`${where}: the text "${clip(text)}" in ${named(l)} doesn't fit its box and runs past it.`)
      }
      if (p.ancestors.length) continue
      const b = outline(p.box, p.matrix)
      const W = board.width
      const H = board.height
      if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= W || b.y >= H) notes.push(`${where}: ${named(l)} is outside the artboard, so it doesn't show.`)
      else if (b.x < -SLACK || b.y < -SLACK || b.x + b.w > W + SLACK || b.y + b.h > H + SLACK) notes.push(`${where}: ${named(l)} goes past the edge of the artboard.`)
    }
  })
  if (notes.length <= MAX_NOTES) return notes
  return [...notes.slice(0, MAX_NOTES), `And ${notes.length - MAX_NOTES} more notes like these.`]
}
