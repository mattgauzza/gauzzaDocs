/**
 * One color per agent, used everywhere an agent shows up: its edit highlights, the "is editing" chip, the tab dot,
 * comment avatars and the participants strip. The four agents gauzzaDocs knows get their own brand-ish colors;
 * any other name gets a stable color picked from its letters, so "Reviewer" is always the same shade.
 */
export const AGENT_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4285f4',
  copilot: '#8e44ef'
}

const PALETTE = ['#e8710a', '#d01884', '#1e8e3e', '#9334e6', '#12b5cb', '#c5221f', '#f9ab00', '#5f6368']

export function agentColor(name?: string | null, kind?: string | null): string {
  const k = (kind || '').toLowerCase()
  if (AGENT_COLORS[k]) return AGENT_COLORS[k]
  const n = (name || '').trim().toLowerCase()
  for (const key of Object.keys(AGENT_COLORS)) if (n.startsWith(key)) return AGENT_COLORS[key]
  let h = 0
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return n ? PALETTE[h % PALETTE.length] : AGENT_COLORS.copilot
}
