# Names come from the model

Every identifier an author writes — a type, a record field, an operation, a
parameter, an error, a provider, a format — reaches the compiler as a string.
Those strings are used as keys in lookup tables, in emitted objects and in
generated runtime code, and JavaScript resolves a missing key through
`Object.prototype`. So a model name that happens to be `toString`,
`constructor`, `hasOwnProperty`, `valueOf` or `__proto__` finds an inherited
member instead of nothing:

- a read such as `TABLE[name] ?? fallback` returns a *function*, and the
  fallback never runs;
- an assignment such as `map[name] = value` with `__proto__` changes the
  prototype of the map and the key silently disappears.

Both have shipped as visible bugs: `function toString() { [native code] }`
appearing in a prompt or in generated DDL, a table that failed to migrate, a
field missing from the OpenAPI document, a provider that "resolved" to a
function.

## The three rules

1. **Read a name-keyed table by ownership.**

   ```ts
   Object.hasOwn(TABLE, name) ? TABLE[name] : fallback
   ```

   Never `TABLE[name] ?? fallback`: the prototype member is not nullish.
   `Object.hasOwn` is available on the Node 24 baseline; `in` is not a
   substitute, because it also walks the prototype chain.

2. **Build a map keyed by model names with no prototype.**

   ```ts
   const byEntity: Record<string, string[][]> = Object.create(null);
   ```

   Then `byEntity[name] ?? []` is safe, including for `__proto__`.

3. **Write a model-named key with `defineProperty`.**

   ```ts
   function putKey(target: Record<string, unknown>, key: string, value: unknown): void {
     Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
   }
   ```

   A plain assignment routes `__proto__` through the setter on
   `Object.prototype`; `defineProperty` makes it an ordinary own, enumerable
   key, so `JSON.stringify` still publishes it.

## Where this applies

- **Compile-time tables** — `WIRE` in `src/prompts.ts`, the dialect type
  tables in `src/dialects.ts`, GraphQL scalars, `FORMAT_BUILTINS`,
  `DEPLOY_PROVIDERS` and `PROVIDERS`, the unique/index maps in
  `src/migrate.ts`.
- **Emitted documents** — `properties`, `components.schemas`, body properties
  and example values in `src/emit/openapi.ts` (via `putKey`), any other
  artifact whose keys are model names.
- **Generated runtime** — the emitted service and the sql/postgres stores:
  `record[column]` on insert/update and `rowToObject` are part of the
  generated program and follow the same rules (`Object.hasOwn`, then
  `defineProperty` for the row object).
- **The example runner** — a record literal or request body built from
  parameter names is a name-keyed object too.

## Tests

Each fixed site keeps a test that names the member explicitly (`toString`,
`constructor`, `hasOwnProperty`, `valueOf`, `__proto__`) and asserts the
fallback or the published key, not just the absence of a crash — see
`test/wire-proto-type.test.ts`, `test/migrate-proto-entity.test.ts`,
`test/sql-store-proto-field.test.ts`, `test/pg-store-proto-field.test.ts`,
`test/dialect-proto-type.test.ts`, `test/graphql-proto-type.test.ts`,
`test/provider-proto-name.test.ts`, `test/openapi-proto-field.test.ts` and
`test/format-proto-name.test.ts`.

A new emitter is not done until one of those names has been run through it
and the artifact still carries the field.
