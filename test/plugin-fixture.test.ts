import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { loadRegistry, resetRegistryCache } from '../src/registry.ts';
import { startService } from './harness.ts';

// B11.4: the reference plugin in test/fixtures proves the seam end to end —
// manifest on ARC_PLUGIN_PATH, registry lookup, build copying the adapter and
// the generated service dispatching the capability's declared signature.

// ARC_PLUGIN_PATH lists roots that contain plugin directories, so the root is
// test/fixtures and the package is fixtures/plugin-notify.
const PLUGIN_ROOT = fileURLToPath(new URL('./fixtures', import.meta.url));

const SPEC = [
  'module notifier @0.1.0 {}',
  'use capability arcod.std.notify @1',
  'service Notifier : http {',
  '  uses nt: notify',
  '  contract {',
  '    public op send(to: string, text: string) -> string { route: "POST /v1/notify" }',
  '  }',
  '}',
  'environment dev {',
  '  bind nt -> notifyfile(path: "unused")',
  '  deploy docker',
  '}',
].join('\n');

const IMPL = {
  send: 'export async function send(input, io) {\n  return { result: await io.send(input.to, input.text) };\n}\n',
};

function withPluginPath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.ARC_PLUGIN_PATH;
  process.env.ARC_PLUGIN_PATH = PLUGIN_ROOT;
  resetRegistryCache();
  return run().finally(() => {
    if (previous === undefined) delete process.env.ARC_PLUGIN_PATH;
    else process.env.ARC_PLUGIN_PATH = previous;
    resetRegistryCache();
  });
}

test('the reference plugin is discovered from ARC_PLUGIN_PATH', async () => {
  await withPluginPath(async () => {
    const registry = loadRegistry();
    const spec = registry.get('notifyfile');
    assert.ok(spec, 'the provider is in the registry');
    assert.equal(spec.external, true, 'a plugin provider is configured, not provisioned');
    assert.equal(registry.origin.notifyfile, 'arcod-plugin-notify');
    assert.deepEqual(registry.signaturesFor('notify'), ['send(to: string, text: string) -> string']);
    const diags = check(parse(SPEC, 'main.arc'), { registry }).filter((d) => d.severity === 'error');
    assert.deepEqual(diags, [], 'the model checks clean against the plugin');
  });
});

test('the reference adapter answers a request and writes the file', async () => {
  await withPluginPath(async () => {
    const registry = loadRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'arcod-notify-'));
    const file = join(dir, 'notified.log');
    const svc = await startService(SPEC, { impl: IMPL, registry, env: { NOTIFY_PATH: file } });
    try {
      const res = await fetch(svc.base + '/v1/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'ops', text: 'disk almost full' }),
      });
      assert.equal(res.status, 201);
      // `notify -> string` answers the declared string as text (B60).
      assert.equal(await res.text(), 'queued:ops');
      assert.equal(await readFile(file, 'utf8'), 'ops\tdisk almost full\n', 'the adapter ran in the service');
    } finally {
      await svc.stop();
    }
  });
});
