// A query string carries no types. The boundary used to hand the impl the raw
// text ("3", "true") for a parameter whose contract says int/bool, while the
// same parameter in a JSON body arrived typed — one contract, two shapes, and
// an impl that added 1 to a limit got "31". The boundary now maps the query
// form back to the declared scalar and refuses a value that is not one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module querytypes @0.1.0 {}',
  '',
  'service Shop : http {',
  '  contract {',
  '    public op find(flag: bool, limit: int(min: 1, max: 5), ratio: decimal(min: 0.1, max: 0.9)) -> string {',
  '      route: "GET /v1/find"',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  deploy docker',
  '}',
].join('\n');

// The body echoes what the impl actually received: the value and its runtime
// type, so a string that only looks like a number cannot pass.
const impl = {
  find: [
    'export async function find(input) {',
    '  return { result: JSON.stringify({',
    '    flag: input.flag, flagType: typeof input.flag,',
    '    limit: input.limit, limitType: typeof input.limit,',
    '    ratio: input.ratio, ratioType: typeof input.ratio,',
    '  }) };',
    '}',
  ].join('\n'),
};

const svc = await startService(spec, { impl });

async function get(query: string): Promise<{ status: number; body: string }> {
  const res = await fetch(svc.base + '/v1/find?' + query);
  return { status: res.status, body: await res.text() };
}

test('a query parameter reaches the impl with its declared type', async () => {
  const typed = await get('flag=true&limit=3&ratio=0.5');
  assert.equal(typed.status, 200);
  const seen = JSON.parse(typed.body) as Record<string, unknown>;
  assert.deepEqual(seen, { flag: true, flagType: 'boolean', limit: 3, limitType: 'number', ratio: 0.5, ratioType: 'number' });

  const off = await get('flag=false&limit=3&ratio=0.5');
  assert.equal((JSON.parse(off.body) as Record<string, unknown>).flag, false, 'false is a value, not a missing one');
});

test('a query value that is not the declared type is refused, naming it', async () => {
  const maybe = await get('flag=maybe&limit=3&ratio=0.5');
  assert.equal(maybe.status, 400);
  assert.match(maybe.body, /flag must be true or false/);

  const fraction = await get('flag=true&limit=3.5&ratio=0.5');
  assert.equal(fraction.status, 400, 'an int query parameter is not a float');
  assert.match(fraction.body, /limit must be an integer/);

  const text = await get('flag=true&limit=abc&ratio=0.5');
  assert.equal(text.status, 400);
  assert.match(text.body, /limit must be an integer/, 'text is not a whole number either');

  const empty = await get('flag=&limit=3&ratio=0.5');
  assert.equal(empty.status, 400, 'an empty bool is not a bool');
});

test('the declared bounds still see a number, not a string', async () => {
  const tooBig = await get('flag=true&limit=9&ratio=0.5');
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body, /limit must be <= 5/);
  const tooSmall = await get('flag=true&limit=3&ratio=0.05');
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.body, /ratio must be >= 0.1/);
});

test('an undeclared query parameter is ignored', async () => {
  const extra = await get('flag=true&limit=3&ratio=0.5&extra=1');
  assert.equal(extra.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(extra.body) as object).sort(), ['flag', 'flagType', 'limit', 'limitType', 'ratio', 'ratioType']);
});

// Runs last: the process under test is shared by the assertions above.
test.after(async () => {
  await svc.stop();
});
