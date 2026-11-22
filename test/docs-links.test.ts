// The docs are a set of files that point at each other: README links the
// guides, and guides mention each other in backticks. A rename that misses one
// reference leaves a reader at a 404 that no test noticed. This walks every
// local Markdown link and every `docs/*.md` mention in the docs and checks it
// resolves on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function pages(): Promise<string[]> {
  const guides = (await readdir(join(root, 'docs')))
    .filter((file) => file.endsWith('.md'))
    .map((file) => join('docs', file));
  return ['README.md', 'README_rus.md', 'CONTRIBUTING.md', 'ROADMAP.md', ...guides]
    .filter((file) => existsSync(join(root, file)));
}

test('every local link in the docs points at a file on disk', async () => {
  const files = await pages();
  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0]);
      if (!path || path.startsWith('/')) continue;
      checked++;
      if (!existsSync(resolve(root, dirname(file), path))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], 'dead local links: ' + broken.join(', '));
  assert.ok(checked >= 8, 'expected the docs to link each other, found ' + checked);
});

test('every docs/*.md mentioned anywhere in the docs exists', async () => {
  const files = await pages();
  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    for (const match of text.matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) {
      checked++;
      if (!existsSync(join(root, match[0]))) broken.push(`${file} -> ${match[0]}`);
    }
  }
  assert.deepEqual(broken, [], 'references to missing docs: ' + broken.join(', '));
  assert.ok(checked >= 10, 'expected cross-references between the guides, found ' + checked);
});
