// examples/nightly is the only demo that declares a workflow, and the docs
// index promises what a reader gets from it: the graph lands in
// deploy.<env>.json with its trigger as data. Nothing tied the demo to that
// promise, so a change to the deploy emitter or to the example could have
// made the demo's headline claim false while every gate stayed green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { deployManifest } from '../src/deploy.ts';

const specPath = fileURLToPath(new URL('../examples/nightly/main.arc', import.meta.url));

interface ManifestStep {
  name: string;
  call: string | null;
  needs: string[];
  returns: string | null;
  onFail: string | null;
}

interface ManifestWorkflow {
  name: string;
  trigger: { kind: string; args: Array<{ name: string | null; value: unknown }> };
  overlap: string | null;
  catchup: string | null;
  retry: number | null;
  steps: ManifestStep[];
}

function manifest(): { workflows: ManifestWorkflow[] } {
  const mod = parse(readFileSync(specPath, 'utf8'), 'examples/nightly/main.arc');
  const env = mod.environments.find((item) => item.name === 'dev');
  assert.ok(env, 'the demo declares a dev environment');
  return deployManifest(mod, env) as unknown as { workflows: ManifestWorkflow[] };
}

test('the workflow demo carries its graph into the deploy manifest', () => {
  const workflows = manifest().workflows;
  assert.equal(workflows.length, 1, 'one workflow');
  const wf = workflows[0];
  assert.equal(wf.name, 'Nightly');
  assert.equal(wf.trigger.kind, 'cron');
  assert.deepEqual(wf.trigger.args.map((arg) => [arg.name, arg.value]), [
    [null, '0 3 * * *'],
    ['tz', 'UTC'],
  ]);
  assert.equal(wf.overlap, 'skip');
  assert.equal(wf.catchup, 'last');
  assert.equal(wf.retry, 2);
  assert.deepEqual(
    wf.steps.map((step) => ({ name: step.name, call: step.call, needs: step.needs, returns: step.returns, onFail: step.onFail })),
    [
      { name: 'prepare', call: 'Reports.prepare', needs: [], returns: 'Snapshot', onFail: null },
      { name: 'render', call: 'Reports.render', needs: ['prepare'], returns: 'Report', onFail: null },
      { name: 'send', call: 'Reports.send', needs: ['render'], returns: 'bool', onFail: 'stop' },
    ],
  );
});

test('every step edge names a step of the same workflow', () => {
  const steps = manifest().workflows[0].steps;
  const names = new Set(steps.map((step) => step.name));
  for (const step of steps) {
    for (const need of step.needs) assert.ok(names.has(need), step.name + ' needs unknown ' + need);
    assert.notEqual(step.call, null, step.name + ' calls an operation');
  }
});
