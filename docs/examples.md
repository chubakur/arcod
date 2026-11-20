# Examples — what each demo proves

Every directory under `examples/` is a working service, not a snippet: each
one checks clean, builds with its own inputs, and its `examples { }` block runs
against the emitted service (`node --test test/examples.test.ts` proves all
three for all of them). This page is the index: what to read a demo for, and how
to run it.

| Demo | Ops | Store | What it is worth reading for |
| --- | --- | --- | --- |
| `onetimemessage` | create, read | kv (ttl 999s) | The smallest end-to-end service: a link that works once, then 410 Gone. Start here. |
| `onetimemessage-pwd` | create, read | kv (ttl 999s) | The same, with a `passwords` capability: scrypt hashing, a password checked before the payload is revealed. |
| `project1` | create, read | kv | A message API with a declared body type and an `examples` block; the reference for `arcod run`. |
| `project1-mysql` | create, read | sql (MySQL) | The same contract over the SQL adapter: migrations, typed tables, `arcod migrate`. |
| `tasks` | create, list, move | kv | `list` as a query: filter, order and limit travel to the adapter, not into the body. |
| `tasks-sql` | create, list, move | sql | The same queries on SQL, plus a deliberately honest W046: the cloud has no managed mysql. |
| `orders` | create | sql + queue | Atomic publish: the fact and the event land through one outbox transaction; prod deploys postgres. |
| `payments` | charge | kv | A foreign service (`external service Ledger`): the amount is checked before the remote call, and a decline is a declared error, not a 500. |
| `saga` | start, mark, unmark, boom, peek | kv | A saga with compensation: a failing step undoes the ones that already committed. |
| `quiz` | start, join, state, advance, vote, rate, comment | kv + stream | Live state over a stream, a host page with a QR code, and a UI built from the same ops. |
| `chat` | start, send, history | sql + llm | Dialogue history and model answers; the page is `layout: chat`; the model is bound, not called from the body. |
| `vector` | add, search | kv + llm | `io.embed` and a vector search; the embedding width comes from the bind (`dim`) and is enforced. |
| `files` | upload, list, download, setVisibility, users | sql + identity + blob | Bytes in the blob store, metadata in the row, Keycloak identities for sharing. `list` keeps W012 (B47: the contract and the demo body disagree). |
| `kanban` | create, list, move, remove, image | sql + identity + blob | A per-caller board: `owner:` guards, images read back by the owner, `auth` ops. |
| `signup` | create, find | kv | Constrained types: `email`, `url`, a closed `Plan` enum and a schema default, checked at the boundary. |
| `notes-ssr` | list, create | kv | Server-rendered pages instead of a SPA: the same contract, a different `ui` kind. |

Run one:

```bash
cd examples/signup
arcod check .          # parse, types, bindings, effects, rules
arcod test .           # the examples block, against the emitted service
arcod build . --impl && arcod run   # a container, if Docker is available
```

`arcod run` needs Docker for the service container; `arcod test` does not: it
builds the service in `.arcod/build` and speaks HTTP to it over a local port
with memory drivers.
