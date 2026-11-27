// A string result is what the contract declares (`-> string`) and what OpenAPI
// promises (a `text/plain` body). The runtime had a second rule for it: any
// 201 answer wrapped the string in the one-time-message envelope
// `{ id, expiresIn }`, so a client generated from the schema parsed an object
// where the spec said string. The `status` clause is the way out — a POST that
// declares `status: 200` gets its declared string back, body and content-type
// alike. Both halves are pinned here: the escape hatch, and the default that
// B60/DECISIONS (2026-11-22) still asks the owner about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { startService } from './harness.ts';

const lines = [
  'module Echo @0.1.0 {}',
  '',
  'service Echo : http {',
  '  contract {',
  '    public op hello() -> string {',
  '      route: "POST /v1/hello"',
  '      status: 200',
  '    }',
  '',
  '    public op shout() -> string {',
  '      route: "POST /v1/shout"',
  '    }',
  '',
  '    public op peek() -> string {',
  '      route: "GET /v1/peek"',
  '    }',
  '  }',
  '}',
  '',
];
const spec = lines.join(String.fromCharCode(10));

const impl = {
  hello: 'export async function hello(input, io) {\n  return { result: \"HELLO\" };\n}',
  shout: 'export async function shout(input, io) {\n  return { result: \"HELLO\" };\n}',
  peek: 'export async function peek(input, io) {\n  return { result: \"HELLO\" };\n}',
};

const post = (url: string) => fetch(url, { method: 'POST' });

test('a declared status gives a POST its declared string back, as text and as schema', async () => {
  const svc = await startService(spec, { impl });
  try {
    const hello = await post(svc.base + '/v1/hello');
    assert.equal(hello.status, 200, 'the declared status wins over the write default');
    assert.match(hello.headers.get('content-type') || '', /text\/plain/);
    assert.equal(await hello.text(), 'HELLO');

    const peek = await fetch(svc.base + '/v1/peek');
    assert.equal(peek.status, 200);
    assert.equal(await peek.text(), 'HELLO');
  } finally {
    await svc.stop();
  }
});

// B60: the envelope is one-time-message semantics, not "any write". An op that
// declares Gone says the value expires and a second read is an error; only
// there does `{ id, expiresIn }` describe the answer. Everything else answers
// the declared string, which is what OpenAPI has always promised.
test('a POST with no status answers its declared string, not the envelope', async () => {
  const svc = await startService(spec, { impl });
  try {
    const shout = await post(svc.base + '/v1/shout');
    assert.equal(shout.status, 201);
    assert.match(shout.headers.get('content-type') || '', /text\/plain/);
    assert.equal(await shout.text(), 'HELLO');
  } finally {
    await svc.stop();
  }
});

const oneTimeLines = [
  'module One @0.1.0 {}',
  '',
  'error Gone',
  '',
  'service One : http {',
  '  contract {',
  '    public op issue() -> string {',
  '      route: "POST /v1/issue"',
  '      errors: Gone',
  '    }',
  '  }',
  '}',
  '',
];
const oneTimeSpec = oneTimeLines.join(String.fromCharCode(10));
const oneTimeImpl = {
  issue: 'export async function issue(input, io) {\n  return { result: \"TICKET\" };\n}',
};

test('an op that declares Gone keeps the one-time-message envelope', async () => {
  const svc = await startService(oneTimeSpec, { impl: oneTimeImpl });
  try {
    const res = await post(svc.base + '/v1/issue');
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, 'TICKET');
    assert.equal(typeof body.expiresIn, 'number');
  } finally {
    await svc.stop();
  }
});

test('openapi promises the string body the declared status answers', () => {
  const doc = emitOpenapi(parse(spec, 'echo.arcod')) as any;
  const hello = doc.paths['/v1/hello'].post.responses['200'];
  assert.equal(hello.content['text/plain'].schema.type, 'string', 'the declared status keeps a plain string body');
});
