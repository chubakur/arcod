import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

// The service embeds its migration plan and applies it on boot. The .sql
// artifact in .arcod/build/migrations is written by the same call, so the two
// cannot disagree and a rebuild cannot leave SQL from an older schema behind.
const spec = `
module lake @0.1.0 {}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type Sample = { id: uuid, value: float, at: datetime }
type AlertAck = { ok: bool, id: string }

service Lake : http {
  uses store: sql
  uses uuid: ids

  effects {
    allow store.insert, store.find, uuid.new
  }

  contract {
    public op record(value: float) -> AlertAck {
      route: "POST /v1/samples"
      effects: store.insert, uuid.new
    }

    public op create(value: float) -> Sample {
      route: "POST /v1/samples/direct"
      effects: store.insert, uuid.new
    }

    public op read() -> Sample {
      route: "GET /v1/sample"
      effects: store.find
    }
  }
}

environment dev {
  bind store -> mysql
  bind uuid -> local
  deploy docker
}
`;

const bodies: Record<string, string> = {
  record: "export async function record({ value }) { await io.insert('Sample', { id: await io.new(), value }); return { ok: true, id: 'x' }; }",
  create: "export async function create({ value }) { return io.insert('Sample', { id: await io.new(), value }); }",
  read: "export async function read() { const page = await io.find('Sample', { limit: 1 }); return page.items[0] ?? null; }",
};

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'arcod-build-migrations-'));
  await mkdir(join(root, 'impl'), { recursive: true });
  for (const [op, body] of Object.entries(bodies)) await writeFile(join(root, 'impl', op + '.mjs'), body);
  return root;
}

test('a build writes the migrations artifact from the plan the service embeds', async () => {
  const root = await project();
  try {
    const result = await buildExample(parse(spec, 'main.arc'), root, { port: 8080 });
    const migrations = join(result.dir, 'migrations');
    const entries = (await readdir(migrations)).sort();
    assert.ok(entries.includes('changelog.json'), 'changelog lands next to the service');
    assert.ok(entries.some((name) => /_sample\.up\.sql$/.test(name)), entries.join(', '));
    assert.ok(!entries.some((name) => /alertack/i.test(name)), 'the DTO still gets no table');
    const plan = JSON.parse(await readFile(join(migrations, 'changelog.json'), 'utf8')) as Array<{ checksum: string; up: string }>;
    const code = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    for (const migration of plan) {
      assert.ok(code.includes(migration.checksum), 'artifact and embedded plan carry one checksum');
    }
    for (const path of result.files) assert.ok(path.startsWith(result.dir), 'reported paths are the final ones');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rebuild replaces the migrations artifact instead of keeping stale SQL', async () => {
  const root = await project();
  try {
    const first = await buildExample(parse(spec, 'main.arc'), root, { port: 8080 });
    const migrations = join(first.dir, 'migrations');
    await writeFile(join(migrations, '9999_stale.up.sql'), 'DROP TABLE sample;\n');
    const second = await buildExample(parse(spec, 'main.arc'), root, { port: 8080 });
    assert.equal(second.dir, first.dir);
    const entries = await readdir(join(second.dir, 'migrations'));
    assert.deepEqual(entries.filter((name) => name.startsWith('9999')), []);
    assert.ok(entries.includes('changelog.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
