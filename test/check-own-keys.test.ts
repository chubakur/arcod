import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

// Two check tables are keyed by a name the author writes: capability effects
// and impl/ bodies. Both asked \`name in table\`, which also answers true for
// every Object.prototype member, so a name like toString or hasOwnProperty
// passed as an existing effect and an operation of that name looked like it
// had a body it never had. The tables are plain records, so the question is
// "does the file declare this key", and that is Object.hasOwn.

const HEAD = `module ownkeys @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-25"
  }
}

use capability arcod.std.kv @1

type Item = { id: string, note: string }
`;

const service = (opName: string, effectEntry: string): string => `
service S : http {
  uses store: kv

  effects {
    allow ${effectEntry}
  }

  contract {
    public op ${opName}(id: string) -> Item {
      route: "GET /v1/items/{id}"
      effects: store.get
      post: result != null
    }
  }
}

environment dev {
  bind store -> kv
  deploy docker
}
`;

const codes = (source: string, impl?: Record<string, string>) =>
  check(parse(HEAD + source, 'main.arc'), impl === undefined ? {} : { impl }).map((d) => ({
    code: d.code,
    path: d.path ?? '',
    message: d.message,
  }));

test('an effect named like a prototype member is refused (A044)', () => {
  const found = codes(service('read', 'store.toString')).filter((d) => d.code === 'A044');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /effect store\.toString does not exist in kv/);
});

test('every prototype member name is refused, not only toString', () => {
  for (const name of ['hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable']) {
    const found = codes(service('read', 'store.' + name)).filter((d) => d.code === 'A044');
    assert.equal(found.length, 1, name + ' should be refused');
    assert.match(found[0].message, new RegExp('effect store\\.' + name + ' does not exist in kv'));
  }
});

test('a real effect still passes', () => {
  const found = codes(service('read', 'store.get')).filter((d) => d.code === 'A044');
  assert.deepEqual(found, []);
});

test('an operation named toString does not inherit a body (W050)', () => {
  // impl holds one unrelated body, so the record exists and the old \`in\`
  // answer came from Object.prototype instead of from impl/toString.mjs.
  const found = codes(service('toString', 'store.get'), { totals: 'export async function totals() { return { result: null }; }\n' })
    .filter((d) => d.code === 'W050');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /operation toString has no body in impl\//);
});

test('a body file of that name silences W050', () => {
  const found = codes(service('toString', 'store.get'), { toString: 'export async function toString() { return { result: null }; }\n' })
    .filter((d) => d.code === 'W050');
  assert.deepEqual(found, []);
});
