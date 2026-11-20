// Every demo is part of the promise the README makes: examples/ is what a
// reader copies. A spec that stops checking clean, or starts warning about an
// example it no longer has, is drift a 856-test run does not name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { loadRegistry } from '../src/registry.ts';
import { implBodiesFor } from '../src/build.ts';

// A warning a demo carries on purpose, with the item that owns it. This is a
// ratchet: the entry goes away when the item does, and a new warning is red.
const DOCUMENTED: Record<string, Record<string, string>> = {
  files: { W012: 'B47: list() declares list<FileId> while the impl returns records' },
  'tasks-sql': { W046: 'prod keeps mysql so the missing managed resource stays visible' },
};

test('every example checks with no errors and only documented warnings', async () => {
  const root = fileURLToPath(new URL('../examples', import.meta.url));
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length >= 10, 'the examples directory is not empty');

  const problems: string[] = [];
  for (const entry of entries) {
    const dir = join(root, entry.name);
    let source: string;
    try {
      source = await readFile(join(dir, 'main.arc'), 'utf8');
    } catch {
      continue; // a directory without a spec is not a demo
    }
    const diags = check(parse(source, 'main.arc'), {
      registry: loadRegistry(dir),
      impl: await implBodiesFor(dir),
    });
    const allowed = DOCUMENTED[entry.name] ?? {};
    for (const d of diags) {
      if (d.severity === 'error') {
        problems.push(entry.name + ': error ' + d.code + ' ' + d.message);
      } else if (!allowed[d.code]) {
        problems.push(entry.name + ': warning ' + d.code + ' ' + d.message);
      }
    }
  }

  assert.deepEqual(problems, [], 'examples must check clean (documented warnings only)');
});
