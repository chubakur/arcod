// A record-typed parameter used to arrive as a bare id when the caller was an
// example: invoke() runs every body value through unwrap(), which collapses
// anything carrying `id` to that id — right for a path capture or an id
// parameter, wrong for a record. The service then saw a string where its schema
// promised an object, and io.fetch on `snapshot.id` found nothing. Over HTTP the
// same call works, which is why only examples caught it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';
import { runExamples } from '../src/test.ts';
import { startService } from './harness.ts';

const SPEC = `module recarg @0.1.0 {}
use capability arcod.std.kv @1
type Snap = { id: uuid, label: string }
type Seen = { hasSnap: bool, idKnown: bool, labelIsText: bool }
service RecArg : http {
  uses store: kv
  contract {
    public op make(label: string) -> Snap {
      route: "POST /v1/make"
      effects: store.insert
    }
    public op show(snap: Snap) -> Seen {
      route: "POST /v1/show"
    }
  }
  examples {
    example handover {
      when {
        let snap = make("nightly")
        let seen = show(snap)
      }
      then {
        seen.hasSnap == true
        seen.idKnown == true
        seen.labelIsText == true
      }
    }
  }
}
environment dev {
  bind store -> redis(host: "kv", port: 6379)
  deploy docker
}
`;

const IMPL = {
  make: 'export async function make(input, io) { return { result: await io.insert("Snap", { id: io.new(), label: String(input.label) }) }; }',
  show: 'export async function show(input, io) { const s = input && input.snap; return { result: { hasSnap: s != null && typeof s === "object", idKnown: !!(s && s.id), labelIsText: typeof (s && s.label) === "string" } }; }',
};

test('an example hands a record to a record parameter as an object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-recarg-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  await mkdir(join(dir, 'impl'), { recursive: true });
  for (const [name, body] of Object.entries(IMPL)) await writeFile(join(dir, 'impl', name + '.mjs'), body);
  const mod = parse(SPEC, 'main.arc');
  const built = await buildExample(mod, dir, {});
  const report = await runExamples(mod, built.dir);
  const failures = report.examples.filter((item) => !item.ok).map((item) => item.example + ': ' + item.error);
  assert.deepEqual(failures, [], failures.join(' | '));
  assert.equal(report.examples.length, 1);
});

test('the same record over HTTP arrives as an object', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const made = await fetch(svc.base + '/v1/make', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'nightly' }),
    });
    const snap = await made.json();
    const shown = await fetch(svc.base + '/v1/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snap }),
    });
    assert.deepEqual(await shown.json(), { hasSnap: true, idKnown: true, labelIsText: true });
  } finally {
    await svc.stop();
  }
});
