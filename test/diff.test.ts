import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSpecs } from '../src/diff.ts';
import { parse } from '../src/parser.ts';
import { printModule } from '../src/fmt.ts';

// arcod diff is the review surface: it must report semantic changes only, and
// every hunk it prints has to apply cleanly to the left side and reproduce the
// right side. These tests parse the patch instead of comparing golden text, so
// a drifting context window or a wrong line count fails here.

const canonical = (source: string, file = 'x.arc'): string[] => {
  const lines = printModule(parse(source, file)).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const base = `module m @0.1.0 {
  meta {
    owner: "@a"
  }
}

type A = { id: uuid }
`;

const withB = base + 'type B = { id: uuid }\n';
const renamedA = base.replace('type A', 'type Renamed');
const wide =
  'module m @0.1.0 {\n  meta {\n    owner: "@a"\n  }\n}\n\n' +
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((n) => 'type ' + n + ' = { id: uuid }\n').join('');
const wideChanged =
  wide.replace('owner: "@a"', 'owner: "@b"') + 'type J = { id: uuid }\n';

interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  body: string[];
}

function parseHunks(patch: string): Hunk[] {
  const lines = patch.split('\n');
  assert.equal(lines[0], '--- a.arc', 'left header');
  assert.equal(lines[1], '+++ b.arc', 'right header');
  const hunks: Hunk[] = [];
  let i = 2;
  while (i < lines.length) {
    if (lines[i] === '') { i++; continue; }
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]);
    assert.ok(m, 'hunk header line: ' + lines[i]);
    const hunk: Hunk = {
      aStart: Number(m[1]),
      aCount: Number(m[2]),
      bStart: Number(m[3]),
      bCount: Number(m[4]),
      body: [],
    };
    i++;
    while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('+') || lines[i].startsWith('-'))) {
      hunk.body.push(lines[i]);
      i++;
    }
    assert.equal(
      hunk.body.filter((l) => !l.startsWith('+')).length,
      hunk.aCount,
      'aCount matches the body',
    );
    assert.equal(
      hunk.body.filter((l) => !l.startsWith('-')).length,
      hunk.bCount,
      'bCount matches the body',
    );
    hunks.push(hunk);
  }
  return hunks;
}

// Apply a unified patch to canonical lines; throws when the context or the
// deleted lines do not match, which is exactly the failure a wrong hunk
// header or a shifted range produces.
function apply(a: string[], patch: string): string[] {
  const out: string[] = [];
  let pos = 0; // 0-based index into a
  for (const hunk of parseHunks(patch)) {
    while (pos < hunk.aStart - 1) out.push(a[pos++]);
    for (const line of hunk.body) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === ' ') {
        assert.equal(a[pos], text, 'context line at a:' + (pos + 1));
        out.push(a[pos++]);
      } else if (kind === '-') {
        assert.equal(a[pos], text, 'deleted line at a:' + (pos + 1));
        pos++;
      } else {
        out.push(text);
      }
    }
  }
  while (pos < a.length) out.push(a[pos++]);
  return out;
}

function diff(aSource: string, bSource: string): string {
  return diffSpecs(aSource, 'a.arc', bSource, 'b.arc');
}

test('an unchanged spec produces headers only', () => {
  assert.equal(diff(base, base), '--- a.arc\n+++ b.arc\n');
});

test('formatting-only changes are not a diff', () => {
  const loose = 'module m @0.1.0 {\n\n    meta {\n        owner:   "@a"\n    }\n\n}\n\ntype A   =   { id: uuid }\n';
  // both parse to the same AST: only indentation, blank lines and spacing differ
  assert.equal(diff(base, loose), '--- a.arc\n+++ b.arc\n');
});

test('an added declaration applies cleanly and lands in one hunk', () => {
  const patch = diff(base, withB);
  const hunks = parseHunks(patch);
  assert.equal(hunks.length, 1, 'one contiguous change');
  assert.ok(hunks[0].body.includes('+type B = { id: uuid }'), 'inserted line is marked');
  assert.deepEqual(apply(canonical(base), patch), canonical(withB));
});

test('a removed declaration is marked with minus and applies cleanly', () => {
  const patch = diff(base, 'module m @0.1.0 {\n  meta {\n    owner: "@a"\n  }\n}\n');
  assert.ok(patch.includes('-type A = { id: uuid }'), patch);
  assert.deepEqual(apply(canonical(base), patch), canonical('module m @0.1.0 {\n  meta {\n    owner: "@a"\n  }\n}\n'));
});

test('a rename stays a delete/insert pair, not a silent no-op', () => {
  const patch = diff(base, renamedA);
  assert.ok(patch.includes('-type A = { id: uuid }'), patch);
  assert.ok(patch.includes('+type Renamed = { id: uuid }'), patch);
  assert.deepEqual(apply(canonical(base), patch), canonical(renamedA));
});

test('changes far apart split into hunks that each apply', () => {
  const patch = diff(wide, wideChanged);
  const hunks = parseHunks(patch);
  assert.ok(hunks.length >= 2, 'two distant regions produce two hunks: ' + patch);
  assert.deepEqual(apply(canonical(wide), patch), canonical(wideChanged));
});

test('hunk headers stay inside the file when the change is at the end', () => {
  const patch = diff(base, withB);
  const [hunk] = parseHunks(patch);
  assert.ok(hunk.bStart + hunk.bCount - 1 <= canonical(withB).length, 'right range in bounds');
  assert.ok(hunk.aStart + hunk.aCount - 1 <= canonical(base).length, 'left range in bounds');
});

test('header names come from the caller, not from the module', () => {
  const patch = diffSpecs(base, 'left/main.arc', withB, 'right/main.arc');
  assert.ok(patch.startsWith('--- left/main.arc\n+++ right/main.arc\n'), patch);
});
