// A service role vocabulary is enforced through A047: an operation naming a
// role the service never declared is an error. The other direction was silent —
// a declared role no operation names looks like an access rule and is dead
// text. W047 says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const NL = String.fromCharCode(10);

const spec = (roles: string, opRoles: string) => [
  'module m @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.auth @1',
  'type Task = { id: uuid, title: string }',
  'service S : http {',
  '  uses store: kv',
  '  uses auth: identity',
  '  roles: ' + roles,
  '  contract {',
  '    public op create(title: string) -> Task {',
  '      route: "POST /v1/tasks"',
  '      effects: store.set',
  '    }',
  '    auth op list() -> Task {',
  '      route: "GET /v1/tasks"',
  '      effects: store.find',
  '      roles: ' + opRoles,
  '    }',
  '  }',
  '}',
].join(NL);

const codes = (src: string) => {
  const mod = parse(src, 'main.arc');
  return check(mod).map((d) => d.code);
};

test('a declared role an operation names is not reported', () => {
  const found = codes(spec('admin, user', 'admin, user'));
  assert.equal(found.includes('W047'), false, found.join(' '));
});

test('a declared role no operation names is W047', () => {
  const mod = parse(spec('admin, auditor', 'admin'), 'main.arc');
  const diags = check(mod).filter((d) => d.code === 'W047');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].message, /role auditor is declared by the service but no operation names it/);
  assert.equal(diags[0].severity, 'warning');
});
