// Three tables describe one CLI: COMMAND_FLAGS (what the parser accepts per
// command), COMMAND_USAGE (the page `--help` prints) and MAIN_USAGE (the list).
// They were edited by hand in different commits, so this pins them together:
// a flag a command accepts is on its page, a page exists for every command, and
// `arcod help <cmd>` reaches every page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_FLAGS, COMMAND_USAGE, MAIN_USAGE, main } from '../src/cli.ts';

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

function flagsNamed(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])].sort();
}

test('every command with flags has a usage page', () => {
  for (const command of Object.keys(COMMAND_FLAGS)) {
    assert.ok(COMMAND_USAGE[command], 'no usage page for ' + command);
    assert.match(COMMAND_USAGE[command], new RegExp('^usage: arcod ' + command + '\\b'));
  }
});

test('a usage page names exactly the flags the command accepts', () => {
  for (const [command, page] of Object.entries(COMMAND_USAGE)) {
    if (command === 'help') continue; // its page names --help in prose only
    assert.deepEqual(flagsNamed(page), [...(COMMAND_FLAGS[command] ?? [])].sort(), command);
  }
});

test('the main page lists every command', () => {
  for (const command of Object.keys(COMMAND_FLAGS)) {
    assert.match(MAIN_USAGE, new RegExp('arcod ' + command + '\\b'), 'main page omits ' + command);
  }
});

test('help <command> reaches every page', async () => {
  for (const command of Object.keys(COMMAND_FLAGS)) {
    const result = await run(['help', command]);
    assert.equal(result.code, 0, command + ': ' + result.err);
    assert.match(result.out, new RegExp('^usage: arcod ' + command + '\\b'), command);
  }
});
