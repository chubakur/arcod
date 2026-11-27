// B121: a body could call io.cancelJob(topic, id) — README documented it and the
// generated service emitted the method — but the queue capability declared no
// such effect, so `effects: events.cancel` answered A044 and the signature the
// model needs never reached the prompt. io.signal and io.messageId existed only
// inside the generated job and were declared nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { capabilityFor, signatureFor, shortFor } from '../src/capabilities.ts';
import { buildPrompts } from '../src/prompts.ts';

const SPEC = `module cancelcap @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-27"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.queue @1

service Jobs : http {
  uses store: kv
  uses uuid: ids
  uses events: queue

  contract {
    public op submit(entry: string) -> bool {
      route: "POST /v1/submit"
      effects: events.publish
      errors: none
    }

    public op stop(topic: string, id: string) -> bool {
      route: "POST /v1/stop"
      effects: events.cancel
      errors: none
    }

    job audit(entry: string) {
      on: events.jobs
      retry: 1
      effects: store.set
      errors: none
    }
  }

  effects {
    allow store.set, events.publish, events.cancel, uuid.new
    deny net, fs, exec
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind events -> redis(host: "events", port: 6379)
  deploy docker
}
`;

const errors = (source: string) =>
  check(parse(source, 'main.arc')).filter((item) => item.severity === 'error');

test('the queue capability declares the cancel effect and its signature', () => {
  const spec = capabilityFor('queue');
  assert.ok(spec, 'queue resolves');
  assert.equal(spec.effects.cancel, 'cancelJob(topic: string, id: string) -> boolean');
  assert.equal(spec.short.cancel, 'cancelJob(topic, id) -> bool');
  assert.equal(signatureFor('queue', 'cancel'), 'cancelJob(topic: string, id: string) -> boolean');
  assert.equal(shortFor('queue', 'cancel'), 'cancelJob(topic, id) -> bool');
});

test('the queue notes say io.signal and io.messageId are job-only', () => {
  const notes = capabilityFor('queue')!.notes;
  assert.match(notes, /io\.messageId/);
  assert.match(notes, /io\.signal/);
  assert.match(notes, /only in a job/i);
  assert.match(notes, /cancelJob\(topic, id\)/);
});

test('an operation declaring events.cancel passes check', () => {
  const diags = errors(SPEC);
  assert.deepEqual(diags.map((item) => item.code + ' ' + item.message), []);
});

test('a phantom effect name is an error and the known list names cancel', () => {
  // The service-level allow list is checked against the capability table: a
  // name the table does not have is A044 and the hint is the live key list.
  const broken = SPEC.replace(
    'allow store.set, events.publish, events.cancel, uuid.new',
    'allow store.set, events.publish, events.cancelJob, uuid.new');
  const diags = errors(broken).filter((item) => item.code === 'A044');
  assert.equal(diags.length, 1, 'one A044 for the misspelled effect');
  assert.match(diags[0].message, /events\.cancelJob does not exist in queue/);
  assert.match(diags[0].hint ?? '', /publish/);
  assert.match(diags[0].hint ?? '', /cancel/);
  assert.match(diags[0].hint ?? '', /drop/);
});

test('an operation may not use the io method name as an effect', () => {
  // cancelJob is the method the body calls; the effect is named cancel. An
  // operation that writes cancelJob is not allowed, and A004 says so.
  const broken = SPEC.replace('effects: events.cancel\n', 'effects: events.cancelJob\n');
  const diags = errors(broken).filter((item) => item.code === 'A004');
  assert.equal(diags.length, 1, 'one A004 for the method spelling');
  assert.match(diags[0].message, /effect events\.cancelJob is not allowed/);
});

test('the prompt for an operation that cancels shows the signature', () => {
  const mod = parse(SPEC, 'main.arc');
  const set = buildPrompts(mod);
  const stop = set.tasks.find((task) => task.op === 'stop');
  assert.ok(stop, 'the operation has a task');
  assert.match(stop.prompt, /cancelJob\(topic, id\) -> bool/);
  const submit = set.tasks.find((task) => task.op === 'submit');
  assert.ok(submit);
  assert.match(submit.prompt, /publish\(topic, msg\) -> bool/);
});
