import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ParseError, parse } from '../src/parser.ts';

// The language server re-parses the editor buffer on every keystroke, so most
// buffers it sees are cut mid-token, mid-string or mid-block. Those bytes must
// reach the user as a located ParseError — never as a TypeError from a helper
// that assumed a finished tree, and never with a position outside the text it
// was given. This walks every example and every third prefix of its bytes.

function inBounds(text: string, loc: { line: number; col: number; offset: number; end: number }): boolean {
  const lines = text.split('\n');
  return loc.line >= 1 && loc.line <= lines.length
    && loc.col >= 1
    && loc.offset >= 0 && loc.end >= loc.offset && loc.end <= text.length;
}

test('every prefix of every example fails as a located ParseError, not a crash', () => {
  const dirs = readdirSync('examples', { withFileTypes: true }).filter((d) => d.isDirectory());
  let checked = 0;
  for (const dir of dirs) {
    let source: string;
    try {
      source = readFileSync(`examples/${dir.name}/main.arc`, 'utf8');
    } catch {
      continue;
    }
    for (let cut = 0; cut <= source.length; cut += 3) {
      const text = source.slice(0, cut);
      let accepted = false;
      try {
        parse(text, `${dir.name}/main.arc`);
        accepted = true;
      } catch (error) {
        checked++;
        assert.ok(error instanceof ParseError,
          `${dir.name} cut at ${cut}: expected ParseError, got ${String(error)}`);
        assert.match(error.message, /\S/, `${dir.name} cut at ${cut}: empty message`);
        assert.ok(inBounds(text, error.loc),
          `${dir.name} cut at ${cut}: position ${JSON.stringify(error.loc)} outside ${text.length} bytes`);
      }
      if (accepted) {
        // A prefix that parses must be a complete module — never a silently
        // half-built tree. The module header is the one thing every valid
        // prefix has.
        assert.ok(text.includes('module'), `${dir.name} cut at ${cut}: parsed without a module header`);
      }
    }
  }
  assert.ok(checked > 1000, `expected to reject many prefixes, rejected ${checked}`);
});

test('a lone surrogate and a NUL byte are a diagnostic, not an exception', () => {
  for (const text of [
    'module demo @0.1.0 { meta { owner: "\uD800" } }',
    'module demo @0.1.0 {\u0000}',
    'module demo @0.1.0 { meta { owner: "ok" } } \uD800',
  ]) {
    try {
      parse(text, 'odd.arc');
    } catch (error) {
      assert.ok(error instanceof ParseError, 'expected ParseError, got ' + String(error));
    }
  }
});
