/// <reference types="vite/client" />
interface GdBridge {
  platform: string
  call<T = any>(method: string, ...args: unknown[]): Promise<T>
  serve(channel: 'agent' | 'open' | 'close', handler: (req: any) => Promise<unknown>): () => void
  on(channel: 'confirm-quit' | 'large-progress' | 'comments-changed' | 'listeners' | 'update' | 'context-command', cb: (...a: any[]) => void): () => void
  tabs(list: unknown[]): void
  changed(file: string, info?: Record<string, unknown>): void
  contextTarget(kind: 'doc' | 'text' | 'other'): void
  pathFor(file: File): string
}
interface Window {
  gd: GdBridge
}
