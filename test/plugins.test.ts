import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPlugins, PLUGIN_API } from '../src/plugins.ts';

// Step 1 of docs/plugin-registry.md: a manifest is data, read and validated
// deterministically. Nothing is installed and no plugin code runs.

async function pluginDir(root: string, name: string, manifest: unknown): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'arcod.plugin.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

function manifest(over: Record<string, unknown> = {}) {
  return {
    name: 'arcod-plugin-nats',
    version: '0.1.0',
    arcod: {
      pluginApi: PLUGIN_API,
      capabilities: [{ name: 'queue', summary: 'pub/sub', signatures: ['publish(t, m)'] }],
      providers: [{ name: 'nats', capability: 'queue', args: { url: 'nats://…' }, secrets: ['NATS_TOKEN'] }],
      ...over,
    },
  };
}

test('a manifest on ARC_PLUGIN_PATH is read and described', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-plugins-'));
  const dir = await pluginDir(root, 'nats', manifest());
  const scan = scanPlugins(root);
  // ARC_PLUGIN_PATH may point nowhere in the test env; scan the temp root by
  // pointing the env at it for this call.
  process.env.ARC_PLUGIN_PATH = root;
  const real = scanPlugins(root);
  assert.equal(scan.plugins.length, 0, 'no manifest in the default roots');
  assert.equal(real.plugins.length, 1);
  assert.deepEqual(real.plugins[0].providers.map((item) => item.name + '->' + item.capability), ['nats->queue']);
  assert.deepEqual(real.plugins[0].providers[0].secrets, ['NATS_TOKEN']);
  assert.equal(real.issues.filter((item) => item.severity === 'error').length, 0);
  delete process.env.ARC_PLUGIN_PATH;
});

test('an unknown pluginApi is ignored with a warning, not a crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-plugins-'));
  await pluginDir(root, 'future', manifest({ pluginApi: 99 }));
  process.env.ARC_PLUGIN_PATH = root;
  const scan = scanPlugins(root);
  delete process.env.ARC_PLUGIN_PATH;
  assert.equal(scan.plugins.length, 0);
  assert.ok(scan.issues.some((item) => item.severity === 'warning' && /pluginApi 99/.test(item.message)));
});

test('shadowing a built-in provider is an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-plugins-'));
  await pluginDir(root, 'shadow', manifest({
    providers: [{ name: 'redis', capability: 'queue' }],
  }));
  process.env.ARC_PLUGIN_PATH = root;
  const scan = scanPlugins(root);
  delete process.env.ARC_PLUGIN_PATH;
  assert.ok(scan.issues.some((item) => item.severity === 'error' && /shadows a built-in/.test(item.message)));
});

test('a provider naming an undeclared capability is an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-plugins-'));
  await pluginDir(root, 'bad', manifest({
    capabilities: [],
    providers: [{ name: 'broker', capability: 'teleport' }],
  }));
  process.env.ARC_PLUGIN_PATH = root;
  const scan = scanPlugins(root);
  delete process.env.ARC_PLUGIN_PATH;
  assert.ok(scan.issues.some((item) => item.severity === 'error' && /neither it nor arcod declares/.test(item.message)));
});
