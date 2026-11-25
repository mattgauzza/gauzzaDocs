import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Built app only. Plugins load from the gdplugin: scheme, which main serves from ~/.gauzzadocs/plugins.
const CSP =
  "default-src 'self'; script-src 'self' gdplugin:; style-src 'self' 'unsafe-inline' gdplugin:; img-src * data: blob:; " +
  "font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' gdplugin: gdfile: blob: data:; object-src 'none'; base-uri 'none'"

export default defineConfig({
  main: { build: { externalizeDeps: true } },
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'gauzzadocs-csp',
        apply: 'build',
        transformIndexHtml: html =>
          html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
      }
    ]
  }
})
