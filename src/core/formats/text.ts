import fs from 'node:fs'

export function loadText(file: string) {
  let text = fs.readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const eol = text.includes('\r\n') ? ('\r\n' as const) : ('\n' as const)
  return { kind: 'text' as const, text: text.replace(/\r\n/g, '\n'), eol }
}

export function textBytes(text: string, eol: '\n' | '\r\n' = '\n'): Uint8Array {
  return Buffer.from(eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text)
}
