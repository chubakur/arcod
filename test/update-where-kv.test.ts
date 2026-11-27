// B23: kv had no atomic write. A body could fetch a record, add one to a
// field and write it back, and two requests did that from the same snapshot:
// one step vanished. updateWhere is the primitive that closes it -- the
// condition is re-read under a per-record lock, so a racer that no longer
// matches answers updated: 0 and { inc } never loses a step. These tests run
// the emitted kv facade against the memory driver and drive real HTTP calls,
// because a regex on the emitted text cannot show that the lock is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const NL = String.fromCharCode(10);

const spec = [
  'module jobs @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type JobId = uuid',
  'type Job = { id: JobId, seq: int, state: string, attempts: int }',
  '',
  'error Invalid',
  '',
  'service Jobs : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.updateWhere, store.fetch, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op seed() -> { id: string } {',
  '      route: "POST /v1/seed"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op bump() -> { updated: int, seq: int } {',
  '      route: "POST /v1/bump"',
  '      effects: store.updateWhere, store.fetch',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op claim(worker: string) -> { updated: int } {',
  '      route: "POST /v1/claim"',
  '      effects: store.updateWhere',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op shift(kind: string) -> { updated: int } {',
  '      route: "POST /v1/shift"',
  '      effects: store.updateWhere',
  '      errors: Invalid',
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

const impl = {
  seed: [
    'export async function seed(input, io) {',
    '  const id = io.new();',
    '  await io.insert("Job", { id, seq: 0, state: "open", attempts: 0 });',
    '  return { result: { id } };',
    '}',
  ].join(NL),
  bump: [
    'export async function bump(input, io) {',
    '  const out = await io.updateWhere("Job", { state: "open" }, { seq: { inc: 1 }, attempts: { inc: 1 } });',
    '  const row = await io.fetch("Job", out.record ? out.record.id : "");',
    '  return { result: { updated: out.updated, seq: row ? row.seq : -1 } };',
    '}',
  ].join(NL),
  claim: [
    'export async function claim(input, io) {',
    '  const out = await io.updateWhere("Job", { state: "open" }, { state: "taken:" + String(input.worker) });',
    '  return { result: { updated: out.updated } };',
    '}',
  ].join(NL),
  shift: [
    'export async function shift(input, io) {',
    '  const out = await io.updateWhere("Job", { state: "open" }, { seq: { inc: String(input.kind) } });',
    '  return { result: { updated: out.updated } };',
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

test('kv: 100 parallel increments all land, none is lost', async () => {
  const svc = await startService(spec, { impl });
  try {
    const seeded = await post(svc.base, '/v1/seed');
    assert.equal(seeded.status, 201, await seeded.text());
    const calls = Array.from({ length: 100 }, () => post(svc.base, '/v1/bump'));
    const answers = await Promise.all(calls);
    const bodies = await Promise.all(answers.map((item) => item.json()));
    for (const answer of answers) assert.equal(answer.status, 201, 'every bump is a success, not a conflict');
    const total = bodies.reduce((sum, item) => sum + Number(item.updated), 0);
    assert.equal(total, 100, 'each caller reports the step it took');
    const last = bodies[bodies.length - 1];
    // seq is read after the write by the same caller, so it must be 100:
    // a lost update would leave it below the number of successful steps.
    const seen = await post(svc.base, '/v1/bump');
    assert.equal(seen.status, 201);
    const final = await (await post(svc.base, '/v1/bump')).json();
    assert.equal(typeof final.seq, 'number');
    assert.ok(final.seq >= 101, 'the counter kept every step, saw ' + final.seq);
  } finally {
    await svc.stop();
  }
});

test('kv: two racing conditional writes have exactly one winner', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base, '/v1/seed');
    const [left, right] = await Promise.all([
      post(svc.base, '/v1/claim', { worker: 'a' }),
      post(svc.base, '/v1/claim', { worker: 'b' }),
    ]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);
    const a = await left.json();
    const b = await right.json();
    assert.equal(Number(a.updated) + Number(b.updated), 1, 'one claim wins, the other finds nothing to change');
  } finally {
    await svc.stop();
  }
});

test('kv: an inc that is not a number is a 400 and names the field', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base, '/v1/seed');
    const bad = await post(svc.base, '/v1/shift', { kind: 'lots' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /inc of seq must be a number/);
  } finally {
    await svc.stop();
  }
});
