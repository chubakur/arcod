import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { formatSource } from '../src/fmt.ts';

// fmt runs on every real spec in the repository, not just hand-written fixtures:
// a formatter that crashes or drifts on an example is a user-visible bug.
const root = new URL('../examples/', import.meta.url);

async function exampleSpecs(): Promise<Array<{ name: string; source: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: Array<{ name: string; source: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const url = new URL(entry.name + '/main.arc', root);
    try {
      out.push({ name: entry.name, source: await readFile(url, 'utf8') });
    } catch {
      // an example without a main.arc is not a spec; other tests cover those
    }
  }
  return out;
}

test('every example formats idempotently', async () => {
  const specs = await exampleSpecs();
  assert.ok(specs.length >= 10, 'the examples directory is still populated');
  for (const { name, source } of specs) {
    const once = formatSource(source, name + '/main.arc');
    const twice = formatSource(once, name + '/main.arc');
    assert.equal(twice, once, name + ' formats to a stable form');
  }
});

test('every example keeps its declaration comments through fmt', async () => {
  const specs = await exampleSpecs();
  for (const { name, source } of specs) {
    const once = formatSource(source, name + '/main.arc');
    const before = source.match(/^\s*\/\/.*$/gm) ?? [];
    const after = once.match(/^\s*\/\/.*$/gm) ?? [];
    assert.equal(after.length, before.length, name + ' keeps every whole-line comment');
  }
});
