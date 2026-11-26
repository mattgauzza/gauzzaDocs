import type { DesignFile } from '../../../shared/design/types'
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

  /** The design with only the assets it refers to that the file doesn't hold. */
  partial(f: DesignFile): FilePayload {
    const fresh: Record<string, Uint8Array> = {}
    for (const name of assetRefs(f.design)) if (!this.onDisk.has(name) && f.assets[name]) fresh[name] = f.assets[name]
    return { kind: 'design', file: { design: f.design, assets: fresh }, partial: true }
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
