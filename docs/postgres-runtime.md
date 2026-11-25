# Postgres runtime — B5.2a

The generated service historically spoke MySQL only: `src/emit/sql-store.ts`
embeds a dependency-free wire client. Dialect support for DDL landed in B5.1
(`src/dialects.ts`, `arcod migrate --dialect postgres`); this step adds the
runtime half that the store can be pointed at.

## What is ready

`src/emit/pg-store.ts` — a self-contained ES module emitted into the service
next to the MySQL client:

- **startup**: `postgres://user:password@host:port/database`,
  protocol 3.0, `client_encoding=UTF8`;
- **auth**: trust, cleartext, MD5 and SCRAM-SHA-256 (RFC 5802/7677) over
  `node:crypto` — no dependencies. `SASLInitialResponse` carries the gs2 header
  before the bare message (`n,,n=,r=<nonce>`): postgres reads the first
  character as the channel-binding flag and expects a comma next, so a bare
  `n=,r=...` is rejected as `08P01 malformed SCRAM message`. The auth message
  that is signed stays the bare part only (`n=,r=...,<server-first>,c=biws,r=...`).
  The client compares the server signature with `timingSafeEqual` on every
  handshake, so a postgres build imports that name whether or not the service
  hashes passwords itself — the name belongs to the wire client, not to the
  guarded bodies (issue #29: without it the container started and died on the
  first connection with `ReferenceError: timingSafeEqual is not defined`);
- **query**: simple-query protocol, `RowDescription`/`DataRow`, SQLSTATE errors;
- **typing**: `pgLiteral(base, value)` renders bool/int/datetime/bytes/json as typed
  literals (bytea via `decode(..., 'hex')`, json via `::jsonb`), never by string
  concatenation of request text; `readPgCell` is the inverse. `TIMESTAMPTZ` text
  becomes ISO-8601 with `Z`;
- **conflict**: `pgIsUnique(error)` is true for SQLSTATE `23505` (MySQL's
  `ER_DUP_ENTRY`/1062 is the equivalent the existing client maps).

## Test

`test/pg-wire.test.ts` loads the emitted source the way the service does and drives
it with a fake backend:

- the SCRAM-SHA-256 client-final matches the RFC 7677 §3 vector;
- `test/pg-scram.test.ts` runs the whole handshake against a fake server: the
  first SASL payload starts with `n,,` and carries the nonce the client-final
  later extends, and the server signature computed from the bare message is
  accepted (a missing gs2 header fails the handshake);
- `test/crypto-import.test.ts` pairs the two sides of the import line: every
  crypto name the emitted service calls must appear in its own `node:crypto`
  import, across kv/sql/guarded/blob shapes and both dialects, and node is asked
  whether each imported name actually exists;
- startup carries `user`/`database` from the URL, a query returns fields and rows,
  and SQLSTATE 23505 surfaces as `pgIsUnique`;
- literals/cells are typed on both directions.

## Dialect at build time (B5.2b)

`emitService(mod, { dialect })` now emits exactly one store: `mysql` (the
default, unchanged output) or `postgres`. A postgres build carries
`PG_STORE_SOURCE` (wire client), `PG_SQL_STORE_SOURCE` (the same store contract:
entity CRUD, kv/claim/take, outbox, transactions) and the postgres migration
changelog; `arcod build --dialect postgres` selects it, and the service defaults
`DATABASE_URL` to `postgres://...@postgres:5432/...`. Identifiers are
double-quoted, values go through `pgLiteral`, kv values travel as `BYTEA`,
`INSERT IGNORE` becomes `ON CONFLICT DO NOTHING` (with the command tag parsed
for the affected count), `<=>` becomes `IS NOT DISTINCT FROM`, and transactions
use `BEGIN`.

A mismatched deployment fails at startup with a named error: each build emits
`assertDialectUrl(url, expected)`, so a mysql build given a `postgres://`
DATABASE_URL (or the reverse) refuses to start instead of speaking the wrong
protocol. The outbox dispatcher builds the same client as the service.

The emitted module is syntax-checked in `test/pg-emit.test.ts`; MySQL output is
asserted to stay byte-identical in shape. `arcod test --dialect postgres` and `arcod make --dialect postgres` build that
shape and run the examples on the in-memory driver, so the postgres path is
exercised on every CI run; `test/pg-emit.test.ts` does the same for
`examples/tasks-sql` (create/move/conflict).

Compose follows the dialect: a sql service with no explicit bind gets the
database its build speaks (mysql:8.4 or postgres:16-alpine) with the matching
`DATABASE_URL`; an explicit bind still wins.

## Errors and reconnects (B90)

The client keeps one socket for the whole service and pipelines statements
through it. A failed statement is not a broken connection: Postgres sends
`ErrorResponse` and then `ReadyForQuery`, so the error rejects only the
statement that caused it and the next queued statement is written normally.
Unique violations therefore reach `entityInsert`/`entityUpdate` as `Conflict`
(409), and `/healthz` keeps answering after a duplicate insert instead of
waiting on a destroyed socket.

Inside an explicit transaction the first failed statement aborts it on the
server: every later statement fails with `25P02` ("current transaction is
aborted") until `ROLLBACK`. Both errors are ordinary statement errors, so the
socket stays usable and a rollback puts the connection back in service — that
is how `PgStore.take()`/`takeIf()` recover in their `catch`.

Only transport failures and startup/auth errors end the connection. A dropped
socket rejects everything in flight and queued, and the store reconnects before
the next query without re-running migrations; if the server is still away, that
request fails cleanly and the following one tries again.

Still open (B5.3): one example on both dialects end to end with a live server
(the host has neither postgres nor docker — see DECISIONS), and k8s picking the
postgres image when the build dialect is postgres.
