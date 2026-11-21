// A list or record field is stored as JSON. On SQL `contains` casts the
// column to text and matched a substring of that JSON; on kv String(actual)
// turned a list into "alpha,beta" and a record into "[object Object]", so the
// same filter found nothing. Both drivers now compare the JSON text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, tags: list<string>, marks: map<string, datetime> }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tags: list<string>, marks: map<string, datetime>) -> { id: uuid } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op scan(mode: string) -> { items: list<Item> } {',
  '      route: "POST /v1/scan"',
  '      effects: store.find',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  put: [
    'export async function put(input, io) {',
    '  const record = { id: io.new(), tags: input.tags, marks: input.marks };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "tag");',
    '  const where = mode === "tag"',
    '    ? { tags: { contains: "alph" } }',
    '    : mode === "joined"',
    '      ? { tags: { contains: "alpha,beta" } }',
    '      : mode === "mark"',
    '        ? { marks: { contains: "2026-01-01T00:00:00Z" } }',
    '        : mode === "offset"',
    '          ? { marks: { contains: "2026-01-01T03:00:00+03:00" } }',
    '          : { tags: { contains: "nope" } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: contains on a list matches the value text, not the joined elements', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', {
      tags: ['alpha', 'beta'],
      marks: { left: '2026-01-01T00:00:00Z' },
    });
    assert.equal(put.status, 201, 'seed insert succeeds');

    const hit = await post(svc.base + '/v1/scan', { mode: 'tag' });
    assert.equal(hit.status, 201);
    assert.equal((await hit.json()).items.length, 1, 'a substring of an element is found');

    // String([a, b]) is "a,b"; JSON text is ["alpha","beta"]. The joined form
    // was a kv-only answer and matched the wrong thing.
    const joined = await post(svc.base + '/v1/scan', { mode: 'joined' });
    assert.equal(joined.status, 201);
    assert.equal((await joined.json()).items.length, 0, 'the joined elements are not the stored text');
  } finally {
    await svc.stop();
  }
});

test('kv: contains on a record of instants finds the stored spelling', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', {
      tags: ['alpha'],
      marks: { left: '2026-01-01T00:00:00Z' },
    });
    assert.equal(put.status, 201);

    // Before the fix String({left: ...}) was "[object Object]" on kv, so the
    // instant never matched a record field, while SQL found it in the JSON.
    const hit = await post(svc.base + '/v1/scan', { mode: 'mark' });
    assert.equal(hit.status, 201);
    assert.equal((await hit.json()).items.length, 1, 'the canonical instant is in the JSON text');

    // contains is a substring, not an instant comparison: the stored text is
    // canonical, so another spelling of the same instant does not appear.
    const offset = await post(svc.base + '/v1/scan', { mode: 'offset' });
    assert.equal(offset.status, 201);
    assert.equal((await offset.json()).items.length, 0, 'contains compares text, not instants');
  } finally {
    await svc.stop();
  }
});

