// `string(min:, max:)` is a length. The schema said minLength/maxLength but
// the service accepted "ab" and "abcdef" anyway: the arguments reached OpenAPI
// and stopped there. Now the boundary and A060 read the same resolver, and a
// length counts code points, so a limit means characters, not UTF-16 units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { startService } from './harness.ts';

const source = [
  'module demo @0.1.0 {',
  '}',
  '',
  'service Accounts : http {',
  '  contract {',
  '    public op create(name: string(min: 3, max: 5)) -> { name: string } {',
  '      route: "POST /v1/accounts"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const impl = 'export async function create(input) { return { result: { name: String(input.name) } }; }';

async function post(body: unknown) {
  const svc = await startService(source, { impl: { create: impl } });
  try {
    const res = await fetch(svc.base + '/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await svc.stop();
  }
}

test('a string bound reaches the OpenAPI parameter as a length', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const param = (doc.paths as any)['/v1/accounts'].post.requestBody.content['application/json'].schema.properties.name;
  assert.deepEqual(param, { type: 'string', minLength: 3, maxLength: 5 });
});

test('the service rejects a value shorter or longer than the bound', async () => {
  assert.deepEqual(check(parse(source, 'main.arc')).filter((item) => item.severity === 'error'), []);
  const short = await post({ name: 'ab' });
  assert.equal(short.status, 400);
  assert.match(short.text, /name must be at least 3 characters/);
  const ok = await post({ name: 'abc' });
  assert.equal(ok.status, 201);
  const long = await post({ name: 'abcdef' });
  assert.equal(long.status, 400);
  assert.match(long.text, /name must be at most 5 characters/);
});

test('a length counts characters, not UTF-16 units', async () => {
  const svc = await startService(source, { impl: { create: impl } });
  try {
    const res = await fetch(svc.base + '/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '🙂🙂🙂🙂🙂' }),
    });
    assert.equal(res.status, 201, 'five code points fit max: 5 even though they are ten UTF-16 units');
  } finally {
    await svc.stop();
  }
});

test('a non-string value is named as such', async () => {
  const res = await post({ name: 5 });
  assert.equal(res.status, 400);
  assert.match(res.text, /name must be a string/);
});

test('a default outside a string bound is A060', () => {
  const a060 = (field: string) => check(parse('module m @0.1.0 {\n}\ntype Item = { ' + field + ' }', 'x.arc'))
    .filter((diag) => diag.code === 'A060');
  const short = a060('name: string(min: 3) = "ab"');
  assert.equal(short.length, 1);
  assert.match(short[0].message, /must be at least 3 characters/);
  const long = a060('name: string(max: 5) = "abcdef"');
  assert.equal(long.length, 1);
  assert.match(long[0].message, /must be at most 5 characters/);
  assert.deepEqual(a060('name: string(min: 3, max: 5) = "abcd"'), []);
});
