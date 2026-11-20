import { test } from 'node:test';
import assert from 'node:assert/strict';

// The io facade is one object literal. A sql build used to emit the kv entity
// methods first and then append the sql ones, so every sql bundle carried ~150
// lines of dead methods that only survived because a later duplicate key wins.
// The duplicate-key trick also hid which driver ran: a kv method that throws on
// sql meta (meta.prefix) could never be spotted by reading the bundle.
// These tests pin one driver, one set of entity methods, no duplicates.

const spec = (store: string) => [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.' + (store === 'sql' ? 'sql' : 'kv') + ' @1',
  'use capability arcod.std.ids @1',
  '',
  'type EntryId = uuid',
  'type Entry = { id: EntryId, amount: int, kind: string }',
  '',
  'error Invalid',
  '',
  'service Ledger : http {',
  '  uses store: ' + store,
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.fetch, store.find, store.count, store.aggregate, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op seed(n: int) -> { n: int } {',
  '      route: "POST /v1/seed"',
  '      effects: store.insert',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op page(limit: int) -> { total: int } {',
  '      route: "GET /v1/page"',
  '      effects: store.find, store.count',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  seed: [
    'export async function seed(input, io) {',
    '  const n = Number(input.n);',
    '  for (let index = 1; index <= n; index += 1) {',
    '    await io.insert("Entry", { id: io.new(), amount: index, kind: "a" });',
    '  }',
    '  return { result: { n } };',
    '}',
  ].join('\\n'),
  page: [
    'export async function page(input, io) {',
    '  const found = await io.find("Entry", { limit: Number(input.limit || 5) });',
    '  const total = await io.count("Entry");',
    '  return { result: { total: found.items.length + total } };',
    '}',
  ].join('\\n'),
};

async function emit(store: string): Promise<string> {
  const { emitService } = await import('../src/emit/service.ts');
  const { parse } = await import('../src/parser.ts');
  return emitService(parse(spec(store), 'main.arc'), { impl });
}

function makeIoBody(source: string): string {
  const start = source.indexOf('function makeIo(req) {');
  assert.notEqual(start, -1, 'the bundle carries the io facade');
  const end = source.indexOf(String.fromCharCode(10) + '}', source.indexOf('  };', start));
  assert.notEqual(end, -1, 'the io facade is a closed function');
  return source.slice(start, end);
}

function methodNames(body: string): string[] {
  return Array.from(body.matchAll(/^    (?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm), (match) => match[1]);
}

const DRIVERS = ['kv', 'sql'] as const;

for (const store of DRIVERS) {
  test('the ' + store + ' bundle carries each io method exactly once', async () => {
    const body = makeIoBody(await emit(store));
    const names = methodNames(body);
    const seen = new Map<string, number>();
    for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
    const doubled = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    assert.deepEqual(doubled, [], 'duplicate io methods: a later key silently overrides an earlier one');
    for (const expected of ['fetch', 'insert', 'update', 'remove', 'find', 'count', 'aggregate']) {
      assert.ok(seen.has(expected), store + ' io facade lacks ' + expected);
    }
  });
}

test('a sql bundle carries no kv entity code', async () => {
  const source = await emit('sql');
  assert.equal(source.includes('meta.prefix'), false, 'kv entity methods leaked into the sql bundle');
  assert.match(makeIoBody(source), /await store\.entityCount\(meta\.table/, 'the sql count goes to the typed table');
});

test('a kv bundle still scans the entity prefix', async () => {
  const body = makeIoBody(await emit('kv'));
  assert.match(body, /await store\.scan\(meta\.prefix\)/, 'the kv count scans its prefix');
  assert.equal(body.includes('meta.table'), false, 'the sql entity methods leaked into the kv bundle');
});
