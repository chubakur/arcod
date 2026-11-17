import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { PLUGIN_API, scanPlugins } from '../src/plugins.ts';
import { registryFromScan, pluginProviderSpec, resetRegistryCache } from '../src/registry.ts';
import { composeYaml } from '../src/emit/compose.ts';

// Step 2 of docs/plugin-registry.md: a provider a plugin declares resolves in
// check and in the emitters exactly like a built-in one.

const SPEC = `module faxer @0.1.0 {
}

service Faxer : http {
  uses fx: fax

  contract {
    public op send(to: string) -> string {
      route: "POST /v1/send"
      effects: fx.send
    }
  }
}

environment dev {
  bind fx -> faxapi(url: "https://fax.example/v1")
  deploy docker
}
`;

const MANIFEST = {
  name: 'arcod-plugin-fax',
  version: '0.1.0',
  arcod: {
    pluginApi: PLUGIN_API,
    capabilities: [{ name: 'fax', summary: 'send a fax' }],
    providers: [{
      name: 'faxapi',
      capability: 'fax',
      args: { url: 'base url' },
      secrets: ['FAX_TOKEN'],
      appEnv: { FAX_URL: '${url}', FAX_TOKEN_FILE: '${host}' },
    }],
  },
};

async function scanWith(): Promise<ReturnType<typeof scanPlugins>> {
  const root = await mkdtemp(join(tmpdir(), 'arcod-lookup-'));
  const dir = join(root, 'fax');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'arcod.plugin.json'), JSON.stringify(MANIFEST), 'utf8');
  process.env.ARC_PLUGIN_PATH = root;
  const scan = scanPlugins(root);
  delete process.env.ARC_PLUGIN_PATH;
  return scan;
}

test('a plugin provider resolves the binding that a built-in registry rejects', async () => {
  const mod = parse(SPEC, 'main.arc');
  const builtin = check(mod);
  assert.ok(builtin.some((d) => d.code === 'A023' && /unknown provider faxapi/.test(d.message)));

  const registry = registryFromScan(await scanWith());
  const diags = check(mod, { registry });
  assert.equal(diags.filter((d) => d.code === 'A023' || d.code === 'A024' || d.code === 'A026').length, 0);
  assert.deepEqual(registry.forCapability('fax'), ['faxapi']);
  assert.equal(registry.origin.faxapi, 'arcod-plugin-fax');
  // Shadowing built-ins is still impossible.
  assert.equal(registry.get('redis')!.image, 'redis:7-alpine');
});

test('plugin appEnv expands bind arguments, not template text', () => {
  const spec = pluginProviderSpec({ name: 'faxapi', capability: 'fax', args: { url: 'base url' }, appEnv: { FAX_URL: '${url}', HOST_HINT: '${host}' } });
  const env = spec.appEnv!({ host: 'fax', port: 443, alias: 'fx', args: { url: 'https://fax.example/v1' } });
  assert.deepEqual(env, { FAX_URL: 'https://fax.example/v1', HOST_HINT: 'fax' });
  assert.equal(spec.external, true, 'a plugin provider is configured, never provisioned');
  assert.deepEqual(spec.requires, ['url']);
});

test('compose renders a plugin provider as env, without inventing an image', async () => {
  resetRegistryCache();
  const mod = parse(SPEC, 'main.arc');
  const root = await mkdtemp(join(tmpdir(), 'arcod-lookup-'));
  const dir = join(root, 'fax');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'arcod.plugin.json'), JSON.stringify(MANIFEST), 'utf8');
  process.env.ARC_PLUGIN_PATH = root;
  const scan = scanPlugins(root);
  delete process.env.ARC_PLUGIN_PATH;
  const yaml = composeYaml(mod, 8080, false, registryFromScan(scan));
  assert.match(yaml, /FAX_URL: "https:\/\/fax\.example\/v1"/);
  assert.ok(!/image: faxapi/.test(yaml), 'no image for a provider arcod cannot provision');
  resetRegistryCache();
});

