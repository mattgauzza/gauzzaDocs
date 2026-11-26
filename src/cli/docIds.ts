import path from 'node:path'
import { samePath } from '../core/paths'
import { docId } from '../shared/docId'

/**
 * The one file a doc id (doc:k3x9q2) names. `places` are looked through first: files open in the app, recent files
 * and files at the top of projects. Files with version history are only looked through when none of those match: they
 * include files that no longer exist, and their paths may be the same file written in another case. Two hits are one
 * file when `same` says so (samePath: case-insensitive on Windows).
 */
export function resolveDocId(id: string, places: Iterable<string>, history: () => Iterable<string>, same = samePath): string {
  const want = id.toLowerCase()
  const find = (paths: Iterable<string>) => {
    const hits: string[] = []
    for (const p of paths) {
      if (docId(p) !== want) continue
      const abs = path.resolve(p)
      if (!hits.some(h => same(h, abs))) hits.push(abs)
    }
    return hits
  }
  let hits = find(places)
  if (!hits.length) hits = find(history())
  if (!hits.length) throw new Error(`${id} isn't open in gauzzaDocs or in your recent files. Use the file's path instead.`)
  if (hits.length > 1) throw new Error(`${id} matches more than one file (${hits.join(', ')}). Use the path instead.`)
  return hits[0]
}
