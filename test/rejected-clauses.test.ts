// Every clause the parser refuses must say so. `set` used to be the exception:
// it parsed an expression and threw it away, so `set: x = 1` looked accepted in
// a spec and did nothing. These cases pin the whole rejected set — a wording
// change is fine, silence is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.ts';

function refuses(source: string, phrase: RegExp): void {
  assert.throws(
    () => parse(source, 'rejected.arc'),
    (error: unknown) => error instanceof ParseError && phrase.test(error.message),
    'expected ParseError matching ' + phrase,
  );
}

const moduleLevel = (statement: string) => 'module rejected @0.1.0 {\n  ' + statement + '\n}';
const serviceMember = (statement: string) => [
  'module rejected @0.1.0 {}',
  'service S : http {',
  '  ' + statement,
  '}',
].join('\n');
const opClause = (clause: string) => [
  'module rejected @0.1.0 {}',
  'service S : http {',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '      ' + clause,
  '    }',
  '  }',
  '}',
].join('\n');

test('module-level blocks that are not v0.1 are named', () => {
  refuses(moduleLevel('unknown X'), /unknown/);
  refuses(moduleLevel('policy { }'), /policy/);
  refuses(moduleLevel('change { }'), /change/);
});

test('service-level blocks that are not v0.1 are named', () => {
  refuses(serviceMember('lifecycle { }'), /lifecycle/);
  refuses(serviceMember('hint "do it"'), /hint/);
  refuses(serviceMember('impl { }'), /impl/);
  refuses(serviceMember('unknown { }'), /unknown/);
});

test('operation clauses that are not v0.1 are named', () => {
  refuses(opClause('idempotent'), /idempotent/);
  refuses(opClause('schedule: "0 3 * * *"'), /schedule/);
  refuses(opClause('since: "2026-01-01"'), /since/);
});

test('set: is refused instead of parsed and dropped', () => {
  refuses(opClause('set: 12'), /set.*not supported/);
});

test('a valid operation without those clauses still parses', () => {
  const mod = parse(opClause('errors: NotFound'), 'rejected.arc');
  assert.equal(mod.services[0].contract[0].name, 'ping');
});
