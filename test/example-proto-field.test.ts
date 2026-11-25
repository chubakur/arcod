// An example reads a field the service sent: `then { made.note == "x" }`.
// The read asked `property in record`, which is also true for every
// Object.prototype member, so `made.toString` answered the inherited function
// instead of null. A `then` assertion is a truthiness check, so an example
// asserting that a field the body never sent is absent passed on the function
// and reported success for a service that dropped the field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';
import { runExamples } from '../src/test.ts';

const SPEC = `module exproto @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-25"
  }
}

use capability arcod.std.kv @1

type Item = { id: uuid, note: string }

service ExProto : http {
  uses store: kv

  effects {
    allow store.insert
  }

  contract {
    public op make(note: string) -> Item {
      route: "POST /v1/make"
      effects: store.insert
    }
  }

  examples {
    example absent {
      when {
        let made = make("nightly")
      }
      then {
        made.note == "nightly"
        made.toString == null
      }
    }
  }
}

environment dev {
  bind store -> kv
  deploy docker
}
`;

const IMPL = {
  make: 'export async function make(input, io) { return { result: await io.insert("Item", { id: io.new(), note: String(input.note) }) }; }',
};

test('a field the body never sent reads as null, not the inherited function', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-exproto-'));
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
