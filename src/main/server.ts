import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { clearServer, writeServer } from '../core/paths'

/**
 * The live-edit bridge: a JSON-RPC style server on 127.0.0.1 that the `gdocs` CLI talks to.
 * Its port and a random token are written to ~/.gauzzadocs/server.json; every request must carry the token,
 * so only programs run by this user (who can read that file) can drive the app.
 *
 *   POST /rpc                         { method, params }  ->  { result } | { error }
 *   GET  /events?path=..&agent=..     server-sent events. With path, only that file's events. Each connection
 *                                     counts as an agent listening to that file (shown in the window).
 * Event types: opened, closed, changed, saved, comment, reply, resolved, edit (a person's edit, with the change).
 */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>

export interface Listener {
  id: number
  agent: string
  path?: string
  since: number
}

export interface Bridge {
  port: number
  emit(event: { type: string; path?: string; [k: string]: unknown }): void
  listeners(): Listener[]
  close(): void
}

export function startBridge(rpc: Rpc, onListeners: (l: Listener[]) => void): Promise<Bridge> {
  const token = crypto.randomBytes(24).toString('hex')
  const streams = new Map<http.ServerResponse, Listener>()
  let seq = 0
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const snapshot = () => [...streams.values()]

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${token}` || req.headers.origin) {
      // Browsers always send Origin on cross-site requests; refusing it keeps web pages from reaching the bridge.
      res.writeHead(401).end()
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/events')) {
      const q = new URL(req.url, 'http://x').searchParams
      const l: Listener = { id: ++seq, agent: q.get('agent') || 'Agent', path: q.get('path') || undefined, since: Date.now() }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      streams.set(res, l)
      onListeners(snapshot())
      // A comment line now and then keeps idle connections (and their presence in the window) alive.
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(ping)
        streams.delete(res)
        onListeners(snapshot())
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024 * 1024) return void res.writeHead(413).end()
    }
    let reply: unknown
    try {
      const { method, params } = JSON.parse(body)
      reply = { result: await rpc(String(method), params || {}) }
    } catch (e) {
      reply = { error: (e as Error).message || String(e) }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      writeServer({ port, token, pid: process.pid })
      resolve({
        port,
        emit: event => {
          const line = `data: ${JSON.stringify({ ...event, at: Date.now() })}\n\n`
          for (const [res, l] of streams) if (!l.path || (event.path && same(l.path, event.path))) res.write(line)
        },
        listeners: snapshot,
        close: () => {
          for (const res of streams.keys()) res.end()
          server.close()
          clearServer(process.pid)
        }
      })
    })
  })
}
