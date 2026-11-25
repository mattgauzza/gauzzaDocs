/**
 * Short, stable document IDs ("doc:k3x9q2") so a person can hand an agent a file without pasting a long path:
 * `gdocs listen doc:k3x9q2`. Derived from the file's path (case-insensitive, separators normalised), so the window,
 * main and the CLI compute the same ID with no shared table. The CLI resolves an ID against the files open in the app,
 * then recent files and projects; if two files ever share an ID it says so and asks for the path.
 */
export const DOC_ID = /^doc:([0-9a-z]{6})$/i

export function docId(file: string): string {
  const key = file.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // Two FNV-1a passes with different seeds give enough bits for six base-36 characters.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  const n = (a % 46656) * 46656 + (b % 46656) // 36^3 * 36^3 = 36^6
  return 'doc:' + n.toString(36).padStart(6, '0').slice(-6)
}
