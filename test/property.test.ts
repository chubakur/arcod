import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// A property/fuzz suite: the generated service must never return an internal
// error (500) for any input — it either succeeds or fails with a declared
// error. The spec's errors clause and the body's validation are the source of
// truth; the fuzzer just throws arbitrary inputs at the boundary.

const SPEC = [
  'module fuzz @0.1.0 {',
  '}',
  '',
  'type Amount = int',
  '',
  'error Invalid',
  '',
  'service Calc : http {',
  '  contract {',
  '    public op double(amount: Amount) -> int {',
  '      route: "POST /v1/double"',
  '      errors: Invalid',
  '      post: result != null',
  '      on error Invalid: amount != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  deploy docker',
  '}',
].join('\n');

const IMPL = {
  double: [
    'export async function double(input, io) {',
    '  const raw = input.amount;',
    '  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return { error: "Invalid" };',
    '  return { result: raw * 2 };',
    '}',
  ].join('\n'),
};

// A deterministic PRNG so a failing case is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('no input produces an internal error: valid doubles, invalid is 400', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  const rand = mulberry32(0xC0DE);
  try {
    const valid = [1, 0, 2, 10, 1000000];
    const invalid = [-1, 1.5, 'x', null, undefined, {}, [], 3.999];

    for (const amount of valid) {
      const res = await fetch(svc.base + '/v1/double', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      assert.equal(res.status, 201, 'valid amount ' + JSON.stringify(amount));
      const body = await res.json();
      assert.equal(body, Number(amount) * 2, 'doubles correctly');
    }

    for (const amount of invalid) {
      const res = await fetch(svc.base + '/v1/double', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      assert.equal(res.status, 400, 'invalid amount ' + JSON.stringify(amount) + ' is a declared error');
    }

    // Random fuzz: integers and floats of wildly different magnitudes.
    for (let i = 0; i < 200; i += 1) {
      const amount = Math.floor(rand() * 2e6) - 1e6 + (rand() < 0.5 ? 0 : rand() - 0.5);
      const res = await fetch(svc.base + '/v1/double', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      assert.ok(res.status !== 500, 'no internal error for amount ' + amount + ' (got ' + res.status + ')');
    }
  } finally {
    await svc.stop();
  }
});
