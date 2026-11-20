import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { runExamples } from '../src/test.ts';

// A scaffolded service answers 501, and that used to reach the example as
// "HTTP_501" — a failure that named neither the operation nor impl/<op>.mjs.
const spec = "module m @0.1.0 {}\nuse capability arcod.std.kv @1\ntype N = { id: uuid }\nerror NotFound\nservice S : http {\n  uses store: kv\n  effects { allow store.find }\n  contract {\n    public op read(id: uuid) -> N {\n      route: \"GET /v1/n/:id\"\n      effects: store.find\n      errors: NotFound\n      on error NotFound: id != null\n    }\n  }\n  examples {\n    example read_missing {\n      when {\n        let item = read(\"00000000-0000-0000-0000-000000000000\")\n      }\n      then {\n        item != null\n      }\n    }\n  }\n}\nenvironment dev {\n  bind store -> redis(host: \"kv\", port: 6379)\n}";

test('an example calling an op with no body names the missing implementation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-noimpl-'));
  try {
    const mod = parse(spec, 'main.arc');
    const built = await buildExample(mod, dir, {});
    const report = await runExamples(mod, built.dir);
    assert.equal(report.examples.length, 1);
    const item = report.examples[0];
    assert.equal(item.ok, false, 'an unimplemented op fails the example');
    assert.match(item.error ?? '', /op read has no implementation/);
    assert.match(item.error ?? '', /impl\/read\.mjs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
