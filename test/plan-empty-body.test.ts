// A body plan with no step left the prompt carrying only the signature, so a
// local model had nothing to follow for the simplest operation in a contract:
// a void `ping` with no effects. The handler still has to answer an object (a
// falsy return is `Internal`, an undefined result is sent as `null`), so the
// plan now always derives at least `return {}`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { planBody, planText } from '../src/plan-body.ts';
import { buildPrompts } from '../src/prompts.ts';

const NL = String.fromCharCode(10);

const VOID_SPEC = [
  'module m @0.1.0 {}',
  'service S : http {',
  '  contract {',
  '    public op ping() {',
  '      route: "GET /v1/ping"',
  '    }',
  '  }',
  '}',
  '',
].join(NL);

test('a void operation with no effects derives a return step', () => {
  const mod = parse(VOID_SPEC, 'main.arc');
  const svc = mod.services[0];
  const op = svc.contract[0];
  const plan = planBody(mod, svc, op);
  assert.deepEqual(plan.steps, ['return {}']);
  assert.equal(planText(plan), 'return {}');
});

test('the prompt of that operation carries the step, not only the signature', () => {
  const mod = parse(VOID_SPEC, 'main.arc');
  const set = buildPrompts(mod, { budget: 1600, format: 'compact' });
  const task = set.tasks.find((item) => item.op === 'ping');
  assert.ok(task);
  assert.match(task!.prompt, /steps: return \{\}/);
});
