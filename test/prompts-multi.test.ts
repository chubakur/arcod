import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildPrompts, promptManifest, promptPath } from '../src/prompts.ts';
import { runImpl } from '../src/impl.ts';
import { main } from '../src/cli.ts';
import { buildExample } from '../src/build.ts';

// A module may declare several services. Prompts used to be built from the
// first internal service only, so the other service never reached the model --
// and a shared operation name would have overwritten its prompt on disk.
const twoServices = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Store : http {
  contract {
    public op create(title: string) -> Item {
      route: "POST /v1/items"
    }

    public op read(id: string) -> Item {
      route: "GET /v1/items/:id"
    }
  }
}

service Cache : http {
  contract {
    public op get(key: string) -> string {
      route: "GET /v1/cache/:key"
    }
  }
}
`;

const oneService = `
module shop @0.1.0 {}

service Cache : http {
  contract {
    public op get(key: string) -> string {
      route: "GET /v1/cache/:key"
    }
  }
}
`;

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

test('prompts: every internal service gets its own tasks and file paths', () => {
  const set = buildPrompts(parse(twoServices, 'main.arc'));
  assert.equal(set.multiService, true);
  assert.deepEqual(set.tasks.map((task) => task.service + '.' + task.op), ['Cache.get', 'Store.create', 'Store.read']);
  for (const task of set.tasks) {
    assert.equal(task.file, 'impl/' + task.service + '/' + task.op + '.mjs');
    assert.equal(promptPath(set, task), task.service + '/' + task.op + '.md');
  }
  const full = buildPrompts(parse(twoServices, 'main.arc'), { format: 'full' });
  const cache = full.tasks.find((task) => task.op === 'get');
  assert.ok(cache);
  assert.match(cache.prompt, /Write exactly one file: impl\/Cache\/get\.mjs/);

  const manifest = promptManifest(set);
  assert.deepEqual(
    (manifest.tasks as Array<{ service: string; file: string }>).map((task) => task.service + ' ' + task.file),
    ['Cache impl/Cache/get.mjs', 'Store impl/Store/create.mjs', 'Store impl/Store/read.mjs'],
  );
});

test('prompts: a one-service module keeps the flat prompt and body paths', () => {
  const set = buildPrompts(parse(oneService, 'main.arc'));
  assert.equal(set.multiService, false);
  assert.equal(set.tasks.length, 1);
  assert.equal(set.tasks[0].file, 'impl/get.mjs');
  assert.equal(promptPath(set, set.tasks[0]), 'get.md');
});

test('prompts: a multi-service module files prompts per service and prunes a stale one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-prompts-multi-'));
  try {
    const spec = join(root, 'main.arc');
    const dir = join(root, '.arcod', 'build', 'prompts');
    await writeFile(spec, twoServices, 'utf8');
    const first = await run(['prompts', spec]);
    assert.equal(first.code, 0);
    assert.deepEqual((await readdir(dir)).sort(), ['Cache', 'Store', 'manifest.json']);
    assert.deepEqual((await readdir(join(dir, 'Store'))).sort(), ['create.md', 'read.md']);
    assert.deepEqual(await readdir(join(dir, 'Cache')), ['get.md']);
    const manifest = JSON.parse(await readFile(join(root, '.arcod', 'build', 'prompts.json'), 'utf8'));
    assert.deepEqual(manifest.tasks.map((task: { service: string }) => task.service), ['Cache', 'Store', 'Store']);

    // Dropping Store leaves its folder, its two prompts and the service entry
    // behind unless the artifact follows the model.
    await writeFile(spec, oneService, 'utf8');
    const second = await run(['prompts', spec]);
    assert.equal(second.code, 0);
    assert.deepEqual((await readdir(dir)).sort(), ['get.md', 'manifest.json']);
    const after = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(after.tasks.map((task: { service: string }) => task.service), ['Cache']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('impl: a multi-service module plans one body per service folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-impl-multi-'));
  try {
    // The build reads impl/<service>/ now (B109), so the prompt's file path is
    // the path impl writes: a shared ping is no longer one flat file.
    const { results } = await runImpl(parse(twoServices, 'main.arc'), root, { dryRun: true });
    const planned = results.map((item) => item.file.slice(root.length + 1).split('\\').join('/')).sort();
    assert.deepEqual(planned, ['impl/Cache/get.mjs', 'impl/Store/create.mjs', 'impl/Store/read.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build: the prompt artifact of a multi-service module is per service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-build-prompts-'));
  try {
    // A scaffold build (no impl, no reference) reaches every service, which is
    // what the prompt artifact follows.
    const result = await buildExample(parse(twoServices, 'main.arc'), root, { port: 0 });
    assert.match(await readFile(join(result.dir, 'prompts', 'Store', 'create.md'), 'utf8'), /function create\(input, io\)/);
    assert.match(await readFile(join(result.dir, 'prompts', 'Cache', 'get.md'), 'utf8'), /function get\(input, io\)/);
    const manifest = JSON.parse(await readFile(join(result.dir, 'prompts.json'), 'utf8'));
    assert.deepEqual(manifest.tasks.map((task: { service: string }) => task.service), ['Cache', 'Store', 'Store']);
    assert.deepEqual((await readdir(join(result.dir, 'prompts'))).sort(), ['Cache', 'Store', 'manifest.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
