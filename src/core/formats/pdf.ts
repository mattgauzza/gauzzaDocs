import fs from 'node:fs'

export const loadPdf = (file: string) => ({ kind: 'pdf' as const, bytes: new Uint8Array(fs.readFileSync(file)) })
