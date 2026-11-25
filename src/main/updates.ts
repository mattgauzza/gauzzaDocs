import { type BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Installed copies keep themselves current from the project's GitHub releases (like quickMail): check at start and
 * every half hour, download in the background, then offer a restart (the green button in the tab strip).
 * An update left waiting is installed the next time the app closes. GAUZZADOCS_FAKE_UPDATE shows the button for testing.
 */
let ready = process.env.GAUZZADOCS_FAKE_UPDATE || ''

export const updateReady = () => ready

export function watchForUpdates(win: () => BrowserWindow | null) {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', info => {
    ready = info.version
    win()?.webContents.send('update', ready)
  })
  autoUpdater.on('error', () => {}) // offline, or GitHub unreachable: try again at the next check
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, 30 * 60_000)
}

export function installUpdate() {
  if (ready && app.isPackaged) autoUpdater.quitAndInstall()
}
