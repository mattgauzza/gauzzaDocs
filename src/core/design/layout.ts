// Diagram layout with ELK (the Eclipse Layout Kernel), in node only. ELK's bundle runs generated code that the
// window's content security policy (no unsafe-eval) refuses, so the window never loads it: the design ops get it
// through `services.layout`, and the window asks the worker for a layout.
import type { ElkGraph } from '../../shared/design/types'

interface Elk { layout(graph: ElkGraph): Promise<ElkGraph> }

/**
 * `load` run the first time it's needed and its result kept, except that a failed load is forgotten, so the next call
 * tries again rather than failing for the life of the process.
 */
export function onceRetrying<T>(load: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | null = null
  return () => {
    if (kept) return kept
    const p = load()
    kept = p
    p.catch(() => {
      if (kept === p) kept = null
    })
    return p
  }
}

const engine = onceRetrying(async (): Promise<Elk> => {
  // elkjs types its graphs loosely; ElkGraph (types.ts) is the part of them diagrams use
  const ELK = ((await import('elkjs/lib/elk.bundled.js')) as unknown as { default: new () => Elk }).default
  return new ELK()
})

/**
 * What every diagram is laid out with, whatever the graph says: the layered algorithm across boxes and what they
 * hold (INCLUDE_CHILDREN, so a link between two boxes is routed with both), orthogonal routes, and every position
 * and route point on the root's terms, which applyLayout turns into artboard coordinates by adding one offset.
 */
const FIXED: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.json.shapeCoords': 'ROOT',
  'elk.json.edgeCoords': 'ROOT'
}

/**
 * Lays out a diagram's graph (diagramGraph makes it from a spec: sizes, direction and spacing are its own layout
 * options) and returns a laid-out copy: every node with x and y, every box sized, and every edge with its sections.
 * ELK is loaded the first time it's needed (again after a load that failed). The graph given is left as it was.
 */
export async function layoutDiagram(graph: ElkGraph): Promise<ElkGraph> {
  const elk = await engine()
  const copy = structuredClone(graph)
  copy.layoutOptions = { ...copy.layoutOptions, ...FIXED }
  return elk.layout(copy)
}
