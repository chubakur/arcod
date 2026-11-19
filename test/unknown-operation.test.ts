// A name in an example or a rule must be an operation of that service.
// `arcod test` resolves it at run time: an example failed with "unknown
// function creat in example" and a rule with "operation readd not found", both
// after the build and the service start. A081 puts the typo on its own line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const spec = (rules: string, examples: string): string => [
  'module names @0.1.0 {}',
  '',
  'type Note = { id: string, text: string }',
  '',
  'error NotFound',
  '',
  'service Notes : http {',
  '  uses store: kv',
  '  effects {',
  '    allow store.get, store.set, store.del',
  '  }',
  '  contract {',
  '    public op create(text: string) -> string {',
  '      route: "POST /v1/notes"',
  '    }',
  '    public op read(id: string) -> Note {',
  '      route: "GET /v1/notes/:id"',
  '      errors: NotFound',
  '    }',
  '  }',
  '  rules {',
  rules,
  '  }',
  '  examples {',
  examples,
  '  }',
  '}',
].join('\n');

function a081(source: string): string[] {
  return check(parse(source, 'names.arc')).filter((diag) => diag.code === 'A081').map((diag) => diag.message);
}

const noRules = '';
const noExamples = '';

test('A081: an example calls a name that is not an operation', () => {
  const found = a081(spec(noRules, [
    '    example typo {',
    '      when {',
    '        let n = creat("x")',
    '      }',
    '      then {',
    '        n != null',
    '      }',
    '    }',
  ].join('\n')));
  assert.deepEqual(found, ['example typo: creat is not an operation of Notes']);
});

test('A081: uuid(...) stays the allowed builtin', () => {
  const found = a081(spec(noRules, [
    '    example literal_id {',
    '      when {',
    '        let n = read(uuid("00000000-0000-0000-0000-000000000000"))',
    '      }',
    '      then {',
    '        n is NotFound',
    '      }',
    '    }',
  ].join('\n')));
  assert.deepEqual(found, []);
});

test('A081: once(...) names the operation it checks', () => {
  const found = a081(spec('    invariant read.once: once(readd, by: id, else: NotFound)', noExamples));
  assert.deepEqual(found, ['once(readd) names no operation of Notes']);
});

test('A081: atomic names the operation it checks', () => {
  const found = a081(spec('    atomic readd { get; del }', noExamples));
  assert.deepEqual(found, ['atomic readd names no operation of Notes']);
});

test('A081: real rule targets are clean', () => {
  const found = a081(spec('    invariant read.once: once(read, by: id, else: NotFound)\n    atomic read { get; del }', noExamples));
  assert.deepEqual(found, []);
});
