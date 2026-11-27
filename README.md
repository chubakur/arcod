# Arcod

A service specification that compiles into a working service. No manual library
selection, no drift between the model and the code.

Arcod is a language and a compiler. You write one `.arc` file — types,
operations, errors, rules, effects, infrastructure bindings — and the compiler
checks the model, builds a work plan, and generates the service, its UI, tests,
prompts for a coding model, and the environment to run it.

```arcod
service OneTimeMessage : http {
  uses store: kv(ttl: 999s)
  uses uuid: ids

  contract {
    public op create(body: Body) -> MessageId {
      route: "POST /api/messages"
      effects: store.set, uuid.new
      errors: Invalid
      post: result != null
      on error Invalid: body != null
    }

    public op read(id: MessageId) -> Body {
      route: "GET /api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }
  }

  rules {
    invariant read.at_most_once: once(read, by: id)
    atomic read { get; del }
  }

  effects {
    allow store.get, store.del, uuid.new
  }
}

ui Web {
  kind:  spa
  route: "/"
  uses  OneTimeMessage.create, OneTimeMessage.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
```

A frontend appears only when a `ui` block is declared. Without it you get the
API and the service port, nothing else.

Website: <https://chubakur.github.io/arcod/> · Russian version: [README_rus.md](README_rus.md) · Roadmap: [ROADMAP.md](ROADMAP.md).

## Quick start

Requires Node.js >= 22.18 and Docker.

```bash
git clone git@github.com:chubakur/arcod.git
cd arcod
npm link            # installs the arcod command globally

cd examples/onetimemessage     # no password
# or
cd examples/onetimemessage-pwd # optional password (--port 8081)
arcod run
```

Open <http://localhost:8080>, create a message, copy the link, open it. The
second read returns 410 Gone.

Every demo under `examples/` is a working service, not a snippet:
[docs/examples.md](docs/examples.md) says what each one proves and how to run
it. Every rule a record must satisfy before it is stored — and the message each
one answers — is in [docs/record-rules.md](docs/record-rules.md). Why a name
such as `toString` or `__proto__` is looked up by ownership everywhere the
compiler keys a table by a model name is
[docs/model-names.md](docs/model-names.md).

```bash
arcod run --down   # stop
node ../../bin/arcod.mjs run   # without npm link
```

A spec file is a module header followed by declarations. The header braces hold
one `meta { ... }` block and nothing else: `type`, `enum`, `error`, `service`,
`environment` and `ui` go after the closing brace. A token that is not `meta`
inside the braces — a declaration written one brace too deep, a second `meta`
block, or a repeated meta key — is a located parse error, so a misplaced
declaration can never become a silently ignored line. Parse errors quote the
token they choked on; at end of file the token is named `end of file`, so a
spec cut in half reads `expected "}", got end of file` instead of an empty
`got ""`.

## Types

Types are part of the contract, not decoration: JSON schemas for parameters and
responses, `check` validation and prompt text are all derived from them.

```arcod
type MessageId = uuid
type Body = { author: string, text: string, attachments: list<uuid> }
type Result = Body | NotFound          // union
type Password = string?                // optional

enum Visibility { draft, published, archived }
```

A name that is neither a builtin nor declared in the module is `A088`: it used
to become an empty schema, so a typo accepted any value.

Records `{ ... }`, `list<T>`, `bytes`, `uuid`, `datetime` (ISO-8601, rendered
as `format: date-time`), `decimal`, unions, optional via `?` and parameter
defaults (`limit: number = 20`). Durations (`999s`, `24h`) are values in clauses
(`ttl: 999s`, `timeout: 30s`), not a type.

A record field may declare a scalar literal default:

```arcod
type Task = { id: TaskId, title: string, done: bool = false, dueAt: datetime? }
```

That one declaration is the whole story: the migration writes `DEFAULT 0`, the
runtime insert fills `false` only when the body omits the field (an explicit
value, including `null` on an optional field, wins), and OpenAPI publishes
`default: false` and drops the field from `required`. `check` rejects anything
that is not a literal of the field type, and keeps the literal inside the
column: `int` takes a whole number (`1.5` is `A059`), `uuid` a UUID, an enum
one of its values, a `datetime` an instant with a zone (`A059`).

A string can carry a constraint. `email` and `url` are shorthands for
`string(format: email)` and `string(format: uri)`; a declared enum closes a
set of values:

```arcod
enum Plan { free, pro, team }
type Account = { id: uuid, email: email, website: url?, plan: Plan = "free" }
```

The constraint is published where clients read it (`format: email`,
`format: uri`, `enum`), stays a plain string column in the migration, and is
enforced by the generated service before the operation body runs: a malformed
address, a URL without a scheme or a value outside the enum is `400 Invalid`
with the offending field named, not a 500 from a body that trusted the client.
`check` rejects a default that violates its own type (`A060`) and an unknown
format name (`A061`). Refinements (`min:`, `max:`, `format:`, a generic
argument) belong to a builtin name: on a declared type they refine nothing,
and `check` answers `A086`. `string`, `bytes`, `int`, `number`, `float` and `decimal` read
`min`/`max` (`string` also `format`), `list` and `map` take type arguments; an
argument no emitter reads is `A087`. A bound bounds the values of its type:
`int(min: 1)` rejects `1.5`, while `number(min: 0.5)` keeps fractions and
rejects only what is below; `string(min: 3, max: 5)` bounds the length in
characters, not UTF-16 units, while a `bytes` bound counts bytes —
`bytes(max: 2kb)` rejects a 1100-letter Cyrillic value because it occupies
2200 bytes, and the 400 says `bytes` rather than `characters`. The schema,
the 400 and `A060` all read the same arguments, and so do the entity stores:
an `io.insert`/`io.update` outside a field's bound is `400 Invalid` on both
`kv` and SQL. The declared type is checked there too: a `bool` takes a
boolean, an `int` a whole number, a `bytes` or a text field a string, and a
`datetime` an ISO 8601 instant, because SQL read the string "false" as TRUE
while `kv` kept it, and a word in a datetime column was a 500 at the driver.
A datetime is stored in one spelling on every driver — UTC, milliseconds, `T`,
`Z` — so an offset in the body is converted rather than kept, and a `where`
filter names the same instant whatever its offset. A container of instants
takes that spelling at every leaf too: `list<datetime>` and `map<string,
datetime>` (nested any depth) store each element — and each map value — as the
same UTC/milliseconds text, so a row does not read back in the spelling a
caller happened to write, and a `where` filter on such a field is respelled
the same way, so the same instant with an offset finds the row. A value inside
a container that is not an instant, or a container that is not a list or map,
is `400 Invalid` there. A day the calendar does not have, a time past 23:59, or a fraction finer than a
millisecond is `400 Invalid` instead of being rolled over by one driver and
cut by the other. A patch cannot change
`id`: echoing the same value is fine, another value is `400 Invalid` on both
drivers. Full example: `examples/signup`.

## Commands

| Command | What it does |
|---|---|
| `arcod check [dir]` | parse, check types, bindings, effects and rules; `--json`; `--strict` turns on W013 (missing budget); `--env <name>` checks one environment; a quoted pattern such as `'examples/*/main.arc'` checks every match, reports each file by its path relative to the caller in both forms, keeps going after a file that does not parse, and fails if any has an error; `--json` answers a spec that does not parse with `{error: "parse failed", diagnostics}`; `**` spans directories, so `'projects/**'` checks the spec of every project below `projects`, at any depth |
| `arcod ast [dir]` | print the canonical AST; `--check` also runs the checks (exit 1 on an error), and `--json` adds a `diagnostics` list while keeping the AST, so a CI gate reads the status instead of the flag |
| `arcod plan [dir]` | deterministic task DAG: files, dependencies, acceptance criteria |
| `arcod openapi [dir]` | OpenAPI 3.1 on stdout: paths from `route`, schemas from `types`, errors mapped as in the runtime, examples from the `examples` block; `--service <name>` picks one service, without it every internal service contributes its paths (two services on one route is an error); `--out <file>` writes it instead of printing |
| `arcod migrate [dir]` | print the migrations of the data model and write them into `.arcod/build/migrations/` (changelog + up/down `.sql`; `arcod build` writes the same artifact); `--json`; `--dialect mysql\|postgres` picks the DDL spelling; `--service name` picks whose plan in a multi-service module (into `migrations-service-<name>/`); the service applies them on boot; files the current plan no longer owns are removed |
| `arcod build --dialect postgres` | same build, Postgres client/store/migrations; MySQL is the default |
| `arcod build --env prod` | same build for a named environment: the dialect follows that environment's `bind .. -> postgres`, so dev can stay MySQL; an unknown name is refused with the declared environments |
| `arcod build [dir]` | scaffold: routes, adapters, tests, infrastructure in `.arcod/build`; bodies are TODO; `--json` reports mode, dir, dialect, files, images and bodies as one object (a reference run that stops for a missing body answers `{error, missing, advice}`; a spec that does not check answers `{error: "check failed", diagnostics}`, and a project mistake such as two bodies declaring one name answers `{error}` with exit 2) |
| `arcod build --impl` | bodies from `impl/*.mjs`, the `io` adapter, nothing invented |
| `arcod build --reference` | the same plus built-in demo bodies for `create`/`read` |
| `arcod test [dir]` | boots every internal service that declares examples and runs the model's `examples` (a multi-service report prefixes each name with its service); `--json` prints the report (`{examples, rules}`, plus `diagnostics` when the spec does not pass check, `{error, missing, advice}` when a body is missing) and never prose; `--url <base>` skips build and spawn and runs the same examples against a running service (one `/healthz` probe, exit 2 when it does not answer; `--impl`/`--reference` cannot be combined, a module with several services needs `--service`) |
| `arcod make [dir]` | the whole cycle in one command: check → prompts → bodies → build → test |
| `arcod run [dir]` | build + `docker compose up --build`; the `docker info` probe gives up after 15 s and says the daemon is not answering instead of hanging |
| `arcod run --down` | stop what this project started (`docker compose down --remove-orphans`); no rebuild, the `.arcod/build` artifacts stay |
| `arcod run --detach --json` | one object instead of the start lines: `mode` (reference/scaffold/impl), `name`, `version`, `build`, `url`, `port`, `services` (name/port/url per service when the module has more than one), `stop`; the compose log goes to stderr, so stdout stays parseable. `--json` without `--detach` is a usage error (a foreground run never returns), and a failed start answers `{error}` |
| `arcod providers` | capability and provider table with ports and the declaring package (`origin`, `-` for built-ins); `--json` also carries each provider's declared bind `options`; `--plugins` lists manifests found on `ARC_PLUGIN_PATH`, `./.arcod/plugins`, `~/.arcod/plugins` |
| `arcod deploy [dir]` | deployment target and `deploy.<env>.json` manifest; `--env`, `--json` (a refusal — no environment, no target, unknown provider — answers `{error}`, not a stderr line) |
| `arcod k8s [dir]` | Kubernetes objects for the compose topology (namespace, configmap, provider deployments, a Deployment and a Service per internal service, an ingress with a path per route set); `--helm` for a chart, `--out dir` to write files; `--env name` renders that environment and an undeclared one is refused (exit 1) like `terraform` |
| `arcod terraform [dir]` | Terraform for the cloud view: network, managed services for the binds, secrets as variables; `--env`, `--out dir`; Yandex Cloud |
| `arcod prompts [dir]` | prompts only: compact by default, `--full` for the detailed task prompt (header, contract, io list, storage shape); `--max-tokens`, `--json` |
| `arcod impl [dir]` | generate operation bodies with a local model: `--model`, `--endpoint`, `--dry-run`, `--no-cache`, `--allow-remote`, `--json` |
| `arcod fmt [dir|pattern]` | canonical AST formatter on stdout; `--check` fails if not formatted; `--write` rewrites the spec; a quoted pattern such as `'examples/*/main.arc'` checks or rewrites every match, reports each file by path and needs `--check` or `--write`; with `--check`/`--write`, `--json` prints one object instead of the lines — `{mode, ok, files: [{file, status, error?, line?, col?}], changed, failed}` with status `ok`/`not formatted`/`formatted`/`failed` and the same exit code, the same shape for one file and a pattern; one file and a pattern name it the same way — a path relative to the caller when it is inside the working directory; `--to <version>` migrates first. Comments are re-attached to the node they belong to: a leading one to the declaration or field it precedes (a commented field makes the record multi-line), a trailing one stays on the line it trailed — including the braces of `meta`, `rules`, `when`/`then` and the module itself. `test/fmt-comment-survival.test.ts` appends a marker to every code line of every example — and of whole-module snippets for constructs no example declares, such as a `workflow`'s clauses, steps and both closing braces — and fails if one goes missing |
| `arcod diff <a> <b>` | structural diff of two specs (both canonicalized first), `-`/`+` hunks; exit 1 when a hunk is printed, 0 on a match and 2 on an unreadable path, so a drift gate can read the status |
| `arcod graphql [dir]` | GraphQL SDL for the same contract: `GET` → Query, other methods → Mutation, `<Name>Input` twins for arguments, the HTTP route, error statuses and access clauses in each field description; `--service <name>` (required when the module declares more than one service), `--out <file>` |
| `arcod grpc [dir]` | proto3 for the same contract: one rpc per routed op, `<Op>Request`/`<Op>Response`, types mapped without silent widening, HTTP route and gRPC error codes in comments; `--service <name>` (required when the module declares more than one service), `--out <file>` |
| `arcod adopt <openapi.json>` | reverse of `openapi`: reads an OpenAPI 3.x JSON doc and emits an `.arc` spec (schemas→types/enums, paths→ops with `{id}`→`:id`, a bearer requirement→`auth op`) |
| `arcod upgrade [dir]` | language-version migration: `--to <version>`, `--write`; v0.1.0 is the only version today, so it reports identity or rejects unknown targets |
| `arcod new <name>` | scaffold a minimal, valid service: `<name>/main.arc`, `.gitignore`, `impl/README.md` (the generated spec parses and checks clean); refuses a non-empty target unless `--force`, and a file at that path is refused by name |
| `arcod lsp` | run the Language Server over stdio for editors (VS Code, Neovim, JetBrains) |

Flags: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`,
`--remove-orphans`. For `make`: `--force` (regenerate bodies), `--skip-impl`,
`--no-test`, `--model`, `--endpoint`, `--reference`, `--port`. `ast` takes
`--check`, `test` takes `--impl`, `run` takes `--impl`, `--scaffold` or `--detach --json`, `check`
takes `--strict`. `fmt` takes `--check`/`--write` (alternatives — `--check` asks, `--write`
answers, so passing both is a usage error, code 2); `upgrade` takes `--to <version>`/`--write`.
Every subcommand answers `arcod <cmd> --help` with its own usage and exits 0;
`arcod help <cmd>` prints the same page, and `arcod help nosuch` names the
command it does not have (exit 2) instead of answering with the main page.
An unknown flag prints one line plus `hint: arcod <cmd> --help` and exits 2.
A flag that names a value must get one: `--env`, `--service`, `--to`, `--out`,
`--dialect`, `--model`, `--endpoint`, `--image`, `--host`, `--namespace`,
`--ingress-class` print `--env needs a value` and exit 2 rather than quietly
meaning nothing, a following flag is never taken as the value, and an empty
value (`--out ""` from an unset variable) counts as missing. A path is
named the same way whether you pass one file or a pattern: `check`, `fmt` and
`upgrade` print it relative to the caller when it is inside the working
directory (absolute only outside it), so a gate greps one shape. A command takes one path: a second one (`arcod check a b`) is
`unexpected argument: b`, exit 2, instead of checking `b` and dropping `a`;
`diff` is the one command that reads two, and it refuses a third the same way. A command that takes no path (`version`, `providers`, `lsp`) refuses one too: `arcod version extra` is `unexpected argument: extra`, exit 2, not the version with the word dropped. The numeric
flags `--port`, `--max-tokens` and `--replicas` answer the same way when bare.

```bash
arcod make .            # first build from scratch
arcod make . --force    # regenerate bodies
arcod make . --skip-impl --no-test   # check + prompts + build only
```

Each step is the same function as the standalone command, so the pipeline cannot
drift from the CLI. It stops at the first failure and says where.

A plan that cannot be derived stops `make` at the prompts step with
`cannot derive a procedure for: <task>: <reason>` — for example `atomic read {
get; del }` consumes the key, so the read operation must declare what a second
call returns. `arcod prompts` still writes the prompts it could build, names the
operation, and exits 1; the manifest carries the same reason under the task's
`unresolved` field.

Numeric flags are checked where they are parsed: `--port` 1..65535, `--replicas`
1..1000, `--max-tokens` 1..1000000. A bad value prints `invalid value for
--flag` and exits 2, instead of writing `NaN` into a manifest.

Flags are per command, not global: `--out` belongs to the file writers, so
`arcod build --out dist` is a usage error (`unknown flag: --out`, exit 2)
rather than a flag that is accepted and ignored. The same goes for
`check --port` and every other flag another command owns. Alternatives are
enforced: `--reference --impl` on one line is an error, not a preference for
whichever flag the code checked first. `--json` always means JSON: `test
--json` on a spec with nothing declared prints `{"examples": [], "rules": []}`
instead of the sentence the human path prints. A refusal is data too: a spec
that does not parse answers `{error: "parse failed", diagnostics}` on stdout for
every command that takes `--json`, a path it cannot read answers
`{error: "cannot read ..."}`, a pattern that matches nothing answers
`{error: "no files match ..."}` with exit 2, and an artifact it cannot write
answers `{error: "cannot write ..."}` with exit 1 — the failure the human path
prints on stderr is the same diagnostic, not a second contract.

A directory that holds several specs and no `main.arc`/`spec.arc`/`arcod.arc`
reads the first by name but says so on stderr, listing the others; pass a path
or a quoted pattern to choose instead of relying on sort order.

A missing environment is named too. `arcod deploy` on a module with none says so
and shows the declaration to add; `--env staging` on a module that declares
`dev` and `prod` answers `no environment to deploy: staging — declared: dev,
prod`. `arcod terraform` separates the two cases: an unknown `--env` name lists
the declared ones, while a module whose environments all lack `deploy` says
that, because the fix is different.

Operation bodies are part of the model, not a hidden blob. Every `impl/*.mjs`
body is checked against the sandbox — no imports, raw network, fs, exec,
process or eval, only the `io` adapter — and `arcod build` fails naming the
operation and the reason. Each body is hashed into
`.arcod/build/impl-manifest.json`, and generated bodies carry a
`// @arcod generated:` header with the prompt hash and model, so provenance is
never lost. All bodies land in one module, so a top-level name declared by two
files (`const LINES` in both `impl/create.mjs` and `impl/list.mjs`) is refused
at build time, naming both files, instead of surfacing as a `SyntaxError` when
the container starts. A body's file name is its operation: `impl/totals.mjs`
declares `export async function totals(input, io)`, and `check` reports the two
ways that contract breaks (`W049` a file no operation is named after, `W050` an
operation with no file) so a typo does not turn into a silent `501`.

What the `io` adapter offers depends on the stores the service declares. With
`uses store: kv` a body gets `io.get(key)` and `io.set(key, value)`: the value
goes in and comes back whole (a scalar, a list or an object), and a key that was
never written is `null`. The store's own record shape stays inside the
runtime: a key is `msg:<key>`, the stored JSON is `{ b: <value>, h: <hash|null> }`,
and `io.load`/`io.save` expose that envelope for the older bodies and for the
generated `--reference` ones (`save(k, { value: 7 })` writes `b: null` — `set`
is the call that means "this value"). Alongside them: `io.del(key)`,
`io.has(key)`, `io.seen(key)` (the at-most-once marker a consumed key leaves),
`io.takeIf(key, record)` (compare-and-delete for `once`), `io.scan()` and
`io.new()` for a uuid. A queue-bound service adds `io.queuePublish(topic, message)`,
and `io.queuePublishLater(topic, message, delaySeconds)` for a message that must
not arrive before that many seconds have passed: the broker (or the outbox row)
holds it and the consumer's poll moves it into the topic when it is due. Nothing
schedules itself — no timer runs in the service, so a topic nobody consumes
keeps its delayed messages waiting.
The one contract any of them keep is the ttl the model declared on the store.

A module with several internal services files each body under its service:
`impl/api/totals.mjs` belongs to `api`, and only a folder named after a
generated service is read (`impl/ops/` stays an ignored directory, `W051`).
Bodies are still keyed by operation name, so the same operation filed twice —
a leftover flat `impl/totals.mjs` beside `impl/api/totals.mjs` — is refused by
name (`A107`) instead of one file silently winning.

## Providers

The model names a capability (`kv`, `sql`, `blob`…), the environment names a
provider (`redis`, `postgres`, `s3`…). The compiler knows which provider
implements which capability and enforces it (`A023` unknown, `A024`
incompatible, `A025` double bind, `A026` a required argument is missing).
Every environment is checked, so a typo in `prod` fails `check`, not the
release.

Capabilities and providers can also come from a package: a plugin manifest
declares them and `arcod providers --plugins` shows what was found, where it
came from and what is wrong with it (unknown `pluginApi`, shadowing a built-in,
a provider naming an undeclared capability). The registry feeds `check`, the
compose/k8s/terraform emitters and `arcod build`: a provider with
`runtime.adapter` has its file copied to `plugins/<provider>.mjs`, and the
generated service loads it at boot and routes the capability's declared
signatures (`send(to)`) to the adapter's methods. A body names `io.send(...)`,
never the package. The manifest is data; plugin code runs only inside the
generated service. A reference plugin in `test/fixtures/plugin-notify` shows the whole seam offline. See `docs/plugin-registry.md`.

```arcod
environment dev {
  bind db     -> postgres(host: "db", expose: true)
  bind files  -> s3(host: "s3")
  bind stream -> websocket()
}
```

```bash
arcod providers            # capability and provider table
arcod providers --plugins  # plugin manifests found on this machine
arcod deploy . --env prod  # deployment target and manifest
```

**Capabilities with an adapter** (an operation body can call them): `kv`
(redis), `sql` (postgres, mysql, mariadb), `blob` (s3), `identity` (keycloak),
`llm` (ollama, openai), `stream` (websocket, redis), `queue` (redis — publish,
consume, retry, dead letter) and `ids`/`hash`, which bind to
`local` — the compiler's own runtime. `local` provisions nothing and serves
only those two: binding `kv`, `sql` or `queue` to it is `A068`. `hash` answers
`io.hash`/`io.verify` (scrypt, a fresh salt per call) as soon as it is used,
not only when an operation takes a `password`.

`rabbitmq` and `kafka` also declare `queue` and are provisioned, but the
emitted adapter speaks only the Redis list protocol. Binding a service's
`queue` to either is `A083`: the container would start, jobs would run
in-process and messages would vanish on restart, so `check` refuses instead.
`arcod providers` prints the same reason next to the row. Bind `queue` to
Redis for delivery across processes.

**Infrastructure only** — the provider is provisioned in compose, but the
capability has no effect signatures yet and no adapter reaches the service:
`document` (mongodb), `proxy` (nginx),
`migrations` (liquibase), `olap` (clickhouse), `metrics` (prometheus),
`errors` (sentry), `tracing` (jaeger), `dashboards` (grafana), `secrets`
(vault). `endpoint` and `websocket` create no container at all: the first is an
address of somebody else's service, the second is a server inside the service
itself.

There is no mail provider: mail used to be listed next to these and the
container came up, but `uses mail: mail` was `A076` — no effects, no adapter.
The provider list no longer promises it, and the `A076` hint names the honest
path: point `endpoint` at the SMTP/API vendor and call it with `io.remote`.

Every binding that needs a container becomes a compose service with a
healthcheck, a volume and env; ports are published only with `expose: true`.

A module may declare more than one service: each one gets its own build
context (`service`, then `service-<name>`), its own container, and only the
binds it names; the front service keeps the published port and the web
proxy, a later one is published on the next port. Kubernetes draws the same
topology: a Deployment and a Service per internal service (each with its own
image from the deploy contract), and an Ingress sends each route root to its
own service; a one-service module keeps its historical `service.yaml`. The
chart carries the same split: every later service reads its image from its own
`services.<name>` values entry.

The service block may name its language. `language: node` (the default) is the
full emitter. `language: go` builds a port-kit service: `main.go` with the
routes, the input-kind coercion and the success statuses read from the same
contract IR as Node, `/healthz`, one `ops.go` stub per operation, a `go.mod`
and a multi-stage `Dockerfile`; the route pattern uses Go 1.22's `{id}` form.
The kit is deliberately narrow: `store: kv` comes with the generated
`arcodio` package, and a bound `queue` comes with both halves; a service
that uses another store (`sql`), `stream`, `graphql`, `olap`, `mail`, `files`,
a ui page, roles, a saga, a job that drives a saga, or `auth` is refused by
name at build time. A Go body at `impl/<op>.go` (or
`impl/<service>/<op>.go` beside other services) is spliced into `ops.go`
verbatim; an operation without one keeps a 501 stub. Every body has the shape
`func op<Name>(io *arcodio.IO, in map[string]any) (any, error)`: `in` holds the
path captures, the query string and the JSON body after coercion, `io.KV` is
the declared kv store. `arcodio` (`arcodio/arcodio.go` in the build context,
copied by the `Dockerfile`) opens one RESP connection lazily to
`KV_HOST`/`KV_PORT` (or `REDIS_URL`) and carries `Get`, `Set` (with a
`time.Duration` TTL), `Del` and `Has` — the four verbs of the kv contract, not
a general redis client. A service that binds a queue also gets
`arcodio/queue.go`: `io.QueuePublish(topic, message)` appends to
`arcod:q:<topic>` in the Node runtime's envelope (`{"payload":…,"attempts":0}`),
so a Go publisher and a Node consumer share one broker — the address comes
from `QUEUE_REDIS_URL` and falls back to the kv one. The consumer side is a
job operation: a job with `on: events.<topic>` and a body gets a
`consume<Name>` goroutine started before the http server. It drains
`arcod:q:<topic>` with `LPOP`, parses the Node envelope
(`{"payload":…,"attempts":n}`), maps the payload onto the declared
parameters — one parameter takes the field of that name, or the whole payload
when the payload has no such key — and runs the body. A failed attempt is
requeued with the Node backoff (250ms doubling, capped at 30s) and, once
`retry` is spent, written to `arcod:q:<topic>:dead` with the payload, the
attempt count and the last error: the same three places the Node runtime
writes, so either language drains a topic the other filled. An empty topic is
polled every 100ms rather than blocked on, because one socket serves the whole
service. A service without a queue carries no queue code and a call says
`arcodio.ErrNoQueue`. A service without a store gets `IO{}` and a store call
returns `arcodio.ErrNoStore`. A body cannot add its own `import` line —
Go imports are per file, and `main.go`'s imports are invisible in `ops.go`.
The build instead adds the stdlib imports the body actually spells:
`encoding/json`, `errors`, `fmt`, `sort`, `strconv`, `strings`, `time`;
an identifier the body never mentions pulls nothing in, because an unused
import is a compile error in Go, and `net`/`os`/`os/exec` are off the list
(the contract denies those effects). A body that opens with its own
`import` is refused by name at build time. Because the body owns the
signature, a parameter named `io` hides the standard package there.
`test/fixtures/go-project1` is the same one-time-message service in Go, with
Go bodies; `arcod test test/fixtures/go-project1 --url <service>` answers 5/5
against the running binary, and `test/go-live.test.ts` does exactly that
with the real toolchain (it compiles the service and points it at a fake
RESP store, since the VM has no docker). `test/go-job-live.test.ts` pushes
the Node envelope at a generated job service and requires two things: the
body's kv write, and the failing message in `<topic>:dead`. Pairing both
languages is `test/mixed-queue-live.test.ts`: a generated Node service
publishes through its own body, the generated Go service consumes it, and the
assertion is the Go body's kv write — the two emitters have to agree on the
envelope, or the test fails. A rule such as `atomic read { get; del }` is not
carried by the emitter for Go — no generated body exists to obey it — so the
author's body keeps that promise and `arcod test` is what checks it.
`language: python` passes
`check` and is reported by `build --json`, but `build` and `impl` refuse it
until B108. Silently generating the wrong runtime is worse
than stopping. `language:` on an `external` service is an error.

### The model as a capability

A service does not know whether the model is local or hosted: it asks for
`llm.chat`, and the environment picks the provider.

```arcod
service Chat : http {
  uses store: sql(ttl: 31536000s)
  uses uuid: ids
  uses llm: llm
  ...
}

environment dev {
  bind llm -> ollama(host: "http://host.docker.internal:11434", model: "qwen2.5-coder:7b")
}

environment prod {
  bind llm -> openai(model: "gpt-4o-mini")   // key from LLM_API_KEY
}
```

Both providers speak the OpenAI-compatible `/chat/completions`, so the body is
the same: `io.chat(messages, system)`. Naming a vendor in the model is forbidden
(`A003`). The same endpoint answers embeddings: `io.embed(texts)` returns one vector
per input, in request order, using `LLM_EMBED_MODEL` (or `LLM_MODEL`) — so a
vector store asks for vectors instead of hashing text inside the body. The
binding may promise the width: `bind model -> ollama(model: "nomic-embed-text", dim: 768)`
puts `LLM_EMBED_DIM=768` into the service, and a vector of another size fails
the operation with `llm: embedding dim N does not match declared dim 768`
instead of being stored next to the rest. Without `dim` the runtime still
rejects a response whose vectors disagree with each other; `check` reports
`A077` when `dim` is not a positive integer. An empty batch returns `[]`
without a request: endpoints reject `input: []`, and an indexer with nothing
to embed has nothing to ask. A failed model call carries a `kind` that says what to do next, not what happened. `rejected` (4xx other
than 429) means a repeat will not help until the configuration changes.
`limited` (429) means repeat later: the endpoint's `Retry-After` header
arrives as `error.retryAfterMs` (seconds or an HTTP date), and without the
header the field is absent rather than `0`. `unknown` (timeout, a dropped
connection, 5xx, a 2xx body we cannot read) means there is no hint and the
service decides whether to repeat. No `kind` promises that the first attempt
left no trace: a proxy, a quota or a gateway queue can answer 429 after the
run started, so a repeat may create a second run - `io.chat` has no
deduplication. The body branches on `error.kind`
instead of parsing our message, which we may rewrite:
`if (error.kind === 'limited') return { error: 'RateLimited' }`; `rejected`
answers `500` in our words, and `unknown` keeps `503` meaning "try again". `error.status` and
`error.body` (truncated) are for the log; neither reaches the client. Full example: `examples/chat` — dialogue history, model answers and a
page with `layout: chat`; `examples/vector` — notes indexed by `io.embed`
and searched by cosine in the body, with `dim: 768` on the binding.

```bash
arcod build examples/chat --impl && arcod run examples/chat
arcod build examples/vector --impl && arcod run examples/vector
```

The local model must be reachable from containers. On macOS Docker Desktop,
`host.docker.internal` reaches Ollama listening on `127.0.0.1:11434` without
setup. On Linux a container cannot reach the host loopback: start Ollama on
`0.0.0.0` (`OLLAMA_HOST=0.0.0.0 ollama serve`) or bind another host.

### The generated page and accessibility

Every `ui` block produces a dependency-free form page. It is also the only UI
most specs will have, so the a11y baseline is part of the emitter: `<html
lang="en">`, a wrapping `<label>` per control, `aria-required` for required
parameters, `autocomplete="off"` so a password manager does not fill API
parameters, and results in a `role="status"` region with `aria-live="polite"`
— an async answer is announced without stealing focus. Fields come from the
contract, not from a template: a `bytes` limit above 512 bytes is a textarea,
every `bytes`/`string` `max` becomes `maxlength` (the unit is converted), a
record parameter or a `list`/`map` becomes a JSON field, and a declared `enum`
becomes a `<select>` of exactly the values the contract accepts — the same list
OpenAPI documents and the service boundary validates, so a form cannot send a
value the API rejects. An `email`/`url` parameter becomes a native `email`/`url`
input, and `int`/`number`/`decimal` bounds become the field's `min`/`max`
attributes, so format and range are checked by the browser before the request
leaves. Only `int` is a whole number: it keeps `step="1"`, while `float`,
`number` and `decimal` get `step="any"` — the browser default of one whole unit
would reject the `1.5` the API accepts. A `decimal` parameter is a number
field, never a text one, because the schema publishes it as `type: number`.

The language is a property of the `ui` block, not a build flag: `locale: "ru"`
(or any BCP-47 tag) sets `<html lang>` and swaps the page's label catalog —
`en` and `ru` ship today, an unshipped tag keeps its `lang` and falls back to
English labels instead of failing the build. A malformed tag is a parse error.

```arcod
ui TasksUi {
  title:  "Tasks"
  locale: "ru"
  uses   Tasks.create, Tasks.list
}
```

Colours are design tokens (`--surface`, `--ink`, `--line`, `--muted`, `--accent`,
`--danger`) read by every rule, and `theme: light|dark|auto` picks a
palette on the `data-theme` attribute — `auto` (the default) follows the
reader's OS through `prefers-color-scheme`. Nothing in the markup hard-codes a
colour.

`render: static|ssr` declares where the page is produced. `static` (the
default) emits the HTML at build; `ssr` also embeds it in the service, which
serves it at the ui route — compose then drops the nginx sidecar and the k8s
ingress points at the service. The page files are still written, so a
deployment may keep the static front door instead. The first screen is
rendered in the HTML, not fetched after load: the service calls the first
public `GET` operation that takes no path parameter in-process (no HTTP round
trip), embeds its result in the page, and the client script hydrates that slot
instead of issuing the call again (`examples/notes-ssr` is the minimal
one). A page with per-request data is served with `cache-control: no-store`.
An operation that needs input cannot be
the first screen, so a `render: ssr` ui whose operations are all
parameterised or non-`GET` gets `W030` and serves the page without data.

The chat and presentation pages take the same `lang` and the same catalog:
their static chrome (send button, composer placeholder, join form, deck
navigation, participant count) is labelled from it, while slide titles and
bodies stay authored text.

A list of locales turns the form page into a switcher: `locales: "en, ru"`
embeds every declared catalog once and adds a `<select>` to the header;
`?lang=ru` chooses a catalog on load and an unknown tag falls back to
`locale` (or the first declared tag). The page is static, so switching
reloads it. The chat and presentation layouts carry the same picker in their
header; SSR is a separate item (B12).

```arcod
ui TasksUi {
  title:   "Tasks"
  locale:  "ru"
  locales: "en, ru"
  uses    Tasks.create, Tasks.list
}
```

### The chat page

`layout: chat` is a message feed instead of a form per operation. It needs two
bindings and accepts an optional third:

```arcod
ui Chat {
  kind:    spa
  route:   "/"
  layout:  chat
  history: Agent.history    // what to read
  send:    Agent.send       // where to send
  start:   Agent.start      // optional: create a conversation
  uses     Agent.history, Agent.send, Agent.start
}
```

The message text comes from the operation parameter of string type; the page
does not guess the parameter name, it comes from the contract. Missing
`history`/`send`, or a non-public operation, is `A036`: a feed without a source
or without a destination makes no sense.

The page does not poll: it reads history on open, sends a message, and appends
the reply returned by `send`. Live updates are the separate `stream` capability
(see below); they are not wired into `layout: chat` yet.

### Somebody else's service: contract and address only

When the service already exists and we only call it, a partial contract is
enough. No container, no bodies, no tests are generated for it.

```arcod
external service Ledger : http {
  contract {
    op record(entry: Entry) -> Receipt {
      route: "POST /v1/entries"
    }
  }
}

environment dev {
  bind Ledger -> endpoint(url: "http://localhost:9009")
}
```

```js
// inside our own operation body
const out = await io.remote('Ledger', 'record', { order: id, amount });
// out is the envelope { status, body }: the receipt itself is out.body
if (out.body.accepted) { ... }
```

`io.remote` returns `{ status, body }`, never the body alone: `body` is the
parsed JSON (or the raw text when the answer is not JSON). A non-2xx answer
throws instead of returning, and the error text carries the status and the
first 200 characters of the response body.

The emitter takes the method and path from the contract, the base URL from the
environment (`LEDGER_URL`), so the body never knows an address. In compose,
`localhost` is rewritten to `host.docker.internal`, and the service declares
`extra_hosts: host.docker.internal:host-gateway` for it, so the name resolves on
a Linux engine as well as on Docker Desktop; `gateway: true` is still accepted
but no longer decides anything. `network: "shared"` attaches the container to
an existing network (`external: true`). A build that names the host this
way also sets `dns.setDefaultResultOrder('ipv4first')`: Docker Desktop answers
`host.docker.internal` with both families, and Node would otherwise pick the
AAAA record while the host listener is IPv4-only. An external service never
appears in the manifest's `services` and gets no scheduler tasks.

The method decides where a parameter goes: a name that matches a `:path`
capture fills the path (percent-encoded), `GET`, `HEAD` and `DELETE` put the
rest in the query string, every other method sends a JSON body with
`content-type: application/json`. `HEAD` is a `GET` without a response body, so
the call is body-less on both sides and the answer is still `{ status, body }`
with `body: null`.

A URL is text — a query string and a `:path` capture alike — so the boundary
maps both back to the declared parameter type before the body runs: `int`,
`number`, `float` and `decimal` arrive as numbers (a value that is not one is
a 400 naming the parameter — `must be a number`, or `must be an integer` for
`int`), and `bool` accepts exactly `true`/`false` and arrives as a boolean.
Without that, one contract had two shapes: `?limit=3` reached the body as the
string `"3"` while the same parameter in a JSON body arrived as `3`, so
`limit + 1` answered `"31"`.

A JSON body keeps the JSON kind the caller wrote, it is not re-read: `true` and
`3` are the declared type, while a quoted `"true"` or `"3"` stays a string. The
boundary checks that kind for every scalar parameter, stored or only branched
on: a quoted number where `int`, `number`, `float` or `decimal` is declared, or
a non-boolean where `bool` is declared, is a 400 naming the parameter
(`qty must be an integer`, `done must be a boolean`) before any statement runs;
a fraction where `int` is declared is refused the same way, so a typed
parameter never reaches the store's own message. Send JSON types in a body.

Checks: `A037` no `route`; `A038` `uses` or effects declared for a foreign
service; `A039` bound to something other than `endpoint`; `W026` called but no
address configured.

The process on the developer machine must listen on `0.0.0.0`: on `127.0.0.1`
the container gets `Connection refused`.

### Where the service lives

Capability and deployment are different axes. Capability says what the service
uses (`bind store -> redis`), deployment says where the service itself runs:

```arcod
environment dev  { ... deploy docker }
environment prod { ... deploy yandex(region: "ru-central1", folder: "arcod-prod") }
```

`docker` produces a local `docker-compose.yml`; `kubernetes` and `helm`
render the same topology as cluster objects (`k8s/` or `helm/` next to the
compose file); `aws` and `yandex` produce a declarative `deploy.<env>.json`
manifest (`"executed": false`: no credentials, no API calls). Unknown provider
is `A028`, unknown argument is `W019`. Compose is built from the local
environment; prod bindings never leak into it.

```bash
arcod deploy . --env prod          # target and artifact
arcod deploy . --env prod --json   # the manifest
```

**Image names are a contract.** Every service gets `arcod/<module>-<service>:<spec version>`
unless the environment names a `registry`, a `repository` or pins `image`. Semver build metadata is sanitized into a legal tag (`0.2.0+build.7` →
`0.2.0-build.7`). The manifest carries the parts (`registry`, `repository`,
`tag`, `image`) per service and in an `images` map, so a CI job builds the
same name the runners pull — arcod still pushes nothing itself. `arcod k8s`
and `arcod helm` render the same name by default; `--env` picks which
environment's contract they use. `.github/workflows/images.yml` builds that
image on a tag or on demand — and stops there: pushing to a registry is a
release action, not something a generator does.

`arcod terraform` renders the cloud view of the same environment: a network
and subnet, a managed cluster per `postgres`/`redis` bind, a bucket per `s3`,
and every credential as a `variable` marked `sensitive`, so the plan never
holds a password. It targets Yandex Cloud (the provider the `deploy` names)
and refuses any other target instead of half-rendering it. The plan reads the
same provider registry `check` uses, so a provider declared by a plugin appears
as an external dependency: the plan states who declared it and turns each of
its secrets into a `sensitive` input, rather than dropping the bind silently.
A provider no one declares is reported in a comment. The state backend is the
owner's choice; no state is generated. A managed service has no container to
address, so the plan exports the endpoint the cloud assigns — `db_host` /
`db_port` for postgres, `kv_host` / `kv_port` for redis — and names in a
comment any `host`, `port` or `expose` it cannot honor. `check` reports the
same gap as `W044`, so a binding copied from the docker environment never looks
applied when it is not. One managed service per provider: two redis binds in one
environment render a single cluster (a duplicate block is a plan terraform
refuses) and `W045` names the second alias instead of pretending it was
provisioned.

The outputs are the wiring contract: `network_id`, `subnet_id`, `image`, and
one endpoint pair per managed bind. A module with several internal services
adds `image_<service>` for each one after the first, so the pipeline builds
every container and not just the front one. A cloud runtime reads the address from
`terraform output`, never from the bind's `host`/`port` — those are container
instructions (`W044`).

A Kubernetes manifest rendered for a cloud environment follows the same rule:
every app env entry that addresses a managed provider moves into a `Secret`
named `<app>-endpoints`, and the pod reads each one with a `secretKeyRef`. That
includes the shapes a container address hides in — a URL (`DATABASE_URL`,
`REDIS_URL`) and the bare `KV_HOST`/`KV_PORT` the kv driver also reads — so no
entry keeps pointing at a compose service the plan never creates. The service
manifest prints the shape each key must carry, with the cloud-assigned parts
left as placeholders, so the wiring step is written down where the pod is
applied:

```
# After `terraform apply`, create it in the namespace:
#   kubectl -n arcod-shop create secret generic arcod-shop-endpoints
#   key database_url  <-  postgres://<user>:<password>@<db_host>:<db_port>/arcod
#   key kv_host  <-  terraform output kv_host
#   key redis_url  <-  redis://<kv_host>:<kv_port>
```

A `docker` environment keeps the literal URL: there the host name is a service
compose really starts.

A managed service is not drawn twice. When the plan provisions the endpoint, the
manifest starts no `postgres` or `redis` workload for it and names the providers
it left to the plan in the same comment.

The manifest is rendered from the environment it names (`arcod k8s
--environment prod`), not from the local docker view: the providers, the URLs
and the workloads are that environment's binds. A module that keeps mysql at
home and postgres in the cloud therefore renders a postgres manifest for prod.

**Scaling** is the application's: `--replicas n` (`replicaCount` in the chart)
sizes the app Deployment and the web tier. A provider workload keeps one
replica — the images are single-instance software (redis with no cluster
configuration, mysql on a `ReadWriteOnce` claim), so two of them behind one
Service would answer from two different stores. For the same reason a provider
Deployment rolls as `Recreate`: the old pod releases the volume before the new
one mounts it, and the two never serve side by side.

**Secrets** are declared by the providers, not guessed from names: `postgres`
marks `POSTGRES_PASSWORD` and `DATABASE_URL` sensitive, `s3` marks
`MINIO_ROOT_PASSWORD`/`S3_SECRET_KEY`, `vault` marks `VAULT_TOKEN`, and so on.
The Kubernetes target writes them to a `Secret`, never to the `ConfigMap`.
Bind a `secrets` capability to replace that Secret with an `ExternalSecret`
(external-secrets.io) sourced from Vault, so no credential is written to disk:

```arcod
environment prod {
  bind db   -> postgres()
  bind keys -> vault(path: "secret/data/shop", store: "vault-backend")
  deploy kubernetes(image: "ghcr.io/acme/shop:1.0.0", host: "shop.example.com")
}
```

### Background work and its dependencies

A single scheduled task is a `job` inside a service contract. Several tasks with
dependencies are a `workflow`: a graph of steps with typed ports.

```arcod
workflow Nightly {
  trigger cron("0 3 * * *", tz: "Europe/Moscow")
  overlap: skip          // if the previous run is still going
  catchup: last          // catch up only the latest miss
  retry: 2
  timeout: 30m

  step prepare() -> Snapshot {
    call: Reports.prepare
    effects: store.set
  }

  step render(snapshot: Snapshot) -> Report {
    call: Reports.render
    needs: prepare
  }

  step send(report: Report) -> Receipt {
    call: Reports.send
    needs: render
    onFail: stop
  }
}
```

Rules:

- edges are explicit only: `needs`; a step without `needs` starts right after
  the trigger;
- an input port is filled by the output of **exactly one** step from `needs` —
  by type, never by guessing;
- cycles are rejected (`A030`), unknown edges are `A029`, a port without a
  producer is `A031`;
- `onFail: stop | skip | retry | continue`; `onFail: skip` on a step others
  depend on is `W020`;
- triggers: `cron(...)`, `event(...)`, `manual`, `after Other`,
  `after <duration>` (a delay such as `after 30s`) and `at(<instant>)` (a
  one-shot start). An instant is ISO-8601 with an explicit zone, written bare
  (`at(2026-11-18T12:00:05Z)`) or quoted; a typo, an impossible date or a
  missing zone is `A034`, a non-positive or unitless delay is `A034` too.

`examples/nightly` is the demo: the three operations the steps call live in a
service — `prepare` stores a snapshot, `render` reads it back through a
record-typed parameter, `send` answers — so `arcod test` runs them over HTTP
while the graph itself stays declarative.

The graph is declarative: it lands in `deploy.<env>.json`, but no runner is
generated yet — a workflow is described, not executed (`W022`). The manifest
carries the trigger as data: `kind`, `args`, and for the delayed forms
`at` (the instant) or `afterSeconds` (the delay), so a runner schedules
without re-parsing the spec.

A delayed trigger is a declaration for a runner, **not a timer**: v0.1 does
not fire `at`/`after` by itself, and work that must happen on a deadline stays
the application's responsibility until a runner exists. An impossible instant,
a missing zone or a non-positive delay is rejected at build time (`A034`).
For a delay an operation really needs, `io.queuePublishLater(topic, message,
seconds)` hands the wait to the broker instead: the consumer's poll delivers the
message once it is due, so a job behind it runs late rather than on a timer.

### Files, sign-in and rights

`examples/files` — a service where a user signs in through Keycloak, uploads a
file to S3 and picks visibility: everyone, authenticated users, or a list of
users. An administrator sees a file at any visibility.

```arcod
uses store: sql(ttl: 31536000s)
uses auth:  identity
uses files: blob

environment dev {
  bind auth  -> keycloak(host: "idp", import: "realm.json")
  bind files -> s3(host: "s3")
}
```

`io.actor()` verifies the JWT against the provider JWKS and returns
`{ id, name, admin }`; `io.users()` reads the user list from the admin API;
`io.blobPut/blobGet` store and read objects. The provider is still chosen in the
environment: neither Keycloak nor MinIO is named in the model.

Effects are declared explicitly: `effects: store.get, files.get`.
The planner derives the procedure from effects and type shapes, not from
operation names; without a declaration, effects are inferred from shape (uuid →
read, bytes → object, list → list).

`allow store.*` grants every effect of one capability in a single entry. An
allow/deny entry that names no effect of the declared capability (or of another
service) is `A044`, so a typo cannot pass for a guard.

Access control is declarative, and the generated runtime enforces it before the
body runs:

- `public op` — no actor required (the anonymous caller gets the visibility
  matrix below);
- `auth op` — an authenticated actor is required; anonymous gets `401`;
- `roles: admin, manager` — the token must carry one of the roles declared in
  the service `roles:` vocabulary, otherwise `403`;
- `owner: id` — the record loaded by parameter `id` must belong to the actor,
  otherwise `403` (administrators bypass; a missing record is `404`, never a
  leak).

The runtime raises `Unauthorized`, `Forbidden`, `NotFound`, `Conflict` and the
rest of the built-in set itself, so a contract does not have to declare them to
get their status: an `auth op` with no `errors:` answers `401` (it used to
answer `500`, because the table was built from `errors:` alone). Declaring the
error is still what attaches fields to the body — the declared entry wins.

The operation name is yours to choose. The generated module keeps its own
dispatcher (`handleRequest`), so the per-operation wrappers carry the prefix —
`arcodHandle<Op>` — and an operation called `request` builds and loads instead
of declaring `handleRequest` twice.

Standard checks (`401`/`403`/ownership) therefore never appear in bodies. The
visibility matrix is not a standard guard, so it stays in one place —
`canRead` in the operation bodies:

| Who | public | authenticated | restricted |
|---|---|---|---|
| anonymous | yes | no | no |
| authenticated | yes | yes | only if listed |
| administrator | yes | yes | yes |

The UI page is derived from the contract as well: a form per public operation,
fields from parameters, the result from the response shape.

### A presentation: one page, two audiences

`layout: presentation` is one page for two audiences: the host opens it on a
screen, participants join from their phones by a code or the QR on the host
screen. Slides are declared in the model, so the page never guesses what to
show. Interactive widgets (poll/rating/comments) were deliberately left out of
v0.1: they are a product feature, not language core, and will come back as a
separate package once the plugin model exists.

```arcod
ui Stage {
  kind:    spa
  route:   "/"
  layout:  presentation
  start:   Live.start
  join:    Live.join
  state:   Live.state
  advance: Live.advance
  uses     Live.start, Live.join, Live.state, Live.advance

  slide "Who are you?" {
    body: "Developers, QA, product — the host asks, the room answers out loud."
  }
  slide "Join" {
    body: "Open the link shown on the big screen or scan the code."
  }
}
```

Rules:

- `start`, `join`, `state`, `advance` are mandatory (`A040`): the host creates
  a session, a guest joins by code, both read state, the host moves the deck;
- `A041` catches an empty deck;
- the join QR is drawn on the client from the link to the current session; the
  code is generated by the service, so the QR always points at a live room; the
  encoder is vendored into the page (MIT, no CDN), so the presentation works
  offline;

Live example: `examples/quiz`. The host gets a code and a QR and moves through
the deck; guests follow the slides live. Updates arrive over websocket: the
service publishes an event after every mutation, the page reads `state`. Idle
traffic is zero; if the socket cannot be opened, the page falls back to polling
every 3 s.

### An event stream over websocket

The model asks for a stream, the environment answers with a transport — the same
way as `kv` and `redis`.

```arcod
service Live : http {
  uses stream: stream
  effects {
    allow store.get, store.set, stream.publish
  }
  contract {
    public op vote(...) -> Ack {
      route: "POST /v1/sessions/:id/votes"
      effects: store.get, store.set, stream.publish
    }
  }
}

environment dev {
  bind stream -> websocket()
}
```

Inside the operation body:

```js
await io.publish('room:' + session.code, { type: 'changed', index: session.index });
```

`publish` returns the number of listeners: `0` is not an error, the host simply
has not opened the screen yet. A topic is a plain string chosen by the body.

What is generated:

- **a server on the same port**, path `/ws?topic=...`: handshake, text frames,
  ping/pong and close per RFC 6455, vendored into a single file — there is no
  `ws` dependency;
- **subscription by topic**: a message reaches only those listening to that room;
- **nginx** gets `location /ws` with `Upgrade` and a one hour
  `proxy_read_timeout`;
- **the page** listens, reconnects with a 1→10 s backoff and polls every 3 s
  while the socket is down. A presentation without `stream` gets `W028`.

**Several replicas.** `bind stream -> websocket()` keeps events in-process —
one replica, demo scale. `bind stream -> redis(...)` puts pub/sub between the
replicas: every instance publishes to the broker and subscribes to the topics
its own websocket clients listen to (the broker URL comes from the bind that
carries the `stream` capability, so a second redis kept as a cache is not
mistaken for the broker), so a client may sit on any replica and
still see every event exactly once. Reconnects re-subscribe automatically,
including after a broker restart or an attempt that never connected: the new
connection announces every topic that still has a listener, and the retry
repeats every 500 ms while a listener remains, so a websocket that subscribed
during an outage starts receiving once redis is back. A subscription is not
lost and not left pending on a socket that failed to connect.

### A queue: publish in one operation, consume in a job

The model declares both ends. An operation publishes:

```arcod
uses events: queue

public op submit(entry: string) -> bool {
  route: "POST /v1/submit"
  effects: events.publish
}
```

A job consumes — the runtime owns the lifecycle, the body is a plain function
of the message:

```arcod
job audit(entry: string) {
  on: events.jobs
  retry: 3
  effects: store.set
}
```

Semantics, enforced by the generated runtime rather than written in bodies:

- the consumer starts before the http server and stops on `SIGINT`/`SIGTERM`,
  finishing the message in flight (ack by completion, nack by requeue);
- a failing body — an exception or `{ error: ... }` — is retried up to
  `retry` times (default 3) with an exponential pause before each requeue
  (250ms, then doubling, capped at 30s), then moved to the dead letter queue, readable
  with `io.queueDead(topic)`; `io.queueDeadDrop(topic, payload)` takes the
  first entry carrying that payload out of the list (`false` when there is
  none), so a replayed message does not sit there forever; every requeue and
  every dead letter writes one line to the service log — topic, attempt number,
  `lastError` — and never the payload; a failing `receive` (a broker restart)
  is retried instead of ending the consumer loop, with one line at the start of
  the outage and one at recovery; a silent broker (accepts, never answers) is
  the same outage: every command has a deadline (`ARCod_QUEUE_TIMEOUT_MS`,
  falling back to `ARCod_STORE_TIMEOUT_MS`, default `5000` ms), so the consumer
  retries instead of blocking forever;
- the body receives named parameters: one parameter is the value of that field
  (a bare scalar is the value itself), several are the fields by name;
- a body that returns nothing while the job declares input is a failed attempt
  too (`consumer returned no result for its input`): a lookup that returned
  `null` must not ack the message and hide the work;
- delivery is at-least-once; a consumer body should be idempotent;
- without a redis binding the queue is in-process (memory driver); with
  `bind events -> redis(...)` messages live in the broker and any replica may
  consume them. The adapter speaks Redis lists — `rabbitmq` and `kafka` are
  provisioned, but there is no zero-dependency client for them yet, and
  `check` rejects a `queue` bind on them (`A083`) instead of running in memory;
- a broker restart does not stall the consumer: a closed socket fails the call
  in flight (`redis connection closed`) and the next one opens a fresh
  connection. The same rule holds for the `kv` Redis client.

When a service uses `sql`, one connection carries every statement and it takes
a queue: a body's concurrent `io` calls (or a queue consumer next to an HTTP
request) are serialized on the wire, so two operations cannot read each
other's rows. `Promise.all` answers the same numbers as a sequential run; the
price is throughput — one statement at a time per replica.

A transactional operation (one that writes a fact and publishes through the
outbox) holds the whole store for its body: other requests wait until it
commits or rolls back, so a second `BEGIN` never lands inside the open
transaction and a loser's rollback cannot discard the winner's row.

When a service uses `queue` on the `sql` driver, a publish in an operation that
also writes a fact goes through the **outbox**: the body runs in a transaction,
the event is appended to `arcod_outbox` in the same transaction, and a
dispatcher relays the committed rows to the broker on its own connection. A
crash between the fact write and the hand-off cannot lose the event, and a
replica that dies mid-relay finds the row still pending on restart; a failing
poll or hand-off leaves the row pending and writes at most one log line per
30 seconds, not one per row per sweep. See
`examples/orders`. Identifiers are always quoted (`q()`), so a record type
named `Order` (table `order`) is safe.

Checked by the compiler: `on:` is a job-only clause (`A051`), the source must
be a declared `queue` alias (`A052`), `retry` without `on:` is an error
(`A053`), and a queue-backed job is executed — so the `W017` "jobs are not
executed" warning no longer applies to it.

### A saga: multi-step with compensation

A saga is a linear, multi-step operation the runtime executes itself — unlike a
`workflow`, which is an external-runner contract. Each step runs an operation
and may name a compensating operation:

```arcod
saga checkout {
  step reserve {
    call: reserve          // own op, in-process
    compensate: release
  }
  step charge {
    call: Billing.charge   // external service, via remoteCall
    compensate: Billing.refund
    retry: 2
  }
}
```

A job drives it: `job run_checkout(label: string) { on: events.checkout
saga: checkout }`. The runner executes steps in order, retries a failing step
up to `retry` (default one attempt), and on final failure compensates the
completed steps in reverse order. Compensation is the terminal state — the
message is not retried. See `examples/saga`.

Checked by the compiler: a step's `call`/`compensate` must name a real
operation (`A057`), and a job's `saga:` must name a declared saga (`A058`).

### The contract as OpenAPI

`arcod openapi` renders the same model as an OpenAPI 3.1 document on stdout —
the contract other teams, SDK generators and API gateways read, with no compiler
in the loop:

```bash
arcod openapi examples/files > openapi.json
arcod openapi . --service FileShare   # a spec with several services
```

Paths come from `route`; request and response schemas from `types` (a declared
type becomes a `$ref` under `components/schemas`); status codes from the same
error mapping the runtime uses — `Invalid` is `400`, `Unauthorized` `401`,
`Forbidden` `403`, `NotFound` `404`, `Unavailable` `503`; and the
`examples` block attaches as named examples, including error examples produced
by `then { e is Invalid }`. Providers and hosts never appear in the document:
the model is not allowed to name them (`A003`), so neither does the contract.

What it does not describe: no `servers` — the address belongs to the
environment, not to the contract. Authentication is described when the model
has it: a service that uses `auth: identity` publishes a `bearerAuth` scheme
(`http`, `bearer`, JWT) and applies it to the whole document, while a `public`
operation opts out with an explicit `security: []`. A spec without an identity
capability has no `security` key at all, so the document never promises a
token the runtime would not check. Roles and ownership have no OpenAPI keyword,
so a `roles:`/`owner:` clause lands in the operation `description` — the client
author reads what the runtime enforces before the body runs.

### The contract as GraphQL

`arcod graphql` renders the same contract as GraphQL SDL. The runtime still
speaks HTTP — the schema is the client-side view, so codegen (Apollo,
graphql-codegen, `graphql` itself) has something real to read:

```bash
arcod graphql examples/tasks-sql                    # SDL on stdout
arcod graphql . --service TaskBoard --out schema.graphql
```

The split follows the REST method the spec already declares, never a naming
convention: a `GET` route becomes a **Query** field, any other method a
**Mutation**. Arguments come from operation params (`uuid` → `ID`, `int` →
`Int`, `datetime` → `DateTime`, optional → nullable), return types from
`-> Type`. GraphQL cannot use an output type as input, so each type that appears
as an argument also gets an `<Name>Input` twin; a body param carries it, scalar
params stay plain arguments:

```graphql
type Query {
  """
  HTTP: GET /v1/tasks
  Errors: Invalid (400)
  """
  list(status: String, sort: String, limit: Int, cursor: String): ListResult!
}

type Mutation {
  create(task: TaskInput!): Task!
}
```

A union survives the trip: `type Result = OkBody | ErrBody` is emitted as
`union Result = OkBody | ErrBody`, and a client selects on the concrete
variant. GraphQL has no input unions, so in an argument position the same
declaration becomes `input ResultInput` with the merged fields of every
variant, all nullable: a value of any one variant satisfies the argument.
A variant named through an alias (`type Item = Task`) contributes `Task`'s
fields, because the alias is the same shape on both sides. A union with a
scalar or enum variant (`type R = Task | string`) has a member GraphQL cannot
hold, so the position is emitted as `JSON` — a hole the schema admits to
rather than SDL no server accepts.

Each field's description carries the HTTP route and the error codes mapped by
the same table the runtime uses, so REST and GraphQL cannot drift apart. The
emitted SDL is validated with `buildSchema` from the `graphql` package in the
test suite — for every example, not just a fixture.

### The contract as gRPC

`arcod grpc` renders the same contract as a proto3 file. This is the one view
that does not speak HTTP at all, so the mechanical part matters: every type has
to land on a proto type that means the same thing, or clients inherit a lie.

```bash
arcod grpc examples/tasks-sql                       # proto3 on stdout
arcod grpc . --service TaskBoard --out proto/tasks.proto
```

| arcod | proto3 |
|---|---|
| `string`, `uuid` | `string` |
| `bytes` | `bytes` |
| `int` | `int64` (the language does not bound it) |
| `float`, `number` | `double` |
| `decimal` | `string` — a `double` would round money away |
| `bool` | `bool` |
| `datetime` | `google.protobuf.Timestamp` |
| `json` | `google.protobuf.Value` |
| `map<K,V>` | `map<K,V>` for scalar keys and values, `Struct` otherwise |
| `list<T>` | `repeated T` |
| `T?` | `optional T` (proto3 field presence) |
| `enum` | `enum` with a `<NAME>_UNSPECIFIED = 0` member |
| record | `message` |

proto3 requires the first enum member to be zero and arcod enums carry no
numbers, so the emitter adds `<NAME>_UNSPECIFIED = 0` and numbers the declared
values from 1 with the enum name as a prefix — the wire needs a zero, the
contract keeps every declared value.

Each routed operation becomes one rpc named after it; every parameter (path,
query and body alike — gRPC has no URL) lands in `<Op>Request`, and the return
value in `<Op>Response.result`; a `-> void` operation gets an empty response.
The HTTP route and the gRPC error codes (mapped from the same status table the
runtime uses) stay in comments, so neither transport drifts:

```proto
service TaskBoard {
  // HTTP: POST /v1/tasks
  // Errors: Invalid (INVALID_ARGUMENT), Conflict (ABORTED)
  rpc Create(CreateRequest) returns (CreateResponse);
}

message CreateRequest {
  Task item = 1;
}

message CreateResponse {
  Task result = 1;
}
```

One file covers one service, because `package` and message names have to stay
unique; `--service` picks it, and a module with several services emits one file
per service.

### Records, not blobs: unique, filter, keyset pages

A record type is also a store. `rules { unique Task.title }` is enforced by the
adapter, so a second task with the same title is the declared `Conflict` (409),
not a 500:

```arcod
type Task = {
  id: TaskId, title: string, status: Status,
  priority: int, createdAt: datetime, dueAt: datetime?
}

service TaskBoard : http {
  uses store: kv(ttl: 604800s)
  rules {
    unique Task.title      // a claim: duplicates are Conflict
    index Task.dueAt       // a query fact: KEY in the generated DDL
  }
}
```

Bodies ask for a page instead of scanning and slicing themselves:

```js
const page = await io.find('Task', {
  where: { status: 'open', priority: { gte: 2 } },
  order: 'priority desc, createdAt asc',
  limit: 20,
  cursor: input.cursor,
});
// { items: [ …records… ], next: 'eyJ2Ijpb…' | null }
```

A unique rule may name a tuple: `unique Fence.(name, fence)` (also written
`unique Fence.name, Fence.fence`) makes the pair unique, so the same `name` on
another `fence` is fine while the same pair is `Conflict`. The kv claim is keyed
by the tuple and SQL emits one composite `UNIQUE KEY (name, fence)`.

A successful call answers what the method implies: `GET`/`HEAD` 200, a write 201 — `DELETE` included, the way the runtime has always answered it (the OpenAPI document used to publish 200 for a delete); both read the same rule now. An operation that is a `POST` but creates nothing (`cancel`, `replay`) declares `status: 200`, and both the runtime and OpenAPI answer it; the clause takes any body-carrying 2xx — 204/205 has no body while every handler builds one, and a 4xx/5xx is an error, not a success answer (`A097`). The clause also decides the shape of a string result: a `POST` that returns `-> string` without `status` answers the one-time-message envelope `{ id, expiresIn }`, so a client generated from the schema would parse an object where the contract says string; declaring `status: 200` gives the declared string back as a `text/plain` body, which is what OpenAPI promises.

An error may declare payload fields: `error Conflict { fence: int }`. A body
that returns `{ error: 'Conflict', fence: lease.fence }` gets a 409 carrying
`fence` next to `error`/`message`; only declared names are copied, so a body
cannot add arbitrary properties, and an error without fields keeps the classic
two-key body.

`io.insert`, `io.fetch`, `io.update` and `io.remove` keep the unique claim in
step with the record (claiming the new value before releasing the old one). A unique group with an absent value is never claimed: two rows may leave a nullable unique field out, exactly as a unique index compares no `NULL`s, and clearing such a field releases the claim it held (the old value used to stay taken forever while no row carried it).
`io.find` filters (`eq`, `ne`, `in`, `gt`/`gte`/`lt`/`lte`, `contains`), sorts,
and pages by a keyset cursor — the last row's sort values and id, base64url
encoded — so a page does not shift when rows are inserted above it. A nullable
sort field has a rank as well as a value: `ASC` ends with the `NULL` rows and
`DESC` starts with them on every driver (MySQL used to sort them the other
way), and the cursor names that rank, so the null tail of a page is served
instead of being skipped. A cursor that does not belong to the order — a
different number of sort values, or a value that does not decode — is
`Invalid`: it used to count as "no cursor" and answer page one again, so a
client following `next` looped forever. The cursor also names the store that minted it — kv spells a moment as an epoch number, MySQL as `2026-01-01 00:00:00.000`, Postgres as `2026-01-01 00:00:00` — so a cursor handed to another store is `Invalid` (ask for page one) instead of comparing a foreign spelling and paging through the wrong rows; a cursor minted before the tag existed still continues. Under `arcod test` the sql driver's memory store is the same kv store, so its cursors are `kv`-tagged too. An operator outside that list is `Invalid` at runtime (the message names it) and `W038` in `check`; on `kv` a filter is a namespace scan with an in-memory match, on SQL it becomes a `WHERE` clause. `in` takes a list: an empty list matches nothing, and any other value is `Invalid` with the field and the received type (a dropped clause used to answer every row). A field the entity does not declare is `Invalid` too, naming the declared ones — a typo in `where` used to return every row on SQL and an empty page on `kv`. The same goes for an unknown sort key in `order` (was: a no-op sort on `kv`, a driver error on SQL). A `list`/record field has no order — `order` names a scalar field — and asking for one is `Invalid` on both drivers (kv used to sort its `String()`, SQL the JSON text). Comparing with `null` is `Invalid` — a null never matches — and a record whose field is null satisfies no filter at all (`gt`/`gte`/`lt`/`lte`/`contains`/`ne`/`in`), on every driver: `col <> 'x'` is not true for a NULL column, and kv used to read an absent field as "different from x". A `list` or record field compares by value — a record ignores key order, a list keeps its order — so `eq`/`ne`/`in` answer the same on `kv` and SQL. `gt`/`gte`/`lt`/`lte` need a scalar field: a range over JSON text is not an order, and both drivers answer `Invalid` with the field. `contains` casts the column to text on SQL, so it also works on an `int` field; a `datetime` is refused — every store spells the same instant its own way (`2026-01-01T00:00:00Z` on kv, `2026-01-01 00:00:00.000` on MySQL, `2026-01-01 00:00:00` on Postgres), so the same text search found different rows. A moment has an order: name the window with `gt`/`gte`/`lt`/`lte`. A `decimal` or `float` field is refused as well — `DECIMAL(30,6)` casts to `1.500000` where `kv` holds `1.5`, and each store picks its own exponent — so compare numbers with `eq`/`ne`/`in` or a range. A `list` or record field is JSON text, so `contains` looks for a substring of that text on both drivers — match a value, not the punctuation between elements. `contains` on a `bool` searches `1`/`0`, the text the column holds, and on a `bytes` field it is refused: bytes have no text form (kv holds the value, MySQL the raw BLOB, Postgres a `\x68\x69` bytea escape), so compare them with `eq`/`ne`/`in`. A `%` or `_` in the needle is that character, not a wildcard: the pattern is escaped and the clause names `ESCAPE '!'`, so `contains: "100%"` finds the row holding a percent sign instead of every row that starts with `100` — which is what mysql and postgres used to match while `kv` compared the text. An `io.insert`/`io.update` record may only carry declared fields: an extra key is `Invalid` (kv kept it, the sql stores silently dropped it). A field declared without `?` is required: a record that leaves it out on insert, or sets it to null, is `Invalid` naming the field (kv used to keep the absence while a NOT NULL column failed inside the sql driver). A declared container keeps its shape: a `list` field takes an array, a `map` and a named record take an object, and anything else is `Invalid` naming the field (kv used to store a bare string in a `list<string>`, so the row contradicted its own type). Only the shape is checked at the record — the element type belongs to the contract. An `enum` field holds one of its declared members: a record built inside a body never crosses the op boundary, so `status: "statuz"` is `Invalid` naming the field and the members instead of a stored string the declaration never allowed. An `email` or `url` field keeps its format for the same reason: a record that stores `"alice"` or `"example.com"` is `Invalid` naming the field. The record itself must be an object: a body that hands `null` or a string to `io.insert`/`io.update` gets `Invalid` naming the call (kv used to spread the string into numbered fields, and a null died on `.id` as a 500). `io.remove` answers whether a record was deleted: `false` for an id that is not there, on every driver (the sql stores used to report success unconditionally). An optional field with no value reads back as `null` on every driver: kv used to leave the key out while a nullable column answered `NULL`, so one fetch returned two shapes.

A read-modify-write is not atomic when the body does it: `fetch` then
`update` reads the same snapshot in two requests and one step vanishes.
`io.updateWhere` is the write that closes it — match, lock, re-read, then write:

```js
const { updated, record } = await io.updateWhere('Counter', { name: 'jobs' }, { seq: { inc: 1 } });
```

The patch carries literals and arithmetic steps: `{ inc: n }` / `{ dec: n }`
on a numeric field, anything else is `Invalid` naming the field (an unknown
field too). `where` takes the same operators as `io.find`. The answer is
`{ updated, record }`: `updated` is 0 when nothing matched and `record` is the
last row written (`null` then). Two racing conditional writes see exactly one
winner, because the loser re-reads the winner's row under the lock and no
longer matches; parallel `{ inc: 1 }` steps are serialized per record, so none
is lost. The lock is a lease: a writer that dies mid-write holds a record for
5 s, not forever, and a caller that waits longer than 10 s gets `Conflict`.
A `sql` service takes the same call: the rows come from the same `where` as a
`find`, each one is re-read under its lease, and the write goes through the
typed table (`UPDATE`), so the unique keys stay the table's business. Reading it
needs `store.updateWhere` in `effects` on either store.

`io.update` takes the same guard as a fourth argument when the body already
holds the row it wants to change:

```js
const row = await io.fetch('Doc', id);
// ... compute the next text ...
const next = await io.update('Doc', id, { version: row.version + 1, text }, { if: { version: row.version } });
```

`if` names the values the stored record must still hold; the record is
re-read under a lease and written only when they do, so the loser of a race
gets `Conflict` (409) and the row is untouched instead of one step being
overwritten. An unknown key under the fourth argument, an `if` that is not an
object, or an empty `if` is `Invalid` naming the call — a guard that guards
nothing is a caller mistake, not an unconditional write. A body that wants the
write to land retries on `error.error === 'Conflict'` by re-reading the row;
ten parallel read-modify-writes then end at version 10 with every character,
instead of the version 2 that the lost-update bug left behind. The guard needs
no extra effect: it is the same `store.update`, on `kv` and `sql` alike, and
`{ inc }`/count semantics stay `io.updateWhere`'s job.

The retry is the difference between a 409 the client sees and a step that
lands. Ten parallel edits of one document, each retrying on `Conflict`, end at
version 10 with every character:

```js
export async function append(input, io) {
  const ch = String(input.ch);
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = await io.fetch('Doc', input.id);
    try {
      return await io.update('Doc', input.id,
        { version: row.version + 1, text: row.text + ch },
        { if: { version: row.version } });
    } catch (error) {
      if (!error || error.error !== 'Conflict') throw error;
      // another writer won this version; re-read and try again
    }
  }
  return { error: 'Conflict' };
}
```

A total is a separate call, not a page you fold yourself:

```js
const total = await io.count('Task', { where: { status: 'open' } });
```

`io.count` returns a number and ignores `limit`/`cursor`: SQL runs one
`COUNT(*)` with the same `WHERE`, kv counts the namespace after the same
in-memory match, so a counter never walks pages or stops at a ceiling. Reading
it needs `store.count` in `effects`.

A sum is a call too — folding pages in the body is the bug this replaces:

```js
const due = await io.aggregate('Invoice', { field: 'amount', op: 'sum', where: { paid: false } });
const top = await io.aggregate('Invoice', { field: 'amount', op: 'max' });
```

`op` is `sum`, `avg`, `min` or `max` over one numeric field, with the same
`where` operators as `find`/`count`. SQL runs a single `SUM/AVG/MIN/MAX`
statement and returns no rows; kv folds the filtered namespace. `sum` of nothing
is `0`, `avg`/`min`/`max` of nothing is `null`. An unknown `op`, an unknown
field or a non-numeric field — decided by its declared type, so an empty table
or a text column of digits is still `Invalid` — is `Invalid` with the name in the
message — a
report never goes quiet and never guesses. Reading it needs `store.aggregate`
in `effects`.

`examples/tasks` (Redis, with `KV_DRIVER=memory` for tests) and
`examples/tasks-sql` (MySQL) share the same bodies and both pass
`arcod test --impl`. What is not there yet: the filter runs in the adapter over
one entity namespace (`scan` plus in-memory match), which is honest for
thousands of rows, not millions. Schema-aware SQL tables and declared indexes
are in place; query pushdown is the next step.

### One model, different providers

`kv` and `sql` are the same record by id over different providers. Operation
bodies do not change:

```arcod
uses store: kv(ttl: 999s)     // redis
uses store: sql(ttl: 999s)    // mysql, postgres
```

`ttl` is the only `uses` parameter an adapter executes, and what it expires
depends on the driver. On `kv` it is the lifetime of every record, entity rows
included: the store writes `SET … PX`, so a task created with the default TTL is
gone 999 s later. Set `ttl` on a store that keeps domain data. On `sql` the TTL
bounds the adapter's own rows (`msg:`, `outbox:`); entity tables have no expiry
column and rows live until removed. Any other name (`consistency: strong`, for
instance) is kept in the spec and printed by `fmt`, but nothing reads it —
`W033` says so. Provider
options belong to `bind alias -> provider(args)`, where they configure the
backend connection. A provider reads a fixed set of them: `arcod providers
--json` lists the names under `options`, and `W035` reports an argument no
provider reads. `host`, `port`, `expose` and `import` are accepted by every
binding. `image` is listed for every provider that runs a container: it pins the
container to an exact reference (`bind store -> redis(image: "redis:7.4")`)
both in the compose file and in the k8s Deployment, instead of the built-in tag,
and `A084` refuses a value that is not a plain reference.

The `io` adapter is what changes: the MySQL client parameterises queries so a
value from a request never concatenates into SQL; `take` runs as a transaction
with `SELECT … FOR UPDATE`.

Live examples: `examples/project1` (Redis) and `examples/project1-mysql`
(MySQL) — the same spec, two lines differ.

A provider can be external: `bind errors -> sentry(dsn: "...")` creates no
container.

## Build modes

```bash
arcod build              # scaffold: handlers return 501, bodies marked TODO
arcod build --reference  # reference: built-in create/read bodies over kv
arcod build --impl       # bodies from impl/*.mjs through the io adapter
arcod run                # reference, so the demo works
arcod run --impl         # run the service with the model's own bodies
arcod run --scaffold     # run the skeleton: healthz works, operations are 501
```

Scaffold is what the compiler actually derives from the model: routes, config,
adapters, errors, limits and infrastructure. Operation bodies are not part of it.

## Prompts and the local model

The compiler does more than write code: it emits **deterministic prompts**, one
per operation.

```bash
arcod build              # .arcod/build/prompts/<op>.md + manifest.json
arcod prompts --json     # prompts only, with token counts and sha256
```

The prompt folder is an artifact: `arcod prompts` and `arcod make` delete an
`<op>.md` the current contract no longer declares, and a contract with no
operations leaves no prompt and no `prompts.json` behind. `arcod prompts`
also refreshes `prompts/manifest.json` in place — the same file `arcod build`
writes — so a rerun cannot leave the build's older task list behind. A build
publishes both manifests too: `prompts/manifest.json` and `prompts.json` at
the root of the build, so `arcod make` cannot lose the loose file when the
build step replaces the tree.

A module with several internal services gets one prompt set per service:
`prompts/<service>/<op>.md`, with a `service` field in every manifest task, so
two services sharing an operation name cannot overwrite each other. One
service keeps the flat `<op>.md` paths. The prompt names the body path it
expects: `impl/<op>.mjs` for one service, `impl/<service>/<op>.mjs` for
several, and `arcod impl` writes the body where the prompt says — the build
reads the per-service folders, so a multi-service module is generated like any
other.

A prompt is a function signature, not a service description:

```text
create(input, io)
in: { body: string /* 1..65536 bytes */, password: string | null /* 1..128 chars */ }
out: { result: string } | { error: "Invalid" }
io: new() -> id; hash(password); set(id, value)
value: {b: string, h: string|null}; h = password hash or null
```

A call into an `external service` is spelled in the same io list: `remote("Ledger", "record", input) -> { status, body }`. The alias has no capability signature, so without that line a body would have to guess how the other service is reached.

115 tokens for `create`, 197 for `read` in the password example; `--full` pays
353 and 395 for the header, contract, io list and storage shape. No routes, no
other operations, no infrastructure: everything constant ("one file, no
imports, no HTTP") lives in the system prompt, so the per-operation payload
stays small.

```bash
ollama pull qwen2.5-coder:7b
```

There are no cloud providers by default: the endpoint is local, a non-local
address is rejected without `--allow-remote`. No tokens are spent.

The compiler derives the procedure for a body (`src/plan-body.ts`) from the
model: a `uuid` parameter gives `load`, `ids.new`+`kv.set` give `new` and
`save`, `once` and `atomic` give `takeIf`, and `on error E: store.has(id)`
means "the check does not consume the record" and puts `verify` before
consumption. Operation names are not used. An operation with no effect and no
result still gets one step, `return {}`: the emitted handler answers `null` for
an undefined result and treats a falsy return as `Internal`, so a body that
returns nothing is the one body that cannot work. If a step cannot be derived,
prompt generation fails with `unresolved` instead of guessing.

Bodies are wired in with `arcod build --impl`: the compiler inlines them into the
service, builds the `io` adapter (records `{b, h}`, compare-and-delete through
`takeIf`, scrypt) and keeps routes, statuses and limits to itself.

Bodies share one module, so a helper belongs in `impl/lib.mjs`: it is bundled
once, before the bodies, and every body calls its functions as top-level names.
The file is not the body of an operation called `lib`, and a body that declares
the same name is refused as `A093` with both file names (issue #39). The lib is
held to the same sandbox and appears in the provenance manifest.

`arcod impl` writes bodies into `impl/` next to the spec (that is what
`--impl` reads). Bodies are cached by prompt hash, so a rerun only asks the model
for what changed. In `examples/*/impl/` the bodies were generated by
qwen2.5-coder:7b and verified by tests, so the demo reproduces without Ollama.

### From zero to a service with a local model

```bash
node scripts/e2e-local-model.mjs
# arcod new demo -> arcod impl demo -> arcod build demo --impl -> arcod test demo --impl
```

The script is the whole promise in one command: scaffold a spec, generate every
body with a local model, build the service with those bodies and run its
examples. It probes `OLLAMA_ENDPOINT` (default `http://localhost:11434`) first;
when no model is reachable it prints one `SKIP e2e-local-model: ...` line and
exits `0` — a machine without a model is a configuration fact, not a red test.
Set `ARC_MODEL` to try another model, `ARC_E2E_KEEP=1` to keep the temp dir.

`node scripts/model-harness.mjs [example ...]` measures the model instead of
trusting it: it copies each example to a temp dir, generates every body, runs
that spec's own examples and writes `docs/model-report.md` — per-example body
coverage, examples green/red, wall time. It skips with the same one-line exit
when no model is reachable, and never touches the checked-in `impl/` bodies.

## What is generated

For `examples/onetimemessage` and `examples/onetimemessage-pwd`: what comes from
the model and what stays a template is described in "Build modes".

The two examples differ in the model only: `create(body, password?)`,
`read(id, password?)`, the `WrongPassword` error,
`on error WrongPassword: store.has(id)` and the `hash(scrypt)` capability.
Routes, TTL, limits and infrastructure are identical.

- `.arcod/build/service/index.mjs` — an HTTP service on Node with no
  dependencies and an adapter per capability: a RESP client for `kv`, a MySQL
  client for `sql`, JWKS for `identity`, S3 for `blob`, an OpenAI-compatible
  chat for `llm`, a websocket hub and pub/sub for `stream`, a queue runtime
  with retry and dead letters for `queue` (Redis lists, or in-process when no
  broker is bound);
- the router matches a path by segment: a `:name` capture is a position, not a
  name, the method is case-insensitive, and a `HEAD` request is answered by the
  `GET` route with the same headers and no body (RFC 9110);
- `.arcod/build/web/` — a static frontend and nginx proxying the roots of
  declared routes (`/api`, `/v1`) and `/ws` when `stream` is used (only when a
  `ui` block is declared);
- `.arcod/build/plugins/<provider>.mjs` — runtime adapters copied from plugin
  packages that declare `runtime.adapter`, with `plugins.json` recording
  `{provider, package, source, target, export}`; the service imports each one
  at boot, calls `createAdapter(io)` once and answers the capability's declared
  signatures through it, so a broken adapter fails startup with the provider
  named;
- `.arcod/build/docker-compose.yml` — providers + service + frontend, with
  content-addressed local image tags (`arcod/<module>-service:<hash>` over
  `service/`, `arcod/<module>-web:<hash>` over `web/`; `arcod build` prints
  them): editing an `impl/*.mjs` body changes the tag, so a plain
  `docker compose up` builds and recreates the container instead of keeping the
  old one, while a rebuild with unchanged files keeps the tag and reuses the
  image;
- `.arcod/build/k8s/` (or `helm/`) — the same topology as Kubernetes objects:
  a Namespace, a ConfigMap for the non-secret env, a `Secret` for credentials
  (an `ExternalSecret` when a `secrets` capability is bound), a
  Deployment+Service per bound provider, the service with `/healthz` probes,
  the web tier and an Ingress; written when an environment says
  `deploy kubernetes` or `deploy helm`. A managed service in a cloud
  environment keeps its endpoint in the `<app>-endpoints` Secret and starts no
  workload of its own, and each tree is rendered from its own environment, so
  `k8s-<env>/` never describes a sibling's binds;
- `.arcod/build/migrations/` — the plan the service applies on boot, written
  from the same call as the embedded copy: `changelog.json` plus
  `NNNN_<table>.up.sql` / `.down.sql`; a rebuild replaces the directory, so it
  cannot carry SQL from an older schema; a second internal service keeps its
  own plan in `migrations-service-<name>/` next to it; a scaffold build has no
  bodies to read, so there every record type is a table — the same rule `arcod migrate`
  applies without evidence;
- `.arcod/build/prompts/` — one prompt per operation (`<service>/<op>.md` when
  the module has several services) and a `manifest.json` with
  the model hash and token budget;
- `.arcod/build/deploy.<env>.json` — a manifest per environment with `deploy`.

The tree is published as a whole: it is written into `.arcod/build.tmp-<pid>` and
renamed into `.arcod/build` after the last file. A build that fails leaves the
previous output untouched (never a half-written service), and a first build that
fails leaves no `.arcod/build` at all. A staging tree left by a killed build is
swept by the next one, unless its process is still alive.

`budget { concurrency: N }` produces an in-flight limiter: above the limit — `503`.

`atomic read { get; del }` switches the read to an atomic Lua script; without
the rule, separate `GET` and `DEL` are generated. `once(read, by: id, else: Gone)`
sets the second-read error — the emitter takes it from the model, not a constant.

Rules become behaviour: `atomic read { get; del }` becomes a Lua script with a
get and a delete, `once(read, by: id)` becomes a tombstone key that yields
`Gone` on a repeated read.

## Observability

Every generated HTTP service ships with a production baseline out of the box —
no dependencies, no config required:

- **Structured access log.** One JSON line per request on stdout:
  `method`, `route` (the declared path template, not the concrete URL),
  `status`, `latency_ms`, `request_id`, `actor_id` (when identity is used)
  and `operation`. A 5xx also logs the stack (`request failed: <stack>`), so the
  access line is never the only trace of a failure; the response keeps one
  sentence from the service's own `Internal` error (for example
  `unknown entity "Workflow"; declared: WorkflowRec`) and never echoes an
  arbitrary exception message.
- **Request id.** An incoming `x-request-id` header (or a generated UUID) is
  echoed on the response and propagated to every external call through
  `AsyncLocalStorage`, so one trace crosses service boundaries.
- **`/metrics`.** Prometheus text format:
  `arcod_requests_total` (by method/route/status),
  `arcod_request_duration_seconds` (histogram with fixed buckets),
  `arcod_errors_total` (by operation), `arcod_inflight_requests` (gauge) and
  `arcod_capability_calls_total` (`store.insert`, `store.find`, `remote.*`).
- **`/healthz`.** On `GET`/`HEAD` only, pings the store the service actually
  uses and names it in the answer: `{"status":"ok","service":"Tasks","kv":"up"}` on kv,
  `{"status":"ok","service":"Tasks","sql":"up"}` on sql; a failed ping is
  `503` with the same key set to `"down"`.
- **Store deadlines.** The redis client bounds the connect attempt and every
  command (default `5000` ms, `ARCod_STORE_TIMEOUT_MS`): a blackholed broker
  cannot hold `/healthz` or a request open past that deadline — the probe
  answers `503`, the stalled socket is dropped, and its late reply cannot be
  handed to the next call. The postgres client bounds a statement the same way
  (`ARCod_SQL_TIMEOUT_MS`, falling back to `ARCod_STORE_TIMEOUT_MS`): a server
  that stops answering fails the statement, and because a late reply could be
  read as the next statement's the connection is dropped and reopened by the
  next query.
- **Request timeouts.** `server.requestTimeout`/`headersTimeout` and an
  `AbortSignal.timeout` on external calls, driven by `ARCod_TIMEOUT_MS`
  (default `30000`).
- **Traces.** Every operation runs in a server span, every store call in a
  client span (`store.<op>` with `capability` and `entity` attributes) and
  every external call in a client span, parented through `AsyncLocalStorage`. With
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set, spans are flushed as OTLP/JSON
  (`POST <endpoint>/v1/traces`) in batches — zero dependencies, opt-in.

```bash
curl -s localhost:8091/metrics | head
# arcod_requests_total{method="POST",route="/v1/tasks",status="201"} 1
# arcod_capability_calls_total{capability="store.insert"} 1
```

## Migrations

`arcod migrate [dir]` turns the data model into an ordered, checksummed
changelog in `.arcod/build/migrations/`. A record type becomes a real table:
scalar fields get typed columns (`uuid` → `CHAR(36)`, `datetime` →
`DATETIME(3)`, `int` → `BIGINT`, `decimal` → `DECIMAL(30,6)`, strings →
`TEXT`, unique strings → `VARCHAR(191)`), `id` is the primary key and each
`rules { unique ... }` becomes a `UNIQUE KEY`. A field default becomes the
column's `DEFAULT` (`done: bool = false` → `DEFAULT 0`), so a row inserted
outside the generated service still gets the declared value. A `datetime`
default is an instant, so it carries a zone (`at: datetime =
"2026-01-01T02:00:00+02:00"`); MySQL's literal has none and receives the UTC
spelling (`DEFAULT '2026-01-01 00:00:00'`), and the runtime codec converts an
offset the same way instead of dropping it. The default published to the
runtime is the stored spelling too (`2026-01-01T00:00:00Z`), so a row that
predates the field reads back the same on `kv` and SQL; a default finer than a
millisecond is `A059`, because `DATETIME(3)` would cut it and every insert
relying on the default would then be refused. Inline records, unions and
`list`/`map` land in `JSON` columns.

Only entities become tables: `arcod migrate` (and the migrations the service
carries) reads `impl/` and takes the table set from the record names the bodies
pass to `io.insert`/`fetch`/`update`/`remove`/`find`, so a DTO such as
`AlertAck { ok, id }` returned by a storing operation gets no table. A scaffold
project with no bodies keeps the older rule (every record type is a table),
because nothing says which shape is stored. A string field that is a key (the
`id` column or a `unique` member) is `VARCHAR(191)`, never `TEXT` — a TEXT
primary key is MySQL error 1170 and hides every later migration.

Each migration carries a `version`, a `checksum` (sha256 of up+down) and
`up`/`down` SQL. The generated service applies them on boot (sql driver):
it records applied versions in `arcod_migrations`, a re-run is a no-op, and a
migration that was edited after being applied refuses to start the service.

The DDL is dialect-shaped: `--dialect postgres` emits double-quoted identifiers,
`TIMESTAMPTZ`, `BOOLEAN`, `CONSTRAINT ... UNIQUE` and `CREATE INDEX` instead of
`ENGINE=InnoDB` and `KEY` (see `src/dialects.ts`).

`arcod build --dialect postgres` carries that dialect into the service: the
build embeds the Postgres wire client and a `PgStore` with the full store
contract (entity CRUD/find, kv/claim/take, outbox, transactions) plus the
Postgres migration changelog, and defaults `DATABASE_URL` to
`postgres://...@postgres:5432/...`. A build speaks one dialect: a
`DATABASE_URL` of the other scheme stops startup with a named error. MySQL
remains the default output, byte for byte. See `docs/postgres-runtime.md`.

The dialect also follows the environment: a spec that binds
`store -> postgres` builds the Postgres client, a bind to `postgres`, `mysql` or
`mariadb` decides the DDL of `arcod migrate` without any flag, and
`arcod build` prints the resolved dialect.
An explicit `--dialect` that disagrees with a bind is refused
(`--dialect mysql conflicts with bind store -> postgres`, exit 2) instead of
shipping a client the database rejects; two sql binds of different dialects in
one spec are refused the same way. A spec without an sql bind keeps the old
default.

```bash
arcod migrate examples/tasks
# migrations for TaskBoard (2):
#   0001 arcod_kv   checksum 46ec9741e862
#   0002 task       checksum b2d653261189
# artifact: .arcod/build/migrations/ — changelog.json + up/down .sql
```

On the `sql` driver the runtime writes straight into these typed tables: a
record is a row, `unique` is the table's `UNIQUE KEY` (a duplicate is the
database's ER_DUP_ENTRY, surfaced as the declared `Conflict`), and `find` is
pushed into SQL (`WHERE`/`ORDER BY`/`LIMIT` with a keyset predicate). The
`kv` driver (memory/Redis) keeps the blob store and claim keys, so the same
bodies run unchanged on both.

## Checks

`arcod check` returns `1` when there are errors and `0` when the model is clean.

Errors:

- `A002` a capability is not bound in `environment`;
- `A003` a provider, host or secret is mentioned in the model;
- `A004` an effect is used but not allowed;
- `A005` a write call inside an invariant;
- `A007` a declared error is neither handled nor covered by an example;
- `A008` a budget without a metric;
- `A009` a duplicate alias;
- `A010` a cycle in `ordering`;
- `A018` `ui` references a missing operation or an operation without `route`;
- `A019` `ui` with an unsupported `kind` (v0.1: only `spa`);
- `A020` an effect is both allowed and denied;
- `A021` a denied effect is used;
- `A022` `once(..., else: E)` references an error outside the contract;
- `A023` unknown provider; `A024` provider does not implement the capability;
  `A025` one alias bound twice; `A026` a provider requires an argument the
  bind omits — all four are checked in every environment, not only the one
  `--env` selects;
- `A027` an operation names an effect whose alias is not declared in `uses`;
- `A028` unknown deployment provider; `W019` unknown provider argument;
- `A029` `needs` references an unknown step;
- `A030` a cycle in the workflow graph;
- `A031` an input port has no single producer;
- `A032` a step is declared twice;
- `A033` a workflow without a trigger or with an unknown trigger;
- `A034` a delayed trigger without a schedulable argument: `at` without one
  ISO-8601 instant carrying a zone (or with an impossible date), `after`
  without a positive duration or job name, or an unknown duration unit;
- `A036` `layout: chat` without `history`/`send` or pointing at a non-public operation;
- `A037` an external service operation has no `route`;
- `A038` `uses` or effects declared for an external service;
- `A039` an external service is bound to something other than `endpoint`;
- `A040` a module declares more than one `ui`; v0.1 emits one page per module;
- `A040` `layout: presentation` lacks `start`/`join`/`state`/`advance`;
- `A041` a presentation without slides;
- `A042` slides on a page whose `layout` is not `presentation` — the page
  would drop them, so the text never reaches the browser;
- `A066` two declarations of one name (a record or error field, an enum
  value, an operation, a parameter, a service, a type, an enum, an error, a
  workflow or an environment) — every emitter keys by name, so the second
  would silently replace the first;
- `A078` an error name nothing declares (`errors: NotFound` with no
  `error NotFound`): the emitter would turn the typo into a handler target and
  an OpenAPI error — declare the error or fix the name;
- `A074` a route path with a query string or fragment (`GET /v1/x?limit=10`):
  the router matches `url.pathname`, which carries neither, so no client can
  ever reach the operation — declare the value as a parameter;
- `A075` an OpenAPI-style capture in a route (`GET /v1/items/{id}`): arcod
  spells a capture `:id`, so the braces are a literal segment, the parameter is
  never bound and the operation answers 404 — write `:id` (`arcod adopt`
  converts an OpenAPI document for you);
- `A077` `dim` in an llm binding is not a positive integer: the width is a
  promise every reader of the vector relies on, and a fractional or string
  value cannot be enforced — write `dim: 768`;
- `A076` a `uses` alias whose capability has no effects and no adapter
  (`uses analytics: olap`): a provider can declare the capability
  (`clickhouse`), but the generated service has nothing to call, so the alias
  is dead weight and the container is provisioned for nothing — remove the
  use or install a plugin that declares its effects;
- `A073` a literal route declared after a capture route of the same shape:
  the router tries routes in declaration order and `:id` matches any segment,
  so `GET /v1/t/new` after `GET /v1/t/:id` never runs — declare the literal
  route first or move it to a segment the capture cannot match;
- `A072` the same `:name` twice in one route (`/v1/locks/:name/:name`):
  the router assigns captures in segment order, so the last segment wins and
  the earlier value is read by nobody — a two-segment key needs two names;
- `A071` a route segment `:name` that is not a parameter of the operation:
  the router captures a value nobody reads and the argument the body uses is
  never bound (a typo such as `:tid` for `id`);
- `A070` a `route` is not `"METHOD /path"` with a known HTTP method (GET,
  POST, PUT, PATCH, DELETE, HEAD, OPTIONS): a bare path used to fall through
  to `GET /` in OpenAPI and in the router, so the operation answered a URL
  nobody wrote. The method is matched case-insensitively and emitted
  uppercased, so `route: "post /v1/x"` serves `POST`;
- `A069` two operations of one service answer the same method and path: the
  generated router keeps the first and the second is unreachable, so the
  second op never runs and no other diagnostic mentions it. The path is
  compared the way the router reads it: a capture is a position, not a name
  (`/v1/t/:id` and `/v1/t/:tid` collide), and empty segments are dropped
  (`/v1/x/` is `/v1/x`);
- `A068` `bind alias -> local` for a capability the bundled runtime does not
  serve: `local` is the compiler's own runtime (ids, hash), so a storage or
  queue alias bound to it provisions nothing and the service starts without an
  address;
- `A067` one operation declares the same clause twice (`route`, `effects`,
  `retry`, `on error E`): the AST keeps both, every reader takes the first,
  and the second would do nothing at all;
- `A045` `--env` names an environment the module does not declare (the hint
  lists the declared ones, instead of reporting every binding as missing);
- `A044` an `allow`/`deny` entry that names no effect of the declared
  capability (a typo such as `store.gett`) or of another service;
- `A043` a `ui` clause the chosen layout does not read (`history`/`send` need
  `layout: chat`; `start` needs chat or presentation; `join`/`state`/`advance`
  need presentation) — the clause would be ignored, not rendered;
- `A046` `auth`/`roles`/`owner` on an operation of a service without the
  `identity` capability — a guarded operation needs an actor source;
- `A047` a `roles:` entry outside the service `roles:` vocabulary;
- `A048` a `public` operation requires an actor (`roles:`/`owner:` clause or an
  identity effect) — declare it `auth op`;
- `A049` `owner:` references a parameter the operation does not have;
- `A050` a `public` operation has no `route`;
- `A051` `on: alias.topic` on something that is not a `job`;
- `A052` a consumer source that is not a declared `queue` alias;
- `A053` `retry` without an `on:` consumer;
- `A054` `unique` does not name a field of a record type;
- `A055` `unique` without a declared `Conflict` error to return;
- `A056` `unique` without a `kv`/`sql` store to keep the claim;
- `A062` `index` does not name a field of a record type;
- `A057` a saga step's `call`/`compensate` names an unknown operation;
- `A058` a job's `saga:` names an undeclared saga;
- `A059` a field default is not a literal of the field type;
- `A060` a field default violates the constrained type (`email`, `url`, `enum`) or
  its integer `min`/`max`;
- `A061` `string(format: ...)` names an unknown format;
- `A063` an example passes a literal the parameter cannot accept (a list where
  a `string` is declared, a number where a `list<T>` is, `null` for a
  non-optional parameter);
- `A064` an `on error E` expression names a member field that `E` does not
  declare;
- `A065` an error declares a payload field that its `on error` clause never
  fills (the response would always omit it).
- `A080` an example call passes more arguments than the operation has
  parameters: `arcod test` invokes by position, so the extra ones were dropped
  without a word.
- `A082` an operation declares a singleton clause twice (`route:`, `roles:`,
  `owner:`): the router, OpenAPI, the auth guard and the generated client all
  read the first one, so the second was dead text that looked live.
- `A083` a service uses `queue` on a provider the runtime has no driver for
  (`rabbitmq`, `kafka`): the broker container starts, jobs run in process and
  messages are lost on restart. The hint names the providers that can serve it.
- `A084` a bind argument `image` is not an image reference: the compose emitter
  writes the value into the image line verbatim, and a spec string may carry a
  line break, so a malformed one rewrote the file instead of pinning it.
- `A085` two binds pin different images to one container host: compose and k8s
  key a container by its host, so the second key overwrote the first and one
  bind talked to an image that was never started.
- `A086` arguments refine a builtin name (`string(max: 80)`, `list<Item>`);
  written on a declared type they were dropped: `check` stayed silent while
  the resolver read the alias declaration and the schema lost the bound.
- `A087` a builtin type is given an argument no emitter reads (`string(mx: 80)`,
  `bool(max: 5)`, `list<A, B>`): the schema and the runtime carried no bound, so
  the model promised a limit it never enforced. A bound that is not a literal
  number (`string(max: unlimited)`) is the same code. The hint lists what the
  builtin takes.
- `A088` a type name is neither a builtin nor declared in the module: OpenAPI
  emitted `{}`, so a typo accepted any value and GraphQL had no field type. The
  hint names the declaration that would fix it.
- `A090` a lower bound is above its upper bound (`int(min: 10, max: 5)`): the
  type admits no value, so every caller gets a 400 and every default is A060
  while the schema promises the type as usable. A size unit is part of the
  bound — `bytes(min: 2kb, max: 1kb)` is 2048 against 1024 — and the message
  quotes the bound as it was written.
- `A091` a `unique` rule names a field with no index: `bytes`, `list`, `map` or
  `json` (MySQL cannot index a JSON column or an unprefixed BLOB, Postgres has
  no `json` equality), so the migration failed only when it reached the server.
- `A092` a route names `/healthz` or `/metrics`: the runtime health probe and
  the metrics scrape answer before the router, so the declared operation is
  never reached (`check` used to be silent and the build succeeded). The hint
  names a path that stays reachable.
- `A093` two `impl/*.mjs` bodies declare the same top-level name
  (`function subjectHash` in `impl/create.mjs` and `impl/seed.mjs`): the bodies
  are concatenated into one module, so the duplicate was a load-time
  `SyntaxError` that only `build` reported. The diagnostic names both files.
- `A096` an `impl/*.mjs` body does not match the call the emitter makes.
  Every operation body is bundled as `async function impl<Op>(input, io)` and
  called with `(input, io)`, so a body written as `function totals(io)` builds
  clean and then answers 500 `io.aggregate is not a function` — the single
  parameter was the input. The same diagnostic names an export whose name
  differs from the file (the handler would call an undefined function) and a
  second parameter that is not named `io` while the body reads `io.*`. The same
  diagnostic names a file with nothing to rename: a body that only declares a
  helper, an operation exported as a `const` arrow, a function without
  `export`, or an `export default` builds clean and leaves every request calling
  an undefined `impl<Op>`; each case is named as itself, so a default export is
  not reported as a missing function.
- `A095` a `list` or `map` parameter sits on a route without a body
  (`GET`/`HEAD`/`DELETE`): a query string carries one value per name, so the
  service handed the body a string (`?tag=a&tag=b` arrived as `"a"`) while the
  contract promised a list, and an alias of a list was accepted the same way.
  The hint asks for a `POST` body or a scalar.
- `A097` an operation declares a success `status` that is not a body-carrying
  2xx: a 4xx/5xx would turn a successful call into an error, and 204/205 has no
  body while every handler of this runtime builds one. The same code names a
  `status` on a job: a job is consumed from a queue, never requested. The hint
  asks for a 2xx on an operation.
- `A098` the module header declares a language version this compiler does not
  know (`@9.9.9`): the spec may use rules the emitters do not implement, so the
  file was reported clean and then built with 0.1.0 semantics, while `arcod
  upgrade` called the same file "unknown language version". The hint names the
  versions this compiler knows. A header without `@version` is untouched.
- `A099` a bound carries a time unit (`bytes(max: 5s)`, `string(min: 2h)`): a
  bound is a count or a size, so the number was read and the unit dropped —
  `check` stayed clean, OpenAPI published five bytes and the runtime enforced
  five bytes; a unit that is not a size (`bytes(max: 5q)`) lost the same way.
  The hint asks for a size (`bytes(max: 64kb)`) or a plain count.
- `A100` an `enum` declares no values. That is not a narrow type but one that
  admits nothing: OpenAPI published `"enum": []`, which JSON Schema forbids
  (the keyword needs at least one element), and the boundary rejected every
  value with an empty "must be one of " list — neither answer named the
  declaration. The hint asks for a value or a plain `string`.
- `A101` a chain of aliases never reaches a shape (`type A = B` with
  `type B = A`, or `type A = A`). OpenAPI published `A: {"$ref": "B"}` and
  `B: {"$ref": "A"}`, a model no tool can dereference, and an operation
  returning A had nothing the service could build. The hint names the chain
  and asks for a record, a builtin or an enum; a cycle through a record is a
  recursive shape and stays legal.
- `A102` a declared name is `__proto__` (a type, an enum, an error, a service,
  an operation, a parameter, a field or a ui). Every generated metadata map is
  an object literal keyed by name, and this key sets the prototype instead of a
  property: a field of this name was stored and migrated but silently missing
  from OpenAPI (`properties` and `required`), and a *type* of this name crashed
  `arcod build` with `uniques.some is not a function` after `check` had called
  the file clean. The hint suggests `proto` or `metadata`; `constructor` and
  `toString` are ordinary keys and stay legal.
- `A103` `language:` names a language the compiler cannot generate
  (`language: rust`): the value chooses the emitter, so a typo must refuse
  rather than silently generate the Node service the author did not ask for.
  The hint lists `node`, `go` and `python`.
- `A104` `language:` sits on an `external` service: an external declaration
  describes someone else's API and is never generated, so there is no emitter
  to choose. The hint asks to drop the clause or move it to a service the
  build owns.
- `A105` a Go or Python service has an `.mjs` body: the build bundles `*.mjs`,
  so the container would run Node code under a Go label. The error names the
  service and the file; the hint asks for `impl/<op>.go` or `.py`.
- `A106` a flat `impl/*.mjs` sits in a module whose services mix languages: a
  flat file cannot say which service it belongs to, so one code per body asks
  for `impl/<service>/<op>.<ext>`.
- `A107` one operation has two bodies (`impl/totals.mjs` and
  `impl/api/totals.mjs`): bodies are keyed by operation name, so one of the two
  would never run. The error names the operation and both files, and the build
  refuses the pair before emitting anything.
- `A094` a `kv` alias is bound to `redis` in a service that stores in sql:
  the runtime has one store, so the alias lives in the sql store's `arcod_kv`
  table. The bind started a container and exported `REDIS_URL` that no
  emitted line read — the cache stayed empty while the table filled.
- `A089` a type or enum is declared with a builtin name (`type int = string`):
  OpenAPI listed the declaration under components while every use site resolved
  the builtin, so one module stated two contracts at once and the runtime, the
  migration and GraphQL each picked a side. The hint suggests the rename.
- `A081` an example calls a name that is not an operation of the service (and
  is not the `uuid(...)` builtin), or a rule (`once(...)`, `atomic name`) names
  an operation the contract does not declare. `arcod test` used to resolve the
  name after the service started and report "unknown function" or "operation
  not found" in the report instead of on the line with the typo.

Warnings:

- `W011` a capability is declared but never used;
- `W012` an operation without examples;
- `W013` no budget — only with `--strict`, budgets are optional by default;
- `W015` an error is declared but never used;
- `W016` `deny` for a whole capability (e.g. `deny store`) is not enforced in
  v0.1; native denies (`net`, `fs`, `exec`) are enforced — bodies are validated
  to have no imports, no raw network and no environment access;
- `W017` `job` is not executed in v0.1 (unless it declares an `on:` queue consumer);
- `W018` operation bodies are not in the spec: they come from `arcod impl`,
  `--reference` or a TODO in the scaffold;
- `W020` `onFail: skip` on a step others depend on;
- `W022` a workflow is described but not executed in v0.1;
- `W023` a step's `call` is not declared in the module;
- `W024` a step without `call`: its body would have to be generated;
- `W026` an external service is called but no address is configured;
- `W028` a presentation without `stream`: the page will poll state;
- `W029` a plugin provider ships a runtime adapter but its capability declares no signatures (the service cannot dispatch it).
- `W030` `ui { render: ssr }` has no first-screen data: no public `GET` operation without a path parameter can be rendered into the page.
- `W032` a bind declares `guarantees [...]`: the clause is kept in the spec and
  printed by `fmt`, but nothing checks or enforces it — it reads like a
  durability contract, so the checker says what it is.
- `W033` a `uses` declares a parameter nothing reads (`consistency: strong`):
  only `ttl` on `kv`/`sql` is executed; every other name stays a note for the
  reader, so the checker says so instead of letting it read as a guarantee.
- `W034` a bind or deploy argument is not a literal
  (`bind store -> redis(host: host)`, `deploy yandex(region: zone)`): emitters
  read `host`, `port`, `expose` and provider options from literals only, so
  the expression would silently fall back to a default or to the string
  `'<expr>'`.
- `W035` a bind passes an argument its provider does not read
  (`bind store -> redis(host: "kv", bogus: 1)`): every provider declares a
  fixed option set, so the argument was accepted and dropped. The hint lists
  the known ones; `host`, `port`, `expose` and `import` belong to every
  binding. A plugin provider without an `args` map is exempt, because there is
  nothing to compare against.
- `W036` a body names an entity no record type declares
  (`io.insert('Workflow', row)` with only `WorkflowRec` declared): the runtime
  would answer `500 Internal` on the first request and write nothing. `check`
  reads `impl/` (the only place a body names an entity) and reports the literal,
  the body file and every declared record type. A block with `check --json`
  carries the same message.
- `W038` `io.find` uses a `where` operator outside `eq`, `ne`, `in`, `contains`,
  `gt`, `gte`, `lt`, `lte`: the store used to drop the condition and return
  every row. The runtime answers `400 Invalid` with the operator name; `check`
  reads the literal in `impl/` and warns before the request.
- `W040` an `invariant` whose predicate `arcod test` cannot run: a typo
  (`oncee(read, ...)`) or a predicate v0.1 does not execute. `arcod test` now
  prints the rule as `skip` and counts it apart instead of dropping it from the
  report, so a green run never hides an invariant that was only a comment.
- `W047` a service declares a role no operation names. The vocabulary is
  enforced (`A047` rejects a role the service never declared), so an unused
  entry reads like an access rule that works: drop it, or name it in an
  operation's `roles:` clause.
- `W050` an operation has no body in `impl/` while other bodies exist: its
  route answers `501 NotImplemented`, which looks like a server bug from the
  client's side. An external service describes someone else's API and a saga job
  is orchestrated by its steps, so neither is reported. A file that exists but
  declares no function is not "missing": `A096` names it with the line.
- `W051` a file in `impl/` is not a `.mjs` body: the build reads only
  `impl/<op>.mjs`, so `impl/totals.js` was never bundled and its operation
  looked bodiless. A warning that names the file and the extension the build
  reads. The same code names a `subdirectory` of `impl/` that holds `.mjs`
  files: bodies are read one level deep, so `impl/ops/totals.mjs` is dead
  weight — shared code belongs in the file `impl/lib.mjs`, not a `lib/`
  directory — and with no top-level body `W050` stays quiet. An empty
  directory is not reported. A folder named after a service is a body folder
  instead (`impl/api/totals.mjs`), so it is read and not warned about; a
  non-`.mjs` file inside it is named with that folder (`impl/api/totals.js`)
  and the hint asks to rename it there.
- `W052` a service has no body at all: no `impl/` directory, or one with no
  `.mjs` body, means every route answers `501 NotImplemented` and `W050` had
  no operation to name. One warning per service names it, so "forgot the
  bodies" and "has not started" stop looking the same. A project with some
  bodies keeps the per-operation `W050`.
- `W049` an `impl/*.mjs` body is named after no operation: only the bodies the
  service contract declares are bundled, so `impl/total.mjs` (a typo of
  `totals`) was loaded and then dropped — `totals` answered `501
  NotImplemented` while its body looked present. A warning that names the file
  and lists the operations the contract declares.
- `W048` an operation names an effect that can be refused on the far side — a
  model endpoint (`llm.chat`, `llm.embed`) or a foreign service
  (`Ledger.record`) — and declares no error covering the refusal. An undeclared throw becomes the
  generic `500 {"error":"Internal"}`: the far side's status and message never
  reach the client, and the contract never said the call could fail. Add
  `Unavailable` (or `RateLimited`/`Forbidden`) to `errors:` with an
  `on error` handler, or catch the failure in the body. A warning: a body may
  answer a result instead.
- `W046` a cloud environment binds a stateful provider the plan cannot
  provision (`mysql`, `mariadb` have no yandex resource): the plan would look
  complete and create nothing for that bind. Bind `postgres` for a managed
  database, or keep `mysql` for docker and point the cloud environment at an
  external host. The plan names it under "No managed equivalent rendered for".
- `W045` two binds in one cloud environment name the same managed provider:
  the plan renders one cluster (the cloud assigns one endpoint), so the second
  binding would have shared a service it never got. Name the collision or give
  the second bind its own environment.
- `W044` a bind passes `host`, `port` or `expose` to a managed cloud service:
  `arcod terraform` provisions the `postgres`/`redis` cluster and the cloud
  assigns its address, so a binding copied from the docker environment would
  deploy a service pointed at the compose host name. The plan exports
  `db_host`/`db_port` (`kv_host`/`kv_port` for redis) and names the
  arguments it ignored in a comment.
- `W042` `once(...)` or `atomic <op>` names an operation with no `uuid`
  parameter: the generated body keys `takeIf`/`seen` by that parameter, so the
  rule degrades to nothing and the guarantee is only text.
- `W041` an example call omits a required argument: `arcod test` sends it as
  `undefined`, so a deliberate "missing field" case and a typo look the same in
  the report. A trailing parameter with a default or an optional type may be
  omitted silently.
- `W039` an `on error X` handler on an operation whose `errors:` does not
  list `X`: only the list reaches OpenAPI and the status map, so the fields
  filled by the handler are never shown to a client — list the error or drop
  the handler.
- `W037` an `io.insert` names a record type without an `id` field: the store
  keys every record by `id`, so each insert is a `400 Invalid` whose message now
  names the entity (`insert Room: missing id`). Add `id: string` (or a uuid) to
  the record, or give the insert a natural key.

### Examples are tests

`examples` in the model are not documentation but executable scenarios:
`arcod test` boots the service and runs them. Bodies come from `impl/` when it
has any (`--impl` forces that); an empty `impl/` falls back to the built-in
reference bodies, which cover only `create`/`read`. For any other operation
`arcod test` says the bodies are missing (and how to generate them) rather than
building a service that cannot answer. A statement becomes a real request: a
`:path` capture fills the path, `GET`, `HEAD` and `DELETE` put the rest in the
query string, every other method sends a JSON body. A `HEAD` answer has no body,
so the statement evaluates to `null`. `page.hits[0].title` reads a list
element; a negative or out-of-range index fails the example with a path
(`index 99 out of range (len 3) in page.hits`).

`--url <base>` runs the same examples against a service that is already running —
a hand-written or non-Node one. Nothing is built or spawned, `.arcod/build` is
not touched, and `/healthz` is probed once so an unreachable address is
`cannot reach <base>` with exit 2. It cannot be combined with `--impl` or
`--reference`, and a module that declares examples for several services needs
`--service <name>`; `--json` adds `target: "url"` and the address
(`target: "build"` otherwise).

`arcod test` supplies every backend as a memory driver: records, blobs, identity,
the queue and the model. `LLM_DRIVER=memory` answers a chat with a deterministic
`memory: <prompt>` reply and an embedding that is a stable pseudo-random vector
of the declared `dim`, so a service that declares `llm.chat` or `model.embed`
runs on a machine with no model at all - it proves the wiring, not a similarity
model. A `dim` declared by the bind becomes `LLM_EMBED_DIM` in the test process
(the same variable `arcod run` sets), so a model that returns another width
fails the example instead of storing a vector that cannot be compared.

```arcod
service OneTimeMessage : http {
  // ...
  examples {
    example create_and_read {
      when { let id = create("hi") }
      then {
        read(id) == "hi"
        read(id) is Gone
      }
    }

    example rejects_empty {
      when { let e = create("") }
      then { e is Invalid }
    }
  }
}
```

`given` (state setup) and `when` call operations and bind results with `let`;
`then` asserts a comparison, `is <Error>`, `&&`, `||`, `!`. Arguments are the
literals the contract knows — strings, numbers, `true`/`false`, `null` and list
literals such as `["ann", "bob"]` for a `list<string>` parameter. `given` runs before
`when` and shares its bindings, so a seeded value can be read in `when`/`then`.
An operation without an example is `W012`; a declared error that is neither
handled nor covered by an example is `A007`.

## Editors and LSP

The `*.arc` extension lives in `editors/vscode`, and `arcod lsp` is a
standard Language Server Protocol server over stdio — built from the same
lexer/parser/check as the compiler, so the editor sees exactly what
`arcod check` sees. Opening or editing a document republishes diagnostics,
closing it forgets the buffer, and a message the server cannot serve is
answered with a JSON-RPC error rather than silence — a client that waits
forever looks like a hung editor. A method the server does not implement is
`-32601` with the method name in the message (it used to be `result: null`,
which a client reads as an empty answer), a body that is valid JSON but not a
request is `-32600`, and a body that is not JSON is `-32700`; the server keeps
serving after all three. `shutdown` is a promise: afterwards only `exit` is
served (anything else is `-32600`), and the process exits 0 only when
`shutdown` came first, 1 when a client tears it down without one.

VS Code (`editors/vscode`):

- TextMate highlighting: declarations, operations, clauses, effects, types and
  durations; providers and capabilities are coloured differently.
- Live diagnostics while you type, plus a status-bar counter.
- Completion: keywords, types, services, operations, errors, enums and `uses`
  aliases. Dead v0.1 keywords are never offered.
- Outline (a page nested by its slides, an environment by its binds),
  go-to-definition, find-references, hover and formatting (`arcod fmt`).

```bash
cd editors/vscode && npm install && npm run package
code --install-extension arcod-0.1.0.vsix --no-dependencies
```

Neovim (lspconfig) and any other LSP client:

```lua
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'arcod',
  callback = function()
    vim.lsp.start({ name = 'arcod', cmd = { 'arcod', 'lsp' } })
  end,
})
```

JetBrains: point an LSP client (e.g. the LSP API plugin) at the command
`arcod lsp` for `*.arc` files.

Extension tests: `node --test test/*.test.mjs` (grammar via vscode-textmate and
the LSP client against the real server) and `node test/runTest.cjs` — starts a
real VS Code extension host.

## Structure

```
src/
  lexer.ts        tokens and positions
  parser.ts       hand-written recursive descent + Pratt for expressions
  ast.ts          canonical AST
  check.ts        static checks
  capabilities.ts effect signatures: what a capability can offer
  providers.ts    provider registry, ports and env variables
  plan.ts         task DAG
  plan-body.ts    what an operation body needs: steps and effects
  prompts.ts      deterministic prompts and token budget
  impl.ts         body generation with a local model
  pipeline.ts     the `arcod make` pipeline
  test.ts         runs `examples` against the generated service
  build.ts        builds into `.arcod/build`
  deploy.ts       deployment providers and manifest
  templates.ts    built-in reference bodies
  cli.ts          commands and flags
  lsp.ts          language features (completion, symbols, navigation, fmt)
  lsp-server.ts   zero-dependency LSP server over stdio
  emit/contract.ts       routes, input kinds and outcomes every emitter shares
  emit/service.ts        service, adapters and `io`
  emit/sql-store.ts      MySQL client
  emit/identity.ts       Keycloak/JWKS
  emit/blob.ts           S3
  emit/llm.ts            OpenAI-compatible chat
  emit/stream.ts         websocket server (RFC 6455) and redis pub/sub
  emit/queue.ts          queue drivers (memory, redis) and consumers
  emit/openapi.ts        OpenAPI 3.1 from the same model
  emit/graphql.ts        GraphQL SDL from the same model
  emit/grpc.ts           proto3 from the same model
  emit/web.ts            frontend: forms
  emit/chat-page.ts      `layout: chat`
  emit/presentation-page.ts `layout: presentation`
  emit/qr-code.ts        vendored QR encoder
  emit/compose.ts        Dockerfile, compose and nginx
editors/vscode/ VS Code extension: grammar, completions, checks
examples/
  onetimemessage/      a one-time message
  onetimemessage-pwd/  the same, optional password
  project1/            message with an author, kv storage
  project1-mysql/      the same model on sql
  files/               sign-in, rights, S3 objects
  chat/                dialogue with a model, `layout: chat`
  payments/            somebody else's service: contract and address
  notes-ssr/           render: ssr — the page arrives with its first screen
  quiz/                a presentation and an event stream
  tasks/               a record store: unique, filter, keyset pages (kv)
  tasks-sql/           the same bodies on sql
  orders/              sql + queue: an atomic publish+fact via the outbox
  saga/                a saga: multi-step with compensation, run by the runtime
  nightly/             a workflow: typed ports, explicit `needs`, a cron trigger
test/             node --test
```

Running the tests:

```bash
npm test
```

`npm run coverage` runs the same suite under `--experimental-test-coverage` and
prints line, branch and function percentages for `src/` — the TypeScript sources,
with the uncovered line ranges — so a gap is visible without a second tool.

The test matrix is split into thematic suites: `arcod.test.ts` (parser, checker,
planner, core emitter), `emit-openapi` / `emit-authz` / `emit-async` (emitters),
`impl.test.ts` (bodies and the sandbox), `tooling.test.ts` (fmt/diff/adopt/
versions), `lsp.test.ts` (language server), and the integration suites —
`authz.test.ts` (401/403), `contract.test.ts` (external services against a mock),
`soak.test.ts` (concurrency + latency) and `property.test.ts` (input fuzzing —
no input may cause a 500). Method behaviour has its own small suites:
`remote-methods` and `remote-capture` (what a remote call does with each method
and parameter), `head-example` (a HEAD operation reached from an example) and
`head-ui` (the SPA operation table). `test/harness.ts` builds a spec and runs the
generated service on a free port for the integration suites.

## v0.1 limitations

This is a vertical slice, not a finished language.

- **Scaffold without bodies** (`arcod build` without `--impl`) knows only
  `create` and `read`: there are no built-in templates for other operations.
  With `--impl` the emitter accepts any operations and any of the nine
  capabilities.
- `kv` in a real environment is Redis; the in-memory driver exists only for
  `arcod test`.
- A UTF-8 BOM at the start of a spec is ignored (a Windows editor adds one),
  and the canonical form never carries it: a file saved with a BOM is clean to
  `check` and "not formatted" to `fmt --check` until `--write` drops it. A CRLF
  file is the same document to `check` and to the language server — every
  diagnostic keeps its line — and `fmt` writes LF, so a Windows-saved file is
  "not formatted" once, until `--write`.
- `arcod fmt` is canonical and idempotent, but it re-lays out record types on one
  line. Empty braces are always tight (`type T = {}`, `enum C {}`, `let r = {}`),
  never `{  }`. Comments above declarations, fields, enum values, example statements,
  service `uses` lines, `allow`/`deny` lines, `budget` items and workflow step
  clauses survive, a comment inside a `saga` step turns that step from one line
  into a block, a comment on one effect name lists the effects one per line,
  a comment written inside the module header braces stays inside the
  block (printed after `meta` when one is declared), a comment inside
  `meta { ... }` stays with the entry it precedes (or at the end of the block),
  a comment inside a `workflow` or `ui` block stays on the clause it precedes
  (or at the end of that block, also when the clause itself is a dropped default
  such as `theme: auto`), the same holds for the last clause of a service or
  operation body, of the `contract`/`rules`/`effects`/`examples`/`budget`
  blocks (an empty `contract`/`rules`/`examples` block is dropped by fmt, but a
  block that carries a comment inside it, or trailing its opening or closing
  brace, is kept so the note is not lost), of a
  service `meta` block (an empty one is dropped unless it carries a comment), of an `example` body and of an
  `environment` block and a `given`/`when`/`then` section of an example, a
  comment written inside a `slide` stays in that
  slide (above its `body`, or after it before the closing brace), a comment
  after the last declaration is printed at the end of the file, a comment that trails
  code on the same line stays there (it is re-attached to the deepest node that
  starts on that line), and a comment after a closing brace stays on that brace:
  a service, an operation, a type or enum, a saga, an example and the
  `effects`/`rules`/`contract`/`examples`/`budget` blocks inside a service all
  keep `}  // note`, and a one-line record or enum keeps its shape instead of
  expanding. A comment written inside a record, error or enum body after its
  last field stays in that body, before the closing brace (it used to slide to
  the next declaration or the end of the file), and a multi-line block comment
  keeps its relative indentation, so a second `fmt` pass changes nothing: a
  whitespace-only line inside it is printed empty, and a block comment that
  trails code is collapsed to one line on that code's line.
  `arcod diff`
  compares canonicalized specs; `arcod adopt` imports OpenAPI 3.x JSON only; a Swagger 2.0 document is refused with its version instead of being adopted without its `basePath` and `definitions`. A property with `format: binary` (a file payload) or `format: byte` (the base64 form of one) becomes `bytes`, keeping its `minLength`/`maxLength` as the length arguments, because adopting it as `string` dropped the fact that the field is not text.
- of the rule predicates `arcod test` supports only `once`; any other
  predicate is reported as `skip` and counted apart in the summary (`W040`),
  never silently dropped.
- `unique` is checked and enforced (`A054`–`A056`, a duplicate returns the
  declared `Conflict`) for one field or a tuple on the same record. `ordering`
  is checked for cycles only and stays declarative.
- Generation targets JavaScript/Node only. PHP, Go and Python would be separate
  emitters.
- `change`, `policy`, `hint`, `impl`, `lifecycle` and `unknown` blocks, and
  the `idempotent`, `since`, `schedule` and `set` clauses, are rejected by the
  parser (`set` used to be parsed and dropped, so a change looked declared):
  they are not supported in v0.1 — a model must say what it means, not leave
  placeholders.
- `pre:` and `post:` are contract statements, not runtime guards: they reach
  the generated prompt and the examples, and `check` validates their shape and
  effects, but the generated service does not evaluate them. A body must enforce
  them itself (as the reference handlers do for `post: result != null`).
- a `job` without an `on:` consumer is still parsed but not executed
  (`W017`): there is no state model or selection condition yet. Queue-backed
  consumers do run, with retry and dead letters.
- **`find` on `kv` is a scan with a filter**, not a query planner: the adapter
  reads one entity namespace and matches in memory, which is fine for thousands
  of rows and wrong for millions. On `sql` the same `find` is pushed into
  `WHERE`/`ORDER BY`/`LIMIT`; `rules { index Task.dueAt }` becomes a `KEY` in
  the generated DDL (single-column indexes only).
- **A unique claim outlives the record**: the claim key has no TTL of its own,
  so a record that expires still holds its value until `io.remove`/`io.update`
  releases it. Update and delete keep the index in step; TTL cleanup is not
  there yet.
- **There are no operation bodies in the spec** (`W018`): `build` gives a
  scaffold with TODO, `--impl` takes bodies from `impl/`, `--reference`
  substitutes a built-in demo template.

## Versioning and releases

Two things carry a version:

- **The CLI** (`arcod --version`, `package.json`). Semantic versioning; while
the project is 0.x, a minor bump may break the command surface.
- **The language** (the module's `@x.y.z`). A language-version bump is a
migration: `arcod upgrade` rewrites a spec across versions through the registry
in `src/versions.ts`. Today only `0.1.0` exists, so the migration engine is
identity plus rejection of unknown or downgrade targets.

Publishing: `npm pack` ships `bin` + `src` + README + LICENSE (TypeScript source,
Node >= 24 runs it natively). Pushing a `v*` tag runs `.github/workflows/release.yml`
— tests, `npm publish` (secret `NPM_TOKEN`), and a GitHub release.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

The code you generate from your own `.arc` specs belongs to you: the license
covers the compiler and its runtime, not the output. The Arcod name and logo
are not covered by the license (Apache-2.0, section 6).
