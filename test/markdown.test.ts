import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateHTML, generateJSON } from '@tiptap/html'
import { htmlToMarkdown, markdownToHtml, splitFrontMatter } from '../src/shared/convert'
import { schemaExtensions } from '../src/renderer/src/doc/schema'

/** A README the way AI tools write them. Opening and saving it in the editor must give it back unchanged. */
const README = `---
title: Project Atlas
tags: [docs, ai]
owner: matt
---

# Project Atlas

A small service that turns **raw events** into *daily reports*. See https://example.com/atlas for the live demo,
or read [the design notes](docs/design.md).

## Quick start

1. Install the dependencies
2. Copy \`.env.example\` to \`.env\`
3. Run the server:
   - \`npm run dev\` for development
   - \`npm start\` in production

\`\`\`ts
import { atlas } from './atlas'

const report = await atlas.run({ days: 7 })
console.log(report.summary)
\`\`\`

## Status

- [x] Ingest events from the queue
- [x] Store them in snake_case tables
- [ ] Email the daily report

| Stage | Owner | Done |
| --- | --- | --- |
| Ingest | Ana | yes |
| Reports | Ben | no |

> **Note:** the old \`v1\` endpoint is ~~supported~~ deprecated.

---

Made with care. Questions: open an issue.
`.replace('the live demo,\nor', 'the live demo, or') // one paragraph per line, as editors keep them

/** Markdown -> HTML -> the editor's document model -> HTML -> Markdown, as when a file is opened and saved. */
function throughEditor(md: string) {
  const ext = schemaExtensions()
  const json = generateJSON(markdownToHtml(md), ext)
  return htmlToMarkdown(generateHTML(json, ext))
}

test('AI-written Markdown survives open + save in the editor unchanged', () => {
  const once = throughEditor(README)
  assert.equal(once, README)
  assert.equal(throughEditor(once), once, 'and a second save changes nothing')
})

test('front matter: split, kept through the editor, and only at the very top', () => {
  assert.deepEqual(splitFrontMatter('---\na: 1\n---\n\n# Hi\n'), { frontMatter: 'a: 1', body: '# Hi\n' })
  assert.equal(splitFrontMatter('# Hi\n\n---\na: 1\n---\n').frontMatter, null)
  const html = markdownToHtml('---\ntitle: "x <y>"\n---\nBody')
  assert.match(html, /^<div data-front-matter=""><pre>title: &quot;x &lt;y&gt;&quot;<\/pre><\/div>/)
  assert.equal(throughEditor('---\ntitle: "x <y>"\n---\n\nBody\n'), '---\ntitle: "x <y>"\n---\n\nBody\n')
})

test('escaping stays quiet: snake_case and plain brackets are left alone', () => {
  assert.equal(throughEditor('Use my_var and [1] here.\n'), 'Use my_var and [1] here.\n')
  assert.equal(throughEditor('Literal \\*stars\\* stay literal.\n'), 'Literal \\*stars\\* stay literal.\n')
})

test('saving a .md file keeps its front matter first and its agent instructions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-md-'))
  process.env.GAUZZADOCS_HOME = dir
  const { loadFile, saveFile } = await import('../src/core/files')
  const { setDocInstructions, getDocInstructions } = await import('../src/core/instructions')
  const file = path.join(dir, 'README.md')
  fs.writeFileSync(file, README)
  const f = await loadFile(file)
  assert.ok(f.payload.kind === 'doc' && f.payload.html.startsWith('<div data-front-matter'))
  await saveFile(file, f.payload)
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('---\ntitle: Project Atlas\n'))

  setDocInstructions(file, 'Keep it short.')
  const again = await loadFile(file)
  await saveFile(file, again.payload)
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.startsWith('---\ntitle: Project Atlas\n'), 'front matter stays on the first line')
  assert.match(text, /\n---\n\n<!-- gdocs:instructions\nKeep it short\.\n-->\n# Project Atlas/)
  assert.ok(!again.payload.kind || (again.payload.kind === 'doc' && !again.payload.html.includes('gdocs:instructions')))
  void getDocInstructions
  fs.rmSync(dir, { recursive: true, force: true })
})

test('markdown: page breaks survive a save and come back as breaks in the editor', () => {
  const md = htmlToMarkdown('<h1>A</h1><p>one</p><div class="page-break" style="page-break-after: always"></div><h2>B</h2><p>two</p>')
  assert.match(md, /one\n\n<div style="page-break-after: always"><\/div>\n\n## B/)
  const json = generateJSON(markdownToHtml(md), schemaExtensions())
  assert.ok(json.content.some((n: { type: string }) => n.type === 'pageBreak'), 'parsed as a page break node')
  assert.doesNotMatch(htmlToMarkdown('<p>a</p><div></div><p>b</p>'), /page-break/)
})
