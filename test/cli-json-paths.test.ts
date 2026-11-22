// Small, whole-command paths that no test walked: the JSON forms of plan and
// migrate, terraform on stdout (no --out), and `arcod impl` meeting a broken
// spec. Each is one line of output someone scripts against, and a silent change
// there is worse than a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

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

async function copyExample(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await cp(join(examplesDir, name), dir, { recursive: true });
  return dir;
}

test('plan --json prints the same plan the human form shows', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['plan', dir, '--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const parsed = JSON.parse(result.out) as { tasks?: unknown[] };
  assert.ok(Array.isArray(parsed.tasks) && parsed.tasks.length > 0, 'a plan carries tasks');
});

test('migrate --json is the machine form of the same run', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['migrate', dir, '--json']);
  assert.equal(result.code, 0, result.out + result.err);
  JSON.parse(result.out);
  // The human form ends with the artifact sentence; the JSON form must not
  // interleave it, or a parser chokes on the first line that is not JSON.
  assert.equal(/artifact: \.arcod\/build\/migrations/.test(result.out), false);
});

test('terraform without --out writes HCL to stdout', async () => {
  const dir = await copyExample('orders');
  const result = await run(['terraform', dir, '--env', 'prod']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /resource\s+"yandex_mdb_postgresql_cluster"/);
});

const BROKEN = [
  'module broken @0.1.0 {}',
  'service S : http {',
  '  roles: user',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/list"',
  '      roles: admin',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

test('impl refuses a broken spec before it spends a model call', async () => {
  const dir = await copyExample('tasks');
  await writeFile(join(dir, 'main.arc'), BROKEN, 'utf8');
  const result = await run(['impl', dir]);
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /A048/, 'the role that was never declared is named');
});
