import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { PLUGIN_API } from '../src/plugins.ts';
import { registryFromScan } from '../src/registry.ts';
import { startService } from './harness.ts';

// B11.3a: a plugin provider may ship a runtime adapter. The build copies that
// file into the generated service instead of importing the package, and records
// where it landed; wiring the dispatch is the next slice.

const SPEC = [
  'module faxer @0.1.0 {}',
  'use capability arcod.std.fax @1',
  'service Faxer : http {',
  '  uses fx: fax',
  '  contract { public op send(to: string) -> string { route: "POST /v1/send" } }',
  '}',
  'environment dev {',
  '  bind fx -> faxapi(url: "https://fax.example/v1")',
  '  deploy docker',
  '}',
].join('\n');

const ADAPTER = 'export function createAdapter(io) {\n  return { send(to) { return io.fetch(to); } };\n}\n';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arcod-runtime-'));
  const pluginDir = join(root, 'plugin');
  await mkdir(join(pluginDir, 'dist'), { recursive: true });
  await writeFile(join(pluginDir, 'dist', 'fax.mjs'), ADAPTER, 'utf8');
  const registry = registryFromScan({
    plugins: [{
      package: 'arcod-plugin-fax',
      version: '0.1.0',
      path: join(pluginDir, 'arcod.plugin.json'),
      dir: pluginDir,
      pluginApi: PLUGIN_API,
      capabilities: [{ name: 'fax' }],
      providers: [{
        name: 'faxapi',
        capability: 'fax',
        runtime: { adapter: 'dist/fax.mjs', export: 'createAdapter' },
      }],
    }],
    issues: [],
  });
  const exampleDir = join(root, 'example');
  await mkdir(exampleDir, { recursive: true });
  await writeFile(join(exampleDir, 'main.arc'), SPEC, 'utf8');
  return { exampleDir, registry, mod: parse(SPEC, 'main.arc') };
}

test('a plugin runtime adapter is copied and recorded in the build', async () => {
  const { exampleDir, registry, mod } = await fixture();
  const result = await buildExample(mod, exampleDir, { registry, implDir: null });
  assert.deepEqual(result.plugins, ['faxapi'], 'the build reports the copied adapter');
  const copied = await readFile(join(result.dir, 'plugins', 'faxapi.mjs'), 'utf8');
  assert.equal(copied, ADAPTER, 'the file travels byte for byte');
  const manifest = JSON.parse(await readFile(join(result.dir, 'plugins.json'), 'utf8'));
  assert.deepEqual(manifest.plugins, [{
    provider: 'faxapi',
    package: 'arcod-plugin-fax',
    source: 'dist/fax.mjs',
    target: 'plugins/faxapi.mjs',
    export: 'createAdapter',
  }]);
});

test('a declared adapter missing from the package fails the build', async () => {
  const { exampleDir, registry, mod } = await fixture();
  const broken = registryFromScan({
    plugins: [{
      package: 'arcod-plugin-fax',
      version: '0.1.0',
      path: join(exampleDir, '..', 'plugin', 'arcod.plugin.json'),
      dir: join(exampleDir, '..', 'plugin'),
      pluginApi: PLUGIN_API,
      capabilities: [{ name: 'fax' }],
      providers: [{ name: 'faxapi', capability: 'fax', runtime: { adapter: 'dist/gone.mjs' } }],
    }],
    issues: [],
  });
  assert.deepEqual(registry.names().includes('faxapi'), true);
  await assert.rejects(
    () => buildExample(mod, exampleDir, { registry: broken, implDir: null }),
    /arcod-plugin-fax declares runtime\.adapter dist\/gone\.mjs/,
  );
});

test('without the registry nothing is copied and no manifest appears', async () => {
  const { exampleDir, mod } = await fixture();
  const result = await buildExample(mod, exampleDir, { implDir: null });
  assert.deepEqual(result.plugins, []);
  await assert.rejects(readFile(join(result.dir, 'plugins.json'), 'utf8'), /ENOENT/);
});

// B11.3b: the copied adapter is actually dispatched. The body names the
// capability method; the generated io method calls the adapter the binding
// selected, so no package name appears in a body or a spec.

function faxRegistry(dir: string, signatures: string[]) {
  return registryFromScan({
    plugins: [{
      package: 'arcod-plugin-fax',
      version: '0.1.0',
      path: join(dir, 'arcod.plugin.json'),
      dir,
      pluginApi: PLUGIN_API,
      capabilities: [{ name: 'fax', signatures }],
      providers: [{
        name: 'faxapi',
        capability: 'fax',
        runtime: { adapter: 'dist/fax.mjs' },
      }],
    }],
    issues: [],
  });
}

const IMPL = {
  send: 'export async function send(input, io) {\n  return { result: await io.send(input.to) };\n}\n',
};

test('a plugin capability answers through its copied adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dispatch-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'fax.mjs'), [
    'export function createAdapter(io) {',
    '  return {',
    "    async send(to) { return 'sent:' + to; },",
    '  };',
    '}',
  ].join('\n'), 'utf8');
  const registry = faxRegistry(root, ['send(to: string) -> string']);
  const svc = await startService(SPEC, { impl: IMPL, registry });
  try {
    const res = await fetch(svc.base + '/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: '+123' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, 'sent:+123', 'the adapter answered, not a stub');
  } finally {
    await svc.stop();
  }
});

test('a signature that shadows a built-in io method fails the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-collide-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'fax.mjs'), 'export function createAdapter() { return {}; }\n', 'utf8');
  const registry = faxRegistry(root, ['load(id: string) -> string']);
  const exampleDir = join(root, 'example');
  await mkdir(exampleDir, { recursive: true });
  await writeFile(join(exampleDir, 'main.arc'), SPEC, 'utf8');
  await assert.rejects(
    () => buildExample(parse(SPEC, 'main.arc'), exampleDir, { registry, implDir: null }),
    /load\(\), which collides with a built-in io method/,
  );
});

test('a plugin without signatures wires no method, so the build stays honest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-nosig-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'fax.mjs'), 'export function createAdapter() { return {}; }\n', 'utf8');
  const registry = faxRegistry(root, []);
  const exampleDir = join(root, 'example');
  await mkdir(exampleDir, { recursive: true });
  await writeFile(join(exampleDir, 'main.arc'), SPEC, 'utf8');
  const result = await buildExample(parse(SPEC, 'main.arc'), exampleDir, { registry, implDir: null });
  const source = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(source, /PLUGIN_ADAPTERS/, 'the adapter is still loaded at boot');
  assert.doesNotMatch(source, /pluginAdapter\("faxapi"\)\.send/, 'no invented method');
});
