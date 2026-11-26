import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { providerRows, builtinRegistry } from '../src/registry.ts';
import { composeYaml } from '../src/emit/compose.ts';
import { emitService } from '../src/emit/service.ts';

// A broker container that the generated runtime cannot talk to used to look
// supported: check was clean, compose started rabbitmq, and jobs ran in process
// with messages lost on restart. A083 refuses the binding instead.

const source = await readFile(new URL('../examples/saga/main.arc', import.meta.url), 'utf8');

function withBroker(provider: string): string {
  return source.replace('bind events -> redis(host: "kv", port: 6379)', 'bind events -> ' + provider + '(host: "mq")');
}

test('A083: a queue bind on rabbitmq or kafka is refused', () => {
  for (const provider of ['rabbitmq', 'kafka']) {
    const diags = check(parse(withBroker(provider), 'saga.arc')).filter((item) => item.code === 'A083');
    assert.equal(diags.length, 1, 'one diagnostic for ' + provider);
    assert.match(diags[0].message, new RegExp('provider ' + provider + ' cannot serve queue at runtime'));
    assert.match(diags[0].hint ?? '', /redis/, 'the hint names the provider that can serve it');
    assert.equal(diags[0].severity, 'error');
  }
});

test('A083: the redis bind stays clean', () => {
  const diags = check(parse(source, 'saga.arc')).filter((item) => item.code === 'A083');
  assert.equal(diags.length, 0);
});

test('A083: an unused broker bind is still allowed for provisioning', () => {
  // The provider is provisioned and usable by other consumers; only a service
  // that relies on the runtime driver is an error.
  const spec = source
    .replace('bind events -> redis(host: "kv", port: 6379)', 'bind events -> rabbitmq(host: "mq")')
    .replace('  uses events: queue\n', '');
  const diags = check(parse(spec, 'saga.arc')).filter((item) => item.code === 'A083');
  assert.equal(diags.length, 0, 'no service uses the broker');
});

test('providers lists the reason next to a broker the runtime cannot drive', () => {
  const rows = providerRows(builtinRegistry());
  const rabbit = rows.find((row) => row.provider === 'rabbitmq');
  const kafka = rows.find((row) => row.provider === 'kafka');
  const redis = rows.find((row) => row.provider === 'redis');
  assert.match(rabbit?.noRuntime ?? '', /AMQP/);
  assert.match(kafka?.noRuntime ?? '', /Kafka/);
  assert.equal(redis?.noRuntime, null, 'redis is driven by the runtime');
});

test('compose still provisions the broker', () => {
  const yaml = composeYaml(parse(withBroker('rabbitmq'), 'saga.arc'), 8080, false);
  assert.ok(yaml.includes('image: rabbitmq:3.13-management-alpine'));
});

// The retry budget is the denominator in the consumer log line (attempt 2/4),
// so the default and an explicit clause both have to reach CONSUMERS.
function consumersOf(spec: string): string {
  // Consumers are runtime code, emitted only for an impl build.
  const out = emitService(parse(spec, 'saga.arc'), { impl: {} });
  const start = out.indexOf('const CONSUMERS = [');
  assert.ok(start >= 0, 'the service has a CONSUMERS table');
  return out.slice(start, start + 400);
}

test('a job without retry gets the default budget of 3 in CONSUMERS', () => {
  assert.match(consumersOf(source), /retry: 3/);
});

test('an explicit retry clause reaches CONSUMERS unchanged', () => {
  const spec = source.replace('      on: events.checkout\n', '      on: events.checkout\n      retry: 1\n');
  const block = consumersOf(spec);
  assert.match(block, /retry: 1/);
  assert.doesNotMatch(block, /retry: 3/);
});

test('the emitted service carries the consumer failure log lines', () => {
  const out = emitService(parse(source, 'saga.arc'), { impl: {} });
  assert.ok(out.includes("'[arcod] queue '"), 'log prefix is emitted');
  assert.match(out, /could not record a failed attempt/);
  assert.match(out, /receive recovered after/);
});
