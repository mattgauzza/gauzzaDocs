# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Plugins

A plugin is the easiest way to add something. It's a folder with a `plugin.json` and one JavaScript file, with no build
step.

```
gdocs plugins new my-plugin          # a starter with a formatter, a command and a preview
gdocs plugins validate ./my-plugin   # the same checks CI runs
gdocs plugins install ./my-plugin    # try it, then Plugins > Reload plugins in the app
```

To get it into the marketplace, open a pull request that adds `plugins/<id>/` and runs `npm run marketplace`. If you'd
rather keep it in your own repo, [submit it](https://github.com/mattgauzza/gauzzaDocs/issues/new?template=plugin-submission.yml)
and it gets listed in `plugins/external.json`, pinned to a commit. [plugins/README.md](plugins/README.md) has the API and
the rules.

## The app

```
npm install
npm run dev          # the app with hot reload
npm run typecheck
npm test
```

The end of the [README](README.md#layout) explains how the code is laid out. Keep changes small and focused, match the
style around them, and add a test when you fix a bug or add something agents can call.

## Releases

To release, bump `version` in package.json, commit and run `npm run release`. GitHub Actions builds the Windows, macOS
and Linux installers and attaches them to the release, and installed copies update themselves.
