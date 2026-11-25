import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, type WebContents } from 'electron'
import { docId } from '../shared/docId'
import type { Kind } from '../shared/kinds'
import type { FilePayload } from '../shared/types'

/**
 * `gdocs look`: lets an agent see a file the way the app shows it. A hidden offscreen window runs the same editors
 * (renderer #look, see renderer/src/look/Look.tsx), gets the content, and is captured one slide or screen at a time
 * into PNGs the agent opens with its image tool. The window is reused for a minute and a half, then closed.
 */
export type Ask = (wc: WebContents, channel: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

export interface LookRequest {
  path: string
  kind: Kind
  payload: FilePayload
  from?: number
  count?: number
  width?: number
  height?: number
  theme?: string
  out?: string
}
export interface LookImage { n: number; file: string; width: number; height: number }
export interface LookResult { path: string; unit: 'slide' | 'screen'; total: number; images: LookImage[] }

interface Rect { x: number; y: number; width: number; height: number }

export const LOOK_MAX = 30
const IDLE_MS = 90_000
const DIR = path.join(os.tmpdir(), 'gauzzadocs-look')

let w: BrowserWindow | null = null
let idle: NodeJS.Timeout | undefined
let queue: Promise<unknown> = Promise.resolve()

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One look at a time: they share the window. */
export function look(req: LookRequest, ask: Ask, preload: string, load: (w: BrowserWindow) => Promise<void>): Promise<LookResult> {
  const run = queue.then(() => shoot(req, ask, preload, load))
  queue = run.catch(() => undefined)
  return run
}

export function closeLook() {
  clearTimeout(idle)
  if (w && !w.isDestroyed()) w.destroy()
  w = null
}

async function windowFor(width: number, height: number, preload: string, load: (w: BrowserWindow) => Promise<void>) {
  clearTimeout(idle)
  if (w && !w.isDestroyed()) {
    w.setContentSize(width, height)
    return w
  }
  w = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { preload, sandbox: false, offscreen: true, spellcheck: false, backgroundThrottling: false }
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', e => e.preventDefault())
  w.on('closed', () => (w = null))
  await load(w)
  // Wait for the page to start listening (React mounts after load).
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript('!!document.querySelector(".look-host")').catch(() => false)) break
    await sleep(100)
  }
  await sleep(50)
  return w
}

async function shoot(req: LookRequest, ask: Ask, preload: string, load: (w: BrowserWindow) => Promise<void>): Promise<LookResult> {
  const slides = req.kind === 'slides'
  // Slides are 13.333 x 7.5 in, which is 1280 x 720 at 96 dpi. Other files get a tall, page-like window.
  const width = clamp(req.width ?? (slides ? 1280 : 1200), 480, 2400)
  const height = clamp(req.height ?? (slides ? 720 : 1400), 360, 3000)
  const win = await windowFor(width, height, preload, load)
  const wc = win.webContents
  try {
    const prep = (await ask(wc, 'look-prepare', { path: req.path, kind: req.kind, payload: req.payload, theme: req.theme }, 45_000)) as {
      unit: 'slide' | 'screen'
      total: number
    }
    const total = Math.max(1, prep.total)
    const from = clamp(req.from ?? 1, 1, total)
    const count = clamp(req.count ?? 3, 1, LOOK_MAX)
    const dir = req.out ? path.resolve(req.out) : DIR
    fs.mkdirSync(dir, { recursive: true })
    const tag = docId(req.path).slice(4)
    // Old shots of this file would be confusing next to new ones (only in our own folder; --out is the agent's).
    if (!req.out) for (const f of fs.readdirSync(dir)) if (f.startsWith(`${tag}-`)) fs.rmSync(path.join(dir, f), { force: true })

    const images: LookImage[] = []
    for (let i = from - 1; i < Math.min(total, from - 1 + count); i++) {
      const rect = (await ask(wc, 'look-shot', { index: i }, 20_000)) as Rect
      let img = await wc.capturePage(rect)
      if (img.isEmpty()) {
        wc.invalidate()
        await sleep(300)
        img = await wc.capturePage(rect)
      }
      if (img.isEmpty()) throw new Error('Could not capture the page. Try again in a moment.')
      const file = path.join(dir, `${tag}-${prep.unit}-${i + 1}.png`)
      await fs.promises.writeFile(file, img.toPNG())
      const size = img.getSize()
      images.push({ n: i + 1, file, width: size.width, height: size.height })
    }
    return { path: req.path, unit: prep.unit, total, images }
  } finally {
    idle = setTimeout(closeLook, IDLE_MS)
  }
}
