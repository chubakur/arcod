// A store that stops answering must not turn /healthz into a hang: the probe
// answers 503 with the store named down, close to the store deadline rather
// than the OS connect timeout (minutes). The generated service is started
// against a fake broker that answers PING until the test silences it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startService } from './harness.ts';

function spec(): string {
  return [
    'module healthdown @0.1.0 {}',
    '',
    'use capability arcod.std.kv @1',
    '',
    'type Row = { id: string }',
    '',
    'service HealthDown : http {',
    '  uses store: kv',
    '',
    '  effects {',
    '    allow store.find',
    '  }',
    '',
    '  contract {',
    '    public op list() -> { items: list<Row> } {',
    '      route: "GET /v1/rows"',
    '      effects: store.find',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind store -> redis(host: "kv", port: 6379)',
    '}',
    '',
  ].join(String.fromCharCode(10));
}

const impl = {
  list: [
    'export async function list(input, io) {',
    "  const page = await io.find('Row', {});",
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

test('a broker that stops answering turns /healthz into a 503, not a hang', async () => {
  let silent = false;
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      if (!silent) socket.write('+PONG\r\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const svc = await startService(spec(), {
    impl,
    env: {
      KV_DRIVER: 'redis',
      KV_HOST: '127.0.0.1',
      KV_PORT: String(address.port),
      ARCod_STORE_TIMEOUT_MS: '300',
    },
  });
  try {
    silent = true;
    const started = Date.now();
    const res = await fetch(svc.base + '/healthz');
    const elapsed = Date.now() - started;
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'degraded', kv: 'down' });
    assert.ok(elapsed < 3000, 'answers near the store deadline, not the OS timeout: ' + elapsed + 'ms');
  } finally {
    await svc.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
