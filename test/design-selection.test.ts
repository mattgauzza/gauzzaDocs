import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Artboard, Layer } from '../src/shared/design/types'
import { type Handle, apply, handlePoints, hitTest, marquee, placeAll, resizeBox } from '../src/renderer/src/design/selection'

// The design canvas's hit testing and handle math: pure, in artboard coordinates.

const base = { visible: true, locked: false, opacity: 1, blend: 'normal' as const, rotation: 0, scaleX: 1, scaleY: 1 }
const rect = (id: string, x: number, y: number, w: number, h: number, more: Partial<Layer> = {}): Layer =>
  ({ ...base, id, name: id, type: 'rect', x, y, width: w, height: h, fill: { type: 'color', color: '#cccccc' }, ...more }) as Layer
const group = (id: string, children: Layer[], more: Partial<Layer> = {}): Layer => {
  const xs = children.flatMap(c => [c.x, c.x + c.width])
  const ys = children.flatMap(c => [c.y, c.y + c.height])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { ...base, id, name: id, type: 'group', x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, children, ...more } as Layer
}
const board = (...layers: Layer[]): Artboard => ({ id: 'ab', name: 'Board', width: 1000, height: 1000, background: null, layers })
const ids = (ls: Layer[]) => ls.map(l => l.id).sort()
// resizeBox rounds to a millionth of a pixel, so a corner it keeps fixed comes back within that
const close = (a: number[], b: number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-4, `${a} vs ${b}`))

test('the hit test respects rotation: inside the rotated box hits, the unrotated corner does not', () => {
  // a 100 x 100 square at 100,100 turned 45 degrees: a diamond reaching 79.3 up and down from its center at 150,150
  const b = board(rect('sq', 100, 100, 100, 100, { rotation: 45 }))
  assert.equal(hitTest(b, [150, 85])?.id, 'sq') // above the unrotated box, inside the diamond
  assert.equal(hitTest(b, [105, 105]), null) // inside the unrotated box's corner, outside the diamond
  assert.equal(hitTest(b, [150, 150])?.id, 'sq')
})

test("a group's rotation turns its children too", () => {
  // children are stored in artboard coordinates and drawn through the group's transform (rotation about its center)
  const g = group('g', [rect('a', 0, 0, 100, 20), rect('b', 0, 80, 100, 20)], { rotation: 90 })
  const b = board(g)
  // turned a quarter about 50,50: a (top strip) now runs down the right side, b down the left
  assert.equal(hitTest(b, [90, 50], { scope: 'g' })?.id, 'a')
  assert.equal(hitTest(b, [10, 50], { scope: 'g' })?.id, 'b')
  assert.equal(hitTest(b, [50, 10], { scope: 'g' }), null) // where a was before the turn
})

test('the topmost layer wins, and hidden and locked layers are skipped', () => {
  const back = rect('back', 0, 0, 200, 200)
  const front = rect('front', 100, 100, 200, 200)
  assert.equal(hitTest(board(back, front), [150, 150])?.id, 'front')
  assert.equal(hitTest(board(back, front), [50, 50])?.id, 'back')
  assert.equal(hitTest(board(back, rect('front', 100, 100, 200, 200, { visible: false })), [150, 150])?.id, 'back')
  assert.equal(hitTest(board(back, rect('front', 100, 100, 200, 200, { locked: true })), [150, 150])?.id, 'back')
  // a hidden or locked group hides or locks what it holds
  assert.equal(hitTest(board(back, group('g', [front], { visible: false })), [150, 150])?.id, 'back')
  assert.equal(hitTest(board(back, group('g', [front], { locked: true })), [150, 150])?.id, 'back')
  assert.equal(hitTest(board(rect('x', 0, 0, 10, 10, { locked: true })), [5, 5]), null)
})

test('a click picks the layer at the level of the group entered, or the top level', () => {
  const inner = group('inner', [rect('leaf', 0, 0, 50, 50)])
  const outer = group('outer', [inner, rect('side', 100, 0, 50, 50)])
  const b = board(outer, rect('other', 300, 0, 50, 50))
  assert.equal(hitTest(b, [10, 10])?.id, 'outer')
  assert.equal(hitTest(b, [10, 10], { scope: 'outer' })?.id, 'inner')
  assert.equal(hitTest(b, [10, 10], { scope: 'inner' })?.id, 'leaf')
  // outside the group entered: the top-level layer there
  assert.equal(hitTest(b, [310, 10], { scope: 'inner' })?.id, 'other')
  assert.equal(hitTest(b, [75, 25]), null) // the gap between the group's children draws nothing
})

test("a clipping group's mask isn't drawn and cuts off what it holds", () => {
  const g = group('g', [rect('mask', 0, 0, 100, 100), rect('photo', 0, 0, 300, 300)], { clip: true } as Partial<Layer>)
  const b = board(g)
  assert.equal(hitTest(b, [50, 50], { scope: 'g' })?.id, 'photo')
  assert.equal(hitTest(b, [200, 200], { scope: 'g' }), null)
})

test('lines hit within the tolerance of their stroke', () => {
  const line = { ...base, id: 'ln', name: 'ln', type: 'line', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 } as Layer
  const b = board(line)
  assert.equal(hitTest(b, [50, 51], { tolerance: 3 })?.id, 'ln')
  assert.equal(hitTest(b, [80, 20], { tolerance: 3 }), null)
})

test('resizing from the left handle keeps the right edge fixed', () => {
  const l = rect('r', 100, 100, 200, 100)
  assert.deepEqual(resizeBox(l, 'w', [100, 150], [60, 150], false), { x: 60, y: 100, w: 240, h: 100 })
  assert.deepEqual(resizeBox(l, 'w', [100, 150], [140, 170], false), { x: 140, y: 100, w: 160, h: 100 })
  // turned 30 degrees: the right edge's middle stays where it was on the artboard
  const t = rect('t', 100, 100, 200, 100, { rotation: 30 })
  const right = (layer: Layer) => apply(placeAll([layer])[0].matrix, [layer.x + layer.width, layer.y + layer.height / 2])
  const before = right(t)
  const h = handlePoints(placeAll([t])[0])
  const box = resizeBox(t, 'w', h.w, [h.w[0] - 40, h.w[1] - 10], false)
  const after = right({ ...t, x: box.x, y: box.y, width: box.w, height: box.h } as Layer)
  close(after, before)
  assert.ok(box.w > 200)
  assert.ok(Math.abs(box.h - 100) < 1e-9)
})

test('every handle keeps the opposite one fixed, and Shift keeps the ratio', () => {
  const l = rect('r', 100, 100, 200, 100, { rotation: -20, scaleX: 1.5 } as Partial<Layer>)
  const opposite: Record<Handle, Handle> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' }
  const h0 = handlePoints(placeAll([l])[0])
  for (const k of Object.keys(opposite) as Handle[]) {
    const box = resizeBox(l, k, h0[k], [h0[k][0] + 30, h0[k][1] + 25], false)
    const h1 = handlePoints(placeAll([{ ...l, x: box.x, y: box.y, width: box.w, height: box.h } as Layer])[0])
    close(h1[opposite[k]], h0[opposite[k]])
  }
  const s = rect('s', 100, 100, 200, 100)
  const box = resizeBox(s, 'se', [300, 200], [350, 210], true)
  assert.ok(Math.abs(box.w / box.h - 2) < 1e-9, `ratio ${box.w / box.h}`)
  assert.equal(box.x, 100)
  assert.equal(box.y, 100)
  assert.ok(box.w > 200)
  // a side handle with Shift grows the other side too, about the middle
  const side = resizeBox(s, 'e', [300, 150], [400, 150], true)
  assert.ok(Math.abs(side.w / side.h - 2) < 1e-9)
  assert.equal(side.x, 100)
  assert.equal(side.y + side.h / 2, 150)
})

test('a resize never makes a side smaller than 1 px', () => {
  const box = resizeBox(rect('r', 100, 100, 200, 100), 'w', [100, 150], [500, 150], false)
  assert.equal(box.w, 1)
  assert.equal(box.x + box.w, 300)
})

test('the marquee selects layers whose boxes intersect it', () => {
  const a = rect('a', 0, 0, 100, 100)
  const b = rect('b', 200, 0, 100, 100)
  // a 100 x 100 square turned 45 degrees about 550,550: its upright bounds reach 479.3, its corners don't
  const c = rect('c', 500, 500, 100, 100, { rotation: 45 })
  const hidden = rect('h', 0, 0, 50, 50, { visible: false })
  const locked = rect('l', 0, 0, 50, 50, { locked: true })
  const all = board(a, b, c, hidden, locked)
  assert.deepEqual(ids(marquee(all, { x: 90, y: 10, w: 20, h: 20 })), ['a'])
  assert.deepEqual(ids(marquee(all, { x: 50, y: 50, w: 200, h: 10 })), ['a', 'b'])
  assert.deepEqual(ids(marquee(all, { x: 480, y: 480, w: 10, h: 10 })), []) // inside c's upright bounds only
  assert.deepEqual(ids(marquee(all, { x: 540, y: 540, w: 5, h: 5 })), ['c'])
  assert.deepEqual(ids(marquee(all, { x: 120, y: 120, w: 20, h: 20 })), [])
  // inside a group entered, its children; otherwise the group as one
  const g = group('g', [rect('g1', 0, 0, 40, 40), rect('g2', 60, 0, 40, 40)])
  assert.deepEqual(ids(marquee(board(g), { x: 50, y: 0, w: 60, h: 10 })), ['g'])
  assert.deepEqual(ids(marquee(board(g), { x: 50, y: 0, w: 60, h: 10 }, 'g')), ['g2'])
})
