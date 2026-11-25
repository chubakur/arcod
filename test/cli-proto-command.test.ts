// The usage table is keyed by command name, and `arcod <cmd> --help` looked
// a name up with a plain read. For a name like toString that read answered
// Object.prototype.toString, so the CLI printed "function toString() { [native
// code] }" and exited 0 instead of refusing a command it does not have. The
// same read serves `arcod help <cmd>`. Both ask for an own key now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';

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

test('an unknown command named like a prototype member is refused', async () => {
  for (const command of ['toString', 'hasOwnProperty', 'valueOf']) {
    const result = await run([command, '--help']);
    assert.equal(result.code, 2, command + ' --help should be a usage error');
    assert.match(result.err, new RegExp('unknown command: ' + command));
    assert.doesNotMatch(result.out, /native code/);
  }
});

test('arcod help <proto name> is refused the same way', async () => {
  for (const command of ['toString', 'constructor']) {
    const result = await run(['help', command]);
    assert.equal(result.code, 2, 'help ' + command + ' should be a usage error');
    assert.match(result.err, new RegExp('unknown command: ' + command));
    assert.doesNotMatch(result.out, /native code/);
  }
});

test('a real command still answers its page', async () => {
  const result = await run(['build', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /arcod build/);
});
