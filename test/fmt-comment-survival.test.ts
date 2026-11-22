// Every comment a spec carries must survive a format pass. The unit tests above
// pin one place at a time; this one takes every example and appends a marker to
// each code line — an opening brace, a closing brace, a `when {` — so a comment
// the printer has no anchor for shows up as a lost marker. It found four such
// places at once (module meta open and close, the module's own closing brace,
// and the example section braces).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatSource } from '../src/fmt.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const examples = readdirSync(join(ROOT, 'examples'))
  .filter((dir) => existsSync(join(ROOT, 'examples', dir, 'main.arc')));

test('every example keeps a comment appended to each of its code lines', () => {
  assert.ok(examples.length > 0, 'no examples found');
  for (const dir of examples) {
    const file = join('examples', dir, 'main.arc');
    const source = readFileSync(join(ROOT, file), 'utf8');
    const lines = source.split('\n');
    const tagged = lines
      .map((line, i) => (line.trim() === '' || line.trim().startsWith('//') ? line : line + '  // c' + i))
      .join('\n');
    const out = formatSource(tagged, file);
    const missing: string[] = [];
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//')) return;
      const marker = '// c' + i;
      if (!out.includes(marker + '\n') && !out.endsWith(marker)) missing.push(i + 1 + ': ' + trimmed.slice(0, 60));
    });
    assert.deepEqual(missing, [], dir + ' lost comments on: ' + missing.join(' | '));
    assert.equal(formatSource(out, file), out, dir + ' is not idempotent with comments');
  }
});
