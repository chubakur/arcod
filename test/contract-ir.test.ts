// The contract IR is the layer Go (B107) and Python (B108) kits read instead of
// copying the Node emitter. These tests pin the parts both languages must agree
// on: how a route splits, which scalars a URL carries as text, and the order an
// emitter walks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractOps, inputKinds, parseRoute } from '../src/emit/contract.ts';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const SPEC = `module ir @0.1.0 {}

type Count = int

service Api : http {
  uses db: kv
  effects {
    allow db.set
  }
  contract {
    public op create(count: Count, done: bool, note: string) -> Count {
      route: "post /v1/items/:id"
    }

    public op read(id: string) -> Count {
      route: "GET /v1/items/:id"
    }

  }
}

environment dev {
  bind db -> mysql
  deploy docker
}
`;

test('parseRoute: the method is uppercase whatever the spec wrote', () => {
  const mod = parse(SPEC, 'main.arc');
  const api = mod.services[0];
  const [create, read] = api.contract;
  assert.deepEqual(parseRoute(create), { method: 'POST', path: '/v1/items/:id' });
  assert.deepEqual(parseRoute(read), { method: 'GET', path: '/v1/items/:id' });
});

test('parseRoute: no route clause is null, not a guess', () => {
  const mod = parse('module bare @0.1.0 {}\n\nservice Api : http {\n  contract {\n    public op ping() -> string { }\n  }\n}\n', 'bare.arc');
  assert.equal(parseRoute(mod.services[0].contract[0]), null);
});

test('inputKinds: URL-carried scalars only, aliases resolved', () => {
  const mod = parse(SPEC, 'main.arc');
  const create = mod.services[0].contract[0];
  assert.deepEqual(inputKinds(mod, create), { count: 'int', done: 'bool' });
});

test('contractOps: declaration order is kept and a route-less op is not invented', () => {
  const mod = parse(SPEC, 'main.arc');
  const ops = contractOps(mod, mod.services[0].contract);
  assert.deepEqual(ops.map((op) => op.name), ['create', 'read']);
  assert.deepEqual(ops[0].route, { method: 'POST', path: '/v1/items/:id' });
  assert.deepEqual(ops[1].inputKinds, {});
});

test('the Node emitter publishes the IR its table describes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ir-'));
  try {
    await mkdir(join(dir, 'impl'), { recursive: true });
    await writeFile(join(dir, 'impl', 'create.mjs'), 'export async function create(input, io) {\n  return input.count;\n}\n');
    const result = await buildExample(parse(SPEC, 'main.arc'), dir, { port: 8080 });
    const emitted = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    const mod = parse(SPEC, 'main.arc');
    const expected = Object.fromEntries(
      contractOps(mod, mod.services[0].contract)
        .filter((op) => Object.keys(op.inputKinds).length > 0)
        .map((op) => [op.name, op.inputKinds]),
    );
    assert.match(emitted, /const INPUT_KINDS = /);
    for (const [op, kinds] of Object.entries(expected)) {
      assert.match(emitted, new RegExp('"' + op + '": \\{[^}]*"' + Object.keys(kinds)[0] + '"'));
    }
    assert.deepEqual(expected, { create: { count: 'int', done: 'bool' } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
