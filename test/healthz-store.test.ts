// The health probe names the store it actually pinged. A sql service answered
// `kv: up`, which reads as a healthy cache while the database is the thing the
// probe just tested; kv keeps its key, a sql service answers `sql`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function spec(store: 'kv' | 'sql'): string {
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module health' + store + ' @0.1.0 {}',
    '',
    'use capability arcod.std.' + store + ' @1',
    '',
    'type Row = { id: string }',
    '',
    'service Health' + (store === 'kv' ? 'Kv' : 'Sql') + ' : http {',
    '  uses store: ' + store,
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
    '  bind store -> ' + bind,
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

for (const store of ['kv', 'sql'] as const) {
  test(store + ': /healthz names the store it pinged', async () => {
    const svc = await startService(spec(store), { impl });
    try {
      const res = await fetch(svc.base + '/healthz');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, {
        status: 'ok',
        service: store === 'kv' ? 'HealthKv' : 'HealthSql',
        [store]: 'up',
      });
      assert.equal(Object.prototype.hasOwnProperty.call(body, store === 'kv' ? 'sql' : 'kv'), false, 'the other store is not named');

      const posted = await fetch(svc.base + '/healthz', { method: 'POST' });
      assert.equal(posted.status, 404, 'a probe is a read; a POST is not answered by it');
      const scraped = await fetch(svc.base + '/metrics', { method: 'POST' });
      assert.equal(scraped.status, 404, 'a scrape is a read too');
      const metrics = await fetch(svc.base + '/metrics');
      assert.equal(metrics.status, 200, 'GET /metrics still answers');
    } finally {
      await svc.stop();
    }
  });
}
