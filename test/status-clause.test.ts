// A POST answers 201 in the generated runtime because a write usually creates a
// resource. An idempotent action (cancel, replay) creates nothing, and the
// client read the 201 as "a new thing exists". The operation may declare its
// own success status; only a body-carrying 2xx is a success answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { formatSource } from '../src/fmt.ts';
import { startService } from './harness.ts';

const spec = [
  'module runs @0.1.0 {}',
  '',
  'error Invalid',
  '',
  'service Runs : http {',
  '  contract {',
  '    public op cancel(id: string) -> { id: string, state: string } {',
  '      route: "POST /v1/runs/:id/cancel"',
  '      status: 200',
  '      errors: Invalid',
  '    }',
  '',
  '    public op create(id: string) -> { id: string } {',
  '      route: "POST /v1/runs"',
  '      errors: Invalid',
  '    }',
  '',
  '    public op read(id: string) -> { id: string } {',
  '      route: "GET /v1/runs/:id"',
  '      status: 202',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  cancel: 'export async function cancel(input, io) {\n  return { result: { id: String(input.id), state: "cancelled" } };\n}',
  create: 'export async function create(input, io) {\n  return { result: { id: String(input.id) } };\n}',
  read: 'export async function read(input, io) {\n  return { result: { id: String(input.id) } };\n}',
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a declared status answers the success call, an undeclared one keeps the default', async () => {
  const svc = await startService(spec, { impl });
  try {
    const cancel = await post(svc.base + '/v1/runs/7/cancel', {});
    assert.equal(cancel.status, 200, 'the idempotent action says 200');
    assert.deepEqual(await cancel.json(), { id: '7', state: 'cancelled' });

    const create = await post(svc.base + '/v1/runs', { id: '8' });
    assert.equal(create.status, 201, 'a POST with no status stays 201');

    const read = await fetch(svc.base + '/v1/runs/9');
    assert.equal(read.status, 202, 'a GET may declare a status too');
    assert.deepEqual(await read.json(), { id: '9' });
  } finally {
    await svc.stop();
  }
});

test('fmt prints the clause back', () => {
  const source = spec;
  const printed = formatSource(source, 'main.arc');
  assert.match(printed, /status: 200/);
  assert.match(printed, /status: 202/);
  assert.equal(formatSource(printed, 'main.arc'), printed, 'the printing is idempotent');
});

function codes(source: string, code: string): Array<{ path: string; message: string }> {
  const mod = parse(source, 'main.arc');
  return check(mod)
    .filter((entry) => entry.code === code)
    .map((entry) => ({ path: entry.path ?? '', message: entry.message }));
}

function moduleWith(contract: string): string {
  return [
    'module s @0.1.0 {}',
    'service S : http {',
    '  contract {',
    contract,
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
}

test('A097 refuses a status that is not a body-carrying 2xx', () => {
  const nl = String.fromCharCode(10);
  const op = (name: string, path: string, status: number) =>
    ['    public op ' + name + '(id: string) -> { id: string } {', '      route: "POST /v1/' + path + '"', '      status: ' + status, '    }'].join(nl);
  const found = codes(moduleWith([op('a', 'a', 404), op('b', 'b', 500), op('c', 'c', 204), op('d', 'd', 200)].join(nl)), 'A097');

  assert.deepEqual(found.map((entry) => entry.path).sort(), [
    'services.S.contract.a',
    'services.S.contract.b',
    'services.S.contract.c',
  ]);
  assert.match(found[0].message, /not a success code/);
  assert.match(found.find((entry) => entry.path.endsWith('.c'))!.message, /has no body/);
});

test('a status the parser cannot read is a parse error, not a silent 200', () => {
  const nl = String.fromCharCode(10);
  assert.throws(() => parse(moduleWith(['    public op a(id: string) -> { id: string } {', '      route: "POST /v1/a"', '      status: "ok"', '    }'].join(nl)), 'main.arc'));
});
