// The generated postgres store read entity records with a plain index, the
// same way the mysql store used to: a column named like a prototype member
// answered a function, and a __proto__ column became the record's prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } from '../src/emit/pg-store.ts';

// The store source relies on the pg helpers (pgLiteral, pgIsUnique) declared
// in the connection half, so both halves are evaluated together.
const load = (): Record<string, any> =>
  new Function(
    PG_STORE_SOURCE.replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\n' + PG_SQL_STORE_SOURCE + '\nreturn { pgRowObject, PgStore };',
  )();

test('a __proto__ column stays an own field of the read row', () => {
  const { pgRowObject } = load();
  const row = pgRowObject([{ name: '__proto__', base: 'string' }, { name: 'id', base: 'int' }], ['x', '7']);
  assert.deepEqual(Object.keys(row).sort(), ['__proto__', 'id']);
  assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__')?.value, 'x');
  assert.equal(Object.getPrototypeOf(row), Object.prototype, 'the prototype is untouched');
  assert.equal(row.id, 7);
});

test('an insert of a record without the column binds NULL, not a function', async () => {
  const { PgStore } = load();
  const store = Object.create(PgStore.prototype);
  const seen: string[] = [];
  store.query = async (sql: string) => {
    seen.push(sql);
    return { rows: [], affected: 1 };
  };
  await store.entityInsert('t', [{ name: 'toString', base: 'string' }, { name: 'id', base: 'int' }], { id: 1 });
  const sql = seen.join(' ');
  assert.match(sql, /VALUES \(NULL, 1\)/, 'the missing column is NULL');
  assert.doesNotMatch(sql, /native code|function toString/);
});
