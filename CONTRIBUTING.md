# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Plugins

The quickest way to contribute is a plugin: a folder with `plugin.json` and one JavaScript file, no build step.

```
gdocs plugins new my-plugin          # a starter with a formatter, a command and a preview
gdocs plugins validate ./my-plugin   # the same checks CI runs
gdocs plugins install ./my-plugin    # try it, then Plugins → Reload plugins in the app
```

To get it into the marketplace, either open a pull request adding `plugins/<id>/` (then `npm run marketplace`), or keep
it in your own repository and [submit it](https://github.com/mattgauzza/gauzzaDocs/issues/new?template=plugin-submission.yml)
to be listed in `plugins/external.json`, pinned to a commit. The full API and rules are in [plugins/README.md](plugins/README.md).

## The app

```
npm install
npm run dev          # the app with hot reload
npm run typecheck
npm test
```

Layout and how the pieces fit are described at the end of the [README](README.md#layout). Keep changes small and
focused, match the surrounding style, and add a test when you fix a bug or add an op agents can call.

## Releases

Maintainers bump `version` in package.json, commit, and run `npm run release`; GitHub Actions builds the Windows,
macOS and Linux installers and attaches them to the release. Installed copies update themselves.
