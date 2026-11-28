import type { Design, DesignFile } from '../../../shared/design/types'
import { assetRefs } from '../../../shared/design/validate'
import type { FilePayload } from '../../../shared/types'

/**
 * What a design's saves send. The editor keeps every asset in memory, but a save sends only the ones the file on disk
 * doesn't hold yet (`partial`), and the worker copies the rest from the file. So the editor has to know what the file
 * holds: what it was opened with, then exactly what each save wrote (designZipBytes writes the assets the design
 * refers to, no more). Plain code with no window, so tests drive it against real saves.
 */
export class DesignSaves {
  private onDisk: Set<string>

  constructor(opened: Record<string, Uint8Array>) {
    this.onDisk = new Set(Object.keys(opened))
  }

  /** The assets the file on disk holds, as far as the editor knows, sorted. */
  disk(): string[] {
    return [...this.onDisk].sort()
  }

  /**
   * The design with only the assets it refers to that the file doesn't hold, and its thumbnail when one was just drawn
   * (without one, the worker keeps the file's own).
   */
  partial(f: DesignFile): FilePayload {
    const fresh: Record<string, Uint8Array> = {}
    for (const name of assetRefs(f.design)) if (!this.onDisk.has(name) && f.assets[name]) fresh[name] = f.assets[name]
    const file: DesignFile = { design: f.design, assets: fresh }
    if (f.thumbnail) file.thumbnail = f.thumbnail
    return { kind: 'design', file, partial: true }
  }

  /** Everything, for a save that can't count on the file (a new file, or one replaced from outside). */
  full(f: DesignFile): FilePayload {
    return { kind: 'design', file: f }
  }

  /** A payload from partial or full is on disk now: the file holds exactly the assets its design refers to. */
  saved(p: FilePayload): void {
    if (p.kind === 'design') this.onDisk = assetRefs(p.file.design)
  }
}

/**
 * The thumbnail a design's saves carry. A save draws the first artboard anew when the file's thumbnail doesn't show the
 * design being saved (drawing needs the window, so it's handed in). If drawing fails, the save goes ahead without one,
 * marked thumbnailStale, and the next save tries again; the flag goes once a thumbnail shows the design. Designs are
 * the editor's own objects, which every change replaces, so the same object means the same design. Plain code with no
 * window, so tests drive it.
 */
export class DesignThumbs {
  /** The last thumbnail drawn (or the file's own when it was current on opening): the design it shows, and its PNG. */
  private last: { design: Design; png: Uint8Array } | null
  /** The design the file's own thumbnail shows; null when it has none or it's stale. */
  private onDisk: Design | null
  /** The design each payload handed out shows in its thumbnail (null: stale), for `saved`. */
  private sent = new WeakMap<FilePayload, Design | null>()

  constructor(opened?: DesignFile) {
    this.last = opened?.thumbnail && !opened.design.thumbnailStale ? { design: opened.design, png: opened.thumbnail } : null
    this.onDisk = this.last?.design ?? null
  }

  /**
   * The file as a save writes it. With `draw` (a save to the file itself) a thumbnail is drawn when the file's own
   * doesn't show this design, and such a save sends a thumbnail only when it's new. Without it (a whole copy for
   * elsewhere) nothing is drawn and what there is goes along. Pass the payload made from it to `handOut`.
   */
  async prepare(f: DesignFile, draw: ((f: DesignFile) => Promise<Uint8Array>) | null): Promise<{ file: DesignFile; shows: Design | null }> {
    const onDisk = this.onDisk === f.design
    if (draw && !onDisk && this.last?.design !== f.design) {
      try {
        this.last = { design: f.design, png: await draw(f) }
      } catch {
        // saved marked stale: the next save tries again
      }
    }
    const png = this.last?.design === f.design ? this.last.png : undefined
    const current = onDisk || png !== undefined
    const { thumbnailStale: _stale, ...unmarked } = f.design
    const file: DesignFile = { design: current ? unmarked : { ...f.design, thumbnailStale: true }, assets: f.assets }
    if (png && (!draw || !onDisk)) file.thumbnail = png
    return { file, shows: current ? f.design : null }
  }

  /** A payload made from what prepare gave, remembered with the design its thumbnail shows. */
  handOut(p: FilePayload, shows: Design | null): FilePayload {
    this.sent.set(p, shows)
    return p
  }

  /** A payload handed out is on disk now: the file's thumbnail shows what that payload's did. */
  saved(p: FilePayload): void {
    const shows = this.sent.get(p)
    if (shows !== undefined) this.onDisk = shows
  }
}
