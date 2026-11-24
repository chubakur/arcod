// `budget { concurrency: N }` is documented as an in-flight limiter: the
// request above the limit answers 503 Unavailable and the slot comes back when
// the slow request finishes. The emitter text was asserted, but nothing drove
// the counter: a leak on either path (a 503 that never releases, or a slot
// released twice) would turn a healthy service into a permanent 503.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module limit @0.1.0 {}',
  'use capability arcod.std.kv @1',
  "type Row = { id: uuid, n: int }",
  'error Invalid',
  'service Limit : http {',
  '  uses store: kv',
  '  budget {',
  '    concurrency: 1',
  '  }',
  '  effects { allow store.set, store.get }',
  '  contract {',
  '    public op slow(n: int) -> { ok: bool } {',
  '      route: "POST /v1/slow"',
  '      effects: store.set',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '}',
  '',
].join('\n');

const impl = {
  slow: [
    'export async function slow(input, io) {',
    "  await new Promise((resolve) => setTimeout(resolve, 800));",
    '  return { result: { ok: true } };',
    '}',
    '',
  ].join('\n'),
};

const call = (base: string) =>
  fetch(base + '/v1/slow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }) });

test('budget concurrency: the request above the limit is 503 and the slot returns', async () => {
  const svc = await startService(source, { impl });
  try {
    const first = call(svc.base);
    // The first request is inside its 800 ms body; the second must be refused
    // rather than queued, because the ceiling is one in flight.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await call(svc.base);
    assert.equal(second.status, 503, 'above the ceiling answers 503');
    assert.equal((await second.json()).error, 'Unavailable');

    const firstDone = await first;
    assert.equal(firstDone.status, 201, 'the in-flight request still finishes');

    const third = await call(svc.base);
    assert.equal(third.status, 201, 'the slot is released when the request ends');
  } finally {
    await svc.stop();
  }
});
