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

test('a comment after the last declaration is kept at the end of the file', () => {
  const src = ['module m @0.1.0 {}', 'type T = { x: int }', '// end of the model', ''].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.equal(out, 'module m @0.1.0 {\n}\n\ntype T = { x: int }\n\n// end of the model\n');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a header note and an end note are kept on both ends', () => {
  const src = [
    'module m @0.1.0 {',
    '  // about the module',
    '}',
    'type T = { x: int }',
    '// about the whole model',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^  \/\/ about the module$/m);
  assert.match(out, /^\/\/ about the whole model$/m);
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a spec without comments still formats canonically', () => {
  const src = 'module m @0.1.0 {}\ntype T = { x: int }\n';
  const out = formatSource(src, 'main.arc');
  assert.equal(out, 'module m @0.1.0 {\n}\n\ntype T = { x: int }\n');
  assert.equal(formatSource(out, 'main.arc'), out);
});

// A comment written inside `meta { ... }` used to slide out of the block: the
// header rule claimed every comment inside the module braces. The block owns
// its offsets now, so the comment stays next to the entry it describes.
test('a comment inside the module meta block stays inside it', () => {
  const source = [
    'module m @0.1.0 {',
    '  meta {',
    '    owner: "@you"',
    '    // статус пока черновик',
    '    status: "draft"',
    '  }',
    '}',
    '',
  ].join('\n');
  const formatted = formatSource(source, 'm.arc');
  const lines = formatted.split('\n');
  const metaOpen = lines.indexOf('  meta {');
  const metaClose = lines.indexOf('  }');
  const comment = lines.findIndex((l) => l.includes('черновик'));

  assert.notEqual(metaOpen, -1, 'the block survives');
  assert.ok(comment > metaOpen && comment < metaClose, 'the comment sits between the braces: ' + JSON.stringify(formatted));
  assert.equal(lines[comment].startsWith('    //'), true, 'and is indented like a meta entry');
  assert.equal(formatSource(formatted, 'm.arc'), formatted, 'stable on a second pass');
});

test('a comment after the last meta entry stays in the block', () => {
  const source = [
    'module m @0.1.0 {',
    '  meta {',
    '    owner: "@you"  // who owns it',
    '    // конец блока',
    '  }',
    '}',
    '',
  ].join('\n');
  const lines = formatSource(source, 'm.arc').split('\n');
  assert.equal(lines.some((l) => l.includes('who owns it') && l.includes('owner:')), true, 'the trailing comment keeps its line');
  const close = lines.indexOf('  }');
  const tail = lines.findIndex((l) => l.includes('конец блока'));
  assert.ok(tail > 1 && tail < close, 'the block-end comment stays inside: ' + JSON.stringify(lines.join('\n')));
});

test('a comment inside a service meta block stays inside it', () => {
  const source = [
    'module m @0.1.0 {}',
    '',
    'service Api : http {',
    '  meta {',
    '    owner: "@you"',
    '    // сервис на паузе',
    '    status: "paused"',
    '  }',
    '  contract {',
    '    public op get() -> string {',
    '      route: "GET /v1/get"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const formatted = formatSource(source, 'm.arc');
  const lines = formatted.split('\n');
  const open = lines.findIndex((l) => l === '  meta {');
  const comment = lines.findIndex((l) => l.includes('сервис на паузе'));
  assert.ok(open !== -1 && comment > open && comment < lines.indexOf('  }', open), 'comment stays between the braces: ' + JSON.stringify(formatted));
  assert.equal(formatSource(formatted, 'm.arc'), formatted, 'stable on a second pass');
});

test('a service meta block without comments prints canonically', () => {
  const source = [
    'module m @0.1.0 {}',
    'service Api : http {',
    '  meta { owner: "@you", status: "live" }',
    '  contract {',
    '    public op get() -> string { route: "GET /v1/get" }',
    '  }',
    '}',
    '',
  ].join('\n');
  const formatted = formatSource(source, 'm.arc');
  assert.match(formatted, /  meta \{\n    owner: "@you"\n    status: "live"\n  \}\n\n/);
  assert.equal(formatSource(formatted, 'm.arc'), formatted);
});


const workflowSpec = [
  'module m @0.1.0 {}',
  '',
  'workflow Nightly {',
  '  // runs at midnight',
  '  trigger cron("0 0 * * *")',
  '  // never doubled',
  '  overlap: skip',
  '  retry: 3',
  '',
  '  // the only step',
  '  step one() {',
  '    call: a.b',
  '  }',
  '  // last word',
  '}',
].join('\n');

test('a comment above a workflow clause stays on that clause', () => {
  const out = formatSource(workflowSpec, 'main.arc');
  assert.match(out, /^  \/\/ runs at midnight\n  trigger cron\("0 0 \* \* \*"\)$/m);
  assert.match(out, /^  \/\/ never doubled\n  overlap: skip$/m);
  assert.doesNotMatch(out, /\/\/ runs at midnight\n  \/\/ never doubled\n  step/, 'the comments do not pile up on the first step');
});

test('a workflow comment after the last step stays inside the block', () => {
  const out = formatSource(workflowSpec, 'main.arc');
  assert.match(out, /  \/\/ last word\n\}$/m);
});

test('a trailing comment on a workflow clause stays on its line', () => {
  const src = ['module m @0.1.0 {}', 'workflow W {', '  trigger cron("0 0 * * *")', '  overlap: skip // never doubled', '}'].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^  overlap: skip  \/\/ never doubled$/m);
});

test('comments inside a ui block stay in the block, on their properties', () => {
  const src = [
    'module m @0.1.0 {}',
    'ui Board {',
    '  // the board page',
    '  kind: spa',
    '  route: "/board"',
    '  // dark by default',
    '  theme: dark',
    '  // printed by the service',
    '  render: ssr',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^  \/\/ the board page\n  kind: spa$/m);
  assert.match(out, /^  \/\/ dark by default\n  theme: dark$/m);
  assert.match(out, /^  \/\/ printed by the service\n  render: ssr$/m);
  assert.doesNotMatch(out, /\n\n\/\/ the board page/, 'nothing but the header precedes the block');
});

test('a comment on a default-valued ui property stays inside the block', () => {
  const src = [
    'module m @0.1.0 {}',
    'ui Plain {',
    '  kind: spa',
    '  route: "/"',
    '  // keeps the default look',
    '  theme: auto',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  const lines = out.split('\n');
  const open = lines.indexOf('ui Plain {');
  const note = lines.findIndex((l) => l.includes('keeps the default look'));
  assert.ok(note > open && note < lines.indexOf('}', open), 'the comment stays between the braces: ' + JSON.stringify(out));
  assert.equal(formatSource(out, 'main.arc'), out, 'stable on a second pass');
});

test('workflow and ui formatting with clause comments is idempotent', () => {
  const once = formatSource(workflowSpec, 'main.arc');
  assert.equal(formatSource(once, 'main.arc'), once);
});



test('a comment inside a workflow step stays on its own clause', () => {
  const src = [
    'module m @0.1.0 {}',
    'workflow W {',
    '  step one() {',
    '    // what it calls',
    '    call: a.b',
    '    // and what it needs',
    '    needs: zero',
    '    onfail: skip // fails soft',
    '  }',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^    \/\/ what it calls\n    call: a\.b$/m);
  assert.match(out, /^    \/\/ and what it needs\n    needs: zero$/m);
  assert.match(out, /^    onFail: skip  \/\/ fails soft$/m);
  assert.equal(formatSource(out, 'main.arc'), out, 'stable on a second pass');
});

test('a comment after the last step clause stays inside the step', () => {
  const src = [
    'module m @0.1.0 {}',
    'workflow W {',
    '  step one() {',
    '    call: a.b',
    '    // nothing else to say',
    '  }',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^    \/\/ nothing else to say\n  \}$/m);
  assert.equal(formatSource(out, 'main.arc'), out);
});



const sagaSpec = [
  'module m @0.1.0 {}',
  'type Task = { name: string }',
  'service Api : http {',
  '  contract {',
  '    public op a() -> Task { route: "POST /a" }',
  '    public op b() -> Task { route: "POST /b" }',
  '  }',
  '  saga Checkout {',
  '    // reserve first',
  '    step reserve {',
  '      call: a',
  '      // undo it',
  '      compensate: b',
  '      retry: 2',
  '    }',
  '  }',
  '}',
].join('\n');

test('a commented saga step goes multi-line and keeps its comments', () => {
  const out = formatSource(sagaSpec, 'main.arc');
  assert.match(out, /^    step reserve \{$/m);
  assert.match(out, /^      call: a\n      \/\/ undo it\n      compensate: b\n      retry: 2$/m);
  assert.match(out, /^      \/\/ undo it$/m);
  assert.equal(formatSource(out, 'main.arc'), out, 'stable on a second pass');
});

test('an uncommented saga step stays on one line', () => {
  const src = [
    'module m @0.1.0 {}',
    'service Api : http {',
    '  contract { public op a() -> string { route: "POST /a" } }',
    '  saga S { step one { call: a retry: 1 } }',
    '}',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /^    step one \{ call: a retry: 1 \}$/m);
});

