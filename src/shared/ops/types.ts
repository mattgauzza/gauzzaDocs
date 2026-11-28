import type { FontSource } from '../design/fonts'
import type { ElkGraph, FontRef } from '../design/types'
import type { AgentOp, FilePayload } from '../types'

/** Result of applying an op to a file's content: what to tell the caller, and the new content if it changed. */
export interface OpResult {
  result: unknown
  payload?: FilePayload
  /** What the op did in a few plain words ("added 3 layers"), for an undo step. Design ops give one. */
  summary?: string
}
/** What some ops need from where they run: fonts to measure text with, and diagram layout (which runs in node only). */
export interface OpServices {
  fonts?: FontSource
  layout?: (graph: ElkGraph) => Promise<ElkGraph>
  /**
   * A font file's bytes as installed here (null when it isn't), so a design op packs the fonts its text brings in, or
   * stores their outlines (design/keepFonts.ts). Without it nothing is packed.
   */
  fontBytes?: (ref: FontRef) => Promise<Uint8Array | null>
  /** False to leave layers marked "font not installed" alone (asking for their fonts would cost a font scan). */
  recheckMissing?: boolean
  /**
   * `fonts` holds only the design's packed fonts and the fallback (the installed ones weren't looked at), so a font that
   * isn't packed is reported missing only when the layer says so, and text drawn from stored outlines is measured by them.
   */
  fontsPartial?: boolean
}
export type OpHandler<P extends FilePayload = FilePayload> = (
  payload: P, op: AgentOp, ctx: { path: string; services?: OpServices }
) => Promise<OpResult> | OpResult

export class OpError extends Error {}
export const need = <T>(op: AgentOp, key: string, type: 'string' | 'number' | 'object' = 'string'): T => {
  const v = op[key]
  if (type === 'object' ? v == null || typeof v !== 'object' : typeof v !== type) throw new OpError(`"${op.op}" needs ${key} (${type})`)
  return v as T
}
export const str = (op: AgentOp, key: string, fallback = '') => (typeof op[key] === 'string' ? (op[key] as string) : fallback)
export const num = (op: AgentOp, key: string, fallback?: number) => {
  const v = op[key]
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new OpError(`${key} must be a number`)
  return n
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Find/replace on a string. `regex` uses JS syntax; with a plain string the match is literal. */
export function replaceIn(text: string, find: string, withText: string, opts: { all?: boolean; regex?: boolean; ignoreCase?: boolean }) {
  const flags = (opts.all ? 'g' : '') + (opts.ignoreCase ? 'i' : '')
  const re = new RegExp(opts.regex ? find : escapeRe(find), flags)
  let count = 0
  const out = text.replace(re, (...m) => {
    count++
    return opts.regex ? m[0].replace(new RegExp(re.source, opts.ignoreCase ? 'i' : ''), withText) : withText
  })
  return { text: out, count }
}
