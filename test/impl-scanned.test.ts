// W052 is the missing-directory half of W050: a project whose impl/ was never
// created answered 501 NotImplemented on every route and check said nothing,
// so "forgot the bodies" and "has not started" looked the same. One warning
// per service; a project with some bodies keeps the per-operation W050.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';
import { main } from '../src/cli.ts';

const SOURCE = `module scanned @0.1.0 {}

type Line = { id: string, amount: int }

use capability arcod.std.sql @1

service Lines : http {
  uses store: sql

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
    }

    public op audit() -> int {
      route: "GET /v1/audit"
    }
  }
}

environment dev {
  bind store -> postgres
}
`;

function codes(source: string, impl: Record<string, string> | undefined, implScanned?: boolean) {
  return check(parse(source, 'main.arc'), { impl, implScanned }).filter((item) => item.code === 'W050' || item.code === 'W052');
}

test('W052: no impl/ warns once, naming the service', () => {
  const diags = codes(SOURCE, undefined, true);
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.equal(diags[0].code, 'W052');
  assert.equal(diags[0].severity, 'warning');
  assert.match(diags[0].message, /service Lines has no body in impl\//);
});

test('W052: a caller that did not scan impl/ gets no warning', () => {
  assert.deepEqual(codes(SOURCE, undefined, false), []);
  assert.deepEqual(codes(SOURCE, undefined), []);
});

test('W050 stays per operation when some bodies exist', () => {
  const diags = codes(SOURCE, { totals: 'export async function totals() { return { result: 1 }; }' }, true);
  assert.deepEqual(diags.map((item) => item.code), ['W050']);
  assert.equal(diags[0].path, 'services.Lines.ops.audit');
});

// The directory is what makes the difference, so the CLI has to inspect it:
// a project with no impl/ and one with an empty impl/ answer the same warning.
async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

test('check warns once for a project with no impl/ and for an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-w052-'));
  try {
    const spec = join(dir, 'main.arc');
    await writeFile(spec, SOURCE, 'utf8');
    const missing = await run(['check', spec]);
    assert.equal(missing.code, 0, missing.err);
    assert.equal((missing.out.match(/W052/g) ?? []).length, 1, missing.out);
    assert.match(missing.out, /service Lines has no body in impl\//);

    await mkdir(join(dir, 'impl'));
    const empty = await run(['check', spec]);
    assert.equal(empty.code, 0, empty.err);
    assert.equal((empty.out.match(/W052/g) ?? []).length, 1, empty.out);

    await writeFile(join(dir, 'impl', 'totals.mjs'), 'export async function totals() { return { result: 1 }; }', 'utf8');
    const partial = await run(['check', spec]);
    assert.doesNotMatch(partial.out, /W052/);
    assert.match(partial.out, /W050/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
