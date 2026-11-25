// Writing tools: a Hemingway-style review of the document. Works on markdown, HTML documents and plain text.

const plain = (text, language) =>
  language === 'html'
    ? text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|h[1-6]|li|div|blockquote|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    : text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[#>*\-+\s]+/gm, '').replace(/[*_~]/g, '')

const syllables = word => {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length <= 3) return 1
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups ? groups.length : 1)
}

const PASSIVE = /\b(am|is|are|was|were|be|been|being)\s+(\w+ly\s+)?(\w+ed|known|done|given|made|seen|taken|written|built|chosen|shown|found|held|kept|left|sent|told|paid|said|brought|bought|caught|taught|thought|run|set|put|cut|hit|read)\b/gi
const ADVERB = /\b\w{3,}ly\b/gi
const NOT_ADVERBS = new Set(['only', 'family', 'reply', 'apply', 'supply', 'early', 'daily', 'likely', 'july', 'italy', 'rely', 'holy', 'ugly', 'fly', 'belly', 'jelly', 'bully', 'rally', 'ally', 'assembly', 'anomaly', 'monopoly', 'friendly', 'lonely', 'lovely', 'silly', 'weekly', 'monthly', 'yearly'])
const WEAK = ['very', 'really', 'just', 'actually', 'basically', 'literally', 'quite', 'rather', 'somewhat', 'simply', 'totally', 'definitely', 'probably', 'perhaps', 'kind of', 'sort of', 'in order to', 'due to the fact that', 'at this point in time', 'utilize']

export function analyse(text) {
  const sentences = text.replace(/\n+/g, '. ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => /\w/.test(s))
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || []
  const syl = words.reduce((n, w) => n + syllables(w), 0)
  const wps = words.length / Math.max(1, sentences.length)
  const spw = syl / Math.max(1, words.length)
  const flesch = Math.round(206.835 - 1.015 * wps - 84.6 * spw)
  const grade = Math.max(0, Math.round(0.39 * wps + 11.8 * spw - 15.59))
  const long = sentences.filter(s => (s.match(/\w+/g) || []).length > 25)
  const passive = [...text.matchAll(PASSIVE)].map(m => m[0])
  const adverbs = [...text.matchAll(ADVERB)].map(m => m[0]).filter(w => !NOT_ADVERBS.has(w.toLowerCase()))
  const weak = WEAK.flatMap(p => [...text.matchAll(new RegExp(`\\b${p}\\b`, 'gi'))].map(m => m[0]))
  const counts = new Map()
  for (const w of words) {
    const k = w.toLowerCase()
    if (k.length > 4) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const repeated = [...counts].filter(([, n]) => n >= Math.max(4, words.length / 150)).sort((a, b) => b[1] - a[1]).slice(0, 12)
  return { words: words.length, sentences: sentences.length, flesch, grade, wps: Math.round(wps * 10) / 10, long, passive, adverbs, weak, repeated }
}

const level = f => (f >= 80 ? ['Very easy', '#188038'] : f >= 60 ? ['Plain English', '#188038'] : f >= 50 ? ['Fairly hard', '#b06000'] : f >= 30 ? ['Hard', '#c5221f'] : ['Very hard', '#c5221f'])

export function activate(api) {
  const esc = api.escapeHtml
  api.registerPreview({
    id: 'review',
    name: 'Writing review',
    languages: ['markdown', 'html', 'text'],
    render(text, el, ctx) {
      const a = analyse(plain(text, ctx.language))
      const [label, color] = level(a.flesch)
      const list = (title, items, note) =>
        items.length
          ? `<h4>${title} <span class="wt-n">${items.length}</span></h4><p class="wt-note">${note}</p><ul>${items.slice(0, 30).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
          : ''
      el.innerHTML = `<style>
        .wt { font: 14px/1.55 var(--font); } .wt h4 { margin: 18px 0 2px; font-size: 13px; } .wt-n { color: var(--muted); font-weight: 400; }
        .wt-note { margin: 0 0 6px; color: var(--muted); font-size: 12px; } .wt ul { margin: 0; padding-left: 18px; } .wt li { margin: 3px 0; }
        .wt-score { display: flex; gap: 18px; flex-wrap: wrap; padding: 12px 14px; border-radius: 10px; background: var(--toolbar); }
        .wt-score b { display: block; font-size: 22px; } .wt-score span { color: var(--muted); font-size: 12px; }
      </style>
      <div class="wt">
        <div class="wt-score">
          <div><b style="color:${color}">${label}</b><span>Flesch ${a.flesch}</span></div>
          <div><b>Grade ${a.grade}</b><span>reading level</span></div>
          <div><b>${a.words.toLocaleString()}</b><span>words</span></div>
          <div><b>${a.wps}</b><span>words / sentence</span></div>
        </div>
        ${list('Long sentences', a.long, 'Over 25 words. Split them or cut words.')}
        ${list('Passive voice', a.passive, 'Say who does what: "the team shipped it", not "it was shipped".')}
        ${list('Weak words', a.weak, 'Usually safe to delete.')}
        ${list('Adverbs', a.adverbs, 'A stronger verb often does the job better.')}
        ${a.repeated.length ? `<h4>Repeated words</h4><p class="wt-note">${a.repeated.map(([w, n]) => `${esc(w)} ×${n}`).join(' · ')}</p>` : ''}
        ${!a.long.length && !a.passive.length && !a.weak.length && !a.adverbs.length ? '<p>Nothing to flag. Nice and tight.</p>' : ''}
      </div>`
    }
  })
  api.registerCommand({
    id: 'stats',
    title: 'Writing: readability summary',
    languages: ['markdown', 'html', 'text'],
    run({ editor, toast }) {
      if (!editor) return toast('Open a document first')
      const a = analyse(plain(editor.getText(), editor.language))
      toast(`${level(a.flesch)[0]} (Flesch ${a.flesch}, grade ${a.grade}) · ${a.long.length} long sentences · ${a.passive.length} passive · ${a.weak.length} weak words`)
    }
  })
}
