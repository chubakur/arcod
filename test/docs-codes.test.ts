// The diagnostic list in both READMEs is the only public catalogue of codes.
// A code that is emitted but not listed is invisible; a code that is listed
// but no longer emitted is a promise the compiler does not keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function emitted(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const dir of ['src', 'src/emit']) {
    for (const file of await readdir(join(root, dir))) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(join(root, dir, file), 'utf8');
      for (const match of text.matchAll(/diag\('([AW][0-9]{3})'/g)) codes.add(match[1]);
    }
  }
  return codes;
}

async function documented(file: string): Promise<Set<string>> {
  const text = await readFile(join(root, file), 'utf8');
  return new Set([...text.matchAll(/\b([AW][0-9]{3})\b/g)].map((match) => match[1]));
}

test('every emitted diagnostic is documented in both READMEs', async () => {
  const codes = await emitted();
  assert.ok(codes.size > 60, 'the source scan found ' + codes.size + ' codes');
  for (const file of ['README.md', 'README_rus.md']) {
    const doc = await documented(file);
    const missing = [...codes].filter((code) => !doc.has(code)).sort();
    const stale = [...doc].filter((code) => !codes.has(code)).sort();
    assert.deepEqual(missing, [], file + ' does not list: ' + missing.join(', '));
    assert.deepEqual(stale, [], file + ' lists codes nothing emits: ' + stale.join(', '));
  }
});
