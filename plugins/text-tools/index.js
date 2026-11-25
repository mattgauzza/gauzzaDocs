// Classic text utilities. Each works on the selection, or on the whole text when nothing is selected.
const b64e = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0)))
const lines = fn => s => fn(s.split('\n')).join('\n')
const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true })

const TOOLS = [
  ['sort', 'Sort lines A to Z', lines(l => [...l].sort(cmp))],
  ['sort-desc', 'Sort lines Z to A', lines(l => [...l].sort((a, b) => cmp(b, a)))],
  ['dedupe', 'Remove duplicate lines', lines(l => [...new Set(l)])],
  ['blank', 'Remove blank lines', lines(l => l.filter(x => x.trim()))],
  ['trim', 'Trim trailing spaces', lines(l => l.map(x => x.replace(/\s+$/, '')))],
  ['reverse', 'Reverse lines', lines(l => [...l].reverse())],
  ['number', 'Number lines', lines(l => l.map((x, i) => `${i + 1}. ${x}`))],
  ['upper', 'UPPER CASE', s => s.toUpperCase()],
  ['lower', 'lower case', s => s.toLowerCase()],
  ['title', 'Title Case', s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())],
  ['b64e', 'Base64 encode', b64e],
  ['b64d', 'Base64 decode', b64d],
  ['urle', 'URL encode', s => encodeURIComponent(s)],
  ['urld', 'URL decode', s => decodeURIComponent(s)],
  ['tabs', 'Tabs to spaces', s => s.replace(/\t/g, '  ')]
]

export function activate(api) {
  for (const [id, title, fn] of TOOLS) {
    api.registerCommand({
      id,
      title: `Text: ${title}`,
      run({ editor, toast }) {
        if (!editor) return toast('Open a file with text first')
        const sel = editor.getSelection()
        if (sel) editor.replaceSelection(fn(sel))
        else editor.setText(fn(editor.getText()))
      }
    })
  }
  api.registerFormatter({ id: 'trim', name: 'Trim trailing whitespace', format: s => s.split('\n').map(x => x.replace(/\s+$/, '')).join('\n') })
}
