// B80.1: a body may bring an AbortSignal to io.remote. The service ceiling
// still applies (the two are combined), and a cancelled call is distinguishable
// from a timeout or a transport failure by kind: 'cancelled'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startService } from './harness.ts';

const spec = [
  'module slowremote @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'type Entry = { order: string, amount: int }',
  'type Receipt = { id: string, accepted: bool }',
  'external service Ledger : http {',
  '  contract {',
  '    op record(entry: Entry) -> Receipt {',
  '      route: "POST /v1/entries"',
  '    }',
  '  }',
  '}',
  'service Proxy : http {',
  '  effects {',
  '    allow Ledger.record',
  '  }',
  '  contract {',
  '    public op cancel() -> { status: int, body: string } {',
  '      route: "GET /v1/cancel"',
  '    }',
  '    public op plain() -> { status: int, body: string } {',
  '      route: "GET /v1/plain"',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind Ledger -> endpoint(url: "SURL")',
  '  deploy docker',
  '}',
  '',
].join('\n');

const bodies = {
  cancel: [
    'export async function cancel(input, io) {',
    '  const controller = new AbortController();',
    '  setTimeout(() => controller.abort(), 30);',
    '  try {',
    "    const out = await io.remote('Ledger', 'record', { order: 'a', amount: 1 }, { signal: controller.signal });",
    "    return { result: { status: out.status, body: 'completed' } };",
    '  } catch (error) {',
    "    return { result: { status: 0, body: String(error && error.kind ? error.kind : error) } };",
    '  }',
    '}',
  ].join('\n'),
  plain: [
    'export async function plain(input, io) {',
    "  const out = await io.remote('Ledger', 'record', { order: 'b', amount: 2 });",
    "  return { result: { status: out.status, body: 'completed' } };",
    '}',
  ].join('\n'),
};

test('io.remote aborts with kind cancelled, and works without a signal', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'r1', accepted: true }));
      }, 120);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const source = spec.replace('SURL', 'http://127.0.0.1:' + address.port);
  const svc = await startService(source, { impl: bodies, env: { LEDGER_URL: 'http://127.0.0.1:' + address.port } });
  try {
    const cancelled = await (await fetch(svc.base + '/v1/cancel')).json();
    assert.deepEqual(cancelled, { status: 0, body: 'cancelled' });
    const plain = await (await fetch(svc.base + '/v1/plain')).json();
    assert.deepEqual(plain, { status: 200, body: 'completed' });
  } finally {
    await svc.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
