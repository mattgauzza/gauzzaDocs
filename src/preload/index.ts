import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** window.gd: the only door from the window to the machine. */
contextBridge.exposeInMainWorld('gd', {
  platform: process.platform,
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args),
  /** Requests from main (agent ops, open/close from the CLI). The handler's return value or error is sent back. */
  serve: (channel: 'agent' | 'open' | 'close' | 'snapshot' | 'look-prepare' | 'look-shot' | 'history-restore', handler: (req: any) => Promise<unknown>) => {
    const h = async (_e: unknown, req: { id: number }) => {
      try {
        ipcRenderer.invoke('agent:reply', req.id, { result: await handler(req) })
      } catch (err) {
        ipcRenderer.invoke('agent:reply', req.id, { error: (err as Error)?.message || String(err) })
      }
    }
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  on: (channel: 'confirm-quit' | 'large-progress' | 'comments-changed' | 'listeners' | 'agents-state' | 'update' | 'context-command' | 'folder-changed' | 'history-paused' | 'history-changed', cb: (...a: any[]) => void) => {
    const h = (_e: unknown, ...a: any[]) => cb(...a)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  tabs: (list: unknown[]) => ipcRenderer.send('tabs', list),
  changed: (file: string, info: Record<string, unknown> = {}) => ipcRenderer.send('changed', file, info),
  /** Tells main what kind of editor a right-click landed in, just before the native menu is built. */
  contextTarget: (kind: 'doc' | 'text' | 'other') => ipcRenderer.send('context-target', { kind }),
  pathFor: (file: File) => webUtils.getPathForFile(file)
})
