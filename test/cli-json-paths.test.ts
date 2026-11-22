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

// The reference gap — no demo body for an operation the create/read templates
// do not cover — used to answer --json with two prose lines and an empty stdout.
// Every other failure above is data, so this one is too.
async function bareExample(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await cp(join(examplesDir, 'tasks-sql', 'main.arc'), join(dir, 'main.arc'));
  return dir;
}

test('build --json reports the reference gap as data', async () => {
  const dir = await bareExample();
  const result = await run(['build', dir, '--reference', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '', 'a parser reads stdout; the failure is not prose');
  const parsed = JSON.parse(result.out) as { error?: string; missing?: string[]; advice?: string };
  assert.match(parsed.error ?? '', /^no operation bodies to build: --reference covers only create and read\.$/);
  assert.deepEqual(parsed.missing, ['list', 'move'], 'the operations without a body are named');
  assert.match(parsed.advice ?? '', /impl\/list\.mjs/);
});

test('test --json keeps the report shape when the reference gap stops it', async () => {
  const dir = await bareExample();
  const result = await run(['test', dir, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '');
  const parsed = JSON.parse(result.out) as { examples?: unknown[]; rules?: unknown[]; missing?: string[]; advice?: string };
  assert.deepEqual(parsed.examples, [], 'a failed run is still an empty report');
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(parsed.missing, ['list', 'move']);
  assert.match(parsed.advice ?? '', /arcod impl/);
});


// A spec that does not check stops build before anything is emitted. The
// diagnostics used to go to stdout as prose even under --json, so a CI gate
// that parsed the output got an empty report and a printed hint.
test('build --json answers check errors with their diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await writeFile(join(dir, 'main.arc'), [
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
  ].join(String.fromCharCode(10)), 'utf8');
  const result = await run(['build', dir, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '', 'the failure is data, not a printed line');
  const parsed = JSON.parse(result.out) as { error?: string; diagnostics?: Array<{ code: string; message: string }> };
  assert.equal(parsed.error, 'check failed');
  assert.deepEqual((parsed.diagnostics ?? []).map((d) => d.code), ['A046', 'A048']);
  assert.match(parsed.diagnostics?.[0]?.message ?? '', /identity capability/);
});


// The shared refusal: every command that reads a contract answers the same
// object when the spec does not check. migrate, prompts and impl printed prose
// under --json while build and test already answered data.
test('migrate, prompts and impl answer check errors as the shared object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await writeFile(join(dir, 'main.arc'), [
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
  ].join(String.fromCharCode(10)), 'utf8');
  for (const command of ['migrate', 'prompts', 'impl']) {
    const result = await run([command, dir, '--json']);
    assert.equal(result.code, 1, command + ': ' + result.out + result.err);
    assert.equal(result.err, '', command + ' prints no prose');
    const parsed = JSON.parse(result.out) as { error?: string; diagnostics?: Array<{ code: string }> };
    assert.equal(parsed.error, 'check failed', command);
    assert.deepEqual((parsed.diagnostics ?? []).map((d) => d.code), ['A046', 'A048'], command);
  }
});
