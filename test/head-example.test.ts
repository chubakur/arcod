// `arcod test` drives the generated service over HTTP: an example statement
// becomes a real request. invoke() treated HEAD like a body method, so a probe
// operation was sent with a JSON body (undici refuses that for HEAD) and the
// empty answer was then parsed as JSON. Neither could ever work.
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
  'module probe @0.1.0 {',
  '}',
  '',
  'service Probe : http {',
  '  contract {',
  '    public op probe(tag: string) -> string {',
  '      route: "HEAD /v1/probe"',
  '    }',
  '  }',
  '',
  '  examples {',
  '    example probe_runs {',
  '      when {',
  '        probe("a b")',
  '      }',
  '      then {',
  '        true',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

test('an example can call a HEAD operation', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);

  const dir = await mkdtemp(join(tmpdir(), 'arcod-head-example-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'probe.mjs'), "export async function probe() {\n  return { result: 'ok' };\n}\n");
    const built = await buildExample(mod, dir, { implDir });
    const report = await runExamples(mod, built.dir);
    assert.deepEqual(report.examples.map((item) => [item.example, item.ok, item.error]), [
      ['probe_runs', true, undefined],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

