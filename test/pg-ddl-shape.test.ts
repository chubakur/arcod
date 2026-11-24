// Every postgres migration in every shipped example is DDL that has to be
// accepted by a real server before an adapter can even exist. The outbox table
// was built as an array of lines with an empty placeholder, and non-mysql got
// `published_at BIGINT NULL,\n\n);` (issue #43) — a shape error no adapter test
// would catch. This walks the plan of every example and checks shape, not
// spelling: no blank line, no comma before a closing paren, balanced parens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { migrationPlan } from '../src/migrate.ts';
import { POSTGRES } from '../src/dialects.ts';

const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));

function balance(sql: string): number {
  let depth = 0;
  for (const ch of sql) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return -1;
  }
  return depth;
}

test('every example plans postgres DDL with no shape error', async () => {
  const demos = (await readdir(examplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let plans = 0;
  for (const demo of demos) {
    const spec = join(examplesDir, demo, 'main.arc');
    let source: string;
    try {
      source = await readFile(spec, 'utf8');
    } catch {
      continue;
    }
    const mod = parse(source, 'main.arc');
    for (const svc of mod.services) {
      if (svc.external) continue;
      for (const migration of migrationPlan(mod, svc, { dialect: POSTGRES }).migrations) {
        const where = demo + ' ' + svc.name + ' ' + migration.name;
        assert.doesNotMatch(migration.up, /,\s*\n\s*\)/, where + ': a comma hangs before the closing paren');
        assert.doesNotMatch(migration.up, /\n\s*\n/, where + ': a blank line inside the statement');
        assert.equal(balance(migration.up), 0, where + ': parens are balanced');
        plans += 1;
      }
    }
  }
  assert.ok(plans > 0, 'at least one example has a migration');
});
