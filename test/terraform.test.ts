import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { formatTerraform, terraformFiles } from '../src/emit/terraform.ts';
import { PLUGIN_API } from '../src/plugins.ts';
import { registryFromScan } from '../src/registry.ts';

// The cloud view of the same topology. HCL is checked structurally: balanced
// braces, the blocks the binds imply, and no credential written as a literal.
// A real 'terraform validate' needs the provider downloaded, which belongs to
// the owner's account, not to a unit test.

const tasksUrl = new URL('../examples/tasks/main.arc', import.meta.url);
const filesUrl = new URL('../examples/files/main.arc', import.meta.url);

function bracesBalanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

async function tasksFiles() {
  const mod = parse(await readFile(tasksUrl, 'utf8'), 'main.arc');
  return {
    mod,
    files: terraformFiles(mod, { environment: 'prod' }),
    byName: (name: string) => terraformFiles(mod, { environment: 'prod' }).find((f) => f.path === name)!,
  };
}

test('the yandex target renders a network, its binds and outputs', async () => {
  const { files, byName } = await tasksFiles();
  assert.deepEqual(files.map((f) => f.path), ['main.tf', 'variables.tf', 'terraform.tfvars.example']);
  const main = byName('main.tf').content;
  assert.ok(bracesBalanced(main), 'every brace is closed');
  assert.match(main, /provider "yandex" /);
  assert.match(main, /folder_id = var\.folder_id/);
  assert.match(main, /resource "yandex_vpc_network" "main"/);
  assert.match(main, /resource "yandex_mdb_redis_cluster" "kv"/);
  assert.match(main, /password = var\.redis_password/, 'the redis password is a variable');
  // The provider takes hosts as blocks and has no top-level subnet_id: without
  // a host block host[0].fqdn (the exported endpoint) never resolves.
  assert.match(main, /resource "yandex_mdb_redis_cluster" "kv"[\s\S]*?\n  host \{\n    zone      = var\.zone\n    subnet_id = yandex_vpc_subnet\.main\.id\n  \}/);
  assert.doesNotMatch(main, /\n  subnet_id   = yandex_vpc_subnet\.main\.id/, 'the cluster has no top-level subnet_id');
  assert.doesNotMatch(main, /security_group_ids = \[\]/);
  assert.match(main, /output "image" /);
  assert.match(main, /cr\.yandex\/arcod\/tasks:0\.1\.0/, 'the image contract is exported');
  assert.doesNotMatch(main, /password\s*=\s*"/, 'no literal password lands in the plan');
});

test('a postgres bind renders a managed cluster and never a literal password', async () => {
  const source = [
    'module shop @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Item = { id: uuid, name: string }',
    'service Shop : http {',
    '  uses db: sql(ttl: 1h)',
    '  contract { public op create(id: uuid, name: string) -> Item { route: "POST /v1/i" } }',
    '}',
    'environment prod {',
    '  bind db -> postgres(version: "16")',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
    '}',
  ].join('\n');
  const files = terraformFiles(parse(source, 'main.arc'), { environment: 'prod' });
  const main = files.find((f) => f.path === 'main.tf')!.content;
  assert.match(main, /resource "yandex_mdb_postgresql_cluster" "db"/);
  assert.match(main, /version = "16"/);
  assert.match(main, /password   = var\.db_password/);
  assert.match(main, /yandex_mdb_postgresql_database/);
});

test('variables are typed and sensitive, and the example holds no values', async () => {
  const { byName } = await tasksFiles();
  const variables = byName('variables.tf').content;
  assert.match(variables, /variable "db_password"/);
  assert.match(variables, /sensitive = true/);
  assert.match(variables, /variable "folder_id"/);
  const uncommented = byName('terraform.tfvars.example').content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(uncommented, /password\s*=\s*"[^"]+"/, 'no real secret in the example');
  assert.doesNotMatch(uncommented, /secret_key\s*=\s*"[^"]+"/);
});

const FAX_SPEC = [
  'module faxer @0.1.0 {}',
  'use capability arcod.std.fax @1',
  'service Faxer : http {',
  '  uses fx: fax',
  '  contract { public op send(to: string) -> string { route: "POST /v1/send" } }',
  '}',
  'environment prod {',
  '  bind fx -> faxapi(url: "https://fax.example/v1")',
  '  deploy yandex(region: "ru-central1", folder: "f", service: "faxer")',
  '}',
].join('\n');

function faxRegistry() {
  return registryFromScan({
    plugins: [{
      package: 'arcod-plugin-fax',
      version: '0.1.0',
      path: '/plugins/fax/arcod.plugin.json',
      dir: '/plugins/fax',
      pluginApi: PLUGIN_API,
      capabilities: [{ name: 'fax', summary: 'send a fax' }],
      providers: [{
        name: 'faxapi',
        capability: 'fax',
        secrets: ['FAX_TOKEN'],
        appEnv: { FAX_URL: '${url}' },
      }],
    }],
    issues: [],
  });
}

test('a plugin provider is rendered as external, with its secrets as inputs', () => {
  const files = terraformFiles(parse(FAX_SPEC, 'main.arc'), { environment: 'prod', registry: faxRegistry() });
  const main = files.find((f) => f.path === 'main.tf')!.content;
  const variables = files.find((f) => f.path === 'variables.tf')!.content;
  const tfvars = files.find((f) => f.path === 'terraform.tfvars.example')!.content;
  assert.match(main, /External providers: configured outside this plan/, 'the plan says who owns it');
  assert.match(main, /faxapi \(declared by arcod-plugin-fax\)/, 'the declaring package is named');
  assert.match(main, /inputs: var\.faxapi_fax_token/, 'the secret becomes an input');
  assert.ok(bracesBalanced(main), 'every brace is closed');
  assert.doesNotMatch(main, /FAX_TOKEN\s*=\s*"/, 'no secret value in the plan');
  assert.match(variables, /variable "faxapi_fax_token"/);
  assert.match(variables, /sensitive   = true/);
  assert.match(tfvars, /# faxapi_fax_token = "\.\.\."/);
});

test('a provider the registry does not know is reported, not dropped', () => {
  const source = [
    'module m @0.1.0 {}',
    'type T = { id: uuid }',
    'service S : http { contract { public op create(id: uuid) -> T { route: "POST /v1/t" } } }',
    'environment prod {',
    '  bind db -> mysterydb',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "s")',
    '}',
  ].join('\n');
  const files = terraformFiles(parse(source, 'main.arc'), { environment: 'prod' });
  const main = files.find((f) => f.path === 'main.tf')!.content;
  assert.match(main, /Providers unknown to the registry \(check reports them\): mysterydb/);
});

test('two binds to one external provider declare its input once', () => {
  const source = FAX_SPEC
    .replace('bind fx -> faxapi(url: "https://fax.example/v1")', 'bind fx -> faxapi(url: "https://fax.example/v1")\n  bind fx2 -> faxapi(url: "https://fax2.example/v1")')
    .replace('uses fx: fax', 'uses fx: fax\n  uses fx2: fax');
  const files = terraformFiles(parse(source, 'main.arc'), { environment: 'prod', registry: faxRegistry() });
  const variables = files.find((f) => f.path === 'variables.tf')!.content;
  const declared = variables.match(/variable "faxapi_fax_token"/g) ?? [];
  assert.equal(declared.length, 1, 'one variable per provider secret, not per bind');
  const main = files.find((f) => f.path === 'main.tf')!.content;
  assert.equal((main.match(/External providers: configured outside this plan/g) ?? []).length, 1);
  assert.ok(bracesBalanced(main));
});

function registryWith(providers: Array<{ name: string; capability: string; secrets?: string[] }>) {
  return registryFromScan({
    plugins: [{
      package: 'arcod-plugin-edge',
      version: '0.1.0',
      path: '/plugins/edge/arcod.plugin.json',
      dir: '/plugins/edge',
      pluginApi: PLUGIN_API,
      capabilities: providers.map((provider) => ({ name: provider.capability })),
      providers: providers.map((provider) => ({ ...provider, capability: provider.capability })),
    }],
    issues: [],
  });
}

test('two provider secrets that map to one variable are refused', () => {
  const source = [
    'module m @0.1.0 {}',
    'use capability arcod.std.a @1',
    'use capability arcod.std.b @1',
    'service S : http {',
    '  uses one: a',
    '  uses two: b',
    '  contract { public op ping() -> string { route: "GET /v1/p" } }',
    '}',
    'environment prod {',
    '  bind one -> a_b',
    '  bind two -> a(c: "x", b_c: "y")',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "s")',
    '}',
  ].join('\n');
  const registry = registryWith([
    { name: 'a_b', capability: 'a', secrets: ['C'] },
    { name: 'a', capability: 'b', secrets: ['B_C'] },
  ]);
  assert.throws(
    () => terraformFiles(parse(source, 'main.arc'), { environment: 'prod', registry }),
    /both need terraform variable a_b_c/,
  );
  const builtin = registryWith([{ name: 'db', capability: 'a', secrets: ['PASSWORD'] }]);
  const single = source
    .replace('  bind one -> a_b\n  bind two -> a(c: "x", b_c: "y")', '  bind one -> db')
    .replace('  uses two: b\n', '');
  assert.throws(
    () => terraformFiles(parse(single, 'main.arc'), { environment: 'prod', registry: builtin }),
    /collides with the built-in variable db_password/,
  );
});

test('every var.* reference in the plan is declared', async () => {
  const { files } = await tasksFiles();
  const main = files.find((f) => f.path === 'main.tf')!.content;
  const variables = files.find((f) => f.path === 'variables.tf')!.content;
  const declared = new Set([...variables.matchAll(/variable "([a-z0-9_]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...main.matchAll(/var\.([a-z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...referenced].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], 'the plan never references an undeclared input');
  // An external provider's secret is an input too: the plugin case must obey
  // the same rule as the built-in one.
  const plugin = terraformFiles(parse(FAX_SPEC, 'main.arc'), { environment: 'prod', registry: faxRegistry() });
  const pluginMain = plugin.find((f) => f.path === 'main.tf')!.content;
  const pluginVars = plugin.find((f) => f.path === 'variables.tf')!.content;
  for (const match of pluginMain.matchAll(/var\.([a-z0-9_]+)/g)) {
    assert.match(pluginVars, new RegExp('variable "' + match[1] + '"'), 'declared: ' + match[1]);
  }
});

test('an s3 bind renders a bucket whose keys are sensitive variables', async () => {
  // Object storage is the one managed service whose credentials are not a
  // password: the plan takes key/secret from variables, and the example file
  // stays empty so no key can be committed by accident.
  const mod = parse(await readFile(filesUrl, 'utf8'), 'main.arc');
  const files = terraformFiles(mod, { environment: 'prod' });
  const main = files.find((file) => file.path === 'main.tf')!.content;
  assert.match(main, /resource "yandex_storage_bucket" "objects" \{/);
  assert.match(main, /bucket     = "files-objects"/);
  assert.match(main, /access_key = var\.s3_access_key/);
  assert.match(main, /secret_key = var\.s3_secret_key/);
  assert.doesNotMatch(main, /access_key\s*=\s*"/, 'a key is a variable, not a literal');
  assert.ok(bracesBalanced(main));

  const variables = files.find((file) => file.path === 'variables.tf')!.content;
  assert.match(variables, /variable "s3_access_key" \{\n  type      = string\n  sensitive = true/);
  assert.match(variables, /variable "s3_secret_key" \{\n  type      = string\n  sensitive = true/);
});

test('formatTerraform writes every file under its own path header', async () => {
  const mod = parse(await readFile(filesUrl, 'utf8'), 'main.arc');
  const text = formatTerraform(terraformFiles(mod, { environment: 'prod' }));
  const blocks = text.split('\n---\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^# main\.tf\n/);
  assert.match(blocks[1], /^# variables\.tf\n/);
  assert.match(blocks[2], /^# terraform\.tfvars\.example\n/);
});

test('a non-yandex target is refused instead of half-rendered', () => {
  const source = [
    'module m @0.1.0 {}',
    'type T = { id: uuid }',
    'service S : http { contract { public op create(id: uuid) -> T { route: "POST /v1/t" } } }',
    'environment prod { deploy kubernetes(image: "x:1") }',
  ].join('\n');
  assert.throws(
    () => terraformFiles(parse(source, 'main.arc'), { environment: 'prod' }),
    /terraform target is implemented for yandex/,
  );
});

test('a missing environment says what the module declares, not just no', () => {
  const bare = parse('module demo @0.1.0 {\n  meta {\n    owner: "@me"\n  }\n}\n', 'main.arc');
  assert.throws(
    () => terraformFiles(bare, { environment: 'prod' }),
    /no environment to render: prod — module demo declares none/,
  );
  assert.throws(
    () => terraformFiles(bare),
    /no environment to render — module demo declares none/,
  );

  // Environments exist, but none of them says `deploy`: a different fix, and
  // the message has to say so instead of looking like a typo.
  const envs = parse([
    'module demo @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'environment dev {',
    '}',
    'environment prod {',
    '}',
    '',
  ].join('\n'), 'main.arc');
  assert.throws(
    () => terraformFiles(envs),
    /no environment to render — declared: dev, prod, but none has `deploy`/,
  );
  assert.throws(
    () => terraformFiles(envs, { environment: 'staging' }),
    /no environment to render: staging — declared: dev, prod/,
  );
});

// Two internal services are two images. An output list that names only the
// first one tells a pipeline to build half the module (B75).
test('a multi-service module outputs an image per service', () => {
  const source = [
    'module shop @0.1.0 {}',
    'type Item = { id: string, name: string }',
    'service Store : http {',
    '  uses db: kv',
    '  contract { public op read(id: string) -> Item { route: "GET /v1/items/:id" } }',
    '}',
    'service Cache : http {',
    '  contract { public op get(key: string) -> string { route: "GET /v1/cache/:key" } }',
    '}',
    'environment prod {',
    '  bind db -> redis(version: "7")',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
    '}',
  ].join('\n');
  const main = terraformFiles(parse(source, 'main.arc'), { environment: 'prod' })
    .find((file) => file.path === 'main.tf')!.content;
  assert.match(main, /output "image" {\n  value = "arcod\/shop-Store:0\.1\.0"\n}/);
  assert.match(main, /output "image_cache" {\n  value = "arcod\/shop-Cache:0\.1\.0"\n}/);
});

