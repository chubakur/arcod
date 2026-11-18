import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { formatSource } from '../src/fmt.ts';

// Comment survival is the point of the anchors in fmt: a formatter may move a
// note to a canonical place, but it must never lose it. This walks every
// example and compares the comments before and after a format.
function commentsOf(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      out.push(src.slice(start, i));
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      out.push(src.slice(start, i));
      continue;
    }
    i++;
  }
  return out.map((c) => c.replace(/\s+/g, ' ').trim());
}

const examples = (await readdir(new URL('../examples', import.meta.url))).sort();

for (const name of examples) {
  test('fmt keeps every comment of example ' + name, async () => {
    const src = await readFile(new URL('../examples/' + name + '/main.arc', import.meta.url), 'utf8');
    const before = commentsOf(src);
    if (before.length === 0) return;
    const formatted = formatSource(src, 'main.arc');
    const after = commentsOf(formatted);
    for (const note of before) {
      assert.ok(after.includes(note), 'lost comment ' + JSON.stringify(note) + ' of ' + name);
    }
    assert.equal(after.length, before.length, 'no comment is duplicated either');
    assert.equal(formatSource(formatted, 'main.arc'), formatted, 'stable on a second pass');
  });
}

