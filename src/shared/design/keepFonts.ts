import { type FontSource, type LoadedFont, canPack, faceKey, fontExt, parseFace } from './fonts'
import { boxOf } from './geometry'
import { parsePath, pathBounds } from './path'
import { sharedAssetName } from './sha256'
import { OutlinesTooLong, layoutText, textPaths } from './text'
import type { Design, DesignFile, FontRef, Layer, TextLayer, TextRun } from './types'
import { pastZipLimit } from './validate'

// Fonts that travel with a design. After every op that changes a design, each text layer it brought in or changed (its
// text, font, size or box) is checked against the fonts installed here:
//  - a font whose license allows it (OS/2 fsType 0 or 8) is packed: its file is stored once as assets/<sha256>.<ext>
//    and every run in that face points to it, so the text draws and measures the same on any PC (fontsFor loads it,
//    registered as gd-<12 hex>);
//  - a font that can't be packed (its license, or the design's zip limits) leaves the layer's laid-out outlines in
//    `glyphs`, which the renderer draws where the font is missing;
//  - a font that isn't here, packed or outlined marks the layer `missingFont`, which is cleared once it's found.
// This runs inside the op, so it's part of the op's one undo step, and it adds nothing to the op's summary.

/** Most characters of stored outlines one layer keeps, and all of a design's layers together. */
export const MAX_LAYER_GLYPHS = 2 * 1024 * 1024
export const MAX_DESIGN_GLYPHS = 16 * 1024 * 1024

/** What keepFonts needs: fonts to lay text out with, and a font's installed bytes. */
export interface KeepServices {
  fonts?: FontSource
  fontBytes?: (ref: FontRef) => Promise<Uint8Array | null>
  /** False to leave layers already marked missingFont alone unless the op changed them. */
  recheckMissing?: boolean
}

/** Every text layer on every artboard and in every component, groups included, walked with a stack. */
export function textLayersOf(design: Design): TextLayer[] {
  const out: TextLayer[] = []
  const stack: Layer[] = []
  for (const c of design.components ?? []) if (c?.root) stack.push(c.root)
  for (const a of design.artboards ?? []) for (const l of a.layers ?? []) stack.push(l)
  while (stack.length) {
    const l = stack.pop()!
    if (!l || typeof l !== 'object') continue
    if (l.type === 'text') out.push(l)
    else if (l.type === 'group' && Array.isArray(l.children)) for (const k of l.children) stack.push(k)
  }
  return out
}

const sameRun = (a: TextRun, b: TextRun): boolean =>
  a.text === b.text && faceKey(a.font) === faceKey(b.font) && a.font.asset === b.font.asset && a.size === b.size &&
  a.letterSpacing === b.letterSpacing && a.lineHeight === b.lineHeight

/** Whether what a layer's outlines depend on changed: its runs, how they lay out, or its box's size. */
function changed(was: TextLayer, now: TextLayer): boolean {
  if (was.mode !== now.mode || was.align !== now.align || was.valign !== now.valign || was.width !== now.width || was.height !== now.height) return true
  if (!Array.isArray(was.runs) || !Array.isArray(now.runs) || was.runs.length !== now.runs.length) return true
  return now.runs.some((r, i) => !sameRun(was.runs[i], r))
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

interface Face { asset?: string; font?: any }

/**
 * Packs, outlines or marks the fonts of the text layers `file` brought in or changed since `before` (see the top of this
 * file). Changes `file.design` and `file.assets` in place. `stored` is what the zip holds besides design.json (the
 * thumbnail's size), so packing a font never takes the design past the zip's limits: such a font is outlined instead.
 */
export async function keepFonts(
  file: { design: Design; assets: Record<string, Uint8Array> }, before: DesignFile, services: KeepServices
): Promise<void> {
  const { fontBytes, fonts } = services
  if (!fontBytes || !fonts) return
  const was = new Map<string, TextLayer>()
  for (const l of textLayersOf(before.design)) if (typeof l.id === 'string') was.set(l.id, l)
  const all = textLayersOf(file.design)
  const touched = new Set<TextLayer>()
  const work: TextLayer[] = []
  const working = new Set<TextLayer>()
  for (const l of all) {
    if (!Array.isArray(l.runs)) continue
    const old = was.get(l.id)
    const isNew = !old || changed(old, l)
    if (isNew) touched.add(l)
    if (isNew || (services.recheckMissing !== false && l.missingFont === true)) {
      work.push(l)
      working.add(l)
    }
  }
  if (!work.length) return

  const packed = (r: TextRun): boolean => typeof r.font?.asset === 'string' && has(file.assets, r.font.asset)
  // faces already packed in this design, so one face is packed once
  const packedFaces = new Map<string, string>()
  for (const l of all) for (const r of l.runs ?? []) if (r?.font && packed(r)) packedFaces.set(faceKey(r.font), r.font.asset!)

  const faces = new Map<string, Face>()
  const resolve = async (ref: FontRef): Promise<Face> => {
    const key = faceKey(ref)
    let face = faces.get(key)
    if (face) return face
    face = {}
    faces.set(key, face)
    const asset = packedFaces.get(key)
    if (asset) {
      face.asset = asset
      return face
    }
    let bytes: Uint8Array | null = null
    try {
      bytes = await fontBytes(ref)
    } catch {
      bytes = null
    }
    if (!bytes || !(bytes instanceof Uint8Array)) return face
    face.font = await parseFace(bytes, ref)
    if (!face.font) return face
    if (canPack(bytes)) {
      const name = sharedAssetName(bytes, fontExt(bytes))
      const had = has(file.assets, name)
      // every run in this face, on any layer, points to the packed file
      const runs: TextRun[] = []
      for (const l of all) for (const r of l.runs ?? []) if (r?.font && !packed(r) && faceKey(r.font) === key) runs.push(r)
      file.assets[name] = bytes
      for (const r of runs) r.font = { ...r.font, asset: name }
      const past = pastZipLimit(file.design, { assets: file.assets, thumbnail: before.thumbnail?.byteLength }, {
        before: { design: before.design, stored: { assets: before.assets, thumbnail: before.thumbnail?.byteLength } }
      })
      if (past) {
        // too large to carry: outlines instead
        for (const r of runs) {
          const { asset: _gone, ...rest } = r.font
          r.font = rest
        }
        if (!had) delete file.assets[name]
      } else {
        face.asset = name
        packedFaces.set(key, name)
        for (const l of all) {
          if (!working.has(l) && l.runs.some(r => r?.font?.asset === name)) {
            work.push(l)
            working.add(l)
          }
        }
      }
    }
    return face
  }
  for (const l of work) for (const r of l.runs) if (r?.font && !packed(r)) await resolve(r.font)
  // a run in a face this design already packed points to that file
  for (const l of work) {
    for (const r of l.runs) {
      const asset = r?.font && !packed(r) ? faces.get(faceKey(r.font))?.asset : undefined
      if (asset) r.font = { ...r.font, asset }
    }
  }

  // the faces found here as fonts to lay text out with, over what the op measured with
  const here = (ref: FontRef): LoadedFont | null => {
    const f = faces.get(faceKey(ref))
    return f?.font ? { font: f.font, family: ref.family } : null
  }
  const layout: FontSource = { fallback: fonts.fallback, get: ref => here(ref) ?? fonts.get(ref) }
  let total = 0
  for (const l of all) if (typeof l.glyphs === 'string') total += l.glyphs.length

  for (const l of work) {
    const state = l.runs.map(r => (packed(r) ? 'packed' : here(r.font) ? 'here' : faces.has(faceKey(r.font)) ? 'missing' : 'unknown'))
    if (state.every(s => s === 'packed')) {
      if (typeof l.glyphs === 'string') total -= l.glyphs.length
      delete l.glyphs
      delete l.missingFont
      continue
    }
    if (state.includes('unknown')) continue // a layer only reached because a face of it was packed: the rest weren't looked at
    if (state.includes('missing')) {
      // outlines made from the text before it changed would draw the old text
      if (touched.has(l) && typeof l.glyphs === 'string') {
        total -= l.glyphs.length
        delete l.glyphs
      }
      if (typeof l.glyphs !== 'string') l.missingFont = true
      continue
    }
    // every font is here, and at least one can't travel packed: keep the outlines
    delete l.missingFont
    if (typeof l.glyphs === 'string') total -= l.glyphs.length
    delete l.glyphs
    const room = Math.min(MAX_LAYER_GLYPHS, MAX_DESIGN_GLYPHS - total)
    if (room <= 0) continue
    try {
      const b = boxOf(l)
      const d = textPaths(l, layout, undefined, -b.x, -b.y, { left: room }).map(p => p.d).join('')
      if (d && d.length <= room) {
        l.glyphs = d
        total += d.length
      }
    } catch (e) {
      if (!(e instanceof OutlinesTooLong)) throw e
    }
  }
}

/**
 * A text layer's flags as a read reports them: "missing font" and "overflow". With `partial` fonts (only the packed
 * ones and the fallback: the installed fonts weren't looked at), a font that isn't packed counts as missing only when
 * the layer was marked so. Text drawn from its stored outlines (its font missing) overflows when they reach past the
 * bottom of its box; other text is laid out with the fonts given.
 */
export function textFlags(layer: TextLayer, fonts: FontSource, partial = false): { missingFont: boolean; overflow: boolean } {
  const runs = Array.isArray(layer.runs) ? layer.runs : []
  const gone = runs.some(r => !!fonts.get(r.font).missing)
  const missingFont = partial ? gone && layer.missingFont === true : gone
  let overflow: boolean
  if (gone && typeof layer.glyphs === 'string' && layer.glyphs) {
    const b = layer.mode === 'box' ? pathBounds(parsePath(layer.glyphs)) : null
    overflow = !!b && b.y + b.h > boxOf(layer).h + 0.5
  } else overflow = layoutText(layer, fonts).overflow
  return { missingFont, overflow }
}
