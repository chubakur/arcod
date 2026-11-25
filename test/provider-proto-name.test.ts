// Both registries were read with a plain index. A name that is not registered
// but exists on Object.prototype — toString, constructor — answered a function
// instead of null, and every caller treats a truthy answer as a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deployNames, deployProvider } from '../src/deploy.ts';
import { providerFor } from '../src/providers.ts';

test('an unregistered deploy provider is null, not a prototype member', () => {
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'nope']) {
    assert.equal(deployProvider(name), null, name);
  }
});

test('every registered deploy provider still resolves', () => {
  const names = deployNames();
  assert.ok(names.length > 0, 'the registry is not empty');
  for (const name of names) assert.ok(deployProvider(name), name);
});

test('an unregistered capability provider is null, not a prototype member', () => {
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'nope']) {
    assert.equal(providerFor(name), null, name);
  }
  assert.ok(providerFor('redis'), 'a real provider still resolves');
});
