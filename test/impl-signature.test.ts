// The emitter bundles a body as `async function impl<Op>(input, io)` and calls
// it with (input, io). A body written as `function totals(io)` is valid JS and
// used to pass build, then answered 500 `io.aggregate is not a function` at
// request time (issue #34): the sole parameter was the input, not io. The check
// and the build now name the file before a container starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const SPEC = `module sig @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-23"
  }
}

use capability arcod.std.sql @1

type Line = { id: string, amount: int }

service Lines : http {
  uses store: sql

  effects {
    allow store.aggregate
  }

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      effects: store.aggregate
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`;

const GOOD = 'export async function totals(input, io) {\n' +
  '  return { result: await io.aggregate("Line", { field: "amount", op: "sum" }) };\n' +
  '}\n';

const ONE_IO = 'export async function totals(io) {\n' +
  '  return { result: await io.aggregate("Line", { field: "amount", op: "sum" }) };\n' +
  '}\n';

function codes(source: string, impl: Record<string, string>): string[] {
  return check(parse(source, 'main.arc'), { impl })
    .filter((item) => item.code === 'A096')
    .map((item) => item.path ?? '');
}

test('A096: a body called (io) is refused with the file and the hint', () => {
  const diags = check(parse(SPEC, 'main.arc'), { impl: { totals: ONE_IO } });
  const found = diags.filter((item) => item.code === 'A096');
  assert.equal(found.length, 1, 'one signature, one diagnostic: ' + diags.map((item) => item.code).join(','));
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].file, 'impl/totals.mjs');
  assert.equal(found[0].range.line, 1);
  assert.match(found[0].message, /declares totals\(io\), but every operation body is called as \(input, io\)/);
  assert.match(String(found[0].hint), /first parameter is the input, the second is io/);
});

test('A096: the documented (input, io) signature stays clean', () => {
  assert.deepEqual(codes(SPEC, { totals: GOOD }), []);
});

test('A096: the export name must match the file the handler calls', () => {
  const wrong = GOOD.replace('function totals', 'function total');
  const found = check(parse(SPEC, 'main.arc'), { impl: { totals: wrong } })
    .filter((item) => item.code === 'A096');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /exports function "total", but the operation is "totals"/);
});

test('A096: io.* under another second-parameter name is still io', () => {
  const renamed = GOOD.replace('(input, io)', '(input, ctx)');
  const found = check(parse(SPEC, 'main.arc'), { impl: { totals: renamed } })
    .filter((item) => item.code === 'A096');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /reads io\.\* but its second parameter is "ctx"/);
});

test('the build refuses the same body with the file and line, not a stack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-sig-'));
  try {
    await writeFile(join(dir, 'main.arc'), SPEC);
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'totals.mjs'), ONE_IO);
    await assert.rejects(
      buildExample(parse(SPEC, 'main.arc'), dir, { implDir: join(dir, 'impl') }),
      /declares totals\(io\).*\(impl\/totals\.mjs:1\); declare totals\(input, io\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
