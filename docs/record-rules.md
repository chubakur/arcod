# A record and its declaration

Every entity is a declared record. An operation can write one through
`io.insert`/`io.update` (or `io.fetch` for reading), and an operation input
crosses the contract boundary first — but a record built **inside** a body never
does. That is why the store facades themselves check the record against the
declaration on every insert and update, on kv and on both SQL drivers. A row that
breaks its own declaration is a 400 `Invalid` naming the call, the entity and the
field, never a value the schema promised clients never see.

## What the check enforces

| Rule | A record fails when | Message |
| --- | --- | --- |
| Declared fields only | it carries a key the entity does not declare | `insert Row: unknown field "skils"; declared: id, name, …` |
| Required field | a field declared without `?` is missing on insert (after defaults) or set to `null` | `insert Row: missing name` / `Row: name is not nullable` |
| The record is an object | `io.insert`/`io.update` receives `null`, a string or an array | `insert Row: the record must be an object` |
| String-ish field | `string`, `email`, `url`, `uri`, `uuid` or `bytes` holds a non-string | `insert Row: name must be a string` |
| Number field | `int`, `number`, `float`, `decimal` holds a non-number; `int` holds a fraction | `insert Row: count must be an integer` |
| Boolean field | `bool`/`boolean` holds anything but `true`/`false` | `insert Row: live must be a boolean` |
| Instant field | `datetime` is not ISO 8601 | `insert Row: at must be an ISO 8601 datetime` |
| Container of instants | a leaf of `list<datetime>`/`map<…, datetime>` is not an instant | `insert Row: marks must be a list or map of datetime` |
| Container shape | a `list` field is not an array, a `map` or named-record field is not an object | `insert Row: skills must be a list` / `tags must be a map` |
| Enum members | an `enum` field holds a value outside its members | `insert Row: status must be one of draft, live` |
| Email/url format | a field declared `email`/`url` does not have that shape | `insert Row: mail must be an email` |
| Declared bounds | a value is outside `min`/`max`/`minLength`/`maxLength` (`bytes` counts bytes) | `insert Row: title must be at most 80 characters` |

Two deliberate limits:

- **The element type of a container is not checked** at the record: `tags: { team: 42 }`
  where the type says `map<string, string>` passes the shape rule. The contract
  layer owns element types, and a record check that re-implemented them would be a
  second, drifting validator.
- **A filter is not a record.** `where` still refuses only what cannot mean
  anything (an unknown field, a range over a container, a non-list `in`); a value
  of the wrong shape matches no row instead of turning the query into a 400.

## Where it runs

```
op input ──▶ contract boundary ──▶ body ──▶ io.insert / io.update ──▶ store facade
             (types, enum,                  (record check: this page)   (kv / mysql / postgres)
              format, bounds)
```

The same check runs in both facades, so `arcod test` (memory drivers) answers what
a live kv or MySQL service answers. Reading is not checked: a row already in the
store is returned as it is, with declared defaults filled in, and every declared
column named — an optional field with no value reads back as `null` on every
driver (kv used to leave the key out while a nullable column answered `NULL`).

## Related

- [examples](examples.md) — the demos that exercise these rules.
- `test/record-shape.test.ts`, `test/record-enum.test.ts`,
  `test/record-format.test.ts`, `test/record-arg.test.ts` —
  each rule on kv and on the sql memory driver.
- `test/optional-read.test.ts` — the read shape of an optional field on kv,
  the sql memory driver, and the mysql and postgres stores' NULL mapping.
