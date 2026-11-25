# gauzzaDocs plugin marketplace

This folder is the marketplace. The app reads [`marketplace.json`](marketplace.json) from this repository on GitHub
(`https://raw.githubusercontent.com/mattgauzza/gauzzaDocs/main/plugins/marketplace.json`; change it under
Settings → Plugin library) and installs plugins into `~/.gauzzadocs/plugins/<id>/`. Every file listed there carries a
SHA-256: the app downloads each file, checks it, and refuses the plugin if anything differs. When GitHub cannot be
reached, the copy of this folder bundled with the app is used.

In the app: **Plugins → Marketplace…** (or the puzzle icon on the home screen). From the terminal:

```
gdocs plugins marketplace            # everything on offer, by category (✓ installed, ↑ update)
gdocs plugins marketplace sql        # search
gdocs plugins install sql-format writing-tools
gdocs plugins update                 # update everything
gdocs format query.sql               # formatters also run from the CLI
```

## What's in it

| Plugin | Category | What it does |
| --- | --- | --- |
| `json-tools` | Formatting | Pretty-print, minify, sort keys; JSON tree preview |
| `xml-tools` | Formatting | Indent XML / SVG / HTML; minify XML |
| `sql-format` | Formatting | One clause per line, indented joins and conditions, upper-case keywords; minify |
| `css-tools` | Formatting | Format, minify, sort properties; color swatch preview |
| `text-tools` | Text | Sort, dedupe, trim, case, Base64, URL encode, number lines (Notepad++ TextFX staples) |
| `writing-tools` | Writing | Readability score and grade, long sentences, passive voice, weak words, adverbs, repeats |
| `markdown-preview` | Preview | Live rendered Markdown; align tables |
| `html-preview` | Preview | Rendered .html / .svg in a sandbox (scripts never run) |
| `csv-preview` | Data | CSV/TSV as a table; align columns |
| `markdown-tables` | Data | CSV/TSV ⇄ Markdown tables; tidy every table in a file |
| `yaml-tools` | Data | JSON ⇄ YAML; normalise YAML |
| `dev-utils` | Developer | UUIDs, timestamps, lorem ipsum, SHA-256, JWT decode, Unix → ISO, JSON string escape |
| `log-insights` | Developer | Counts by level, most frequent errors (numbers and ids folded together), time span |

## Writing a plugin

A plugin is a folder with `plugin.json` and one ES module. No build step and no dependencies.

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One sentence on what it does.",
  "author": "you",
  "category": "Formatting",
  "tags": ["json"],
  "icon": "🧩",
  "main": "index.js",
  "languages": ["json"]
}
```

```js
export function activate(api) {
  // Reformat a whole file (Tools → Format document, Ctrl+Shift+F, and `gdocs format`).
  api.registerFormatter({ id: 'pretty', name: 'JSON: pretty', languages: ['json'], format: (text, { language, path }) => text })

  // A live view beside the editor (View → Preview pane). Window only.
  api.registerPreview({ id: 'view', name: 'My view', languages: ['json'], render: (text, el) => { el.textContent = text } })

  // A command under the Plugins menu. Window only.
  api.registerCommand({ id: 'shout', title: 'Shout', run: ({ editor, toast }) => editor?.replaceSelection(editor.getSelection().toUpperCase()) })
}
```

- `id` must match the folder name. `category` is one of the marketplace's categories (or a new one); `icon` is an emoji.
- `languages` are the text editor's language ids (`json`, `markdown`, `html`, `xml`, `csv`, `sql`, `yaml`, `css`, `python`,
  `javascript`, …). Documents report `html` (or `markdown` for .md files) and spreadsheets `csv`. Omit it or use `["*"]` for all.
- The API: `api.markdown.toHtml(md)` / `api.markdown.fromHtml(html)`, `api.escapeHtml(s)`, `api.ui.toast(msg)`.
  `api.host` is `'app'` in the window and `'cli'` when `gdocs format` loads the plugin in Node; formatters run in both,
  so keep them free of DOM calls. `api.version` is the plugin API version (1); set `"minApi"` if you need a newer one.
- List any extra files your plugin loads under `"files"`, or they will not be downloaded.
- Plugins have the same access as the app, like Notepad++ plugins. Only install plugins you trust.

## Trying it locally

```
gdocs plugins install ./plugins/my-plugin     # straight from a folder
```

Or point Settings → Plugin library at this folder to browse it as a marketplace. Then Plugins → Reload plugins.

## Submitting a plugin

Start with `gdocs plugins new my-plugin`, and check it with `gdocs plugins validate ./my-plugin` (CI runs the same
checks on every pull request). Listed plugins must not import Node modules, use `eval`, make network requests or
download code, and must stay under 512 KB. Then pick one:

**In this repo** (best for small plugins we maintain together)

1. Fork, add your folder under `plugins/`.
2. Run `npm run marketplace`: it validates every plugin and rebuilds `marketplace.json` (checksums) and
   [MARKETPLACE.md](MARKETPLACE.md) (the catalog page). Commit both with your folder.
3. Open a pull request. When you later change the plugin, bump `version` so installed copies are offered the update.

**In your own repo** (you keep ownership; we list it)

1. Push your plugin folder to a public GitHub repository.
2. Add one line to [`external.json`](external.json) with a raw URL **pinned to a commit**:
   `{ "source": "https://raw.githubusercontent.com/you/your-repo/<40-character commit>/plugin-folder/" }`,
   run `npm run marketplace`, and open a pull request. Or just
   [fill in the submission form](https://github.com/mattgauzza/gauzzaDocs/issues/new?template=plugin-submission.yml)
   and we'll do it.
3. The marketplace records the SHA-256 of every file at that commit, so users install exactly what was reviewed.
   A new version is a pull request that moves the pin. Community plugins are labelled as such in the marketplace.

`.gitattributes` keeps plugin files byte-for-byte in git, so the checksums match what GitHub serves.
