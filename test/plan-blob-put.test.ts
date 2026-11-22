// `blob.put` with no bytes parameter used to plan `io.blobPut(id, value)`,
// where `value` is bound nowhere. The prompt then asked a local model to write
// a body with an undeclared name. The plan now refuses the operation instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { planBody, planText } from '../src/plan-body.ts';

const NL = String.fromCharCode(10);

const spec = (params: string) => [
  'module m @0.1.0 {}',
  'type Doc = { id: uuid, name: string }',
  'service S : http {',
  '  uses store: kv',
  '  uses files: blob',
  '  uses uuid: ids',
  '  contract {',
  '    public op upload(' + params + ') -> Doc {',
  '      route: "POST /v1/docs"',
  '      effects: store.set, files.put, uuid.new',
  '    }',
  '  }',
  '}',
].join(NL);

test('blob.put with a bytes parameter writes that parameter', () => {
  const mod = parse(spec('name: string, content: bytes'), 'main.arc');
  const svc = mod.services[0];
  const plan = planBody(mod, svc, svc.contract[0]);
  assert.equal(plan.unresolved.length, 0);
  assert.match(planText(plan), /await io\.blobPut\(id, content\)/);
});

test('blob.put without a bytes parameter is unresolved, not a phantom name', () => {
  const mod = parse(spec('name: string'), 'main.arc');
  const svc = mod.services[0];
  const plan = planBody(mod, svc, svc.contract[0]);
  assert.equal(planText(plan).includes('blobPut'), false, planText(plan));
  assert.deepEqual(plan.unresolved, [
    'blob.put is declared but the operation has no bytes parameter to write',
  ]);
});
