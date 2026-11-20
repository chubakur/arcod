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
import { composeYaml } from '../src/emit/compose.ts';

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
  // version feeds the terraform cluster, image pins the compose container;
  // host/port/expose belong to every binding. Both are read, so neither warns.
  const diags = warn(check(specOf('bind store -> redis(host: "kv", port: 6380, expose: true, version: "7.2", image: "redis:7.4")')));
  assert.deepEqual(diags, []);
});

test('an image that is not a plain reference is A084, not a rewritten compose file', () => {
  // The first entry reaches the lexer as \n, so the literal really carries a
  // line break; a spec string cannot hold a raw one.
  const bad = ['redis:7\\nalpine: latest', 'redis 7', '', ':latest'];
  for (const value of bad) {
    const diags = check(specOf('bind store -> redis(image: "' + value + '")')).filter((item) => item.code === 'A084');
    assert.equal(diags.length, 1, JSON.stringify(value) + ' is refused');
    assert.equal(diags[0].severity, 'error');
    assert.match(diags[0].hint ?? '', /image: "redis:7\.4"/);
  }
  const ok = check(specOf('bind store -> redis(image: "registry.example:5000/kv/redis@sha256:abc123")'));
  assert.deepEqual(ok.filter((item) => item.code === 'A084'), []);
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

test('every container provider declares image, and only those do', () => {
  // The compose emitter reads args.image for any provider with a built-in
  // image, so the declaration is derived, not hand-written: a new provider that
  // forgets it would make W035 advise against the one argument that works.
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const declares = (spec.options ?? []).includes('image');
    assert.equal(declares, Boolean(spec.image), name + ' declares image: ' + declares);
  }
});

test('the declared image is the one compose runs', () => {
  const pinned = composeYaml(specOf('bind store -> redis(image: "redis:7.4")'), 8080);
  assert.match(pinned, /\n  redis:\n    image: redis:7\.4\n/, 'the pinned reference reaches the YAML');
  const plain = composeYaml(specOf('bind store -> redis(host: "kv")'), 8080);
  assert.match(plain, /\n  kv:\n    image: redis:7-alpine\n/, 'no image means the built-in tag');
});

test('provider discovery exposes the same allowlist', () => {
  // W035 names the options in its hint; the table has to agree with it, or an
  // author is told about an argument they cannot discover.
  const rows = providerRows(builtinRegistry());
  const row = (name: string) => rows.find((item) => item.provider === name)!;
  assert.deepEqual(row('redis').options, ['image', 'version']);
  assert.deepEqual(row('clickhouse').options, ['image']);
  assert.deepEqual(row('ollama').options, ['dim', 'model'], 'no container, no image');
  assert.deepEqual(row('endpoint').options, ['network', 'url']);

  const declared = pluginRegistry([{ name: 'faxapi', capability: 'fax', args: { url: 'base url', token: 'api token' } }]);
  assert.deepEqual(providerRows(declared).find((item) => item.provider === 'faxapi')!.options, ['token', 'url']);
  const naked = pluginRegistry([{ name: 'faxnaked', capability: 'fax' }]);
  assert.deepEqual(providerRows(naked).find((item) => item.provider === 'faxnaked')!.options, []);
});

test('two binds on one host with two images is A085', () => {
  const source = (q: string, images: [string, string]) => [
    'module m @0.1.0 {}',
    'type Item = { id: uuid }',
    'service Items : http {',
    '  uses store: kv',
    '  uses bus: queue',
    '  contract {',
    '    public op list() -> { items: list<Item> } { route: "GET /v1/items" effects: store.find }',
    '  }',
    '}',
    'environment dev {',
    '  bind store -> redis(host: "kv", image: "' + images[0] + '")',
    '  bind bus -> redis(host: "kv", image: "' + images[1] + '")',
    '  deploy docker',
    '}',
    '',
  ].join('\n');

  const diags = check(parse(source('', ['redis:7.4', 'redis:6.2']), 'binds.arc')).filter((item) => item.code === 'A085');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'environments.dev.binds.bus');
  assert.match(diags[0].message, /container kv is bound to two images/);
  assert.match(diags[0].hint ?? '', /redis:7\.4/);
  assert.match(diags[0].hint ?? '', /redis:6\.2/);

  // One host, one image: the saga shares a container on purpose.
  assert.deepEqual(check(parse(source('', ['redis:7.4', 'redis:7.4']), 'binds.arc')).filter((item) => item.code === 'A085'), []);
  // Different hosts may run different images.
  assert.deepEqual(check(parse(source('', ['redis:7.4', 'redis:6.2']).replace('host: "kv"', 'host: "kv2"').replace('host: "kv"', 'host: "kv"'), 'binds.arc')).filter((item) => item.code === 'A085'), []);
});
