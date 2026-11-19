// invoke() looked a capture up in the original parameter list, then removed
// that index from the argument list. With two captures the second lookup still
// used the pre-filter index: :id got the value of the first body parameter and
// every body field moved one slot. Values are keyed by name now.
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
  'module notes @0.1.0 {',
  '}',
  '',
  'service Notes : http {',
  '  contract {',
  '    public op add(book: string, id: string, title: string, note: string) -> { book: string, id: string, title: string, note: string } {',
  '      route: "POST /v1/books/:book/notes/:id"',
  '    }',
  '  }',
  '',
  '  examples {',
  '    example two_captures {',
  '      when {',
  '        let r = add("b1", "n7", "hello", "body")',
  '      }',
  '      then {',
  '        r.book == "b1"',
  '        r.id == "n7"',
  '        r.title == "hello"',
  '        r.note == "body"',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const IMPL = [
  'export async function add(input) {',
  '  return { result: { ...input } };',
  '}',
].join('\n');

test('two route captures and two body fields keep their own values', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);

  const dir = await mkdtemp(join(tmpdir(), 'arcod-example-captures-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'add.mjs'), IMPL + '\n');
    const built = await buildExample(mod, dir, { implDir });
    const report = await runExamples(mod, built.dir);
    assert.deepEqual(report.examples.map((item) => [item.example, item.ok, item.error]), [
      ['two_captures', true, undefined],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
