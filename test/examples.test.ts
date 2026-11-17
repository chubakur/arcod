import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildExample } from '../src/build.ts';

// examples/ is the project's promise: every file there is a working service.
// Nothing enforced that across the whole directory — a change to the checker
// or an emitter could quietly rot one example while the suites covering the
// others stayed green.

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

async function examples(): Promise<Array<{ name: string; spec: string; source: string }>> {
  const names = (await readdir(examplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const out: Array<{ name: string; spec: string; source: string }> = [];
  for (const name of names) {
    const spec = join(examplesDir, name, 'main.arc');
    const source = await readFile(spec, 'utf8').catch(() => null);
    if (source !== null) out.push({ name, spec, source });
  }
  return out;
}

test('every example parses and checks without errors', async () => {
  const list = await examples();
  assert.ok(list.length >= 10, 'the examples directory is populated (found ' + list.length + ')');
  const broken: string[] = [];
  for (const example of list) {
    const mod = parse(example.source, example.name + '/main.arc');
    const errors = check(mod).filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      broken.push(example.name + ': ' + errors.map((item) => item.code + ' ' + item.message).join('; '));
    }
  }
  assert.deepEqual(broken, [], 'examples must check clean');
});

test('every example builds in place, with its own inputs', async () => {
  const list = await examples();
  const failed: string[] = [];
  for (const example of list) {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-example-'));
    try {
      // Copy the directory and build inside it: an example may carry inputs
      // beyond main.arc (files/realm.json), and the build resolves those
      // relative to the project, exactly as a user's in-place build would.
      await cp(join(examplesDir, example.name), dir, { recursive: true });
      const mod = parse(example.source, example.name + '/main.arc');
      const built = await buildExample(mod, dir, {});
      const files = await readdir(join(built.dir, 'service'));
      assert.ok(files.includes('index.mjs'), example.name + ' produced a service entry point');
    } catch (error) {
      failed.push(example.name + ': ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failed, [], 'every example compiles');
});
