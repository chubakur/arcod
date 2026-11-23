// A service has one store at runtime. When it stores in sql, every kv alias is
// served by that store's arcod_kv table; a redis binding for such an alias
// started a container and exported REDIS_URL that no emitted line read, so the
// cache stayed empty while the table filled. check rejected nothing and the
// user read the provider table as support.
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

test('a kv alias next to a sql store refuses a redis bind with the alias name', () => {
  const diags = check(parse(spec('sql', 'kv', 'redis'), 'main.arc'), {});
  const found = diags.filter((item) => item.code === 'A094');
  assert.equal(found.length, 1, diags.map((item) => item.code + ':' + item.message).join(' | '));
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /alias cache is kv in Items/);
  assert.match(found[0].message, /arcod_kv/);
  assert.match(found[0].hint ?? '', /store: kv/);
});

test('a kv-store service keeps its redis binding', () => {
  const diags = check(parse(spec('kv', 'kv', 'redis'), 'main.arc'), {});
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'the kv store is the redis adapter');
});

test('a memory-backed kv alias next to sql is legal', () => {
  const diags = check(parse(spec('sql', 'kv', 'memory'), 'main.arc'), {});
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'no container is promised, so nothing is dead');
});
