# arcod-plugin-notify (test fixture)

A reference plugin for docs/plugin-registry.md step 4. It declares the
`notify` capability and one provider, `notifyfile`, whose runtime adapter
appends a line to `NOTIFY_PATH` — no network, no dependencies, so the whole
seam (manifest scan -> `check` -> `arcod build` copy -> adapter dispatch) is
tested offline by `test/plugin-fixture.test.ts`.

Point `ARC_PLUGIN_PATH` at the directory that contains this package
(`test/fixtures`) to use it:

```bash
ARC_PLUGIN_PATH=test/fixtures arcod providers --plugins
```
