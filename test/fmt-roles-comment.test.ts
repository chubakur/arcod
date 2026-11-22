import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';

const source = [
  'module m @0.1.0 {}',
  '',
  'service Tasks : http {',
  '  uses store: kv  // where rows live',
  '  uses uuid: ids // ids',
  '  roles: admin, user // who may call',
  '}',
].join('\n');

test('fmt keeps a trailing comment on a service roles clause', () => {
  const out = formatSource(source, 'main.arc');
  assert.match(out, /^  roles: admin, user  \/\/ who may call$/m);
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('fmt keeps a comment written above the service roles clause', () => {
  const above = [
    'module m @0.1.0 {}',
    '',
    'service Tasks : http {',
    '  uses store: kv',
    '  // who may call',
    '  roles: admin, user',
    '}',
  ].join('\n');
  const out = formatSource(above, 'main.arc');
  assert.match(out, /^  \/\/ who may call\n  roles: admin, user$/m);
  assert.equal(formatSource(out, 'main.arc'), out);
});
