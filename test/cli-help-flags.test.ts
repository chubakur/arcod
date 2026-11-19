// `arcod --help` and `arcod <cmd> --help` are the map of what the CLI accepts.
// They drifted: --out reached openapi, --json reached build/ast, --reference
// reached test and --env reached k8s, while the top-level page never said so.
// This test keeps the three sources of truth — the accepted flags, the per
// command usage and the summary page — in step in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_FLAGS, COMMAND_USAGE, MAIN_USAGE } from '../src/cli.ts';

const FLAG = /--[a-z][a-z-]*/g;

function blockFor(command: string): string {
  const lines = MAIN_USAGE.split('\n');
  const start = lines.findIndex((line) => new RegExp('^  arcod ' + command + '( |$)').test(line));
  assert.notEqual(start, -1, 'the summary page has no line for ' + command);
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^  arcod /.test(line) || line.trim() === '') break;
    block.push(line);
  }
  return block.join('\n');
}

for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
  test(command + ': every accepted flag is on both help pages', () => {
    const summary = blockFor(command);
    const detail = COMMAND_USAGE[command];
    assert.ok(detail, 'there is a per-command usage string for ' + command);
    for (const flag of flags) {
      assert.ok(summary.includes(flag), 'arcod --help does not mention ' + flag + ' for ' + command);
      assert.ok(detail.includes(flag), 'arcod ' + command + ' --help does not mention ' + flag);
    }
  });

  test(command + ': every flag on the help pages is accepted', () => {
    const allowed = new Set(flags);
    const shown = new Set([...(blockFor(command).match(FLAG) ?? []), ...(COMMAND_USAGE[command].match(FLAG) ?? [])]);
    for (const flag of shown) {
      if (flag === '--help') continue;
      assert.ok(allowed.has(flag), command + ' help promises ' + flag + ', but COMMAND_FLAGS rejects it');
    }
  });
}
