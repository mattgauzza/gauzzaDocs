/** The next zoom level up (dir 1) or down (-1) from the current one, staying within the list. */
export function stepZoom(levels: number[], current: number, dir: 1 | -1) {
  if (dir > 0) return levels.find(z => z > current + 0.001) ?? levels[levels.length - 1]
  return [...levels].reverse().find(z => z < current - 0.001) ?? levels[0]
}

/** Zoom levels in percent for sheets and slides (slides: of the size that fits the window). */
export const SHEET_ZOOMS = [50, 75, 90, 100, 125, 150, 200]
export const SLIDE_ZOOMS = [50, 75, 100, 125, 150, 200, 300]
