import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const SPEC = [
  'module soak @0.1.0 {',
  '}',
  '',
  'service Echo : http {',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '      post: result == "pong"',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  deploy docker',
  '}',
].join('\n');

const IMPL = {
  ping: 'export async function ping(input, io) {\n  return { result: "pong" };\n}',
};

test('concurrent requests all succeed within the latency budget', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const N = 60;
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, async () => {
        const t0 = Date.now();
        const res = await fetch(svc.base + '/v1/ping');
        return { status: res.status, ms: Date.now() - t0 };
      }),
    );
    const total = Date.now() - start;

    const statuses = new Set(results.map((r) => r.status));
    assert.deepEqual([...statuses], [200], 'every request succeeds');

    const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    assert.ok(p95 < 1500, 'p95 latency ' + p95 + 'ms is under 1500ms');
    assert.ok(total < 8000, 'whole soak finished in ' + total + 'ms');
  } finally {
    await svc.stop();
  }
});
