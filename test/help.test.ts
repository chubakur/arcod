// `arcod help build` printed the main page and silently dropped the word
// build: the page already lists build, so the argument looked answered. It now
// prints the same page `arcod build --help` does, and a name the CLI does not
// have is refused with exit 2 instead of ignored. The two built-ins also answer
// --help now instead of calling themselves unknown commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('help <command> prints that command usage, not the main page', async () => {
  const result = await run(['help', 'build']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^usage: arcod build /);
  assert.doesNotMatch(result.out, /specification compiler for agent-built services/, 'the main page is not the answer');
});

test('help without a command still prints the main page', async () => {
  const result = await run(['help']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^arcod \d+\.\d+\.\d+ /);
});

test('help names a command the CLI does not have', async () => {
  const result = await run(['help', 'nosuch']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^unknown command: nosuch$/m);
  assert.match(result.out, /^arcod \d+\.\d+\.\d+ /, 'the main page follows the refusal');
});

test('a flag after help still means the main page', async () => {
  const result = await run(['help', '--json']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^arcod \d+\.\d+\.\d+ /);
});

test('version answers --help instead of calling itself unknown', async () => {
  const result = await run(['version', '--help']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^usage: arcod version/);
  assert.doesNotMatch(result.err, /unknown command/);
});
