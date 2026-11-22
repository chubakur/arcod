// docs/examples.md is the public index of demos: "Every directory under
// examples/". A demo that exists but is not in the table is invisible to a
// reader; a row that names a directory that is gone is a dead link. The list
// is written by hand, so it is checked against the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function demos(): Promise<string[]> {
  const entries = await readdir(join(root, 'examples'), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(root, 'examples', entry.name, 'main.arc'));
      out.push(entry.name);
    } catch {
      // A directory without a spec is not a demo; the examples test owns that
      // rule, this one only indexes what is there.
    }
  }
  return out.sort();
}

async function indexed(): Promise<string[]> {
  const text = await readFile(join(root, 'docs', 'examples.md'), 'utf8');
  return text
    .split('\n')
    .map((line) => /^\| \`([^\`]+)\` \|/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

test('docs/examples.md lists every demo exactly once', async () => {
  const onDisk = await demos();
  const inDocs = await indexed();
  assert.deepEqual(inDocs, onDisk,
    'examples.md and examples/ disagree: ' + JSON.stringify({ onlyOnDisk: onDisk.filter((d) => !inDocs.includes(d)), onlyInDocs: inDocs.filter((d) => !onDisk.includes(d)) }));
  assert.equal(new Set(inDocs).size, inDocs.length, 'a demo is listed twice');
  assert.ok(onDisk.length >= 17, 'expected the index to have substance, got ' + onDisk.length);
});

test('the README points a reader at the index', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('docs/examples.md'), 'README no longer links the demo index');
});
