// Developer utilities. "Insert" commands replace the selection (or insert at the cursor);
// the others work on the selection, or the whole text when nothing is selected.

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'

const b64url = s => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/')
  return new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0)))
}
export function decodeJwt(token) {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('That is not a JWT (expected header.payload.signature)')
  const header = JSON.parse(b64url(parts[0]))
  const payload = JSON.parse(b64url(parts[1]))
  const when = k => (typeof payload[k] === 'number' ? `  // ${new Date(payload[k] * 1000).toISOString()}` : '')
  const body = JSON.stringify(payload, null, 2).replace(/^(\s*"(exp|iat|nbf)": (\d+))(,?)$/gm, (m, a, k, _v, comma) => `${a}${comma}${when(k)}`)
  return `// header\n${JSON.stringify(header, null, 2)}\n// payload\n${body}\n// signature not verified`
}
export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export function unixToIso(s) {
  return s.replace(/\b(\d{10}|\d{13})\b/g, n => new Date(n.length === 13 ? Number(n) : Number(n) * 1000).toISOString())
}

export function activate(api) {
  const insert = (id, title, make) =>
    api.registerCommand({ id, title, run: async ({ editor, toast }) => (editor ? editor.replaceSelection(await make()) : toast('Open a file first')) })
  const transform = (id, title, fn, done) =>
    api.registerCommand({
      id,
      title,
      run: async ({ editor, toast }) => {
        if (!editor) return toast('Open a file first')
        const sel = editor.getSelection()
        try {
          const out = await fn(sel || editor.getText())
          if (done) return done(out, toast)
          sel ? editor.replaceSelection(out) : editor.setText(out)
        } catch (e) {
          toast(e.message)
        }
      }
    })

  insert('uuid', 'Insert: UUID', () => crypto.randomUUID())
  insert('iso', 'Insert: date and time (ISO 8601)', () => new Date().toISOString())
  insert('date', 'Insert: today\'s date', () => new Date().toISOString().slice(0, 10))
  insert('unix', 'Insert: Unix timestamp', () => String(Math.floor(Date.now() / 1000)))
  insert('lorem', 'Insert: lorem ipsum paragraph', () => LOREM)
  transform('sha256', 'Copy SHA-256 of selection', sha256, (hash, toast) => navigator.clipboard.writeText(hash).then(() => toast(`SHA-256 copied: ${hash.slice(0, 16)}…`)))
  transform('jwt', 'Decode JWT (selection)', decodeJwt)
  transform('unix2iso', 'Unix timestamps → ISO dates', unixToIso)
  transform('jsonesc', 'Escape as a JSON string', s => JSON.stringify(s))
  transform('jsonunesc', 'Unescape a JSON string', s => {
    const t = s.trim()
    return JSON.parse(t.startsWith('"') ? t : `"${t}"`)
  })
}
