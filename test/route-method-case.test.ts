// A070 looks the method up case-insensitively, so `route: "post /v1/x"` is a
// legal spec. The generated router compares the request method against ROUTES
// verbatim, so the written casing reached matchRoute as "post" and every
// request answered 404 — a spec that passed check, built, and served nothing.
// The remote client and the OpenAPI document already uppercase the method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const SPEC = [
  'module routecase @0.1.0 {',
  '}',
  '',
  'service Ping : http {',
  '  contract {',
  '    public op poke() -> { ok: bool } {',
  '      route: "post /v1/poke"',
  '      post: result != null',
  '    }',
  '',
  '    public op peek() -> { ok: bool } {',
  '      route: "Get /v1/peek"',
  '      post: result != null',
  '    }',
  '  }',
  '}',
].join('\n');

const IMPL = {
  poke: 'export async function poke() {\n  return { result: { ok: true } };\n}',
  peek: 'export async function peek() {\n  return { result: { ok: true } };\n}',
};

test('a lowercase route method still reaches its operation', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const posted = await fetch(svc.base + '/v1/poke', { method: 'POST' });
    assert.equal(posted.status, 201, 'the declared "post" answers a POST with a created result');
    assert.deepEqual(await posted.json(), { ok: true });

    const peeked = await fetch(svc.base + '/v1/peek', { method: 'GET' });
    assert.equal(peeked.status, 200, 'the declared "Get" answers a GET');

    // The casing is normalized, not loosened: the other method stays a miss.
    const wrong = await fetch(svc.base + '/v1/poke', { method: 'GET' });
    assert.equal(wrong.status, 404);
  } finally {
    await svc.stop();
  }
});
