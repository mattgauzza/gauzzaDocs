import type { FilePayload } from '../../../shared/types'
import type { EditorHandle } from '../editor'

/**
 * Saves what an editor holds through `write` and returns the payload that reached the disk, with the file's new
 * modification time (the editor's `saved` is told about that payload).
 *
 * A design's save sends only the assets its file doesn't hold yet (`partial`), and the worker copies the rest from the
 * file on disk. When that fails, the file on disk is the likely cause: another program (a sync tool, git) replaced it
 * with one that lacks those assets ("Asset ... is missing.") or that can't be read. So it's saved once more with
 * everything (peekPayload), which never reads the file. A failure that has nothing to do with the file fails again the
 * same way, and that error is the one reported. Plain code with no window, so tests drive it against real saves.
 */
export async function savePayload(
  h: Pick<EditorHandle, 'getPayload' | 'peekPayload'>,
  write: (payload: FilePayload) => Promise<number>
): Promise<{ payload: FilePayload; mtime: number }> {
  const payload = await h.getPayload()
  try {
    return { payload, mtime: await write(payload) }
  } catch (e) {
    if (payload.kind !== 'design' || !payload.partial || !h.peekPayload) throw e
    const full = await h.peekPayload()
    return { payload: full, mtime: await write(full) }
  }
}
