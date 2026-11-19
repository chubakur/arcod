import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

// A build is published as a whole tree: a failing rebuild must not destroy the
// last good output, and a failing first build must not leave an empty skeleton.
const good = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Shop : http {
  contract {
    public op create(title: string) -> Item {
      route: "POST /v1/items"
    }

    public op read(id: string) -> Item {
      route: "GET /v1/items/:id"
    }
  }
}
`;

// Reference mode has templates only for create/read, so this spec cannot be
// emitted in reference mode: the failure happens after the tree is created.
const bad = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Shop : http {
  contract {
    public op rename(id: string, title: string) -> Item {
      route: "POST /v1/items/:id/rename"
    }
  }
}
`;

test('a completed build leaves no staging directory behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-atomic-'));
  try {
    const result = await buildExample(parse(good, 'main.arc'), root, { port: 8080, reference: true });
    assert.equal(result.dir, join(root, '.arcod', 'build'));
    assert.ok(existsSync(join(result.dir, 'service', 'index.mjs')));
    const entries = await readdir(join(root, '.arcod'));
    assert.deepEqual(entries.filter((name) => name.startsWith('build.')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed rebuild keeps the previous tree and adds nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-atomic-'));
  try {
    await writeFile(join(root, 'main.arc'), good);
    const first = await buildExample(parse(good, 'main.arc'), root, { port: 8080, reference: true });
    const before = await readFile(join(first.dir, 'docker-compose.yml'), 'utf8');
    await assert.rejects(buildExample(parse(bad, 'main.arc'), root, { port: 8080, reference: true }), /templates only for/);
    const after = await readFile(join(root, '.arcod', 'build', 'docker-compose.yml'), 'utf8');
    assert.equal(after, before);
    const entries = await readdir(join(root, '.arcod'));
    assert.deepEqual(entries.filter((name) => name.startsWith('build.')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a build sweeps staging trees left by a killed process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-atomic-'));
  try {
    for (const name of ['build.tmp-999999', 'build.old-999999']) {
      await mkdir(join(root, '.arcod', name, 'service'), { recursive: true });
      await writeFile(join(root, '.arcod', name, 'service', 'index.mjs'), '// abandoned\n');
    }
    const result = await buildExample(parse(good, 'main.arc'), root, { port: 8080, reference: true });
    assert.ok(existsSync(join(result.dir, 'service', 'index.mjs')));
    const entries = await readdir(join(root, '.arcod'));
    assert.deepEqual(entries.filter((name) => name.startsWith('build.')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a build that fails after writing files keeps the previous tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-atomic-'));
  try {
    const first = await buildExample(parse(good, 'main.arc'), root, { port: 8080, reference: true });
    const before = await readFile(join(first.dir, 'docker-compose.yml'), 'utf8');
    await writeFile(join(root, 'main.arc'), "module shop @0.1.0 {}\n\nuse capability arcod.std.ids @1\n\ntype Item = { id: string, title: string }\n\nservice Shop : http {\n  uses uuid: ids\n\n  effects {\n    allow uuid.new\n  }\n\n  contract {\n    public op create(title: string) -> Item {\n      route: \"POST /v1/items\"\n      effects: uuid.new\n    }\n\n    public op read(id: string) -> Item {\n      route: \"GET /v1/items/:id\"\n    }\n  }\n}\n\nenvironment dev {\n  bind uuid -> local(import: \"missing-realm.json\")\n  deploy docker\n}\n", 'utf8');
    await assert.rejects(buildExample(parse("module shop @0.1.0 {}\n\nuse capability arcod.std.ids @1\n\ntype Item = { id: string, title: string }\n\nservice Shop : http {\n  uses uuid: ids\n\n  effects {\n    allow uuid.new\n  }\n\n  contract {\n    public op create(title: string) -> Item {\n      route: \"POST /v1/items\"\n      effects: uuid.new\n    }\n\n    public op read(id: string) -> Item {\n      route: \"GET /v1/items/:id\"\n    }\n  }\n}\n\nenvironment dev {\n  bind uuid -> local(import: \"missing-realm.json\")\n  deploy docker\n}\n", 'main.arc'), root, { port: 8080, reference: true }), /missing-realm\.json/);
    assert.equal(await readFile(join(root, '.arcod', 'build', 'docker-compose.yml'), 'utf8'), before);
    const entries = await readdir(join(root, '.arcod'));
    assert.deepEqual(entries.filter((name) => name.startsWith('build.')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed first build leaves no .arcod/build at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-atomic-'));
  try {
    await assert.rejects(buildExample(parse(bad, 'main.arc'), root, { port: 8080, reference: true }), /templates only for/);
    assert.equal(existsSync(join(root, '.arcod', 'build')), false);
    const entries = existsSync(join(root, '.arcod')) ? await readdir(join(root, '.arcod')) : [];
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
