// An example could not read a list element: `page.hits[0].title` reached
// evalExpr as a call with a member callee named `[]` and the evaluator only
// accepted an identifier. Indexing is evaluated now, with bounded errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildExample } from '../src/build.ts';
import { runExamples } from '../src/test.ts';

const SPEC = [
  'module search @0.1.0 {',
  '}',
  '',
  'type Hit = { title: string }',
  '',
  'service Search : http {',
  '  contract {',
  '    public op search(q: string) -> { total: int, hits: list<Hit> } {',
    '      route: "GET /v1/search"',
  '    }',
  '  }',
  '',
  '  examples {',
  '    example first_hit {',
  '      when {',
    '        let page = search("x")',
  '      }',
  '      then {',
    '        page.hits[0].title == "first"',
  '      }',
  '    }',
  '',
  '    example out_of_range {',
  '      when {',
    '        let page = search("x")',
  '      }',
  '      then {',
    '        page.hits[99].title == "first"',
  '      }',
  '    }',
  '',
  '    example negative_index {',
  '      when {',
    '        let page = search("x")',
  '      }',
  '      then {',
    '        page.hits[-1].title == "third"',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const IMPL = [
  'export async function search() {',
  '  return { result: { total: 3, hits: [{ title: "first" }, { title: "second" }, { title: "third" }] } };',
  '}',
].join('\n');

test('a list element is readable and an out-of-range index names itself', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);
  const dir = await mkdtemp(join(tmpdir(), 'arcod-example-index-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'search.mjs'), IMPL + '\n');
    const built = await buildExample(mod, dir, { implDir });
    const report = await runExamples(mod, built.dir);
    const byName = new Map(report.examples.map((item) => [item.example, item]));
    assert.equal(byName.get('first_hit')?.ok, true);
    for (const [name, index] of [['out_of_range', 99], ['negative_index', -1]] as Array<[string, number]>) {
      const item = byName.get(name);
      assert.equal(item?.ok, false, name);
      assert.ok(String(item?.error).includes('index ' + index + ' out of range (len 3) in page.hits'), String(item?.error));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
