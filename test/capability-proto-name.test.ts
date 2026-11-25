// capabilityFor and MANAGED_ENDPOINTS are keyed by names the model writes: a
// `use capability` path and a `bind` provider. Read with a plain index, an
// unregistered name that exists on Object.prototype answered a function, so
// capabilityFor returned a "spec" and check treated an unknown provider as a
// managed endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { capabilityFor } from '../src/capabilities.ts';

test('an unregistered capability is null, not a prototype member', () => {
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'nope']) {
    assert.equal(capabilityFor(name), null, name);
  }
  assert.ok(capabilityFor('sql'), 'a bare capability name still resolves');
  assert.ok(capabilityFor('arcod.std.sql'), 'a scoped capability name still resolves');
});

test('an unknown bind provider is an error, not a managed endpoint', () => {
  const source = [
    'module v @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Task = { id: uuid, title: string }',
    'service S : http {',
    '  uses store: sql',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(id: uuid, title: string) -> Task { route: "POST /v1/t" }',
    '  }',
    '}',
    'environment dev {',
    '  bind store -> toString',
    '}'
  ].join('\n');
  const mod = parse(source, 'main.arc');
  const result = check(mod);
  assert.ok(result.length > 0, 'the unknown provider is reported');
  assert.match(result.map((d) => d.message).join(' '), /toString/);
});
