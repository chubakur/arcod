// A body file is keyed by the operation it implements. The emitter bundles only
// a body whose name is in the service contract, so impl/total.mjs (a typo of
// totals) was loaded, sandbox-checked and then dropped: totals answered 501
// NotImplemented while the author believed the body was in use. W049 names the
// file and lists the operations the contract declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const SPEC = `module orphan @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-23"
  }
}

use capability arcod.std.sql @1

type Line = { id: string, amount: int }

service Lines : http {
  uses store: sql

  effects {
    allow store.aggregate
  }

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      effects: store.aggregate
      post: result != null
    }

    public op audit() -> int {
      route: "GET /v1/audit"
      effects: store.aggregate
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`;

const BODY = (op: string): string =>
  'export async function ' + op + '(input, io) {\n' +
  '  return { result: await io.aggregate("Line", { field: "amount", op: "sum" }) };\n' +
  '}\n';

function warnings(impl: Record<string, string>) {
  return check(parse(SPEC, 'main.arc'), { impl }).filter((item) => item.code === 'W049');
}

test('W049: a body file that matches no operation is a warning with the file', () => {
  const found = warnings({ total: BODY('total'), totals: BODY('totals'), audit: BODY('audit') });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.equal(found[0].file, 'impl/total.mjs');
  assert.match(found[0].message, /impl\/total\.mjs matches no operation/);
  assert.match(String(found[0].hint), /audit, totals/);
});

test('W049: bodies named after the declared operations stay clean', () => {
  assert.deepEqual(warnings({ totals: BODY('totals'), audit: BODY('audit') }), []);
});

// The warning is not a refusal: build still succeeds (the body is simply not
// bundled), and the generated service has no handler for the orphan name. What
// the author loses is silence, not the build.
test('W049: build still succeeds, and the orphan body reaches no handler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-orphan-'));
  try {
    await writeFile(join(dir, 'main.arc'), SPEC);
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'total.mjs'), BODY('total'));
    await writeFile(join(dir, 'impl', 'totals.mjs'), BODY('totals'));
    const result = await buildExample(parse(SPEC, 'main.arc'), dir, { implDir: join(dir, 'impl') });
    const svc = result.files.find((file) => file.endsWith('index.mjs'));
    assert.ok(svc, 'the build wrote index.mjs');
    const text = await readFile(svc, 'utf8');
    assert.match(text, /function implTotals/, 'the declared body is bundled');
    assert.doesNotMatch(text, /implTotal\b/, 'the orphan body is not');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('W049: a module with no operations says no body is bundled', () => {
  const bare = 'module bare @0.1.0 {\n  meta {\n    owner: "@test"\n    status: "draft"\n    since: "2026-11-23"\n  }\n}\n';
  const found = check(parse(bare, 'main.arc'), { impl: { totals: BODY('totals') } })
    .filter((item) => item.code === 'W049');
  assert.equal(found.length, 1);
  assert.match(String(found[0].hint), /declares no operations/);
});
