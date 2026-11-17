import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { PLUGIN_API } from '../src/plugins.ts';
import { registryFromScan } from '../src/registry.ts';

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
      path: pluginDir,
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
      path: join(exampleDir, '..', 'plugin'),
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
