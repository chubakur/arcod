// `--out` is a file path for the single-file emitters, a directory for k8s and
// terraform, and a user gets that wrong. The answer used to be Node's own
// "EISDIR: illegal operation on a directory, open '...'" — a syscall, not a
// fix. `adopt` already translates a missing input, so the write side speaks
// the same way and names the mistake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-write-'));
  await cp(join(examplesDir, 'tasks-sql'), dir, { recursive: true });
  return dir;
}

test('grpc --out on a directory says so instead of leaking EISDIR', async () => {
  const dir = await project();
  await mkdir(join(dir, 'schema'), { recursive: true });
  const result = await run(['grpc', dir, '--out', 'schema']);
  assert.equal(result.code, 1);
  assert.match(result.err, /^arcod: cannot write .*schema: is a directory \(pass a file path\)$/m);
  assert.equal(result.err.includes('EISDIR'), false, 'the syscall name is not the message');
  assert.equal(result.out, '', 'nothing was written, so no "wrote" line');
});

test('openapi --out on a directory uses the same wording', async () => {
  const dir = await project();
  await mkdir(join(dir, 'api'), { recursive: true });
  const result = await run(['openapi', dir, '--out', 'api']);
  assert.equal(result.code, 1);
  assert.match(result.err, /^arcod: cannot write .*api: is a directory \(pass a file path\)$/m);
  assert.equal(result.out, '');
});

test('k8s --out on a file names the parent, not the leaf', async () => {
  const dir = await project();
  await writeFile(join(dir, 'blockfile'), 'x', 'utf8');
  const result = await run(['k8s', dir, '--out', join(dir, 'blockfile')]);
  assert.equal(result.code, 1);
  assert.match(result.err, /^arcod: cannot write .*blockfile\/.*: a parent path is a file, not a directory$/m);
  assert.equal(result.out, '', 'the "wrote N file(s)" line is not printed for a failed write');
});

test('a nested --out still creates its tree and writes the file', async () => {
  const dir = await project();
  const result = await run(['grpc', dir, '--out', join('proto', 'deep', 'tasks.proto')]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^wrote .*proto\/deep\/tasks.proto$/m);
  const proto = await readFile(join(dir, 'proto', 'deep', 'tasks.proto'), 'utf8');
  assert.match(proto, /^syntax = "proto3";/m);
});

test('fmt --write on a read-only file names the permission, not EACCES', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-write-'));
  const file = join(dir, 'main.arc');
  const NL = String.fromCharCode(10);
  await writeFile(file, 'module   x   @0.1.0 {}' + NL, 'utf8');
  await chmod(file, 0o444);
  const result = await run(['fmt', file, '--write']);
  assert.equal(result.code, 1);
  assert.match(result.err, /^arcod: cannot write .*main\.arc: permission denied$/m);
  assert.equal(result.out, '', 'the file was not formatted, so nothing claims it was');
});

test('fmt --write over a pattern counts an unwritable file as failed', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-write-'));
  const locked = join(dir, 'locked.arc');
  const free = join(dir, 'free.arc');
  const NL = String.fromCharCode(10);
  await writeFile(locked, 'module   locked   @0.1.0 {}' + NL, 'utf8');
  await writeFile(free, 'module   free   @0.1.0 {}' + NL, 'utf8');
  await chmod(locked, 0o444);
  const result = await run(['fmt', join(dir, '*.arc'), '--write']);
  assert.equal(result.code, 1);
  assert.match(result.out, /locked\.arc: cannot write: permission denied/);
  assert.match(result.out, /formatted .*free\.arc/, 'one locked file does not stop the others');
});
