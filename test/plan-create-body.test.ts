// The prompt for a create says how the record is built: which fields come from
// the input, which from io.new(), which from the actor and which start as now
// or null. That literal (`entityLiteral`) was never executed by any test, so a
// drift in the field order or in the owner/id spelling would reach the model
// unnoticed. A remove op pins the other unreached branch: io.del.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { planBody, planText } from '../src/plan-body.ts';

const NL = String.fromCharCode(10);

const CREATE_SPEC = [
  'module m @0.1.0 {}',
  'type Note = { id: uuid, title: string, owner: string, createdAt: datetime }',
  'service S : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '  uses auth: identity',
  '  contract {',
  '    public op create(title: string) -> Note {',
  '      route: "POST /v1/notes"',
  '      effects: store.set, uuid.new, auth.actor',
  '      roles: user',
  '    }',
  '    public op remove(id: uuid) -> bool {',
  '      route: "DELETE /v1/notes/{id}"',
  '      effects: store.del',
  '    }',
  '  }',
  '}',
  '',
].join(NL);

test('a create spells the record it stores: id, owner, now, param', () => {
  const mod = parse(CREATE_SPEC, 'main.arc');
  const svc = mod.services[0];
  const plan = planBody(mod, svc, svc.contract[0]);
  assert.deepEqual(plan.steps, [
    'actor = await io.actor()',
    'id = await io.new()',
    'record = { id: id, title: title, owner: actor.id, createdAt: new Date().toISOString() }',
    'await io.set(id, record)',
    'return { result: record }',
  ]);
  assert.deepEqual(plan.intents, ['actor', 'generate-id', 'persist']);
  assert.match(planText(plan), /; record = \{ id: id, title: title, owner: actor\.id, createdAt: new Date\(\)\.toISOString\(\) \}; /);
});

test('a remove deletes by the path id and answers true', () => {
  const mod = parse(CREATE_SPEC, 'main.arc');
  const svc = mod.services[0];
  const plan = planBody(mod, svc, svc.contract[1]);
  assert.deepEqual(plan.steps, ['await io.del(id)', 'return { result: true }']);
  assert.deepEqual(plan.intents, ['remove']);
  assert.deepEqual(plan.unresolved, []);
});
