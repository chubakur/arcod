// uniquesByEntity and indexesByEntity were plain objects keyed by a record
// name. An entity named like a prototype member answered a function where an
// array of rules was expected, so migrationPlan threw before writing a table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { migrationPlan } from '../src/migrate.ts';

const sourceOf = (name: string): string => [
  'module m @0.1.0 {}',
  'use capability arcod.std.sql @1',
  'type ' + name + ' = { id: uuid, at: datetime, title: string }',
  'service S : http {',
  '  uses store: sql',
  '  effects { allow store.insert }',
  '  rules {',
  '    unique ' + name + '.title',
  '    index ' + name + '.at',
  '  }',
  '  contract {',
  '    public op create(id: uuid, title: string) -> ' + name + ' { route: "POST /v1/t" }',
  '  }',
  '}',
].join('\n');

const planOf = (name: string) => {
  const mod = parse(sourceOf(name), 'main.arc');
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return migrationPlan(mod, svc);
};

test('an entity named like a prototype member still gets its table', () => {
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const plan = planOf(name);
    const table = plan.migrations.find((m) => m.name === name.toLowerCase());
    assert.ok(table, name + ' is migrated');
    assert.match(table.up, /UNIQUE/, name + ' keeps its unique rule');
    assert.match(table.up, /idx_/, name + ' keeps its index');
    assert.match(table.down, /DROP TABLE/, name + ' can be rolled back');
  }
});

test('an entity named __proto__ does not change the rule maps', () => {
  const plan = planOf('__proto__');
  const table = plan.migrations.find((m) => m.name === '__proto__');
  assert.ok(table, 'the record is still a table');
  assert.match(table.up, /UNIQUE/);
  assert.equal(({} as Record<string, unknown>).idx_dummy, undefined, 'Object.prototype is untouched');
});
