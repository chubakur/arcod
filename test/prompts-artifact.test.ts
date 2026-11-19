import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';

// `arcod prompts` writes an artifact, and an artifact has to follow the model.
// A rerun after an operation is removed used to leave its <op>.md behind: the
// agent then read a task for a route that no longer exists. The same command on
// a contract with no operations wrote an empty folder and a manifest that
// claimed zero tasks, so every consumer had to special-case the artifact.

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

const twoOps = `
module shop @0.1.0 {}

service Shop : http {
  contract {
    public op create(title: string) -> string {
      route: "POST /v1/items"
    }

    public op read(id: string) -> string {
      route: "GET /v1/items/:id"
    }
  }
}
`;

const oneOp = `
module shop @0.1.0 {}

service Shop : http {
  contract {
    public op create(title: string) -> string {
      route: "POST /v1/items"
    }
  }
}
`;

const noOps = `
module shop @0.1.0 {}

service Shop : http {
  contract {
  }
}
`;

test('prompts: a removed operation loses its prompt file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-prompts-'));
  try {
    const spec = join(root, 'main.arc');
    await writeFile(spec, twoOps, 'utf8');
    const first = await run(['prompts', spec]);
    assert.equal(first.code, 0);
    const dir = join(root, '.arcod', 'build', 'prompts');
    assert.deepEqual((await readdir(dir)).sort(), ['create.md', 'read.md']);

    await writeFile(spec, oneOp, 'utf8');
    const second = await run(['prompts', spec]);
    assert.equal(second.code, 0);
    assert.deepEqual(await readdir(dir), ['create.md']);
    const manifest = JSON.parse(await readFile(join(root, '.arcod', 'build', 'prompts.json'), 'utf8'));
    assert.deepEqual(manifest.tasks.map((task: { op: string }) => task.op), ['create']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prompts: a contract with no operations clears the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-prompts-'));
  try {
    const spec = join(root, 'main.arc');
    await writeFile(spec, twoOps, 'utf8');
    assert.equal((await run(['prompts', spec])).code, 0);
    const build = join(root, '.arcod', 'build');
    assert.ok(existsSync(join(build, 'prompts.json')));

    await writeFile(spec, noOps, 'utf8');
    const empty = await run(['prompts', spec]);
    assert.equal(empty.code, 0);
    assert.match(empty.out, /no operations in shop/);
    assert.equal(existsSync(join(build, 'prompts.json')), false);
    assert.deepEqual(await readdir(join(build, 'prompts')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prompts: a file that is not a prompt is not deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-prompts-'));
  try {
    const spec = join(root, 'main.arc');
    await writeFile(spec, twoOps, 'utf8');
    const dir = join(root, '.arcod', 'build', 'prompts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'hand-written note\n', 'utf8');
    assert.equal((await run(['prompts', spec])).code, 0);
    assert.deepEqual((await readdir(dir)).sort(), ['create.md', 'notes.txt', 'read.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
