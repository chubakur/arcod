// The generated sql store read entity records with a plain index. A column
// named like a prototype member answered a function instead of the value: an
// insert of a record without that key bound the source text of
// Object.prototype.toString, and rowToObject turned a __proto__ column into the
// prototype of the returned record instead of a field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SQL_STORE_SOURCE } from '../src/emit/sql-store.ts';

type StoreModule = {
  rowToObject: (columns: Array<{ name: string; base: string }>, row: unknown[]) => Record<string, unknown>;
  SqlStore: new (...args: unknown[]) => Record<string, unknown> & { query: (sql: string) => Promise<unknown> };
};

const load = (): StoreModule => new Function(SQL_STORE_SOURCE + '\nreturn { rowToObject, SqlStore };')() as StoreModule;

test('a __proto__ column stays an own field of the read row', () => {
  const { rowToObject } = load();
  const row = rowToObject([{ name: '__proto__', base: 'string' }, { name: 'id', base: 'int' }], ['x', '7']);
  assert.deepEqual(Object.keys(row).sort(), ['__proto__', 'id']);
  assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__')?.value, 'x');
  assert.equal(Object.getPrototypeOf(row), Object.prototype, 'the prototype is untouched');
  assert.equal(row.id, 7);
});

test('an insert of a record without the column binds NULL, not a function', async () => {
  const { SqlStore } = load();
  const store = Object.create(SqlStore.prototype) as { query: (sql: string) => Promise<unknown>; entityInsert: Function };
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
