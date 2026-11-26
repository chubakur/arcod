// A build emits one image, but dev and prod may bind different databases:
// examples/files, chat and orders keep mysql in dev and postgres in prod. The
// dialect has to follow the environment the build is for, or the prod manifest
// says postgres:// while the image speaks mysql and cannot start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

const examples = fileURLToPath(new URL('../examples', import.meta.url));

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

test('build --env chooses the dialect of that environment', async () => {
  for (const example of ['files', 'chat', 'orders']) {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-env-'));
    try {
      await cp(join(examples, example), dir, { recursive: true });
      const dev = await run(['build', dir, '--json']);
      assert.equal(dev.code, 0, dev.err);
      assert.equal((JSON.parse(dev.out) as { dialect: string }).dialect, 'mysql', example + ' dev keeps the historical dialect');

      const prod = await run(['build', dir, '--json', '--env', 'prod']);
      assert.equal(prod.code, 0, prod.err);
      assert.equal((JSON.parse(prod.out) as { dialect: string }).dialect, 'postgres', example + ' prod binds postgres');

      const unknown = await run(['build', dir, '--env', 'nope']);
      assert.equal(unknown.code, 2);
      assert.match(unknown.err, /unknown environment nope/);
      assert.match(unknown.err, /declared: /, 'the refusal names the environments');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
