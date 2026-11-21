// A unique rule is a key. MySQL cannot index a JSON column at all or a BLOB
// without a prefix, and Postgres has no equality operator for json, so a
// unique rule on bytes/list/map/json was accepted by check and failed only
// when the migration reached the server. A091 names the field instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const spec = (rule: string): string => [
  'module keys @0.1.0 {}',
  '',
  'type Doc = { id: uuid, label: string, tags: list<string>, blob: bytes, meta: map<string, string> }',
  '',
  'error Conflict',
  '',
  'service S : http {',
  '  uses store: kv',
  '  rules {',
  '    ' + rule,
  '  }',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const a091 = (rule: string) => check(parse(spec(rule), 'keys.arc')).filter((diag) => diag.code === 'A091');

test('A091: unique on a list or record names the unindexable field', () => {
  const list = a091('unique Doc.tags');
  assert.equal(list.length, 1);
  assert.match(list[0].message, /unique Doc\.tags names tags, a list field a key cannot index/);

  const record = a091('unique Doc.meta');
  assert.equal(record.length, 1);
  assert.match(record[0].message, /names meta, a map field/);
});

test('A091: a composite key checks every field', () => {
  const diags = a091('unique Doc.(label, blob)');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /names blob, a bytes field/);
});

test('A091: a scalar unique rule is clean', () => {
  assert.deepEqual(a091('unique Doc.label'), []);
});
