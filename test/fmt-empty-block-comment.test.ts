// A block with no declarations is normally dropped by fmt (an empty
// `contract {}` says nothing the service does not already say). A comment
// written between its braces is not nothing: before this, the note fell past
// the closing brace, found no node to attach to and vanished, while README
// promised that a comment after the last clause of `contract`/`rules`/
// `examples` survives. The block is now kept when it carries a comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

const NL = String.fromCharCode(10);

test('a comment inside an empty contract keeps the block and the comment', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    // no operations yet',
    '  }',
    '}',
    '',
  ].join(NL);
  const out = formatSource(source, 'main.arc');
  assert.equal(out, [
    'module m @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    // no operations yet',
    '  }',
    '}',
    '',
  ].join(NL));
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a comment inside an empty rules block survives above the contract', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  rules {',
    '    // invariants come later',
    '  }',
    '  contract {',
    '    public op a() -> int {',
    '      route: "GET /a"',
    '    }',
    '  }',
    '}',
    '',
  ].join(NL);
  const out = formatSource(source, 'main.arc');
  assert.match(out, /rules \{[\s\S]*invariants come later[\s\S]*contract \{/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a block with nothing inside is still dropped', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  rules {',
    '  }',
    '  contract {',
    '    public op a() -> int {',
    '      route: "GET /a"',
    '    }',
    '  }',
    '}',
    '',
  ].join(NL);
  const out = formatSource(source, 'main.arc');
  assert.doesNotMatch(out, /rules/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('a comment inside an empty service meta block keeps the block', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  meta {',
    '    // owner comes later',
    '  }',
    '  contract {',
    '    public op a() -> int {',
    '      route: "GET /a"',
    '    }',
    '  }',
    '}',
    '',
  ].join(NL);
  const out = formatSource(source, 'main.arc');
  assert.match(out, /meta \{[\s\S]*owner comes later[\s\S]*\}/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('an empty service meta block without a comment is dropped', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  meta {',
    '  }',
    '  contract {',
    '    public op a() -> int {',
    '      route: "GET /a"',
    '    }',
    '  }',
    '}',
    '',
  ].join(NL);
  const out = formatSource(source, 'main.arc');
  assert.doesNotMatch(out, /meta/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});
