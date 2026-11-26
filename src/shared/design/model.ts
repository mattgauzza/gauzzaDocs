import type { Artboard, Design, Layer } from './types'

export const MAX_ARTBOARD_SIDE = 8192
/** How reading, the ops and saving all refuse an artboard over MAX_ARTBOARD_SIDE. */
export const ARTBOARD_TOO_LARGE = `Artboards can be at most ${MAX_ARTBOARD_SIDE} px per side.`

export const PRESETS: Record<string, { width: number; height: number; transparent?: boolean; label: string }> = {
  instagram: { width: 1080, height: 1080, label: 'Instagram post' },
  portrait: { width: 1080, height: 1350, label: 'Portrait post' },
  story: { width: 1080, height: 1920, label: 'Story' },
  linkedin: { width: 1200, height: 627, label: 'LinkedIn post' },
  x: { width: 1600, height: 900, label: 'X post' },
  youtube: { width: 1280, height: 720, label: 'YouTube thumbnail' },
  logo: { width: 1000, height: 1000, transparent: true, label: 'Logo' },
  letter: { width: 816, height: 1056, label: 'Letter page' }
}

/** A design's size when none is asked for. */
export const DEFAULT_DESIGN_PRESET = 'instagram'

const rand = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, '0')

/** Eight base36 characters. Pass the ids already in use and the result is guaranteed not to collide with them. */
export function newId(taken?: Set<string>): string {
  let id = rand()
  while (taken?.has(id)) id = rand()
  taken?.add(id)
  return id
}

export function newDesign(preset: string): Design {
  const key = preset.trim()
  let width: number
  let height: number
  let name: string
  let transparent = false
  const p = Object.prototype.hasOwnProperty.call(PRESETS, key.toLowerCase()) ? PRESETS[key.toLowerCase()] : undefined
  if (p) {
    ;({ width, height } = p)
    name = p.label
    transparent = !!p.transparent
  } else {
    const m = /^(\d+)x(\d+)$/i.exec(key)
    if (!m || +m[1] < 1 || +m[2] < 1) {
      throw new Error(`Unknown size "${preset}". Use one of: ${Object.keys(PRESETS).join(', ')} or <w>x<h>`)
    }
    width = +m[1]
    height = +m[2]
    name = `${width}x${height}`
  }
  if (width > MAX_ARTBOARD_SIDE || height > MAX_ARTBOARD_SIDE) throw new Error(ARTBOARD_TOO_LARGE)
  return {
    format: 1,
    id: crypto.randomUUID(),
    artboards: [
      {
        id: newId(),
        name,
        width,
        height,
        background: transparent ? null : { type: 'color', color: '#ffffff' },
        layers: []
      }
    ],
    components: [],
    styles: { colors: [], text: [] }
  }
}

/** Depth first, in z order. `path` holds the names of the ancestors plus the layer's own name. */
export function walk(layers: Layer[], fn: (l: Layer, parent: Layer | null, path: string[]) => void): void {
  const go = (list: Layer[], parent: Layer | null, trail: string[]): void => {
    for (const l of list) {
      const path = [...trail, l.name]
      fn(l, parent, path)
      if (l.type === 'group') go(l.children, l, path)
    }
  }
  go(layers, null, [])
}

export function artboardOf(design: Design, ref?: string): Artboard {
  if (ref === undefined || ref === '') {
    const first = design.artboards[0]
    if (!first) throw new Error('This design has no artboards')
    return first
  }
  const found = design.artboards.find(a => a.id === ref) ?? design.artboards.find(a => a.name === ref)
  if (!found) throw new Error(`No artboard "${ref}"`)
  return found
}

/** Matches by id, then by name, then by a Group/Child path. */
export function findLayers(design: Design, artboardId: string, ref: string): Layer[] {
  const board = artboardOf(design, artboardId)
  const all: { layer: Layer; path: string[] }[] = []
  walk(board.layers, (layer, _parent, path) => all.push({ layer, path }))
  const byId = all.filter(e => e.layer.id === ref)
  if (byId.length) return byId.map(e => e.layer)
  const byName = all.filter(e => e.layer.name === ref)
  if (byName.length) return byName.map(e => e.layer)
  if (ref.includes('/')) {
    const want = ref.split('/')
    return all.filter(e => e.path.length === want.length && e.path.every((n, i) => n === want[i])).map(e => e.layer)
  }
  return []
}

export function resolveLayer(design: Design, artboardId: string, ref: string): Layer {
  const hits = findLayers(design, artboardId, ref)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new Error(`${hits.length} layers are named "${ref}": ${hits.map(l => l.id).join(', ')}`)
  }
  throw new Error(`No layer "${ref}" on ${artboardOf(design, artboardId).name}`)
}
