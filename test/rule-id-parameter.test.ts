// `once(read, by: id)` and `atomic read { get; del }` are implemented by
// takeIf/seen keyed by the operation's uuid parameter. An operation without one
// silently got no rule at all: the spec promised a guarantee, the generated body
// never consumed anything. W042 names the parameter gap at the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const spec = (idType: string): string => [
  'module rules @0.1.0 {}',
  '',
  'type Key = uuid',
  '',
  'error NotFound',
  'error Gone',
  '',
  'service S : http {',
  '  uses store: kv',
  '  rules {',
  '    invariant read.once: once(read, by: id, else: Gone)',
  '    atomic read { get; del }',
  '  }',
  '  contract {',
  '    public op read(id: ' + idType + ') -> string {',
  '      route: "GET /v1/things/:id"',
  '      errors: NotFound, Gone',
  '    }',
  '  }',
  '}',
].join('\n');

test('W042: a rule on an operation without a uuid parameter', () => {
  const found = check(parse(spec('string'), 'rules.arc')).filter((diag) => diag.code === 'W042');
  assert.equal(found.length, 2, 'once and atomic both point at read');
  assert.match(found[0].message, /read\.once names read, which has no uuid parameter/);
  assert.match(found[1].message, /read names read, which has no uuid parameter/);
  assert.equal(found[0].severity, 'warning');
});

test('W042: uuid and an alias of uuid are fine', () => {
  for (const type of ['uuid', 'Key']) {
    const found = check(parse(spec(type), 'rules.arc')).filter((diag) => diag.code === 'W042');
    assert.deepEqual(found, [], type);
  }
});
