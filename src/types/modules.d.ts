declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
}
declare module '@turbodocx/html-to-docx' {
  const htmlToDocx: (html: string, header?: string | null, options?: Record<string, unknown>, footer?: string | null) => Promise<Buffer | ArrayBuffer | Blob>
  export default htmlToDocx
}
