// An operation is named by its author, and its body is impl/<name>.mjs. The
// emitter asked for that body with a truthy read of a plain record. For an
// operation called toString the read found Object.prototype.toString even
// when impl/toString.mjs did not exist, so the native function was bundled as
// source and `arcod build` threw "source.trim is not a function" — after check
// had (wrongly) stayed silent. Both questions are now own-key reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const SPEC = `module protoname @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-25"
  }
}

use capability arcod.std.kv @1

type Item = { id: string, note: string }

service Proto : http {
  uses store: kv

  effects {
    allow store.get
  }

  contract {
    public op totals(id: string) -> Item {
      route: "GET /v1/totals/{id}"
      effects: store.get
      post: result != null
    }

    public op toString(id: string) -> Item {
      route: "GET /v1/proto/{id}"
      effects: store.get
      post: result != null
    }
  }
}

environment dev {
  bind store -> kv
  deploy docker
}
`;

const BODY = 'export async function totals(input, io) { return { result: await io.get("Item", String(input.id)) }; }\n';

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-protoname-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'totals.mjs'), BODY);
  return dir;
}

test('an operation named toString builds without a body of its own', async () => {
  const dir = await project();
  const built = await buildExample(parse(SPEC, 'main.arc'), dir, {});
  const files = built.files.filter((name) => name.endsWith('.mjs'));
  assert.notEqual(files.length, 0, 'the build emitted no module');
  const runtime = (await Promise.all(files.map((name) => readFile(name, 'utf8')))).join('\n');
  assert.doesNotMatch(runtime, /native code/, 'the inherited function became a body');
  // The op is routed, but no body function is invented for it.
  assert.match(runtime, /"op": "toString"/);
  assert.doesNotMatch(runtime, /implToString/);
});

test('check warns that the same operation has no body', async () => {
  const found = check(parse(SPEC, 'main.arc'), { impl: { totals: BODY } })
    .filter((item) => item.code === 'W050');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /operation toString has no body in impl\//);
});
