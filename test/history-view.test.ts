import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OUTSIDE,
  dayLabel,
  diffRows,
  diffStats,
  eventLine,
  groupByDay,
  mb,
  sizeText,
  saveContext,
  statsText,
  whoIs,
} from '../src/renderer/src/shell/historyView'
import type { Hunk } from '../src/shared/diff'
import { lineDiff } from '../src/shared/diff'

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).getTime()
const NOW = at(2026, 10, 25, 15, 4) // Nov 25 2026, 3:04 PM local

test('dayLabel says Today and Yesterday, then the date', () => {
  assert.equal(dayLabel(at(2026, 10, 25, 0, 1), NOW), 'Today')
  assert.equal(dayLabel(at(2026, 10, 24, 23, 59), NOW), 'Yesterday')
  assert.equal(dayLabel(at(2026, 10, 20), NOW), new Date(at(2026, 10, 20)).toLocaleDateString([], { month: 'long', day: 'numeric' }))
  // another year shows the year
  assert.equal(dayLabel(at(2025, 11, 31), NOW), new Date(at(2025, 11, 31)).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }))
})

test('dayLabel: yesterday across a month boundary', () => {
  assert.equal(dayLabel(at(2026, 10, 30), at(2026, 11, 1, 9)), 'Yesterday')
})

test('groupByDay groups by local day, keeping the order it is given', () => {
  const items = [
    { n: 5, at: at(2026, 10, 25, 15) },
    { n: 4, at: at(2026, 10, 25, 9) },
    { n: 3, at: at(2026, 10, 24, 18) },
    { n: 2, at: at(2026, 10, 20, 8) },
    { n: 1, at: at(2026, 10, 20, 7) },
  ]
  const g = groupByDay(items, x => x.at, NOW)
  assert.deepEqual(g.map(x => x.items.map(i => i.n)), [[5, 4], [3], [2, 1]])
  assert.equal(g[0].label, 'Today')
  assert.equal(g[1].label, 'Yesterday')
  assert.notEqual(g[2].label, 'Today')
})

test('groupByDay: a day that comes back later joins its first group', () => {
  const g = groupByDay([{ at: at(2026, 10, 25) }, { at: at(2026, 10, 24) }, { at: at(2026, 10, 25, 1) }], x => x.at, NOW)
  assert.equal(g.length, 2)
  assert.equal(g[0].items.length, 2)
})

test('groupByDay of nothing is nothing', () => {
  assert.deepEqual(groupByDay([], () => 0, NOW), [])
})

test('diffRows puts a gap row between two adjacent same hunks only', () => {
  const hunks: Hunk[] = [
    { kind: 'same', lines: ['a', 'b'] },
    { kind: 'del', lines: ['c'] },
    { kind: 'add', lines: ['C'] },
    { kind: 'same', lines: ['d'] },
    { kind: 'same', lines: ['x'] },
    { kind: 'add', lines: ['y'] },
  ]
  const { rows, cut } = diffRows(hunks)
  assert.equal(cut, false)
  assert.deepEqual(rows, [
    { kind: 'same', text: 'a' },
    { kind: 'same', text: 'b' },
    { kind: 'del', text: 'c' },
    { kind: 'add', text: 'C' },
    { kind: 'same', text: 'd' },
    { kind: 'gap' },
    { kind: 'same', text: 'x' },
    { kind: 'add', text: 'y' },
  ])
})

test('diffRows on a real lineDiff with two distant edits has exactly one gap', () => {
  const doc = (edits: Record<number, string>) => Array.from({ length: 40 }, (_, i) => edits[i] ?? `line ${i}`).join('\n')
  const { rows } = diffRows(lineDiff(doc({}), doc({ 2: 'two', 35: 'thirty five' })) as Hunk[])
  assert.equal(rows.filter(r => r.kind === 'gap').length, 1)
  assert.equal(rows.filter(r => r.kind === 'add').length, 2)
  assert.equal(rows.filter(r => r.kind === 'del').length, 2)
})

test('diffRows stops at max lines and says so', () => {
  const { rows, cut } = diffRows([{ kind: 'add', lines: ['1', '2', '3'] }, { kind: 'same', lines: ['4'] }, { kind: 'same', lines: ['5'] }], 3)
  assert.equal(cut, true)
  assert.equal(rows.length, 3)
  assert.deepEqual(diffRows([{ kind: 'add', lines: ['1', '2', '3'] }], 3).cut, false)
})

test('diffRows of no changes is empty', () => {
  assert.deepEqual(diffRows([]), { rows: [], cut: false })
})

test('diffStats and statsText count lines in plain words', () => {
  const s = diffStats([{ kind: 'add', lines: ['a', 'b', 'c'] }, { kind: 'same', lines: ['x'] }, { kind: 'del', lines: ['d'] }])
  assert.deepEqual(s, { added: 3, removed: 1 })
  assert.equal(statsText(s), '3 lines added and 1 removed')
  assert.equal(statsText({ added: 1, removed: 0 }), '1 line added')
  assert.equal(statsText({ added: 0, removed: 2 }), '2 lines removed')
  assert.equal(statsText({ added: 0, removed: 0 }), '')
})

test('saveContext: nobody is undefined; the person alone has no summary; agent ops give one', () => {
  const matt = { name: 'Matt', by: 'person' as const }
  const claude = { name: 'Claude', by: 'agent' as const }
  assert.equal(saveContext([], ['replace']), undefined)
  assert.deepEqual(saveContext([matt], []), { authors: [matt] })
  assert.deepEqual(saveContext([matt, claude], ['replace', 'replace', 'set'], 'sheet'), { authors: [matt, claude], summary: 'Replaced text and changed cells' })
})

test('whoIs tells the person, agents and outside changes apart', () => {
  assert.equal(whoIs('Matt', 'Matt'), 'person')
  assert.equal(whoIs('matt', 'Matt'), 'person')
  assert.equal(whoIs('Claude', 'Matt'), 'agent')
  assert.equal(whoIs(OUTSIDE, 'Matt'), 'outside')
})

test('eventLine words each kind of event', () => {
  assert.deepEqual(eventLine({ type: 'save', by: 'Matt, Claude', summary: 'saved v4' }), { names: ['Matt', 'Claude'], text: 'saved v4', named: true })
  assert.deepEqual(eventLine({ type: 'agent-op', by: 'Claude', summary: 'replace' }), { names: ['Claude'], text: 'replaced text', named: true })
  assert.equal(eventLine({ type: 'agent-op', by: 'Claude', summary: 'merge' }, 'pdf').text, 'added pages from other PDFs')
  assert.deepEqual(eventLine({ type: 'agent-op', by: 'Claude', summary: '3 edits' }), { names: ['Claude'], text: 'made 3 edits', named: true })
  assert.deepEqual(eventLine({ type: 'outside', by: OUTSIDE, summary: 'changed outside gauzzaDocs, kept as v2' }), {
    names: [OUTSIDE],
    text: 'Changed outside gauzzaDocs, kept as v2',
    named: false,
  })
  assert.deepEqual(eventLine({ type: 'moved', by: OUTSIDE, summary: 'moved from C:/a.md' }).text, 'Moved from C:/a.md')
  assert.deepEqual(eventLine({ type: 'restored', by: 'Matt', summary: 'restored v1' }), { names: ['Matt'], text: 'restored v1', named: true })
})

test('mb shows megabytes with one decimal below 100', () => {
  assert.equal(mb(0), '0 MB')
  assert.equal(mb(400 * 1024), '0.4 MB')
  assert.equal(mb(12.44 * 1024 * 1024), '12.4 MB')
  assert.equal(mb(1024 * 1024 * 1024), '1024 MB')
})

test('sizeText shows kilobytes below a megabyte', () => {
  assert.equal(sizeText(0), '0 KB')
  assert.equal(sizeText(100), '1 KB')
  assert.equal(sizeText(6 * 1024 + 100), '6 KB')
  assert.equal(sizeText(3.25 * 1024 * 1024), '3.3 MB')
})
