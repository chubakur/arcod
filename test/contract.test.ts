import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';

const SPEC = [
  'module contract @0.1.0 {',
  '}',
  '',
  'type OrderId = string',
  'type Amount = int',
  'type Entry = { order: OrderId, amount: Amount }',
  'type Receipt = { id: string, accepted: bool }',
  '',
  'error Unavailable',
  '',
  '// An external service: we describe only what we call.',
  'external service Ledger : http {',
  '  contract {',
  '    op record(entry: Entry) -> Receipt {',
  '      route: "POST /v1/entries"',
  '    }',
  '  }',
  '}',
  '',
  'service Orders : http {',
  '  effects {',
  '    allow Ledger.record',
  '  }',
  '',
  '  contract {',
  '    public op charge(order: OrderId, amount: Amount) -> Receipt {',
  '      route: "POST /v1/orders"',
  '      effects: Ledger.record',
  '      errors: Unavailable',
  '      post: result != null',
  '      on error Unavailable: order != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind Ledger -> endpoint(url: "http://ledger.example.com")',
  '}',
].join('\n');

const IMPL = {
  charge: [
    'export async function charge(input, io) {',
    '  const amount = Number(input.amount);',
    '  try {',
    '    const out = await io.remote("Ledger", "record", { order: input.order, amount });',
    '    return { result: out.body };',
    '  } catch (error) {',
    '    return { error: "Unavailable" };',
    '  }',
    '}',
  ].join('\n'),
};

test('the generated service calls an external service per its contract', async () => {
  const ledger = await mockHttp((req) => {
    return { status: 200, body: { id: 'r1', accepted: true } };
  });
  const svc = await startService(SPEC, { impl: IMPL, env: { LEDGER_URL: ledger.base } });
  try {
    const res = await fetch(svc.base + '/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: 'o1', amount: 10 }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 'r1', accepted: true });

    assert.equal(ledger.requests.length, 1, 'one call to the ledger');
    const call = ledger.requests[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/entries');
    assert.deepEqual(JSON.parse(call.body), { order: 'o1', amount: 10 });
  } finally {
    await svc.stop();
    await ledger.stop();
  }
});

test('an external failure surfaces as the declared error', async () => {
  const ledger = await mockHttp(() => ({ status: 503, body: { error: 'down' } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { LEDGER_URL: ledger.base } });
  try {
    const res = await fetch(svc.base + '/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: 'o1', amount: 10 }),
    });
    assert.equal(res.status, 503, 'Unavailable maps to 503');
    assert.deepEqual(await res.json(), { error: 'Unavailable', message: 'temporarily unavailable' });
  } finally {
    await svc.stop();
    await ledger.stop();
  }
});
