// Designs to pixels, in a window: PNG export and `gdocs look` draw in the hidden look window, thumbnails in the editor.
// The SVG always comes from designToSvg in raster mode, so the pixels match what the editor shows.

/** The long side of a design's thumbnail, in px. */
export const THUMBNAIL_SIDE = 512

/** A thumbnail's size: the artboard's shape with its long side THUMBNAIL_SIDE px, and at least 1 px each way. */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const k = THUMBNAIL_SIDE / Math.max(width, height, 1)
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/**
 * SVG to PNG bytes at a size. The SVG is loaded as an image, which never runs a script or fetches anything, and drawn
 * onto a canvas that size. Throws when the image can't be read or the canvas can't be made: Chromium caps a canvas at
 * 16,384 px a side and 268,435,456 pixels, and memory can run out before that.
 */
export async function rasterize(svg: string, width: number, height: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch {
      throw new Error('This drawing could not be read as an image.')
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')
    if (g) g.drawImage(img, 0, 0, width, height)
    const blob = g ? await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png')) : null
    if (!blob) throw new Error(`There isn't enough memory to draw a ${width} x ${height} px image. Try a smaller size.`)
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}
