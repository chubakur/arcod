// A command takes one path. `arcod check a b` used to check b and say nothing
// about a — and `arcod build a b` built b, writing artifacts, as if a had not
// been typed. A second path is a usage error now; `diff` is the one command
// that reads two and still does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const realWrite = process.stdout.write;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  // Only the CLI's own strings are swallowed; the test runner writes its TAP
  // stream through this same function as buffers and must keep it.
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

test('a second path is a usage error, not a preference for the last one', async () => {
  const result = await run(['check', 'examples/chat', 'examples/tasks']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: examples\/tasks$/m);
  assert.equal(result.out, '', 'the first path is not silently checked, nor the second');
});

test('a flag value is not mistaken for a second path', async () => {
  const result = await run(['check', 'examples/chat', '--env', 'dev']);
  assert.equal(result.code, 0, result.err);
  assert.doesNotMatch(result.err, /unexpected argument/);
});

test('diff still reads two paths', async () => {
  const result = await run(['diff', 'examples/chat', 'examples/tasks']);
  assert.equal(result.code, 1, result.err);
  assert.match(result.out, /^--- /);
  assert.match(result.out, /^\+\+\+ /m);
});

test('diff refuses a third path', async () => {
  const result = await run(['diff', 'examples/chat', 'examples/tasks', 'examples/orders']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: examples\/orders$/m);
  assert.equal(result.out, '');
});

// A command with no operand dropped one the same way: `arcod version extra`
// printed the version and said nothing about extra. These commands name the
// word they never read instead — and lsp refuses before it starts serving.
test('version refuses a path it would drop', async () => {
  const result = await run(['version', 'extra']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: extra$/m);
  assert.equal(result.out, '');
});

test('providers refuses a path it would drop', async () => {
  const result = await run(['providers', 'examples/chat']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: examples\/chat$/m);
});

test('lsp refuses an argument before it starts serving', async () => {
  const result = await run(['lsp', 'extra']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: extra$/m);
});

// The raw-argument commands (adopt, new) read their operand with find(), so a
// second one is only refused by parseFlags. These pin that they never reach
// the raw argument list and quietly pick the first: no file is read, no
// project is scaffolded.
test('adopt refuses a second document', async () => {
  const result = await run(['adopt', 'a.json', 'b.json']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: b\.json$/m);
  assert.equal(result.out, '');
});

test('new refuses a second name before scaffolding anything', async () => {
  const result = await run(['new', 'arcod-extra-one', 'arcod-extra-two']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: unexpected argument: arcod-extra-two$/m);
  assert.doesNotMatch(result.err, /created|scaffold/i, 'nothing was written');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('arcod-extra-one'), false);
  assert.equal(existsSync('arcod-extra-two'), false);
});
