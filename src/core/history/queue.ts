/**
 * Per-key job queue for history work. Jobs for one key run one at a time, in order; a job queued with
 * `low` waits behind every normal job for that key (the folder watcher uses it). A failing job never stops the queue.
 */
type Job = () => Promise<void>
interface Lane {
  normal: Job[]
  low: Job[]
  running: boolean
}

const lanes = new Map<string, Lane>()
let pending = 0
let waiters: Array<() => void> = []

async function drain(key: string, lane: Lane) {
  lane.running = true
  await Promise.resolve() // never start a job inside the caller's call
  try {
    for (;;) {
      const job = lane.normal.shift() ?? lane.low.shift()
      if (!job) break
      try {
        await job()
      } catch {
        /* jobs report their own failures */
      } finally {
        pending--
      }
    }
  } finally {
    lane.running = false
    lanes.delete(key)
    if (pending === 0) {
      const w = waiters
      waiters = []
      for (const r of w) r()
    }
  }
}

export function enqueue(key: string, job: () => Promise<void>, opts: { low?: boolean } = {}): void {
  let lane = lanes.get(key)
  if (!lane) {
    lane = { normal: [], low: [], running: false }
    lanes.set(key, lane)
  }
  ;(opts.low ? lane.low : lane.normal).push(job)
  pending++
  if (!lane.running) void drain(key, lane)
}

/** Resolves when every queued job (including ones queued meanwhile) has finished. */
export function idle(): Promise<void> {
  if (pending === 0) return Promise.resolve()
  return new Promise<void>(r => waiters.push(r))
}
