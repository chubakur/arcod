import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildExample } from '../src/build.ts';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './harness.ts';

// A body names its entity with a string. A typo used to be an anonymous 500:
// the client saw internal error, the log saw an access line, and the row was
// never written.
const spec = `
module flows @0.1.0 {}

type WorkflowRec = { id: uuid, name: string }

service Flows : http {
  uses store: kv
  uses uuid: ids

  effects {
    allow store.insert, store.fetch, uuid.new
  }

  contract {
    public op create(name: string) -> WorkflowRec {
      route: "POST /v1/workflows"
      effects: store.insert, uuid.new
    }

    public op read(id: uuid) -> WorkflowRec {
      route: "GET /v1/workflows/:id"
      effects: store.fetch
    }
  }
}

environment dev {
  bind store -> redis(host: "kv")
  bind uuid -> local
  deploy docker
}
`;

const typo = { create: "export async function create(input, io) { return io.insert('Workflow', { id: io.new(), name: input.name }); }" };
const good = { create: "export async function create(input, io) { return io.insert('WorkflowRec', { id: io.new(), name: input.name }); }" };

test('check names the literal, the body and the declared set', () => {
  const mod = parse(spec, 'main.arc');
  const diags = check(mod, { impl: typo });
  const found = diags.filter((item) => item.code === 'W036');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.equal(found[0].file, 'impl/create.mjs');
  assert.match(found[0].message, /unknown entity "Workflow"; declared: WorkflowRec/);
  assert.equal(found[0].path, 'impl.create');
  // The correct spelling is silent.
  assert.equal(check(mod, { impl: good }).filter((item) => item.code === 'W036').length, 0);
});

test('the generated service answers the typo with its name instead of "internal error"', async () => {
  const service = await startService(spec, { impl: typo });
  try {
    const response = await fetch(service.base + '/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'daily' }),
    });
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string; message: string };
    assert.equal(body.error, 'Internal');
    assert.match(body.message, /unknown entity "Workflow"/);
    assert.match(body.message, /declared: WorkflowRec/);
  } finally {
    await service.stop();
  }
});

test('a 5xx logs the stack, not just the message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-unknown-'));
  try {
    await writeFile(join(dir, 'main.arc'), spec);
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'create.mjs'), typo.create);
    const mod = parse(spec, 'main.arc');
    const built = await buildExample(mod, dir, { implDir: join(dir, 'impl') });
    const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
    assert.match(code, /console\.error\('request failed:', err && err\.stack \? err\.stack : err\)/);
    assert.match(code, /err instanceof ArcodError && err\.error === 'Internal'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
