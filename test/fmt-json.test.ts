// A formatting gate needs the answer as data: the human line "<path>: not
// formatted" is a verdict a script would have to parse back out of prose. fmt
// now answers one object under --json, the same shape for a single file and a
// pattern, with the exit code unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const realWrite = process.stdout.write;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    if (typeof chunk !== 'string') return (realWrite as (...a: unknown[]) => boolean).apply(process.stdout, [chunk, enc, cb]);
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.stdout.write = realWrite;
    process.exitCode = before;
  }
}

const chat = await readFile(new URL('../examples/chat/main.arc', import.meta.url), 'utf8');

async function project(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-fmt-json-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'main.arc'), source, 'utf8');
  return dir;
}

test('fmt --check --json on one clean file says ok', async () => {
  const dir = await project(chat);
  try {
    const result = await run(['fmt', dir, '--check', '--json']);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.mode, 'check');
    assert.equal(report.ok, true);
    assert.equal(report.changed, 0);
    assert.equal(report.failed, 0);
    assert.deepEqual(report.files.map((f: { status: string }) => f.status), ['ok']);
    assert.match(report.files[0].file, /main\.arc$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fmt --check --json names the file that differs and exits 1', async () => {
  const dir = await project(chat.replace(/^service /m, 'service   '));
  try {
    const result = await run(['fmt', dir, '--check', '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.err, '');
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false);
    assert.equal(report.changed, 1);
    assert.deepEqual(report.files.map((f: { status: string }) => f.status), ['not formatted']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pattern answer has the same shape, and --write reports what it rewrote', async () => {
  const dir = await project(chat.replace(/^service /m, 'service   '));
  try {
    const pattern = join(dir, '*.arc');
    const check = await run(['fmt', pattern, '--check', '--json']);
    assert.equal(check.code, 1);
    assert.equal(JSON.parse(check.out).mode, 'check');
    assert.equal(JSON.parse(check.out).files.length, 1);

    const write = await run(['fmt', pattern, '--write', '--json']);
    assert.equal(write.code, 0, write.err);
    const report = JSON.parse(write.out);
    assert.equal(report.mode, 'write');
    assert.equal(report.ok, true);
    assert.deepEqual(report.files.map((f: { status: string }) => f.status), ['formatted']);

    const again = await run(['fmt', pattern, '--check', '--json']);
    assert.equal(again.code, 0, 'the rewrite left the file canonical');
    assert.equal(JSON.parse(again.out).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a broken spec is a failed entry, not a crash and not a clean file', async () => {
  const dir = await project('service chat {\n  route get /x {\n');
  try {
    const result = await run(['fmt', join(dir, '*.arc'), '--check', '--json']);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false);
    assert.equal(report.failed, 1);
    assert.equal(report.files[0].status, 'failed');
    assert.equal(typeof report.files[0].error, 'string');
    assert.equal(typeof report.files[0].line, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--json without a mode is a refusal, not canonical text', async () => {
  const dir = await project(chat);
  try {
    const single = await run(['fmt', dir, '--json']);
    assert.equal(single.code, 2);
    assert.equal(JSON.parse(single.out).error, '--json needs --check or --write');

    const pattern = await run(['fmt', join(dir, '*.arc'), '--json']);
    assert.equal(pattern.code, 2);
    assert.match(JSON.parse(pattern.out).error, /a pattern needs --check or --write/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
