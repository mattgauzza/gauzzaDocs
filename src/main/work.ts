import path from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * Runs a job on the file worker thread (see worker.ts) and resolves with its result. The worker is started on first use
 * and restarted if it ever dies, so one bad file cannot take file handling down for the rest of the session.
 */
let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; progress?(p: unknown): void }>()

type WorkerEvent = (name: string, data: unknown) => void
const eventListeners = new Set<WorkerEvent>()
/** Things the worker reports unasked, such as `history-paused` ({ reason }). Returns a function that stops listening. */
export function onWorkerEvent(cb: WorkerEvent): () => void {
  eventListeners.add(cb)
  return () => void eventListeners.delete(cb)
}

function start() {
  const w = new Worker(path.join(__dirname, 'worker.js'))
  w.on('message', (m: { id: number; result?: unknown; error?: string; progress?: unknown; event?: string }) => {
    if (typeof m.event === 'string') {
      const { event, ...data } = m
      for (const cb of eventListeners) {
        try {
          cb(event, data)
        } catch { /* a listener must never break the worker's replies */ }
      }
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    if ('progress' in m) return p.progress?.(m.progress)
    pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.result)
  })
  const fail = (e: Error) => {
    for (const p of pending.values()) p.reject(e)
    pending.clear()
    if (worker === w) worker = null
  }
  w.on('error', fail)
  w.on('exit', code => code !== 0 && fail(new Error(`The file worker stopped (code ${code}); try again`)))
  return w
}

export function work<T = unknown>(fn: string, args: unknown[] = [], onProgress?: (p: unknown) => void): Promise<T> {
  worker ??= start()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress: onProgress })
    worker!.postMessage({ id, fn, args })
  })
}

/** Starts the worker early so its warm-up (loading the format libraries) happens while the window opens. */
export const warmUp = () => void (worker ??= start())

export const stopWorker = () => {
  worker?.terminate()
  worker = null
}
