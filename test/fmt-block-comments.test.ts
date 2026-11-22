// fmt coverage for the block-comment branches: an empty line inside /* ... */,
// a block comment written after the last field of a body, a block comment
// before the closing brace of a workflow, and the comment-free printModule
// entry point.  Each case is asserted for placement and idempotence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource, printModule } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

const format = (source: string): string => formatSource(source, 'main.arc');

test('a blank line inside a block comment stays blank and gains no indent', () => {
  const source = [
    'module m @0.1.0 {}',
    '',
    '/*',
    '  first',
    '   ',
    '  second',
    '*/',
    'type Row = { id: uuid }',
    '',
  ].join('\n');
  const out = format(source);
  assert.match(out, /^\/\*\n  first\n\n  second\n\*\/$/m, 'the blank line has no spaces left');
  assert.equal(format(out), out, 'a second pass changes nothing');
});

test('a block comment after the last record field stays inside the braces', () => {
  const source = [
    'module m @0.1.0 {}',
    'type Row = {',
    '  id: uuid',
    '  /*',
    '   * the body ends here',
    '   */',
    '}',
    '',
  ].join('\n');
  const out = format(source);
  assert.match(out, /^  \/\*\n   \* the body ends here\n   \*\/$/m, 'the comment keeps the body indent');
  assert.ok(out.indexOf('*/') < out.lastIndexOf('\n}'), 'the comment is printed before the closing brace');
  assert.equal(format(out), out, 'a second pass changes nothing');
});

test('a block comment before the workflow closing brace stays in the block', () => {
  const source = [
    'module m @0.1.0 {}',
    '',
    'workflow W {',
    '  trigger manual',
    '  step touch() {',
    '    call: Items.list',
    '  }',
    '  /*',
    '    end of the workflow',
    '  */',
    '}',
    '',
  ].join('\n');
  const out = format(source);
  assert.match(out, /^  \/\*\n    end of the workflow\n  \*\/$/m, 'the block comment keeps a body indent');
  const close = out.lastIndexOf('\n}');
  assert.ok(out.indexOf('end of the workflow') < close, 'the text is before the closing brace');
  assert.equal(format(out), out, 'a second pass changes nothing');
});

test('printModule prints a parsed module without comments', () => {
  const source = 'module m @0.1.0 {}\ntype Row = { id: uuid }\n';
  const out = printModule(parse(source, 'main.arc'));
  assert.equal(out, 'module m @0.1.0 {\n}\n\ntype Row = { id: uuid }\n');
  assert.equal(format(source), out, 'printModule matches formatSource on a comment-free file');
});
