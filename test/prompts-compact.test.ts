// The compact prompt is what `arcod prompts` and `arcod impl` hand the local
// model. A call into somebody else's service has no capability signature, so
// the io line used to drop `Ledger.record` and the model wrote a body that
// never made the call the contract declares. The full format already spelled
// it out; both must name the same call, or the two generators drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompts } from '../src/prompts.ts';
import { parse } from '../src/parser.ts';

const spec = [
  'module pay @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  'type Amount = int',
  'type Receipt = { id: string, accepted: bool }',
  'error Invalid',
  'external service Ledger : http {',
  '  contract {',
  '    op record(amount: Amount) -> Receipt {',
  '      route: "POST /v1/entries"',
  '    }',
  '  }',
  '}',
  'service Orders : http {',
  '  uses store: kv(ttl: 86400s)',
  '  uses uuid: ids',
  '  effects { allow store.set, uuid.new, Ledger.record }',
  '  contract {',
  '    public op charge(amount: Amount) -> Receipt {',
  '      route: "POST /v1/orders"',
  '      effects: store.set, uuid.new, Ledger.record',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '}',
  '',
].join('\n');

const mod = parse(spec, 'pay.arc');
const promptOf = (format: 'compact' | 'full') => {
  const set = buildPrompts(mod, { format });
  const task = set.tasks.find((item) => item.op === 'charge');
  assert.ok(task, 'charge has a prompt');
  return task.prompt;
};

const remote = 'remote("Ledger", "record", input) -> { status, body }';

test('an external call is named in the io line of the compact prompt', () => {
  const prompt = promptOf('compact');
  assert.ok(prompt.includes(remote), 'the body is told how to call Ledger: ' + prompt);
  assert.ok(prompt.includes('save(id, {b,h})'), 'the store signature is still there');
});

test('both prompt formats name the same external call', () => {
  assert.ok(promptOf('full').includes('io.' + remote), 'the full format spells io.remote');
});
