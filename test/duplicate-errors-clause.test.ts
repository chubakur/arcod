// An operation may list `errors:` twice; the emitter flattens both clauses
// into one map. check read only the first, so an error declared in the second
// produced W039 ("handler for an error not in errors:"), A007 ("declared but
// not handled") and A078 in the wrong direction — diagnostics that contradicted
// the service the build would produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const source = [
  'module errors @0.1.0 {}',
  '',
  'type Note = { id: string }',
  '',
  'error NotFound',
  'error Gone',
  '',
  'service S : http {',
  '  contract {',
  '    public op read(id: string) -> Note {',
  '      route: "GET /v1/notes/:id"',
  '      errors: NotFound',
  '      errors: Gone',
  '      on error NotFound: true',
  '      on error Gone: true',
  '    }',
  '  }',
  '  rules {',
  '    invariant read.once: once(read, by: id, else: Gone)',
  '  }',
  '}',
].join('\n');

test('a second errors: clause is part of the contract for check too', () => {
  const codes = check(parse(source, 'errors.arc')).map((diag) => diag.code);
  for (const code of ['W039', 'A007', 'A078']) {
    assert.equal(codes.includes(code), false, code + ' must not fire: ' + JSON.stringify(codes));
  }
});

test('the same contract passes A022 for an else: in the second clause', () => {
  const a022 = check(parse(source, 'errors.arc')).filter((diag) => diag.code === 'A022');
  assert.deepEqual(a022, []);
});
