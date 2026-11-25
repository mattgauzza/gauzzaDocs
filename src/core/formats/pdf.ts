import fs from 'node:fs'

export const loadPdf = (file: string) => ({ kind: 'pdf' as const, bytes: new Uint8Array(fs.readFileSync(file)) })
export const savePdf = (file: string, bytes: Uint8Array) => fs.writeFileSync(file, bytes)
