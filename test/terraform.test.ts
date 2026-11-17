import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { terraformFiles } from '../src/emit/terraform.ts';
import { PLUGIN_API } from '../src/plugins.ts';
import { registryFromScan } from '../src/registry.ts';

// The cloud view of the same topology. HCL is checked structurally: balanced
// braces, the blocks the binds imply, and no credential written as a literal.
// A real 'terraform validate' needs the provider downloaded, which belongs to
// the owner's account, not to a unit test.

const tasksUrl = new URL('../examples/tasks/main.arc', import.meta.url);

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
  assert.match(main, /output "image" /);
  assert.match(main, /cr\.yandex\/arcod\/tasks:0\.1\.0/, 'the image contract is exported');
  assert.doesNotMatch(main, /password\s*=\s*"/, 'no literal password lands in the plan');
});

test('a postgres bind renders a managed cluster and never a literal password', async () => {
  const source = [
    'module shop @0.2.0 {}',
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
      path: '/plugins/fax',
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
