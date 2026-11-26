/**
 * Which editor opens a file, decided by its extension. Pure: used by main, the CLI and the window alike.
 *  doc   rich document editor (Google Docs style): .html .htm .md .markdown .docx
 *  sheet spreadsheet editor (Google Sheets style): .xlsx .csv .tsv
 *  pdf   PDF viewer / markup: .pdf
 *  slides presentation editor (Google Slides style): .pptx
 *  design layered design editor (artboards, layers, diagrams): .gdesign
 *  text  code and plain text editor (Notepad++ style): everything else
 */
export type Kind = 'doc' | 'sheet' | 'pdf' | 'text' | 'slides' | 'design'

const DOC = ['html', 'htm', 'md', 'markdown', 'docx']
const SHEET = ['xlsx', 'csv', 'tsv']
const SLIDES = ['pptx']
const DESIGN = ['gdesign']

export const extOf = (file: string) => {
  const base = file.split(/[\\/]/).pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
export const baseName = (file: string) => file.split(/[\\/]/).pop() || file
export const stem = (file: string) => baseName(file).replace(/\.[^.]+$/, '')

export function kindOf(file: string): Kind {
  const ext = extOf(file)
  if (DOC.includes(ext)) return 'doc'
  if (SHEET.includes(ext)) return 'sheet'
  if (ext === 'pdf') return 'pdf'
  if (SLIDES.includes(ext)) return 'slides'
  if (DESIGN.includes(ext)) return 'design'
  return 'text'
}

/** Formats whose save cannot keep everything the original file held. They are not autosaved. */
export const lossy = (file: string) => ['docx', 'pdf'].includes(extOf(file))

/** Language id for the text editor and for plugin formatters. Matches @codemirror/language-data names, lowercased. */
const LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', mts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', html: 'html', htm: 'html', xml: 'xml', svg: 'xml', css: 'css', scss: 'sass',
  less: 'less', md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', c: 'c', h: 'c', cpp: 'c++', cc: 'c++', hpp: 'c++', cs: 'c#', php: 'php', sh: 'shell', bash: 'shell',
  ps1: 'powershell', psm1: 'powershell', bat: 'shell', cmd: 'shell', sql: 'sql', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'properties', env: 'dotenv', properties: 'properties', cfg: 'properties', conf: 'properties',
  config: 'xml', plist: 'xml', csproj: 'xml', props: 'xml', csv: 'csv', tsv: 'csv',
  lua: 'lua', swift: 'swift', dart: 'dart', r: 'r', pl: 'perl', vue: 'vue', svelte: 'svelte', dockerfile: 'dockerfile',
  txt: 'text', log: 'text'
}
export function languageOf(file: string): string {
  const base = baseName(file).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'shell'
  // Config dotfiles have no extension before the dot: .env, .env.local, .prettierrc, .bashrc ...
  if (/^\.env(\.|$)/.test(base) || base.endsWith('.env')) return 'dotenv'
  if (/^\.(prettierrc|eslintrc|babelrc|swcrc|jshintrc|stylelintrc)$/.test(base)) return 'json'
  if (/^\.(npmrc|yarnrc|editorconfig|gitconfig|gitattributes|gitignore|dockerignore|npmignore|prettierignore|eslintignore)$/.test(base)) return 'properties'
  if (/^\.(bashrc|bash_profile|zshrc|zprofile|profile|bash_aliases)$/.test(base)) return 'shell'
  return LANG[extOf(file)] || 'text'
}

/** Extensions shown in the Open dialog, grouped like the editors. */
export const OPEN_FILTERS = [
  { name: 'All supported', extensions: ['*'] },
  { name: 'Documents', extensions: DOC },
  { name: 'Spreadsheets', extensions: SHEET },
  { name: 'Presentations', extensions: SLIDES },
  { name: 'Designs', extensions: DESIGN },
  { name: 'PDF', extensions: ['pdf'] }
]
