// A bind argument is configuration: the provider reads a fixed set of names.
// Before W035 an unknown one was accepted and dropped, so
// bind store -> redis(host: "kv", bogus: 1) looked configured and changed
// nothing. The allowlist is per provider: built-ins declare their options,
// a plugin manifest's args map is its declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { builtinRegistry, providerRows, registryFromScan, type ProviderRegistry } from '../src/registry.ts';
import { BIND_ARGS, PROVIDERS } from '../src/providers.ts';

function specOf(bindLine: string): ReturnType<typeof parse> {
  return parse('module m @0.1.0 {\n}\n\ntype Item = { id: uuid }\n\nservice Items : http {\n  uses store: kv\n\n  contract {\n    public op list() -> { items: list<Item> } {\n      route: "GET /v1/items"\n      effects: store.find\n    }\n  }\n}\n\nenvironment dev {\n  ' + bindLine + '\n}\n', 'binds.arc');
}

function warn(diags: ReturnType<typeof check>): ReturnType<typeof check> {
  return diags.filter((item) => item.code === 'W035');
}

test('an unknown bind argument is reported with the known ones', () => {
  const diags = warn(check(specOf('bind store -> redis(host: "kv", bogus: 1)')));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, 'environments.dev.binds.store');
  assert.equal(diags[0].severity, 'warning');
  assert.match(diags[0].message, /provider redis does not read bind argument bogus/);
  assert.match(diags[0].hint ?? '', /known arguments: .*host/);
});

test('declared options and the universal arguments are clean', () => {
  // version is redis's own option; host/port/expose belong to every binding.
  const diags = warn(check(specOf('bind store -> redis(host: "kv", port: 6380, expose: true, version: "7.2")')));
  assert.deepEqual(diags, []);
});

test('provider options are read per provider, not globally', () => {
  // model is ollama's option, not redis's.
  assert.equal(warn(check(specOf('bind store -> redis(model: "x")'))).length, 1);
  assert.deepEqual(warn(check(specOf('bind kv -> redis(host: "kv")'))), []);
});

test('every built-in declares its options', () => {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    assert.ok(Array.isArray(spec.options), name + ' has no options list');
    for (const option of spec.options ?? []) {
      assert.equal((BIND_ARGS as readonly string[]).includes(option), false,
        name + ' redeclares the universal argument ' + option);
    }
  }
});

test('a plugin args map is its allowlist', () => {
  const withArgs = pluginRegistry([{ name: 'faxapi', capability: 'fax', args: { url: 'base url' } }]);
  const diags = warn(check(pluginSpec('faxapi(url: "https://fax.example", bogus: 1)'), { registry: withArgs }));
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /faxapi does not read bind argument bogus/);
  assert.match(diags[0].hint ?? '', /known arguments: .*url/);

  assert.deepEqual(warn(check(pluginSpec('faxapi(url: "https://fax.example")'), { registry: withArgs })), []);
});

test('a plugin without an args map cannot be judged and stays silent', () => {
  const naked = pluginRegistry([{ name: 'faxnaked', capability: 'fax' }]);
  assert.deepEqual(warn(check(pluginSpec('faxnaked(anything: 1)'), { registry: naked })), []);
});

function pluginSpec(bindLine: string): ReturnType<typeof parse> {
  return parse('module m @0.1.0 {\n}\n\nservice F : http {\n  uses fx: fax\n\n  contract {\n    public op send() -> string {\n      route: "POST /v1/send"\n      effects: fx.send\n    }\n  }\n}\n\nenvironment dev {\n  bind fx -> ' + bindLine + '\n}\n', 'plugin.arc');
}

function pluginRegistry(providers: Array<Record<string, unknown>>): ProviderRegistry {
  return registryFromScan({
    issues: [],
    plugins: [{
      package: 'arcod-plugin-fax',
      version: '0.1.0',
      path: '/tmp/fax/arcod.plugin.json',
      dir: '/tmp/fax',
      pluginApi: 1,
      capabilities: [{ name: 'fax', signatures: ['send() -> string'] }],
      providers: providers as never,
    }],
  });
}

test('provider discovery exposes the same allowlist', () => {
  // W035 names the options in its hint; the table has to agree with it, or an
  // author is told about an argument they cannot discover.
  const rows = providerRows(builtinRegistry());
  const row = (name: string) => rows.find((item) => item.provider === name)!;
  assert.deepEqual(row('redis').options, ['version']);
  assert.deepEqual(row('clickhouse').options, []);
  assert.deepEqual(row('endpoint').options, ['network', 'url']);

  const declared = pluginRegistry([{ name: 'faxapi', capability: 'fax', args: { url: 'base url', token: 'api token' } }]);
  assert.deepEqual(providerRows(declared).find((item) => item.provider === 'faxapi')!.options, ['token', 'url']);
  const naked = pluginRegistry([{ name: 'faxnaked', capability: 'fax' }]);
  assert.deepEqual(providerRows(naked).find((item) => item.provider === 'faxnaked')!.options, []);
});
