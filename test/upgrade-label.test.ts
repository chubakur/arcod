// upgrade named the spec by its absolute path, while check and fmt name the
// same file relative to the caller. A script that ran `arcod check examples/x`
// and then `arcod upgrade examples/x` saw two names for one file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

test('upgrade names a spec inside the working directory relatively', async () => {
  const result = await run(['upgrade', 'examples/chat']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^examples\/chat\/main\.arc: already at 0\.1\.0$/m);
  assert.doesNotMatch(result.out, new RegExp(examplesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'not the absolute path');
});

test('a spec outside the working directory keeps its absolute name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-upgrade-'));
  try {
    await cp(join(examplesDir, 'chat'), dir, { recursive: true });
    const result = await run(['upgrade', dir]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/main\\.arc: already at 0\\.1\\.0$', 'm'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
