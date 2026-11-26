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

const isItalic = (f: any): boolean => !!f.italicAngle || !!f.head?.macStyle?.italic || /italic|oblique/i.test(f.subfamilyName || '')
const weightOf = (f: any): number => f['OS/2']?.usWeightClass || 400

/** True when the font's OS/2 fsType is 0 or 8 (installable or editable embedding). A font with no OS/2 table is not. */
export function canPack(bytes: Uint8Array): boolean {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = v.getUint32(0)
    if (tag === 0x74746366) {
      // ttcf: every face in the collection must allow packing
      const n = v.getUint32(8)
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

/** The face of a parsed font or collection that a reference asks for. */
function pickFace(parsed: any, ref: FontRef): any {
  const faces = facesOf(parsed)
  let face = faces.length > 1 ? faces.find(f => ref.postscript && f.postscriptName === ref.postscript) : faces[0]
  if (!face) {
    const fam = faces.filter(f => (f.familyName || '').toLowerCase() === ref.family.toLowerCase())
    const pool = fam.length ? fam : faces
    const same = pool.filter(f => isItalic(f) === (ref.style === 'italic'))
    const c = same.length ? same : pool
    face = c.reduce((a, b) => (Math.abs(weightOf(b) - ref.weight) < Math.abs(weightOf(a) - ref.weight) ? b : a))
  }
  const wght = face.variationAxes?.wght
  if (wght && typeof face.getVariation === 'function') {
    try {
      return face.getVariation({ wght: Math.min(wght.max, Math.max(wght.min, ref.weight)) })
    } catch {
      return face
    }
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
  const parse = (bytes: Uint8Array, ref: FontRef): any | null => {
    try {
      return pickFace(fk.create(bytes), ref)
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
