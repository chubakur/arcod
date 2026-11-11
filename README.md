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

Russian version: [README_rus.md](README_rus.md).

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

```bash
arcod run --down   # stop
node ../../bin/arcod.mjs run   # without npm link
```

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

Records `{ ... }`, `list<T>`, `bytes`, `uuid`, unions, optional via `?` and
parameter defaults (`limit: number = 20`). Durations (`999s`, `24h`) are values
in clauses (`ttl: 999s`, `timeout: 30s`), not a type.

## Commands

| Command | What it does |
|---|---|
| `arcod check [dir]` | parse, check types, bindings, effects and rules; `--json`; `--strict` turns on W013 (missing budget); `--env <name>` checks one environment |
| `arcod ast [dir]` | print the canonical AST; `--check` also runs the checks |
| `arcod plan [dir]` | deterministic task DAG: files, dependencies, acceptance criteria |
| `arcod build [dir]` | scaffold: routes, adapters, tests, infrastructure in `.arcod/build`; bodies are TODO |
| `arcod build --impl` | bodies from `impl/*.mjs`, the `io` adapter, nothing invented |
| `arcod build --reference` | the same plus built-in demo bodies for `create`/`read` |
| `arcod test [dir]` | boots the generated service and runs the model's `examples` |
| `arcod make [dir]` | the whole cycle in one command: check → prompts → bodies → build → test |
| `arcod run [dir]` | build + `docker compose up --build` |
| `arcod run --down` | stop the environment (`down --remove-orphans`) |
| `arcod providers` | capability and provider table with ports; `--json` |
| `arcod deploy [dir]` | deployment target and `deploy.<env>.json` manifest; `--env`, `--json` |
| `arcod prompts [dir]` | prompts only: `--max-tokens`, `--full` (no budget cut), `--json` |
| `arcod impl [dir]` | generate operation bodies with a local model: `--model`, `--endpoint`, `--dry-run`, `--no-cache`, `--allow-remote` |
| `arcod fmt [dir]` | v0.1 stub: prints that there is no formatter |

Flags: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`,
`--remove-orphans`. For `make`: `--force` (regenerate bodies), `--skip-impl`,
`--no-test`, `--model`, `--endpoint`, `--reference`, `--port`. `ast` takes
`--check`, `test` takes `--impl`, `run` takes `--impl` or `--scaffold`, `check`
takes `--strict`.

```bash
arcod make .            # first build from scratch
arcod make . --force    # regenerate bodies
arcod make . --skip-impl --no-test   # check + prompts + build only
```

Each step is the same function as the standalone command, so the pipeline cannot
drift from the CLI. It stops at the first failure and says where.

## Providers

The model names a capability (`kv`, `sql`, `blob`…), the environment names a
provider (`redis`, `postgres`, `s3`…). The compiler knows which provider
implements which capability and enforces it (`A023` unknown, `A024`
incompatible, `A025` double bind).

```arcod
environment dev {
  bind db     -> postgres(host: "db", expose: true)
  bind files  -> s3(host: "s3")
  bind stream -> websocket()
}
```

```bash
arcod providers            # capability and provider table
arcod deploy . --env prod  # deployment target and manifest
```

**Capabilities with an adapter** (an operation body can call them): `kv`
(redis), `sql` (postgres, mysql, mariadb), `blob` (s3), `identity` (keycloak),
`llm` (ollama, openai), `stream` (websocket), and `ids`/`hash`, which bind to
`local` — a provider that provisions nothing.

**Infrastructure only** — the provider is provisioned in compose, but the
capability has no effect signatures yet and no adapter reaches the service:
`queue` (rabbitmq, kafka), `document` (mongodb), `proxy` (nginx),
`migrations` (liquibase), `olap` (clickhouse), `metrics` (prometheus),
`errors` (sentry), `tracing` (jaeger), `dashboards` (grafana), `mail`
(mailpit), `secrets` (vault). `endpoint` and `websocket` create no container
at all: the first is an address of somebody else's service, the second is a
server inside the service itself.

Every binding that needs a container becomes a compose service with a
healthcheck, a volume and env; ports are published only with `expose: true`.

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
(`A003`). Full example: `examples/chat` — dialogue history, model answers and a
page with `layout: chat`.

```bash
arcod build examples/chat --impl && arcod run examples/chat
```

The local model must be reachable from containers. On macOS Docker Desktop,
`host.docker.internal` reaches Ollama listening on `127.0.0.1:11434` without
setup. On Linux a container cannot reach the host loopback: start Ollama on
`0.0.0.0` (`OLLAMA_HOST=0.0.0.0 ollama serve`) or bind another host.

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
```

The emitter takes the method and path from the contract, the base URL from the
environment (`LEDGER_URL`), so the body never knows an address. In compose,
`localhost` is rewritten to `host.docker.internal`; `network: "shared"`
attaches the container to an existing network (`external: true`), and
`gateway: true` adds `host-gateway` for Linux. An external service never
appears in the manifest's `services` and gets no scheduler tasks.

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

`docker` produces a local `docker-compose.yml`; `aws`, `yandex` and
`kubernetes` produce a declarative `deploy.<env>.json` manifest
(`"executed": false`: no credentials, no API calls). Unknown provider is
`A028`, unknown argument is `W019`. Compose is built from the local
environment; prod bindings never leak into it.

```bash
arcod deploy . --env prod          # target and artifact
arcod deploy . --env prod --json   # the manifest
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
- triggers: `cron(...)`, `event(...)`, `manual`, `after Other`.

The graph is declarative: it lands in `deploy.<env>.json`, but no runner is
generated yet — a workflow is described, not executed (`W022`).

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

Effects are declared explicitly: `effects: store.get, auth.actor, files.get`.
The planner derives the procedure from effects and type shapes, not from
operation names; without a declaration, effects are inferred from shape (uuid →
read, bytes → object, list → list).

The visibility policy lives in one place — `canRead` in the operation bodies:

| Who | public | authenticated | restricted |
|---|---|---|---|
| anonymous | yes | no | no |
| authenticated | yes | yes | only if listed |
| administrator | yes | yes | yes |

The UI page is derived from the contract as well: a form per public operation,
fields from parameters, the result from the response shape.

### A presentation with widgets

`layout: presentation` is one page for two audiences: the host opens it on a
screen, participants join from their phones by a code or a QR. Slides and
widgets are declared in the model, so the page never guesses what to show.

```arcod
ui Stage {
  kind:    spa
  route:   "/"
  layout:  presentation
  start:   Live.start
  join:    Live.join
  state:   Live.state
  advance: Live.advance
  vote:    Live.vote
  rate:    Live.rate
  comment: Live.comment
  uses     Live.start, Live.join, Live.state, Live.advance, Live.vote, Live.rate, Live.comment

  slide "Who are you?" {
    body: "Pick a role — the result appears on the screen."
    poll("Backend", "Frontend", "QA", "Product")
  }
  slide "Join" { qr }
  slide "How useful was it?" { rating(max: 5) }
  slide "Questions" { comments }
}
```

Rules:

- `start`, `join`, `state`, `advance` are mandatory (`A040`): the host creates
  a session, a guest joins by code, both poll state, the host moves the deck;
- widgets are never rendered "just in case": `poll` requires `vote`, `rating`
  requires `rate`, `comments` requires `comment` (`A045`), otherwise the
  controls would have nowhere to send answers;
- `qr` is drawn on the client from the link to the current session; the code is
  generated by the service, so the QR always points at a live room; the encoder
  is vendored into the page (MIT, no CDN), so the presentation works offline;
- `A041`–`A044` catch an empty deck, a slide without a widget, a one-option
  `poll` and a scale outside 2..10; `W027` — nobody can join.

Live example: `examples/quiz`. The host gets a code and a QR, the guest answers a
poll, rates and comments; the host sees percentages and the feed on their screen.
Updates arrive over websocket: the service publishes an event after every
mutation, the page reads `state`. Idle traffic is zero; if the socket cannot be
opened, the page falls back to polling every 3 s.

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

Limitations: the channel is one-way (server → client); commands stay on HTTP
where there are statuses and limits. The hub lives in process memory, so several
service replicas do not share subscribers — that needs a pub/sub provider, and
there is none yet.

### One model, different providers

`kv` and `sql` are the same record by id over different providers. Operation
bodies do not change:

```arcod
uses store: kv(ttl: 999s)     // redis
uses store: sql(ttl: 999s)    // mysql, postgres
```

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

A prompt is a function signature, not a service description:

```text
create(input, io)
in: { body: string /* 1..65536 bytes */, password: string | null /* 1..128 chars */ }
out: { result: string } | { error: "Invalid" }
io: new() -> id; hash(password); set(id, value)
value: {b: string, h: string|null}; h = password hash or null
```

66 tokens for `create`, 109 for `read`. No routes, no other operations, no
infrastructure: everything constant ("one file, no imports, no HTTP") lives in
the system prompt, so the per-operation payload stays small.

```bash
ollama pull qwen2.5-coder:7b
```

There are no cloud providers by default: the endpoint is local, a non-local
address is rejected without `--allow-remote`. No tokens are spent.

The compiler derives the procedure for a body (`src/plan-body.ts`) from the
model: a `uuid` parameter gives `load`, `ids.new`+`kv.set` give `new` and
`save`, `once` and `atomic` give `takeIf`, and `on error E: store.has(id)`
means "the check does not consume the record" and puts `verify` before
consumption. Operation names are not used. If a step cannot be derived, prompt
generation fails with `unresolved` instead of guessing.

Bodies are wired in with `arcod build --impl`: the compiler inlines them into the
service, builds the `io` adapter (records `{b, h}`, compare-and-delete through
`takeIf`, scrypt) and keeps routes, statuses and limits to itself.

`arcod impl` writes bodies into `impl/` next to the spec (that is what
`--impl` reads). Bodies are cached by prompt hash, so a rerun only asks the model
for what changed. In `examples/*/impl/` the bodies were generated by
qwen2.5-coder:7b and verified by tests, so the demo reproduces without Ollama.

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
  chat for `llm`, a websocket hub for `stream`;
- `.arcod/build/web/` — a static frontend and nginx proxying the roots of
  declared routes (`/api`, `/v1`) and `/ws` when `stream` is used (only when a
  `ui` block is declared);
- `.arcod/build/docker-compose.yml` — providers + service + frontend;
- `.arcod/build/prompts/` — one prompt per operation and a `manifest.json` with
  the model hash and token budget;
- `.arcod/build/deploy.<env>.json` — a manifest per environment with `deploy`.

`budget { concurrency: N }` produces an in-flight limiter: above the limit — `503`.

`atomic read { get; del }` switches the read to an atomic Lua script; without
the rule, separate `GET` and `DEL` are generated. `once(read, by: id, else: Gone)`
sets the second-read error — the emitter takes it from the model, not a constant.

Rules become behaviour: `atomic read { get; del }` becomes a Lua script with a
get and a delete, `once(read, by: id)` becomes a tombstone key that yields
`Gone` on a repeated read.

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
  `A025` one alias bound twice;
- `A027` an operation names an effect whose alias is not declared in `uses`;
- `A028` unknown deployment provider; `W019` unknown provider argument;
- `A029` `needs` references an unknown step;
- `A030` a cycle in the workflow graph;
- `A031` an input port has no single producer;
- `A032` a step is declared twice;
- `A033` a workflow without a trigger or with an unknown trigger;
- `A036` `layout: chat` without `history`/`send` or pointing at a non-public operation;
- `A037` an external service operation has no `route`;
- `A038` `uses` or effects declared for an external service;
- `A039` an external service is bound to something other than `endpoint`;
- `A040` `layout: presentation` lacks `start`/`join`/`state`/`advance`;
- `A041` a presentation without slides;
- `A042` a slide without a widget;
- `A043` a `poll` with fewer than two options;
- `A044` `rating(max: n)` outside 2..10;
- `A045` a widget without its operation (poll → vote, rating → rate, comments → comment).

Warnings:

- `W011` a capability is declared but never used;
- `W012` an operation without examples;
- `W013` no budget — only with `--strict`, budgets are optional by default;
- `W015` an error is declared but never used;
- `W016` `deny` for a native effect (`net`, `fs`, `exec`) is not enforced;
- `W017` `job` is not executed in v0.1;
- `W018` operation bodies are not in the spec: they come from `arcod impl`,
  `--reference` or a TODO in the scaffold;
- `W020` `onFail: skip` on a step others depend on;
- `W022` a workflow is described but not executed in v0.1;
- `W023` a step's `call` is not declared in the module;
- `W024` a step without `call`: its body would have to be generated;
- `W026` an external service is called but no address is configured;
- `W027` a presentation has no `qr` slide;
- `W028` a presentation without `stream`: the page will poll state.

### Examples are tests

`examples` in the model are not documentation but executable scenarios:
`arcod test` boots the service and runs them. Without a flag it uses reference
bodies (`create`/`read`); with `--impl` it uses the bodies from `impl/`.

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

`when` calls operations and binds results with `let`; `then` asserts a
comparison, `is <Error>`, `&&`, `||`, `!`. `given` (state setup) is not executed
in v0.1. An operation without an example is `W012`; a declared error that is
neither handled nor covered by an example is `A007`.

## Editor — VS Code

The `*.arc` extension lives in `editors/vscode`:

- TextMate highlighting: declarations, operations, clauses, effects, types and
  durations;
- providers and capabilities are coloured differently — they are different axes;
- context-aware completion: after `uses store:` — capabilities, after
  `bind x ->` — providers, after `deploy` — deployment providers, values of
  `layout`, `overlap`, `catchup`, `onFail`, `trigger`;
- `arcod check --json` on open and save: Problems, a status bar counter, parse
  errors with positions;
- navigation: Cmd/Ctrl+Click and F12 go to a declaration, Shift+F12 — to
  references.

```bash
cd editors/vscode && npm install && npm run package
code --install-extension arcod-0.1.0.vsix --no-dependencies
```

Extension tests: `node --test test/*.test.mjs` (grammar via vscode-textmate,
completions, diagnostics rendering) and `node test/runTest.cjs` — starts a real
VS Code extension host and checks activation, `.arc` recognition and `A002` in
Problems.

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
  emit/service.ts        service, adapters and `io`
  emit/sql-store.ts      MySQL client
  emit/identity.ts       Keycloak/JWKS
  emit/blob.ts           S3
  emit/llm.ts            OpenAI-compatible chat
  emit/stream.ts         websocket server (RFC 6455)
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
  quiz/                presentation, widgets and an event stream
test/             node --test
```

Running the tests:

```bash
npm test
```

## v0.1 limitations

This is a vertical slice, not a finished language.

- **Scaffold without bodies** (`arcod build` without `--impl`) knows only
  `create` and `read`: there are no built-in templates for other operations.
  With `--impl` the emitter accepts any operations and any of the eight
  capabilities.
- `kv` in a real environment is Redis; the in-memory driver exists only for
  `arcod test`.
- `arcod fmt` is a stub; `arcod diff` and `arcod adopt` are not implemented.
- `arcod test` does not execute `given`; of the predicates it supports only
  `once`.
- `unique` and `ordering` are not checked beyond syntax and cycles.
- Generation targets JavaScript/Node only. PHP, Go and Python would be separate
  emitters.
- `change`, `policy`, `hint` and `unknown`, as well as the `idempotent`,
  `since` and `schedule` clauses, are parsed but do not affect the build: they
  are placeholders, not working constructs.
- `job` is parsed but not executed (`W017`): the language has no state model or
  selection condition yet.
- **There are no operation bodies in the spec** (`W018`): `build` gives a
  scaffold with TODO, `--impl` takes bodies from `impl/`, `--reference`
  substitutes a built-in demo template.

## License

MIT
