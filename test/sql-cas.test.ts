// B113: io.update had no precondition, so two requests that fetched the same
// row both wrote it and one step vanished (issue #58: ten parallel edits left
// version: 2 and three characters). The fourth argument -- { if: { version } }
// -- re-reads the record under a lease and writes only while the condition
// still holds; the loser answers 409 Conflict and the row is untouched. These
// tests drive real HTTP calls against the emitted facade on both stores,
// because a regex on the template cannot show that the lease is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const NL = String.fromCharCode(10);

const kvSpec = [
  'module docs @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type DocId = uuid',
  'type Doc = { id: DocId, version: int, text: string }',
  '',
  'error Invalid',
  'error NotFound',
  'error Conflict',
  '',
  'service Docs : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.update, store.fetch, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op open() -> { id: string, version: int } {',
  '      route: "POST /v1/open"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op read(id: string) -> { version: int, text: string } {',
  '      route: "POST /v1/read"',
  '      effects: store.fetch',
  '      errors: Invalid, NotFound',
  '      post: result != null',
  '    }',
  '',
  '    public op append(id: string, ch: string) -> { version: int, text: string } {',
  '      route: "POST /v1/append"',
  '      effects: store.fetch, store.update',
  '      errors: Invalid, NotFound, Conflict',
  '      post: result != null',
  '    }',
  '',
  '    public op bump(id: string, expect: int) -> { version: int } {',
  '      route: "POST /v1/bump"',
  '      effects: store.fetch, store.update',
  '      errors: Invalid, NotFound, Conflict',
  '      post: result != null',
  '    }',
  '',
  '    public op guarded(id: string, mode: string) -> { version: int } {',
  '      route: "POST /v1/guarded"',
  '      effects: store.fetch, store.update',
  '      errors: Invalid, NotFound, Conflict',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join(NL);

const sqlSpec = kvSpec
  .split('use capability arcod.std.kv @1').join('use capability arcod.std.sql @1')
  .split('uses store: kv').join('uses store: sql')
  .split('bind store -> redis(host: "kv", port: 6379)').join('bind store -> mysql');

const impl = {
  open: [
    'export async function open(input, io) {',
    '  const id = io.new();',
    '  await io.insert("Doc", { id, version: 1, text: "" });',
    '  return { result: { id, version: 1 } };',
    '}',
  ].join(NL),
  read: [
    'export async function read(input, io) {',
    '  const row = await io.fetch("Doc", String(input.id || ""));',
    '  if (row == null) return { error: "NotFound" };',
    '  return { result: { version: row.version, text: row.text } };',
    '}',
  ].join(NL),
  // The read-modify-write the owner hit: fetch, compute, write with the
  // version it read. A loser is told Conflict and retries, which is the only
  // way a body can turn a conflict into a lost update that never happens.
  append: [
    'export async function append(input, io) {',
    '  const id = String(input.id || "");',
    '  const ch = String(input.ch == null ? "" : input.ch);',
    '  for (let attempt = 0; attempt < 200; attempt++) {',
    '    const row = await io.fetch("Doc", id);',
    '    if (row == null) return { error: "NotFound" };',
    '    try {',
    '      const next = await io.update("Doc", id, { version: row.version + 1, text: row.text + ch }, { if: { version: row.version } });',
    '      return { result: { version: next.version, text: next.text } };',
    '    } catch (error) {',
    '      if (!error || error.error !== "Conflict") throw error;',
    '    }',
    '  }',
    '  return { error: "Conflict" };',
    '}',
  ].join(NL),
  bump: [
    'export async function bump(input, io) {',
    '  const id = String(input.id || "");',
    '  const expect = Number(input.expect);',
    '  const row = await io.fetch("Doc", id);',
    '  if (row == null) return { error: "NotFound" };',
    '  const next = await io.update("Doc", id, { version: row.version + 1 }, { if: { version: expect } });',
    '  return { result: { version: next.version } };',
    '}',
  ].join(NL),
  guarded: [
    'export async function guarded(input, io) {',
    '  const id = String(input.id || "");',
    '  const guard = input.mode === "empty" ? { if: {} } : { unless: { version: 1 } };',
    '  const next = await io.update("Doc", id, { text: "x" }, guard);',
    '  return { result: { version: next.version } };',
    '}',
  ].join(NL),
};

function post(base: string, path: string, body?: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function openDoc(base: string): Promise<string> {
  const opened = await post(base, '/v1/open');
  if (opened.status !== 201) assert.fail('open answered ' + opened.status + ': ' + await opened.text());
  return (await opened.json()).id;
}

for (const [label, spec] of [['kv', kvSpec], ['sql', sqlSpec]] as const) {
  test(label + ': a stale precondition is 409 and leaves the row untouched', async () => {
    const svc = await startService(spec, { impl });
    try {
      const id = await openDoc(svc.base);
      const first = await post(svc.base, '/v1/bump', { id, expect: 1 });
      if (first.status !== 201) assert.fail('bump answered ' + first.status + ': ' + await first.text());
      assert.equal((await first.json()).version, 2);

      const again = await post(svc.base, '/v1/bump', { id, expect: 1 });
      assert.equal(again.status, 409, 'the second writer read the old version');
      assert.equal((await again.json()).error, 'Conflict');

      const seen = await (await post(svc.base, '/v1/read', { id })).json();
      assert.equal(seen.version, 2, 'a rejected guard does not write');
      assert.equal(seen.text, '');
    } finally {
      await svc.stop();
    }
  });

  test(label + ': ten parallel read-modify-writes all land', async () => {
    const svc = await startService(spec, { impl });
    try {
      const id = await openDoc(svc.base);
      const letters = 'abcdefghij'.split('');
      const answers = await Promise.all(letters.map((ch) => post(svc.base, '/v1/append', { id, ch })));
      for (const answer of answers) assert.equal(answer.status, 201, await answer.clone().text());
      const seen = await (await post(svc.base, '/v1/read', { id })).json();
      assert.equal(seen.version, 11, 'ten appends = ten versions, saw ' + seen.version);
      assert.equal([...seen.text].sort().join(''), letters.join(''), 'every character survived: ' + seen.text);
    } finally {
      await svc.stop();
    }
  });

  test(label + ': a malformed guard is Invalid, not an unconditional write', async () => {
    const svc = await startService(spec, { impl });
    try {
      const id = await openDoc(svc.base);
      const empty = await post(svc.base, '/v1/guarded', { id, mode: 'empty' });
      assert.equal(empty.status, 400);
      assert.match((await empty.json()).message, /if names no field/);
      const unknown = await post(svc.base, '/v1/guarded', { id, mode: 'unknown' });
      assert.equal(unknown.status, 400);
      assert.match((await unknown.json()).message, /unknown precondition/);
      const seen = await (await post(svc.base, '/v1/read', { id })).json();
      assert.equal(seen.version, 1);
      assert.equal(seen.text, '');
    } finally {
      await svc.stop();
    }
  });
}
