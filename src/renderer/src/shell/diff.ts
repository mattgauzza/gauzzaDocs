/**
 * What changed between two versions of a file, as an agent would want to hear it: the first changed line and the
 * lines removed and added there (trimmed common prefix and suffix). Long runs are cut so one paste cannot flood
 * the agent; `truncated` says so.
 */
export function diffLines(before: string, after: string, max = 40) {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) (endA--, endB--)
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)
  return {
    line: start + 1,
    removed: removed.slice(0, max),
    added: added.slice(0, max),
    ...(removed.length > max || added.length > max ? { truncated: true, removedCount: removed.length, addedCount: added.length } : {})
  }
}
