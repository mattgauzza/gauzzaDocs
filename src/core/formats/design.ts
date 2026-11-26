// Reading and writing .gdesign files: a zip holding only design.json, assets/<sha256>.<ext> and thumbnail.png.
import { createHash } from 'node:crypto'
import type { Design, DesignFile, Layer } from '../../shared/design/types'

type JSZipT = InstanceType<typeof import('jszip')>
const loadZip = async (bytes: Uint8Array): Promise<JSZipT> => (await import('jszip')).default.loadAsync(bytes)
const newZip = async (): Promise<JSZipT> => new (await import('jszip')).default()

export const MAX_ENTRIES = 10_000
export const MAX_UNCOMPRESSED = 1024 * 1024 * 1024
const ASSET_RE = /^assets\/[0-9a-f]{64}\.[a-z0-9]+$/
const DESIGN = 'design.json'
const THUMB = 'thumbnail.png'

/** `assets/<sha256>.<ext>`, the name an asset is stored under. */
export function assetName(bytes: Uint8Array, ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!clean) throw new Error('An asset needs a file extension')
  return `assets/${createHash('sha256').update(bytes).digest('hex')}.${clean}`
}

/** Loads a zip and refuses it from the central directory alone, before anything is inflated. */
async function openChecked(bytes: Uint8Array): Promise<JSZipT> {
  const zip = await loadZip(bytes)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ENTRIES) throw new Error(`This design has too many entries (more than ${MAX_ENTRIES})`)
  let total = 0
  for (const e of entries) {
    const size = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    // JSZip reads the 32-bit field as a signed number, so a huge declared size shows up negative.
    total += typeof size === 'number' ? (size < 0 ? size + 2 ** 32 : size) : 0
    if (total > MAX_UNCOMPRESSED) throw new Error('This design is too large to open (over 1 GB uncompressed)')
  }
  return zip
}

/** Every asset path a layer refers to, paired with the layer's id. */
function layerAssets(l: Layer): string[] {
  const out: string[] = []
  if (l.type === 'image' || l.type === 'paint') out.push(l.asset)
  if (l.type === 'text') for (const r of l.runs) if (r.font.asset !== undefined) out.push(r.font.asset)
  if (l.type === 'instance') for (const o of Object.values(l.overrides)) if (o.asset !== undefined) out.push(o.asset)
  return out
}

function eachLayer(design: Design, fn: (l: Layer) => void): void {
  const go = (list: Layer[]): void => {
    for (const l of list) {
      fn(l)
      if (l.type === 'group') go(l.children)
    }
  }
  for (const a of design.artboards) go(a.layers)
  for (const c of design.components) go([c.root])
}

function checkAssetRefs(design: Design): void {
  eachLayer(design, l => {
    for (const a of layerAssets(l)) {
      if (typeof a !== 'string' || !ASSET_RE.test(a)) throw new Error(`Layer ${l.id} points outside assets/`)
    }
  })
  for (const s of design.styles.text) {
    const a = s.run.font.asset
    if (a !== undefined && !ASSET_RE.test(a)) throw new Error(`Style ${s.name} points outside assets/`)
  }
}

/** Asset paths the design refers to. */
function referencedAssets(design: Design): Set<string> {
  const refs = new Set<string>()
  eachLayer(design, l => layerAssets(l).forEach(a => refs.add(a)))
  for (const s of design.styles.text) if (s.run.font.asset) refs.add(s.run.font.asset)
  return refs
}

export async function readDesignZip(bytes: Uint8Array): Promise<DesignFile> {
  const zip = await openChecked(bytes)
  const entry = zip.files[DESIGN]
  if (!entry || entry.dir) throw new Error('This is not a design file: design.json is missing')
  let design: Design
  try {
    design = JSON.parse(await entry.async('string')) as Design
  } catch {
    throw new Error('This design file is damaged: design.json is not valid JSON')
  }
  if (!design || design.format !== 1 || !Array.isArray(design.artboards)) {
    throw new Error('This design file is from a newer version of gauzzaDocs or is damaged')
  }
  design.components ??= []
  design.styles ??= { colors: [], text: [] }
  checkAssetRefs(design)
  const assets: Record<string, Uint8Array> = {}
  for (const name of Object.keys(zip.files)) {
    if (!ASSET_RE.test(name) || zip.files[name].dir) continue
    assets[name] = await zip.files[name].async('uint8array')
  }
  const t = zip.files[THUMB]
  const thumbnail = t && !t.dir ? await t.async('uint8array') : undefined
  return thumbnail ? { design, assets, thumbnail } : { design, assets }
}

/**
 * Writes the file. Assets the design refers to but `f.assets` lacks are copied from `base` (the file as it is on disk),
 * and assets nothing refers to are dropped, so autosave only has to send design.json and new assets.
 */
export async function designZipBytes(f: DesignFile, base?: Uint8Array): Promise<Uint8Array> {
  const zip = await newZip()
  zip.file(DESIGN, JSON.stringify(f.design), { compression: 'DEFLATE' })
  const refs = referencedAssets(f.design)
  const baseZip = base ? await openChecked(base) : null
  for (const name of refs) {
    if (!ASSET_RE.test(name)) continue
    let data: Uint8Array | undefined = f.assets[name]
    if (!data) {
      const e = baseZip?.files[name]
      if (e && !e.dir) data = await e.async('uint8array')
    }
    if (data) zip.file(name, data, { compression: 'STORE' })
  }
  let thumb = f.thumbnail
  if (!thumb && baseZip) {
    const t = baseZip.files[THUMB]
    if (t && !t.dir) thumb = await t.async('uint8array')
  }
  if (thumb) zip.file(THUMB, thumb, { compression: 'DEFLATE' })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
