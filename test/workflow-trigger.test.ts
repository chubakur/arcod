// A workflow can start on a clock, not only on a cron line: `after 30s`
// (a delay) and `at(<instant>)` (one-shot) were documented in A033's hint but
// the parser only understood cron(...)/event(...)/manual. `after Cleanup` was
// worse: the parser stopped at the bare word and the workflow loop reported
// "unexpected workflow clause Cleanup" for a trigger the checker allowed.
// A034 now owns the argument shape, and the manifest carries the instant or
// the delay so a runner does not have to re-parse the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { formatSource } from '../src/fmt.ts';
import { deployManifest } from '../src/deploy.ts';

function spec(trigger: string): string {
  return `module m @0.1.0 {
}

type Item = { id: uuid }

service Items : http {
  contract {
    public op list() -> { items: list<Item> } {
      route: "GET /v1/items"
    }
  }
}

workflow Delayed {
  trigger ${trigger}
  step touch() {
    call: Items.list
  }
}

environment dev {
  deploy docker
}
`;
}

function errors(source: string): ReturnType<typeof check> {
  return check(parse(source, 'trigger.arc')).filter((item) => item.severity === 'error');
}

function manifestTrigger(trigger: string): Record<string, unknown> {
  const mod = parse(spec(trigger), 'trigger.arc');
  const manifest = deployManifest(mod, mod.environments[0]) as {
    workflows: Array<{ trigger: Record<string, unknown> }>;
  };
  return manifest.workflows[0].trigger;
}

test('after 30s is a delay carried into the manifest', () => {
  const mod = parse(spec('after 30s'), 'trigger.arc');
  const trigger = mod.workflows[0].trigger!;
  assert.equal(trigger.kind, 'after');
  assert.equal(trigger.args.length, 1);
  assert.deepEqual(
    { kind: trigger.args[0].value.kind, value: (trigger.args[0].value as { value: number }).value, unit: (trigger.args[0].value as { unit: string }).unit },
    { kind: 'duration', value: 30, unit: 's' },
  );
  const carried = manifestTrigger('after 30s');
  assert.equal(carried.kind, 'after');
  assert.equal(carried.afterSeconds, 30);
  assert.equal(carried.at, null);
});

test('after Cleanup waits for a job instead of failing to parse', () => {
  const carried = manifestTrigger('after Cleanup');
  assert.equal(carried.kind, 'after');
  assert.equal(carried.afterSeconds, null);
  assert.deepEqual(carried.args, [{ name: null, value: 'Cleanup' }]);
});

test('a bare ISO instant is one token and reaches the manifest', () => {
  const carried = manifestTrigger('at(2026-11-18T12:00:05Z)');
  assert.equal(carried.kind, 'at');
  assert.equal(carried.at, '2026-11-18T12:00:05Z');
  assert.deepEqual(carried.args, [{ name: null, value: '2026-11-18T12:00:05Z' }]);
});

test('the quoted instant is the same moment', () => {
  const carried = manifestTrigger('at("2026-11-18T12:00:05Z")');
  assert.equal(carried.at, '2026-11-18T12:00:05Z');
  assert.deepEqual(errors(spec('at("2026-11-18T12:00:05Z")')), []);
});

test('an offset instant keeps its zone', () => {
  const carried = manifestTrigger('at(2026-11-18T15:00:05+03:00)');
  assert.equal(carried.at, '2026-11-18T15:00:05+03:00');
});

test('fmt prints both forms back and stays idempotent', () => {
  const source = spec('after 30s').replace('workflow Delayed', 'workflow Delayed');
  const once = formatSource(source, 'trigger.arc');
  assert.ok(once.includes('trigger after 30s'), 'the delay keeps its shorthand');
  assert.ok(!once.includes('after(30s)'), 'fmt does not invent parentheses');
  assert.equal(formatSource(once, 'trigger.arc'), once);

  const instant = formatSource(spec('at(2026-11-18T12:00:05Z)'), 'trigger.arc');
  assert.ok(instant.includes('trigger at(2026-11-18T12:00:05Z)'), 'the bare instant keeps its text');
  assert.equal(formatSource(instant, 'trigger.arc'), instant);
});

test('A034 rejects a delay that cannot be scheduled', () => {
  for (const trigger of ['after 0s', 'after 5w', 'after "soon"']) {
    const diags = errors(spec(trigger));
    assert.ok(diags.some((item) => item.code === 'A034'), trigger + ' is reported: ' + JSON.stringify(diags.map((d) => d.message)));
  }
});

test('A034 rejects an instant a runner could not schedule', () => {
  for (const trigger of ['at("yesterday")', 'at(2026-02-30T12:00:05Z)', 'at("2026-11-18T12:00:05")', 'at(1, 2)', 'at(nope)']) {
    const diags = errors(spec(trigger));
    assert.ok(diags.some((item) => item.code === 'A034'), trigger + ' is reported');
  }
});

test('the accepted forms are clean', () => {
  for (const trigger of ['after 30s', 'after Cleanup', 'at(2026-11-18T12:00:05Z)', 'at("2026-11-18T12:00:05+03:00")']) {
    assert.deepEqual(errors(spec(trigger)), [], trigger);
  }
});
