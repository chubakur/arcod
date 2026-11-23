// `arcod check examples/chat` named the spec by its bare file name while
// `arcod check 'examples/**'` named each match by a path relative to the
// caller — the same verdict in two shapes. Both now go through `specLabel`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

async function specInCwd(): Promise<{ dir: string; file: string; label: string }> {
  const dir = await mkdtemp(join(process.cwd(), 'arcod-check-'));
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module label @0.1.0 {}\n', 'utf8');
  return { dir, file, label: relative(process.cwd(), file) };
}

test('a clean single file is named like a pattern match', async () => {
  const { dir, file, label } = await specInCwd();
  try {
    const result = await run(['check', file]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, 'ok — ' + label + ' is clean');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a diagnostic names the file the same way', async () => {
  const { dir, file, label } = await specInCwd();
  try {
    const single = await run(['check', file, '--env', 'nope']);
    assert.equal(single.code, 1);
    assert.match(single.out, new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'));

    const pattern = await run(['check', join(dir, '*.arc'), '--env', 'nope']);
    assert.equal(pattern.code, 1);
    assert.ok(pattern.out.startsWith(label + ':'), 'the pattern reports the same label: ' + pattern.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
