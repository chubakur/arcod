// B117: a sql-storing service may keep a kv alias on redis (the emitter splits
// the stores) or let the sql table serve it when unbound. The check must accept
// both; only the kv-store service needs its own binding to exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const HEAD = [
  'module cache @0.1.0 {',
  '  meta {',
  '    owner: "@test"',
  '    status: "draft"',
  '    since: "2026-11-23"',
  '  }',
  '}',
  '',
  'use capability arcod.std.sql @1',
  'use capability arcod.std.kv @1',
  '',
].join('\n');

function spec(store: string, cache: string, bind: string): string {
  return HEAD + [
    'service Items : http {',
    '  uses store: ' + store,
    '  uses cache: ' + cache,
    '',
    '  effects {',
    '    allow store.insert, cache.set',
    '  }',
    '',
    '  contract {',
    '    public op save(key: string, value: string) -> bool {',
    '      route: "POST /v1/items"',
    '      effects: store.insert, cache.set',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind store -> mysql',
    '  bind cache -> ' + bind,
    '  deploy docker',
    '}',
    '',
  ].join('\n');
}

test('a kv alias next to a sql store accepts a redis bind', () => {
  const diags = check(parse(spec('sql', 'kv', 'redis'), 'main.arc'), {});
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'A094 is retired by B117');
  assert.deepEqual(
    diags.filter((item) => item.severity === 'error'),
    [],
    diags.map((item) => item.code + ':' + item.message).join(' | '),
  );
});

test('a kv-store service keeps its redis binding', () => {
  const diags = check(parse(spec('kv', 'kv', 'redis'), 'main.arc'), {});
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'the kv store is the redis adapter');
});

// Unbound, the sql store serves the alias through its arcod_kv table.
test('a kv alias next to a sql store needs no bind', () => {
  const source = spec('sql', 'kv', 'memory').replace('  bind cache -> memory\n', '');
  assert.equal(source.includes('bind cache'), false, 'the bind is gone');
  const diags = check(parse(source, 'main.arc'), {});
  assert.deepEqual(
    diags.filter((item) => item.code === 'A002'),
    [],
    diags.map((item) => item.code + ':' + item.message).join(' | '),
  );
});

test('a kv-store service still needs its bind', () => {
  const source = spec('kv', 'kv', 'redis').replace('  bind cache -> redis\n', '');
  const diags = check(parse(source, 'main.arc'), {})
    .filter((item) => item.code === 'A002');
  assert.equal(diags.length, 1, 'nothing serves kv but the binding');
  assert.match(diags[0].message, /capability kv is not bound/);
});

test('a memory-backed kv alias next to sql is legal', () => {
  const diags = check(parse(spec('sql', 'kv', 'memory'), 'main.arc'), {});
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'the store serves the alias');
});
