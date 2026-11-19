// An example call is what `arcod test` actually invokes, by position. A call
// with an extra argument silently dropped it, and a call with a missing one
// sent undefined: the only place that can say so is `check`. A080 is that
// promise; a trailing parameter with a default or an optional type may be left
// out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function diags(op: string, call: string, code = 'A080'): Array<{ code: string; message: string }> {
  const source = [
    'module arity @0.1.0 {}',
    '',
    'type Note = { id: string, text: string }',
    '',
    'service Notes : http {',
    '  contract {',
    '    public op create' + op + ' -> Note {',
    '      route: "POST /v1/notes"',
    '    }',
    '  }',
    '  examples {',
    '    example call {',
    '      when {',
    '        let note = create(' + call + ')',
    '      }',
    '      then {',
    '        note != null',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return check(parse(source, 'arity.arc')).filter((diag) => diag.code === code);
}

test('A080: more arguments than parameters', () => {
  const found = diags('(text: string, tag: string)', '"a", "b", "c"');
  assert.equal(found.length, 1);
  assert.equal(found[0].message, 'example call: create takes 2 argument(s), the call passes 3');
});

test('W041: a missing argument without a default is named', () => {
  const found = diags('(text: string, tag: string)', '"a"', 'W041');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /missing argument tag/);
  assert.match(found[0].message, /undefined/);
});

test('A080: a trailing default may be omitted', () => {
  assert.deepEqual(diags('(text: string, tag: string = "x")', '"a"'), []);
});

test('A080: a trailing optional parameter may be omitted', () => {
  assert.deepEqual(diags('(text: string, tag: string?)', '"a"'), []);
});

test('A080: a matching count is clean', () => {
  assert.deepEqual(diags('(text: string)', '"a"'), []);
});
