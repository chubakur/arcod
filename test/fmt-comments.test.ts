import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';

const spec = [
  'module m @0.1.0 {}',
  '',
  '// a task is a unit of work',
  'type Task = {',
  '  name: string,  // the human key',
  '  done: bool = false, // flipped by the board',
  '}',
  '',
  'enum Plan { free, pro // paid tier',
  '}',
  '',
  'service Tasks : tasks {',
  '  contract {',
  '    op create(input: Task) -> Task {  // writes one row',
  '      route: "/v1/tasks"',
  '    }',
  '  }',
  '}',
].join('\n');

test('fmt keeps a trailing comment on the field it trails', () => {
  const out = formatSource(spec, 'main.arc');
  assert.match(out, /^  name: string,  \/\/ the human key$/m);
  assert.match(out, /^  done: bool = false  \/\/ flipped by the board$/m);
});

test('fmt keeps a trailing enum value comment on the value line', () => {
  const out = formatSource(spec, 'main.arc');
  assert.match(out, /^  pro  \/\/ paid tier$/m);
});

test('fmt keeps a trailing comment on an op line', () => {
  const out = formatSource(spec, 'main.arc');
  assert.match(out, /^    op create\(input: Task\) -> Task \{  \/\/ writes one row$/m);
});

test('fmt stays idempotent with trailing comments', () => {
  const once = formatSource(spec, 'main.arc');
  assert.equal(formatSource(once, 'main.arc'), once);
});

test('fmt keeps leading comments before declarations alongside trailing ones', () => {
  const out = formatSource(spec, 'main.arc');
  assert.match(out, /^\/\/ a task is a unit of work\ntype Task = \{$/m);
});

test('a trailing comment on a closing brace is dropped, not moved', () => {
  const src = ['module m @0.1.0 {}', 'type T = {', '  x: int', '} // the task record'].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /type T = \{ x: int \}/);
  assert.doesNotMatch(out, /the task record/);
});

test('a trailing block comment is flattened onto its line', () => {
  const src = ['module m @0.1.0 {}', 'type T = { x: int /* the x */ }'].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^  x: int  \/\* the x \*\/$/m);
});

test('a comment inside the module header stays inside the block', () => {
  const src = ['module m @0.1.0 {', '  // the module note', '}', 'type T = { x: int }'].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.equal(out, 'module m @0.1.0 {\n  // the module note\n}\n\ntype T = { x: int }\n');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a header comment prints after the meta block and keeps its order', () => {
  const src = [
    'module m @0.1.0 {',
    '  // first note',
    '  meta { stage: "beta" }',
    '  // second note',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^module m @0\.1\.0 \{$/m);
  assert.match(out, /^  meta \{$/m);
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 5), [
    'module m @0.1.0 {',
    '  meta {',
    '    stage: "beta"',
    '  }',
    '  // first note',
  ]);
  assert.equal(lines[5], '  // second note');
  assert.equal(lines[6], '}');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a spec without comments still formats canonically', () => {
  const src = 'module m @0.1.0 {}\ntype T = { x: int }\n';
  const out = formatSource(src, 'main.arc');
  assert.equal(out, 'module m @0.1.0 {\n}\n\ntype T = { x: int }\n');
  assert.equal(formatSource(out, 'main.arc'), out);
});
