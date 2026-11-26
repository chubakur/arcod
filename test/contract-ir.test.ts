// The contract IR is the layer Go (B107) and Python (B108) kits read instead of
// copying the Node emitter. These tests pin the parts both languages must agree
// on: how a route splits, which scalars a URL carries as text, and the order an
// emitter walks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractOps, inputKinds, parseRoute, successStatus } from '../src/emit/contract.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
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

const DELETE_SPEC = `module del @0.1.0 {}

service Api : http {
  uses db: kv
  contract {
    public op remove(id: string) -> string {
      route: "DELETE /v1/items/:id"
      effects: db.set
    }
  }
}

environment dev {
  bind db -> mysql
}
`;

test('successStatus: a read is 200, a write or delete 201, a declared status wins', () => {
  const mod = parse(SPEC, 'main.arc');
  const remove = parse(DELETE_SPEC, 'del.arc').services[0].contract[0];
  assert.equal(successStatus(remove), 201);
  assert.equal(successStatus(mod.services[0].contract[0]), 201);
  const declared = parse('module d @0.1.0 {}\n\nservice Api : http {\n  contract {\n    public op cancel() -> string {\n      route: "POST /v1/cancel"\n      status: 202\n    }\n  }\n}\n', 'd.arc');
  assert.equal(successStatus(declared.services[0].contract[0]), 202);
});

test('the runtime and OpenAPI answer a DELETE with the same status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ir-del-'));
  try {
    await mkdir(join(dir, 'impl'), { recursive: true });
    await writeFile(join(dir, 'impl', 'remove.mjs'), 'export async function remove(input, io) {\n  return "ok";\n}\n');
    const mod = parse(DELETE_SPEC, 'del.arc');
    const result = await buildExample(mod, dir, { port: 8080 });
    const emitted = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    assert.match(emitted, /callImpl\(req, res, params, implRemove, \['id'\], 201, 'remove'\)/);
    const openapi = emitOpenapi(mod) as { paths: Record<string, { delete: { responses: Record<string, unknown> } }> };
    assert.deepEqual(Object.keys(openapi.paths['/v1/items/{id}'].delete.responses), ['201']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
