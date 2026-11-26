// Reading and writing .gdesign files: a zip holding only design.json, assets/<sha256>.<ext> and thumbnail.png.
import { createHash } from 'node:crypto'
import type { Design, DesignFile, Layer } from '../../shared/design/types'
import { MAX_SVG_MARKUP, svgMarkupOf, validateDesign } from '../../shared/design/validate'

type JSZipT = InstanceType<typeof import('jszip')>
const loadZip = async (bytes: Uint8Array): Promise<JSZipT> => (await import('jszip')).default.loadAsync(bytes)
const newZip = async (): Promise<JSZipT> => new (await import('jszip')).default()

export const MAX_ENTRIES = 10_000
export const MAX_UNCOMPRESSED = 1024 * 1024 * 1024
const ASSET_RE = /^assets\/[0-9a-f]{64}\.[a-z0-9]+$/
const DESIGN ='design.json'
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
    if (e.dir) continue
    const size = (e as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize
    if (typeof size !== 'number' || Number.isNaN(size)) throw new Error("This design file can't be read.")
    // JSZip reads the 32-bit field as a signed number, so a huge declared size shows up negative.
    total += size < 0 ? size + 2 ** 32 : size
    if (total > MAX_UNCOMPRESSED) throw new Error('This design is too large to open (over 1 GB uncompressed)')
  }
  return zip
}

const MAX_DESIGN_JSON = 64 * 1024 * 1024
/** Why a save was refused, in plain words. */
export const TOO_LARGE_TO_SAVE = 'This design is too large to save (its design.json would be over 64 MB).'
export const SVG_TOO_LARGE_TO_SAVE = 'This design is too large to save (its SVG layers come to over 16 MB).'
export const TOO_DEEP_TO_SAVE = 'This design is too deeply nested to save.'
export const LOOPS_TO_SAVE = "This design can't be saved: part of it contains itself."
export const ODD_VALUE_TO_SAVE = "This design can't be saved: it holds a value a design file can't store."

/** What made writing design.json fail, as one of the messages above (anything else as it was). */
function saveFailure(e: unknown): Error {
  if (e instanceof RangeError) return new Error(/call stack/i.test(e.message) ? TOO_DEEP_TO_SAVE : TOO_LARGE_TO_SAVE)
  if (e instanceof TypeError) return new Error(/circular/i.test(e.message) ? LOOPS_TO_SAVE : ODD_VALUE_TO_SAVE)
  return e instanceof Error ? e : new Error(ODD_VALUE_TO_SAVE)
}

/**
 * design.json for a design, or a plain error saying why it can't be saved: an asset pointer outside assets/, over
 * 16 MB of SVG layers (reading would drop the layers past it), groups or values nested too deep to write, or a
 * design.json over 64 MB (reading would refuse it).
 */
function designJson(design: Design): string {
  try {
    checkAssetRefs(design)
  } catch (e) {
    throw e instanceof RangeError ? saveFailure(e) : e
  }
  if (svgMarkupOf(design) > MAX_SVG_MARKUP) throw new Error(SVG_TOO_LARGE_TO_SAVE)
  let json: string
  try {
    json = JSON.stringify(design)
  } catch (e) {
    throw saveFailure(e)
  }
  if (json.length > MAX_DESIGN_JSON || Buffer.byteLength(json, 'utf8') > MAX_DESIGN_JSON) throw new Error(TOO_LARGE_TO_SAVE)
  return json
}
const MAX_THUMBNAIL = 16 * 1024 * 1024

/** Bytes still allowed across everything inflated in one read or write. */
interface Budget { left: number }

/**
 * Inflates one entry as a stream and counts the real bytes, so a deflate bomb that declares small sizes is
 * stopped as soon as it passes `limit` or the shared budget, instead of filling memory first.
 */
interface Stream {
  on(ev: 'data', fn: (c: Uint8Array) => void): Stream
  on(ev: 'error', fn: (e: Error) => void): Stream
  on(ev: 'end', fn: () => void): Stream
  pause(): Stream
  resume(): Stream
}
type Entry = JSZipT['files'][string]

function readEntry(entry: Entry, label: string, limit: number, budget: Budget): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let done = false
    const stream = (entry as unknown as { internalStream(t: 'uint8array'): Stream }).internalStream('uint8array')
    const fail = (err: Error): void => {
      if (done) return
      done = true
      stream.pause()
      chunks.length = 0
      reject(err)
    }
    stream
      .on('data', (chunk: Uint8Array) => {
        if (done) return
        size += chunk.length
        budget.left -= chunk.length
        if (budget.left < 0) return fail(new Error('This design is too large to open (over 1 GB uncompressed)'))
        if (size > limit) return fail(new Error(`This design is too large to open (${label} is over ${Math.round(limit / 1048576)} MB)`))
        chunks.push(chunk)
      })
      .on('error', (e: Error) => fail(e))
      .on('end', () => {
        if (done) return
        done = true
        const out = new Uint8Array(size)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        resolve(out)
      })
      .resume()
  })
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

/**
 * Reads a .gdesign. design.json goes through validateDesign before anything else sees it, so the design that comes
 * back holds only what the schema allows (see validate.ts); `notes` lists, in plain words, what was repaired or
 * dropped on the way (absent when nothing was). A file that can't be repaired throws "This design file is damaged:
 * <reason>.".
 */
export async function readDesignZip(bytes: Uint8Array): Promise<DesignFile & { notes?: string[] }> {
  const zip = await openChecked(bytes)
  const entry = zip.files[DESIGN]
  if (!entry || entry.dir) throw new Error('This is not a design file: design.json is missing')
  const budget: Budget = { left: MAX_UNCOMPRESSED }
  const json = await readEntry(entry, 'design.json', MAX_DESIGN_JSON, budget)
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(json).toString('utf8'))
  } catch {
    throw new Error('This design file is damaged: design.json is not valid JSON')
  }
  const notes: string[] = []
  const design = validateDesign(raw, notes, json.length)
  checkAssetRefs(design)
  const assets: Record<string, Uint8Array> = {}
  for (const name of Object.keys(zip.files)) {
    if (!ASSET_RE.test(name) || zip.files[name].dir) continue
    assets[name] = await readEntry(zip.files[name], name, MAX_UNCOMPRESSED, budget)
  }
  const t = zip.files[THUMB]
  const thumbnail = t && !t.dir ? await readEntry(t, THUMB, MAX_THUMBNAIL, budget) : undefined
  const file: DesignFile & { notes?: string[] } = thumbnail ? { design, assets, thumbnail } : { design, assets }
  if (notes.length) file.notes = notes
  return file
}

/**
 * Writes the file. Assets the design refers to but `f.assets` lacks are copied from `base` (the file as it is on disk),
 * and assets nothing refers to are dropped, so autosave only has to send design.json and new assets. A design that
 * couldn't be opened again as it is (a design.json over 64 MB, or over 16 MB of SVG layers) is refused rather than
 * written, and every refusal says what caused it.
 */
export async function designZipBytes(f: DesignFile, base?: Uint8Array): Promise<Uint8Array> {
  const json = designJson(f.design)
  const zip = await newZip()
  zip.file(DESIGN, json, { compression: 'DEFLATE' })
  const refs = referencedAssets(f.design)
  const baseZip = base ? await openChecked(base) : null
  const budget: Budget = { left: MAX_UNCOMPRESSED }
  for (const name of refs) {
    let data: Uint8Array | undefined = f.assets[name]
    if (!data) {
      const e = baseZip?.files[name]
      if (e && !e.dir) data = await readEntry(e, name, MAX_UNCOMPRESSED, budget)
    }
    if (!data) throw new Error(`Asset ${name} is missing.`)
    zip.file(name, data, { compression: 'STORE' })
  }
  let thumb = f.thumbnail
  if (!thumb && baseZip) {
    const t = baseZip.files[THUMB]
    if (t && !t.dir) thumb = await readEntry(t, THUMB, MAX_THUMBNAIL, budget)
  }
  if (thumb) zip.file(THUMB, thumb, { compression: 'DEFLATE' })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
