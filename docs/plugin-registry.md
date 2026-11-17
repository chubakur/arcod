# Plugin registry: capabilities and providers outside the compiler

Status: RFC for B11.1, accepted for implementation; no code loads plugins yet.
Audience: someone who wants a capability (`queue`, `llm`, `blob`, …) or a
provider (`redis`, `postgres`, `yandex`, …) that arcod does not ship.

## The gap

Today a capability and its providers live in `src/capabilities.ts` and
`src/providers.ts`: one table compiled into the binary. That is the right
default — a spec can only name capabilities the compiler understands, and
`check` can prove that a provider implements a capability. It also means a
team with an internal broker cannot use it without forking arcod, and a
vendor cannot ship "our queue" without a patch.

The registry is the seam: a package declares a capability and the providers
that implement it, arcod reads the declaration, and the spec keeps working
with no change. The spec never names a package — it names a capability, as
before. Installing a package is an operator decision, not something a spec
can trigger.

## Package manifest

A plugin is an npm package with one file:

```json
{
  "name": "arcod-plugin-nats",
  "version": "0.1.0",
  "arcod": {
    "pluginApi": 1,
    "capabilities": [
      {
        "name": "queue",
        "summary": "publish/consume with delivery guarantees",
        "effects": ["publish", "consume"],
        "signatures": ["publish(topic, message)", "consume(topic) -> Message"]
      }
    ],
    "providers": [
      {
        "name": "nats",
        "capability": "queue",
        "summary": "NATS JetStream",
        "args": { "url": "nats://…", "stream": "stream name" },
        "secrets": ["NATS_TOKEN"],
        "appEnv": { "NATS_URL": "${url}" },
        "runtime": { "adapter": "./dist/nats.mjs", "export": "createAdapter" }
      }
    ]
  }
}
```

Rules the compiler enforces when it reads a manifest:

- `pluginApi` is an integer; an unknown major is a warning and the plugin is
  ignored, never a crash. The current API version is 1.
- A capability name must match `[a-z][a-z0-9_-]*` and must not collide with a
  built-in capability; a collision is an error for the plugin, not for arcod.
- A provider name must be unique across built-ins and plugins. A plugin cannot
  override `redis`, `postgres`, `mysql`, `yandex`.
- Every provider names a capability declared either in the same manifest or by
  the compiler. Otherwise `bind x -> p` could pass `check` and fail at runtime.
- `runtime.adapter` is a relative path inside the package. The compiler copies
  it into the generated service at build time, like an impl body: the service
  stays dependency-free and the plugin is not required at runtime.

## Where plugins are found

Search order, first match wins, no network:

1. `ARC_PLUGIN_PATH` — colon-separated directories (CI, tests).
2. `<module>/.arcod/plugins/*/arcod.plugin.json` — per project, committed or
   not, the same trust as `impl/`.
3. `~/.arcod/plugins/*/arcod.plugin.json` — per user.

No installation, no downloads, no postinstall. A plugin exists if its manifest
is on that path; removing the directory removes the capability.
`arcod providers --plugins` lists what was found, with the path it came from,
so two machines can be compared.

## What changes in the compiler

- `capabilities.ts` and `providers.ts` keep their built-in tables; the lookup
  gains one fallback layer that reads the loaded manifests.
- `check` treats plugin capabilities exactly like built-ins: an unbound
  capability is `A002`, a provider that does not implement it is `A024`,
  unknown arguments are `W019` (against the manifest's `args`).
- `arcod plan/deploy/k8s/terraform` read `appEnv`, `secrets` and `args` from
  the provider entry, so a plugin provider can be rendered without touching
  the emitters.
- `prompts` include only capability signatures, never package names.

## What a plugin cannot do

- Run code at compile time. The manifest is data; `runtime.adapter` is copied,
  not imported by the compiler.
- Name a host or secret inside the model. `A003` still applies.
- Introduce a diagnostic code. Plugins report through existing codes and
  `arcod providers` output; the global code list stays append-only and owned
  by the compiler.
- Change a built-in provider's behaviour. Shadowing is an error.
- Supply the runtime for a *built-in* capability (a plugin `queue` provider,
  say). Dispatch is driven by the capability's declared `signatures`, and
  built-in capabilities declare none in a manifest, so the generated service
  has no method to route. A plugin can add a capability and answer it; taking
  over `queue`/`store` means changing the emitted runtime, which is a compiler
  decision, not a manifest.

## Compatibility and versions

- `pluginApi` versions the manifest shape, not the plugin's own version.
- A spec pins nothing: bindings name providers. Reproducibility comes from the
  lock file of the project that installed the plugin, exactly like `impl/`.
- Removing a plugin from the path makes `check` fail with `A023` (unknown
  provider) — visible, not silent.

## Minimal implementation order

1. Manifest reader + validation + `arcod providers --plugins` (read-only).
   First slice: no runtime adapter copying.
2. Wire the capability/provider lookup into `check` and the emitters.
   Done for `check` and compose (which the k8s renderer consumes):
   `src/registry.ts` merges the built-in tables with the manifests on the
   plugin path, `check` judges `A023`/`A024`/`A026` against that registry, and
   compose renders a plugin provider's `appEnv` (`${arg}` from the bind,
   `${host}`/`${port}` from the address) without inventing an image — a plugin
   provider is configured, never provisioned. `arcod terraform` now resolves
   binds through the same registry: a plugin provider is not provisioned by
   the plan but is not dropped either — it becomes an external dependency
   comment naming the declaring package, and each declared secret becomes a
   `sensitive` variable (`faxapi` + `FAX_TOKEN` -> `var.faxapi_fax_token`). A
   provider no registry knows is reported in a comment, because `check`
   already rejects it.
3. Copy `runtime.adapter` into the generated service and document the module
   contract (`createAdapter(io) -> { publish, consume }`).
   Done (B11.3a): `arcod build` copies each used plugin provider's adapter to
   `plugins/<provider>.mjs` and writes `plugins.json
   ({provider, package, source, target, export})` next to the build.
   Done (B11.3b): the generated service imports every adapter listed in that
   manifest before it listens, calls the declared export once with
   `io = { env, fetch, log }`, and answers the capability's manifest
   `signatures` through the returned object: `send(to)` becomes
   `io.send(to)` in a body and `adapter.send(to)` at runtime. Consequences:
   - `signatures` is the runtime contract, not documentation. A signature the
     compiler cannot parse is skipped (no invented method); a signature whose
     name collides with a built-in io method (`load`, `save`, `publish`, …)
     fails the build, because it would shadow the store/dispatch contract.
   - A missing file, a missing export, a factory that returns no object, or a
     missing adapter at boot stops the service with the provider and package
     named — never a 500 on the first request.
   - The adapter sees `io.env` for `appEnv`-provided configuration; it never
     receives a request-scoped io, so it must not assume an actor or a body.
4. One reference plugin in the repository's test fixtures that proves the seam
   end to end without a network dependency.
   Done (B11.4): `test/fixtures/plugin-notify/` declares the `notify`
   capability (`send(to, text) -> string`) and the `notifyfile` provider, whose
   adapter appends a line to `NOTIFY_PATH`. `test/plugin-fixture.test.ts`
   puts the directory on `ARC_PLUGIN_PATH`, checks a model against the
   registry, builds it, starts the service and asserts the adapter wrote the
   file. The same test found the `path`/`dir` bug: a manifest's path is the
   JSON file, while `runtime.adapter` is relative to the package directory.

Step 1 is the gate: if a manifest cannot be read and validated deterministically,
nothing else should be built.
