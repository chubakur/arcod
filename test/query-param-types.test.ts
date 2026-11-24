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
  '// An alias is the declared type: the table resolves it, not the spelling.',
  'type Qty = int(min: 1)',
  'type On = bool',
  '',
  'service Shop : http {',
  '  contract {',
  '    public op find(flag: bool, limit: int(min: 1, max: 5), ratio: decimal(min: 0.1, max: 0.9)) -> string {',
  '      route: "GET /v1/find"',
  '    }',
  '    public op item(id: int, ratio: decimal) -> string {',
  '      route: "GET /v1/item/:id"',
  '    }',
  '    public op count(n: Qty, on: On) -> string {',
  '      route: "GET /v1/count"',
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
  count: [
    'export async function count(input) {',
    '  return { result: JSON.stringify({ n: input.n, nType: typeof input.n, on: input.on, onType: typeof input.on }) };',
    '}',
  ].join('\n'),
  item: [
    'export async function item(input) {',
    '  return { result: JSON.stringify({ id: input.id, idType: typeof input.id, ratio: input.ratio, ratioType: typeof input.ratio }) };',
    '}',
  ].join('\n'),
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

// A ':id' capture is a URL string too: an int path parameter is a number in
// the impl, and a segment that is not one is refused before the body runs.
test('a path parameter arrives with its declared type', async () => {
  const ok = await fetch(svc.base + '/v1/item/7?ratio=0.25');
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(await ok.text()), { id: 7, idType: 'number', ratio: 0.25, ratioType: 'number' });

  const bad = await fetch(svc.base + '/v1/item/seven?ratio=0.25');
  assert.equal(bad.status, 400, 'an int path segment is not text the impl has to parse');
  assert.match(await bad.text(), /id must be an integer/);
});

test('an alias of a scalar is coerced like the scalar itself', async () => {
  const ok = await fetch(svc.base + '/v1/count?n=4&on=false');
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(await ok.text()), { n: 4, nType: 'number', on: false, onType: 'boolean' });

  const bad = await fetch(svc.base + '/v1/count?n=4.5&on=true');
  assert.equal(bad.status, 400, 'Qty is an int(min: 1), so a fraction is refused by the alias bounds');
  assert.match(await bad.text(), /n must be an integer/);
});

// Runs last: the process under test is shared by the assertions above.
test.after(async () => {
  await svc.stop();
});
