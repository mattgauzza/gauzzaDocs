/**
 * "ABCDEF+Calibri-BoldItalic" -> "Calibri-BoldItalic": the subset prefix PDFs put on embedded fonts goes, and so does
 * the number pdf-lib adds to fonts it embeds ("ArialMT-9750").
 */
export const baseFontName = (raw?: string) => (raw || '').replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '').trim()

/**
 * A key that matches a PDF's font name to an installed font's name: "Calibri-Bold", "Calibri,Bold" and "Calibri Bold"
 * all become "calibribold"; "Arial-BoldMT" becomes "arialbold" and "TimesNewRomanPSMT" becomes "timesnewroman".
 */
export function fontKey(name: string) {
  return baseFontName(name)
    .toLowerCase()
    .replace(/\((truetype|opentype)\)/g, '')
    .replace(/oblique/g, 'italic')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(psmt|mt|ps)$/, '')
    .replace(/regular$/, '')
}
