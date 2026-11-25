# gauzzaDocs plugin marketplace

This folder is the plugin marketplace. The app reads [`marketplace.json`](marketplace.json) from this repo on GitHub and
installs plugins into `~/.gauzzadocs/plugins/<id>/`. Every file in the marketplace has a SHA-256 next to it. The app
checks each download against it and won't install a plugin if anything doesn't match. When GitHub can't be reached, the
app uses the copy of this folder that ships with it. You can point it somewhere else under Settings > Plugin library.

To browse plugins, open Plugins > Marketplace in the app or click the puzzle icon on the home screen. From a terminal:

```
gdocs plugins marketplace            # everything available, by category
gdocs plugins marketplace sql        # search
gdocs plugins install sql-format writing-tools
gdocs plugins update                 # update everything
gdocs format query.sql               # formatters work from the terminal too
```

## What's in it

| Plugin | Category | What it does |
| --- | --- | --- |
| `json-tools` | Formatting | Pretty print, minify and sort JSON keys, plus a tree view |
| `xml-tools` | Formatting | Indent XML, SVG and HTML and minify XML |
| `sql-format` | Formatting | One clause per line with indented joins and conditions, upper case keywords and a minifier |
| `css-tools` | Formatting | Format, minify and sort properties, plus swatches of every color in the file |
| `text-tools` | Text | Sort, dedupe, trim, change case, Base64, URL encode and number lines |
| `writing-tools` | Writing | Readability score and grade, long sentences, passive voice, weak words and repeated words |
| `markdown-preview` | Preview | Live rendered Markdown and a table formatter |
| `html-preview` | Preview | Rendered HTML and SVG files in a sandbox where scripts never run |
| `csv-preview` | Data | CSV and TSV shown as a table and a column aligner |
| `markdown-tables` | Data | Turns CSV or TSV into Markdown tables and back, and tidies every table in a file |
| `yaml-tools` | Data | Converts JSON to YAML and back and normalises YAML |
| `dev-utils` | Developer | UUIDs, timestamps, lorem ipsum, SHA-256, JWT decoding, Unix times to ISO dates and JSON string escaping |
| `log-insights` | Developer | Counts by log level, the most common errors with numbers and ids folded together and the time span |

[MARKETPLACE.md](MARKETPLACE.md) has the full catalog, generated from the plugins themselves.

## Writing a plugin

A plugin is a folder with a `plugin.json` and one JavaScript file. There's no build step and no dependencies.
`gdocs plugins new my-plugin` writes a starter you can edit.

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
  // Reformats a whole file: Tools > Format document (Ctrl+Shift+F) and `gdocs format`.
  api.registerFormatter({ id: 'pretty', name: 'JSON: pretty', languages: ['json'], format: (text, { language, path }) => text })

  // A live view beside the editor: View > Preview pane. Only in the app.
  api.registerPreview({ id: 'view', name: 'My view', languages: ['json'], render: (text, el) => { el.textContent = text } })

  // A command in the Plugins menu. Only in the app.
  api.registerCommand({ id: 'shout', title: 'Shout', run: ({ editor, toast }) => editor?.replaceSelection(editor.getSelection().toUpperCase()) })
}
```

The `id` has to match the folder name. Pick a `category` from the ones the marketplace already uses, and use an emoji
for `icon`.

`languages` uses the code editor's language ids, like `json`, `markdown`, `html`, `xml`, `csv`, `sql`, `yaml`, `css`,
`python` and `javascript`. Documents report `html` (or `markdown` for .md files) and spreadsheets report `csv`. Leave
it out or use `["*"]` to work with every file.

The `api` object also has `api.markdown.toHtml(md)`, `api.markdown.fromHtml(html)`, `api.escapeHtml(s)` and
`api.ui.toast(msg)`. `api.host` is `'app'` in the window and `'cli'` when `gdocs format` loads the plugin, so keep
formatters free of anything that needs a page. `api.version` is the plugin API version. Set `"minApi"` if you need a
newer one.

If your plugin loads extra files, list them under `"files"` or they won't be downloaded.

Plugins run with the same access as the app, the same way Notepad++ plugins do. Only install plugins you trust.

## Trying it out

```
gdocs plugins validate ./my-plugin    # the same checks CI runs
gdocs plugins install ./my-plugin     # installs straight from the folder
```

Then pick Plugins > Reload plugins in the app. You can also point Settings > Plugin library at a folder with a
`marketplace.json` to browse it like the real marketplace.

## Submitting a plugin

Listed plugins can't import Node modules, use `eval`, make network requests or download code, and they have to stay
under 512 KB. `gdocs plugins validate` checks all of that, and CI runs the same checks on every pull request.

There are two ways to get a plugin listed.

To add it to this repo, fork it and put your folder under `plugins/`. Run `npm run marketplace`, which checks every
plugin and rebuilds `marketplace.json` and [MARKETPLACE.md](MARKETPLACE.md). Commit those with your folder and open a
pull request. This works best for small plugins. When you change one later, bump its `version` so people who installed
it get the update.

To keep it in your own repo, push the plugin folder to a public GitHub repository. Then add one line to
[`external.json`](external.json) with a raw URL pinned to a commit, run `npm run marketplace` and open a pull request:

```json
{ "source": "https://raw.githubusercontent.com/you/your-repo/<40 character commit>/plugin-folder/" }
```

Or [fill in the submission form](https://github.com/mattgauzza/gauzzaDocs/issues/new?template=plugin-submission.yml)
and I'll add it. The marketplace records the SHA-256 of every file at that commit, so people install exactly what was
reviewed. A new version is a pull request that moves the pin. These show up as community plugins in the marketplace.

`.gitattributes` keeps plugin files byte for byte in git, so the checksums match what GitHub serves.
