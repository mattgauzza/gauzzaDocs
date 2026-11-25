// HTML preview: renders the file in a sandboxed frame. The sandbox has no allow-scripts, so nothing in the page runs,
// and it cannot reach the app. Relative links and images that point at local files may not load.

export function activate(api) {
  api.registerPreview({
    id: 'page',
    name: 'Rendered page',
    languages: ['html', 'xml'],
    render(text, el, ctx) {
      const isSvg = ctx.path.toLowerCase().endsWith('.svg') || /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(text)
      if (ctx.language === 'xml' && !isSvg) {
        el.innerHTML = '<p style="color:var(--muted)">Only SVG files can be previewed as pictures.</p>'
        return
      }
      let frame = el.querySelector('iframe')
      if (!frame) {
        el.innerHTML = ''
        el.style.padding = '0'
        frame = document.createElement('iframe')
        frame.setAttribute('sandbox', '') // no scripts, no forms, no navigation, no same-origin access
        frame.setAttribute('referrerpolicy', 'no-referrer')
        frame.style.cssText = 'width:100%;height:100%;border:0;background:#fff'
        el.appendChild(frame)
      }
      frame.srcdoc = isSvg
        ? `<!doctype html><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:96%;max-height:96%}</style>${text}`
        : text
    }
  })
}
