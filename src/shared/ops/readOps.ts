import type { AgentOp } from '../types'

/** Ops that only look, for every kind. */
const READS = new Set(['read', 'info', 'find', 'outline', 'get', 'sheets', 'charts', 'rules', 'merges', 'comments', 'export'])

/**
 * Whether an op only looks and never changes the file. Reads skip a design's file lock on disk, aren't logged or sent
 * to other agents as edits, and show as reading in the app. `svg` with `get` gives a design's SVG back; without it, it
 * imports.
 */
export function isReadOp(op: AgentOp): boolean {
  if (READS.has(op.op)) return true
  return op.op === 'svg' && op.get !== undefined && op.get !== false
}
