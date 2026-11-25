// The dialect type tables are keyed by a type name, and the name comes from
// the model. A field typed as an undeclared `toString` answered
// Object.prototype.toString, so the DDL carried that function's source text as
// the column type instead of a JSON column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MYSQL, POSTGRES } from '../src/dialects.ts';

test('an unknown base falls back to JSON, not to a prototype member', () => {
  for (const base of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    assert.equal(MYSQL.type(base, false), 'JSON', 'mysql ' + base);
    assert.equal(POSTGRES.type(base, false), 'JSONB', 'postgres ' + base);
  }
});

test('a real base still gets its dialect type', () => {
  assert.equal(MYSQL.type('uuid', false), 'CHAR(36)');
  assert.equal(MYSQL.type('int', false), 'BIGINT');
  assert.equal(POSTGRES.type('uuid', false), 'UUID');
  assert.equal(POSTGRES.type('bool', false), 'BOOLEAN');
});
