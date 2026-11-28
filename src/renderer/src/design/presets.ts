import { PRESETS } from '../../../shared/design/model'
import type { MenuItem } from '../editor'

/**
 * The sizes a new design can start at, as menu items: each preset's name with its size in pixels. Kept out of the
 * design editor so the home screen and the File menu can offer them without loading it.
 */
export const designSizeItems = (pick: (preset: string) => void): MenuItem[] =>
  Object.entries(PRESETS).map(([key, p]) => ({
    label: p.transparent ? `${p.label} (transparent)` : p.label,
    shortcut: `${p.width} x ${p.height}`,
    run: () => pick(key)
  }))
