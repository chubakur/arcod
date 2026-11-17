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
  `node:crypto` — no dependencies;
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
- startup carries `user`/`database` from the URL, a query returns fields and rows,
  and SQLSTATE 23505 surfaces as `pgIsUnique`;
- literals/cells are typed on both directions.

## What is next (B5.2b)

`serviceTemplate()` still always embeds `SQL_STORE_SOURCE`. The next step picks
the client by the `DATABASE_URL` scheme (or an explicit `--dialect` at build), teaches
`SqlStore` to render literals through a dialect object, and runs one example against both
MySQL and Postgres (B5.3). Until then a postgres-bound deployment starts but talks
the wrong protocol — the check that rejects it is part of B5.2b.
