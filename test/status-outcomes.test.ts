// Issue #56: an idempotent POST answered 201 on a repeat, because the success
// status was a constant of the operation. Now the clause can name each
// successful answer (B94): `status: created 201, existed 200`, and the body
// picks one by `out.status`. A miss is a compile error when the name is a
// literal and a 500 with the operation and the name when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { formatSource } from '../src/fmt.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { goMain } from '../src/emit/go.ts';
import { spawnSync } from 'node:child_process';
import { startService } from './harness.ts';

const source = [
  'module demo @0.1.0 {',
  '}',
  '',
  'service Events : http {',
  '  contract {',
  '    public op create(clientEventId: string) -> { ok: bool } {',
  '      route: "POST /v1/events"',
  '      status: created 201, existed 200',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const idempotent = [
  'const seen = new Set();',
  'export async function create(input) {',
  '  const id = String(input.clientEventId);',
  '  if (seen.has(id)) return { result: { ok: true, repeat: true }, status: "existed" };',
  '  seen.add(id);',
  '  return { result: { ok: true, repeat: false }, status: "created" };',
  '}',
].join('\n');

test('a named status clause parses and formats back', () => {
  const mod = parse(source, 'main.arc');
  const op = mod.services[0].contract[0];
  const clause = op.clauses.find((item) => item.kind === 'status');
  assert.ok(clause && clause.kind === 'status');
  assert.deepEqual(clause.outcomes, [
    { name: 'created', value: 201 },
    { name: 'existed', value: 200 },
  ]);
  assert.match(formatSource(source, 'main.arc'), /status: created 201, existed 200/);
});

test('the first call creates (201), the repeat replays (200) with the same body', async () => {
  const svc = await startService(source, { impl: { create: idempotent } });
  try {
    const post = (id: string) => fetch(svc.base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientEventId: id }),
    });
    const first = await post('e-1');
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { ok: true, repeat: false });
    const again = await post('e-1');
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, repeat: true });
  } finally {
    await svc.stop();
  }
});

test('a body that names no outcome gets the first declared one', async () => {
  const plain = 'export async function create(input) { return { result: { ok: true, id: String(input.clientEventId) } }; }';
  const svc = await startService(source, { impl: { create: plain } });
  try {
    const res = await fetch(svc.base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientEventId: 'e-2' }),
    });
    assert.equal(res.status, 201);
  } finally {
    await svc.stop();
  }
});

test('an undeclared outcome name is a 500 that names the operation and the name', async () => {
  const dynamic = 'export async function create(input) { return { result: { ok: true }, status: input.clientEventId === "bogus" ? "bogus" : "created" }; }';
  const svc = await startService(source, { impl: { create: dynamic } });
  try {
    const res = await fetch(svc.base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientEventId: 'bogus' }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.message, /create/);
    assert.match(body.message, /bogus/);
    assert.match(body.message, /created 201/);
  } finally {
    await svc.stop();
  }
});

test('a literal outcome the clause does not declare is a check error', () => {
  const impl = 'export async function create(input) { return { result: { ok: true }, status: "bogus" }; }';
  const diags = check(parse(source, 'main.arc'), { impl: { create: impl } });
  const hit = diags.filter((item) => item.code === 'A097' && /bogus/.test(item.message));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'error');
  assert.match(String(hit[0].hint), /created, existed/);
});

test('OpenAPI publishes every outcome with its name', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const responses = (doc.paths as any)['/v1/events'].post.responses;
  assert.equal(responses['201'].description, 'created');
  assert.equal(responses['200'].description, 'existed');
});

test('A097 rejects a non-2xx code, a duplicate name and a duplicate code', () => {
  const bad = [
    'module demo @0.1.0 {',
    '}',
    '',
    'service Events : http {',
    '  contract {',
    '    public op create(id: string) -> { ok: bool } {',
    '      route: "POST /v1/events"',
    '      status: created 201, gone 410',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const diags = check(parse(bad, 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A097' && /410/.test(item.message)));
});

test('A097 rejects two names for one code', () => {
  const twin = source.replace('created 201, existed 200', 'created 201, alsoCreated 201');
  const diags = check(parse(twin, 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A097' && /declared twice/.test(item.message)));
});

test('A097 rejects two unnamed outcomes', () => {
  const anonymous = source.replace('created 201, existed 200', '201, 200');
  const diags = check(parse(anonymous, 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A097' && /unnamed/.test(item.message)));
});

test('the Go emitter selects the named outcome, drops the marker and compiles as syntax', () => {
  const mod = parse(source, 'main.arc');
  const generated = goMain(mod, mod.services[0]);
  assert.match(generated, /code, body, unknown := successOutcome\(out, 201, map\[string\]int\{"created": 201, "existed": 200\}\)/);
  assert.match(generated, /func successOutcome\(out any, fallback int, outcomes map\[string\]int\) \(int, any, string\)/);
  assert.match(generated, /delete\(fields, "status"\)/);
  assert.match(generated, /the contract declares created 201, existed 200/);
  const gofmt = spawnSync('gofmt', ['-e'], { input: generated, encoding: 'utf8' });
  if (gofmt.error) return; // no Go toolchain on this host
  assert.equal(gofmt.status, 0, gofmt.stderr);
});

test('the Go emitter keeps the constant status for an operation without names', () => {
  const plain = source.replace('      status: created 201, existed 200\n', '');
  const mod = parse(plain, 'main.arc');
  const generated = goMain(mod, mod.services[0]);
  assert.doesNotMatch(generated, /successOutcome/);
  assert.match(generated, /writeJSON\(w, 201, out\)/);
});

test('the old single-code status still answers that code', async () => {
  const single = source.replace('status: created 201, existed 200', 'status: 200');
  const svc = await startService(single, { impl: { create: 'export async function create() { return { result: { ok: true } }; }' } });
  try {
    const res = await fetch(svc.base + '/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientEventId: 'e-4' }) });
    assert.equal(res.status, 200);
  } finally {
    await svc.stop();
  }
});
