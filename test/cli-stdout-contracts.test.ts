// Three commands print their whole result on stdout — `providers --json`,
// `graphql` and `grpc` without `--out`. A script pipes them, so a stray
// "wrote ..." line or a prose summary would break the caller; only the file
// form was tested. `providers --plugins --json` and the empty-answer case of
// `arcod test` are the same kind of contract. And `fmt` with a pattern that
// matches nothing must fail before it prints anything: exit 2 and one line on
// stderr, not a silent "ok" (the mistake a commit message made on 2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

async function emptyProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-stdout-'));
  await mkdir(join(dir, '.arcod', 'plugins'), { recursive: true });
  return dir;
}

async function copyExample(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-stdout-'));
  await cp(join(examplesDir, name), dir, { recursive: true });
  return dir;
}

async function inDir<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  const savedPath = process.env.ARC_PLUGIN_PATH;
  try {
    delete process.env.ARC_PLUGIN_PATH;
    process.chdir(dir);
    return await body();
  } finally {
    process.chdir(before);
    if (savedPath === undefined) delete process.env.ARC_PLUGIN_PATH;
    else process.env.ARC_PLUGIN_PATH = savedPath;
  }
}

test('providers --json is one bare array, and every row carries the declared bind options', async () => {
  const dir = await emptyProject();
  const result = await inDir(dir, () => run(['providers', '--json']));
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trimStart().startsWith('['), true, 'stdout is the array, with no prose around it');
  const rows = JSON.parse(result.out) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows) && rows.length > 0, 'the built-in registry is listed');
  for (const row of rows) {
    assert.equal(typeof row.capability, 'string');
    assert.equal(typeof row.provider, 'string');
    assert.ok(Array.isArray(row.env), row.provider + ' lists its env names');
    assert.ok(Array.isArray(row.options), row.provider + ' carries options: the README promises it for --json');
    assert.ok(row.origin === null || typeof row.origin === 'string', row.provider + ' has no declaring package or names it');
  }
  const redis = rows.find((row) => row.provider === 'redis');
  assert.ok(redis, 'redis is in the registry');
  assert.equal(redis.capability, 'kv');
  assert.equal(redis.origin, null, 'a built-in has no declaring package');
  assert.ok((redis.env as string[]).includes('REDIS_URL'));
});

test('graphql without --out prints the SDL, and writes no file', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['graphql', dir]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^type Query \{/m);
  assert.match(result.out, /^type Mutation \{/m);
  assert.equal(result.out.includes('wrote '), false, 'no file was written, so no "wrote" line');
});

test('grpc without --out prints the proto, and writes no file', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['grpc', dir]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^syntax = "proto3";/m);
  assert.match(result.out, /^service TaskBoard \{/m);
  assert.equal(result.out.includes('wrote '), false, 'no file was written, so no "wrote" line');
});

test('providers --plugins --json is one bare object even with nothing installed', async () => {
  const dir = await emptyProject();
  const result = await inDir(dir, () => run(['providers', '--plugins', '--json']));
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trimStart().startsWith('{'), true, 'stdout is the object, with no prose around it');
  assert.deepEqual(JSON.parse(result.out), { plugins: [], issues: [] });
});

test('fmt on a pattern that matches nothing fails with exit 2 and one stderr line', async () => {
  const dir = await emptyProject();
  const result = await inDir(dir, () => run(['fmt', 'zzz-nope-*.arc', '--check']));
  assert.equal(result.code, 2);
  assert.equal(result.out, '', 'nothing is formatted, so nothing is printed on stdout');
  assert.equal(result.err, 'arcod: no files match zzz-nope-*.arc');
});

test('test refuses a spec with a check error before it builds anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-stdout-'));
  await writeFile(join(dir, 'main.arc'), [
    'module bad @0.1.0 {}',
    '',
    'type Weird = float128',
    '',
    'service S : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /v1/ping"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  const result = await run(['test', dir]);
  assert.equal(result.code, 1);
  // Diagnostics, like every other command's, go to stdout; stderr stays empty.
  assert.match(result.out, /A088 {2}unknown type float128/);
  assert.match(result.out, /1 error\(s\), 0 warning\(s\)/);
  assert.equal(result.err, '');
  assert.equal(result.out.includes('examples:'), false, 'no example report is printed for a spec that does not pass check');
});
