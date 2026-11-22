// Commands that emit infrastructure or DDL check the model first and refuse a
// broken spec with a diagnostic, not a stack trace. The upgrade path also has a
// no-op line for a spec already at the target version. None of the three was
// covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

interface Result {
  out: string;
  err: string;
  code: number;
}

async function run(argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

const BROKEN = [
  'module m @0.1.0 {}',
  'service S : http {',
  '  roles: user',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/list"',
  '      roles: user',
  '    }',
  '  }',
  '}',
].join(String.fromCharCode(10));

async function project(spec: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-errors-'));
  await writeFile(join(dir, 'main.arc'), spec + String.fromCharCode(10), 'utf8');
  return dir;
}

test('terraform refuses a spec with an error and names it', async () => {
  const dir = await project(BROKEN);
  const result = await run(['terraform', join(dir, 'main.arc')]);
  assert.equal(result.code, 1, result.out);
  // Diagnostics go to stdout — the same stream a clean run reports on.
  assert.match(result.out, /A048/);
  assert.equal(result.out.includes('resource '), false, 'no plan is printed for a broken spec');
});

test('migrate refuses a spec with an error and names it', async () => {
  const dir = await project(BROKEN);
  const result = await run(['migrate', join(dir, 'main.arc')]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /A048/);
  assert.equal(result.out.includes('CREATE TABLE'), false, 'no DDL is printed for a broken spec');
});

test('upgrade says a spec is already at the target version', async () => {
  const dir = await project('module m @0.1.0 {}');
  const result = await run(['upgrade', join(dir, 'main.arc'), '--to', '0.1.0']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /: already at 0\.1\.0$/m);
});
