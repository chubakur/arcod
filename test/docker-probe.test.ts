// `arcod run` and `arcod run --down` both ask `docker info` before they touch
// compose. The probe had no cap, so a daemon that accepted the connection and
// never answered (a wedged dockerd, a DOCKER_HOST pointing nowhere) hung the
// command with no output at all — and both call sites carried their own copy of
// the same sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_PROBE_MS, probeDocker } from '../src/docker.ts';

type Failure = { status: number | null; error?: Error & { code?: string } };

function recorder(result: { status: number | null; error?: Error & { code?: string } }) {
  const calls: { command: string; args: string[]; options: { stdio: 'ignore'; timeout: number } }[] = [];
  const spawn = (command: string, args: string[], options: { stdio: 'ignore'; timeout: number }) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, spawn };
}

test('the probe asks docker info under a cap', () => {
  const { calls, spawn } = recorder({ status: 0 });
  assert.deepEqual(probeDocker(spawn), { ok: true });
  assert.equal(calls.length, 1, 'one probe, not a loop');
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args, ['info']);
  assert.equal(calls[0].options.timeout, DOCKER_PROBE_MS);
  assert.equal(DOCKER_PROBE_MS, 15_000, 'the cap is 15 seconds');
});

test('a missing docker stays "not running or unavailable"', () => {
  const { spawn } = recorder({ status: null, error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }) });
  assert.deepEqual(probeDocker(spawn), { ok: false, message: 'docker is not running or unavailable' });
});

test('a daemon that never answers is named, not waited on forever', () => {
  const { spawn } = recorder({ status: null, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const probe = probeDocker(spawn);
  assert.equal(probe.ok, false);
  if (probe.ok) return;
  assert.match(probe.message, /docker is not answering/);
  assert.match(probe.message, /still running after 15s/);
  assert.doesNotMatch(probe.message, /not running or unavailable/, 'a wedged daemon is not a missing one');
});

test('the message carries whatever cap the caller set', () => {
  const { calls, spawn } = recorder({ status: null, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const probe = probeDocker(spawn, 250);
  assert.equal(calls[0].options.timeout, 250);
  assert.equal(probe.ok, false);
  if (probe.ok) return;
  assert.match(probe.message, /after 250ms/, 'a sub-second cap reads in milliseconds');
});

test('a probe killed by a signal is still an unavailable docker', () => {
  const { spawn } = recorder({ status: null });
  assert.deepEqual(probeDocker(spawn), { ok: false, message: 'docker is not running or unavailable' });
});

test('a non-zero info is an unavailable docker, whatever the code', () => {
  const failure: Failure = { status: 3 };
  const { spawn } = recorder(failure);
  assert.deepEqual(probeDocker(spawn), { ok: false, message: 'docker is not running or unavailable' });
});
