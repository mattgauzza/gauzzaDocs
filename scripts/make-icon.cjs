// Draws resources/icon.png (taskbar / window / installer icon). Run: npm run icon
// Keep in step with Logo in src/renderer/src/shell/icons.tsx: a green sheet behind a blue doc with three lines.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false })
  await w.loadURL('about:blank')
  const url = await w.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas'); c.width = c.height = 1024
    const x = c.getContext('2d'); x.scale(1024 / 32, 1024 / 32)
    x.save(); x.translate(12, 16); x.rotate(-10 * Math.PI / 180); x.translate(-12, -16)
    x.fillStyle = '#0f9d58'; x.beginPath(); x.roundRect(3, 5, 18, 23, 3); x.fill(); x.restore()
    x.fillStyle = '#4285f4'; x.beginPath(); x.roundRect(11, 3, 18, 24, 3); x.fill()
    x.fillStyle = '#fff'; x.fillRect(15, 10, 10, 1.6); x.fillRect(15, 14, 10, 1.6); x.fillRect(15, 18, 7, 1.6)
    return c.toDataURL()
  })()`)
  fs.mkdirSync(path.join(__dirname, '../resources'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '../resources/icon.png'), Buffer.from(url.split(',')[1], 'base64'))
  app.quit()
})
