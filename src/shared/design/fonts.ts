import type { Design, FontRef, Layer } from './types'

// Fonts for designs. A design names fonts by family, weight, style and PostScript name. A font file is packed into the
// design only when its license allows it (OS/2 fsType 0 or 8), and packed fonts register as `gd-<12 hex>`.

export type LoadedFont = { font: any; family: string; packedFamily?: string; missing?: boolean }
export interface FontSource {
  get(ref: FontRef): LoadedFont
  fallback: LoadedFont
}

async function fontkit(): Promise<any> {
  return (await import('@pdf-lib/fontkit')).default
}

/** Every face in a parsed result: the faces of a collection, or the font itself. */
function facesOf(parsed: any): any[] {
  return Array.isArray(parsed?.fonts) ? parsed.fonts : [parsed]
}

/** Most faces a collection may hold; larger ones are refused. */
export const MAX_COLLECTION_FACES = 256

/** True when the bytes are a collection with more faces than we accept. */
export function collectionTooBig(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return v.getUint32(0) === 0x74746366 && v.getUint32(8) > MAX_COLLECTION_FACES
}

/** Italic from OS/2 fsSelection (bit 0 italic, bit 9 oblique); the italic angle only when there is no OS/2 table. */
export function isItalic(f: any): boolean {
  const os2 = f?.['OS/2']
  if (os2) {
    const s = os2.fsSelection
    if (typeof s === 'number') return !!(s & 1) || !!(s & 512)
    if (s && typeof s === 'object') return !!s.italic || !!s.oblique
  }
  return !!f?.italicAngle
}

/** A weight in 1..1000, else 400. */
export const normWeight = (w: unknown): number => (typeof w === 'number' && w >= 1 && w <= 1000 ? w : 400)
export const weightOf = (f: any): number => normWeight(f?.['OS/2']?.usWeightClass)

/** The item with the weight CSS font matching prefers for `target`. The first of equal weights wins. */
export function closestWeight<T>(items: T[], target: number, weight: (t: T) => number): T | undefined {
  const t = normWeight(target)
  const w = (x: T) => normWeight(weight(x))
  const asc = (a: T, b: T) => w(a) - w(b)
  const desc = (a: T, b: T) => w(b) - w(a)
  let order: T[]
  if (t < 400) order = [...items.filter(x => w(x) <= t).sort(desc), ...items.filter(x => w(x) > t).sort(asc)]
  else if (t <= 500)
    order = [...items.filter(x => w(x) >= t && w(x) <= 500).sort(asc), ...items.filter(x => w(x) < t).sort(desc), ...items.filter(x => w(x) > 500).sort(asc)]
  else order = [...items.filter(x => w(x) >= t).sort(asc), ...items.filter(x => w(x) < t).sort(desc)]
  return order[0]
}

/** Same style first, by CSS weight order; when that style has no face, the nearest weight in the other style. */
export function pickStyled<T>(
  items: T[], style: 'normal' | 'italic', target: number, weight: (t: T) => number, italic: (t: T) => boolean
): T | undefined {
  const same = items.filter(x => italic(x) === (style === 'italic'))
  return closestWeight(same.length ? same : items, target, weight)
}

/** True when the font's OS/2 fsType is 0 or 8 (installable or editable embedding). A font with no OS/2 table is not. */
export function canPack(bytes: Uint8Array): boolean {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = v.getUint32(0)
    if (tag === 0x74746366) {
      // ttcf: every face in the collection must allow packing
      const n = v.getUint32(8)
      if (n > MAX_COLLECTION_FACES) return false
      for (let i = 0; i < n; i++) if (!tableAllows(v, bytes, v.getUint32(12 + i * 4))) return false
      return n > 0
    }
    return tableAllows(v, bytes, 0)
  } catch {
    return false
  }
}

function tableAllows(v: DataView, bytes: Uint8Array, dir: number): boolean {
  const n = v.getUint16(dir + 4)
  for (let i = 0; i < n; i++) {
    const rec = dir + 12 + i * 16
    if (String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]) !== 'OS/2') continue
    const fsType = v.getUint16(v.getUint32(rec + 8) + 8)
    return fsType === 0 || fsType === 8
  }
  return false
}

/** `gd-` plus the first 12 hex characters of the hash in an asset name (assets/<sha256>.<ext>). */
export function packedFamily(assetName: string): string {
  const base = assetName.split('/').pop()!.replace(/\.[^.]*$/, '')
  return 'gd-' + base.slice(0, 12).toLowerCase()
}

/** The face of a parsed font or collection that a reference asks for, or null when a collection has no such face. */
function pickFace(parsed: any, ref: FontRef): any | null {
  const faces = facesOf(parsed)
  let face: any
  if (Array.isArray(parsed?.fonts)) {
    const fam = faces.filter(f => (f.familyName || '').toLowerCase() === ref.family.toLowerCase())
    face = ref.postscript ? fam.find(f => f.postscriptName === ref.postscript) : pickStyled(fam, ref.style, ref.weight, weightOf, isItalic)
    if (!face) return null
  } else face = faces[0]
  try {
    const wght = face.variationAxes?.wght
    if (wght && typeof face.getVariation === 'function') {
      return face.getVariation({ wght: Math.min(wght.max, Math.max(wght.min, normWeight(ref.weight))) })
    }
  } catch {
    // an unreadable variation table: use the default instance
  }
  return face
}

function textRefs(design: Design): FontRef[] {
  const out: FontRef[] = []
  const visit = (layers: Layer[]) => {
    for (const l of layers) {
      if (l.type === 'text') for (const r of l.runs) out.push(r.font)
      else if (l.type === 'group') visit(l.children)
    }
  }
  for (const a of design.artboards) visit(a.layers)
  for (const c of design.components) visit([c.root])
  for (const t of design.styles.text) out.push(t.run.font)
  return out
}

const keyOf = (r: FontRef) => r.asset ? `asset:${r.asset}` : `${r.family.toLowerCase()}|${r.weight}|${r.style}|${r.postscript || ''}`

/**
 * True when `after` names a font `before` didn't (a new text family, an svg import), so a FontSource built for `before`
 * would measure it with the fallback: build one for `after` before measuring.
 */
export function newFonts(before: Design, after: Design): boolean {
  if (before === after) return false
  const had = new Set(textRefs(before).map(keyOf))
  return textRefs(after).some(r => !had.has(keyOf(r)))
}

/**
 * Loads every font a design names: the packed asset first, then `fetch`. A font nothing can supply resolves to the
 * fallback with `missing: true`, so `get` never throws.
 */
export async function fontsFor(
  design: Design,
  assets: Record<string, Uint8Array>,
  fetch: (ref: FontRef) => Promise<Uint8Array | null>,
  fallbackBytes: Uint8Array
): Promise<FontSource> {
  const fk = await fontkit()
  const parsedBytes = new WeakMap<Uint8Array, any>() // a collection is parsed once per buffer, not once per ref
  const parse = (bytes: Uint8Array, ref: FontRef): any | null => {
    try {
      let parsed = parsedBytes.get(bytes)
      if (!parsed) {
        if (collectionTooBig(bytes)) return null
        parsed = fk.create(bytes)
        parsedBytes.set(bytes, parsed)
      }
      return pickFace(parsed, ref)
    } catch {
      return null
    }
  }
  const fb = fk.create(fallbackBytes)
  const fallback: LoadedFont = { font: fb, family: fb.familyName || 'Liberation Sans' }
  const loaded = new Map<string, LoadedFont>()
  for (const ref of textRefs(design)) {
    const key = keyOf(ref)
    if (loaded.has(key)) continue
    let font: any = null
    let packed: string | undefined
    const packedBytes = ref.asset ? assets[ref.asset] : undefined
    if (packedBytes) {
      font = parse(packedBytes, ref)
      if (font) packed = packedFamily(ref.asset!)
    }
    if (!font) {
      let bytes: Uint8Array | null = null
      try {
        bytes = await fetch(ref)
      } catch {
        bytes = null
      }
      if (bytes) font = parse(bytes, ref)
    }
    loaded.set(key, font ? { font, family: ref.family, ...(packed ? { packedFamily: packed } : {}) } : { ...fallback, missing: true })
  }
  return {
    fallback,
    get: ref => loaded.get(keyOf(ref)) ?? { ...fallback, missing: true }
  }
}
