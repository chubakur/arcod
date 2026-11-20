import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { formatTerraform, terraformFiles } from '../src/emit/terraform.ts';

// terraform refuses a plan with two resources of one name ("Duplicate resource
// configuration") or an output that names a resource no block declares. Both
// failures surface only at `terraform init`, minutes after the build, so the
// plan is checked structurally here: unique names, and every reference to a
// managed resource resolved inside the same file.

const source = [
  'module shop @0.3.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.sql @1',
  'use capability arcod.std.objects @1',
  'service Shop : http {',
  '  uses store: kv',
  '  uses db: sql(ttl: 1h)',
  '  uses files: objects',
  '  contract { public op get(id: uuid) -> string { route: "GET /v1/i/:id" } }',
  '}',
  'environment prod {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind db -> postgres(host: "pg", port: 5432)',
  '  bind files -> s3()',
  '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
  '}',
].join('\n');

const plan = terraformFiles(parse(source, 'main.arc'), { environment: 'prod' })
  .find((file) => file.path === 'main.tf')!.content;

const resources = [...plan.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => m[1] + '.' + m[2]);
const outputs = [...plan.matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]);
const variables = [...plan.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1]);

test('every managed service of one environment lands in one plan', () => {
  assert.deepEqual(resources.slice().sort(), [
    'yandex_mdb_postgresql_cluster.db',
    'yandex_mdb_postgresql_database.db',
    'yandex_mdb_postgresql_user.db',
    'yandex_mdb_redis_cluster.kv',
    'yandex_storage_bucket.objects',
    'yandex_vpc_network.main',
    'yandex_vpc_subnet.main',
  ]);
  assert.deepEqual(outputs.slice().sort(), ['db_host', 'db_port', 'image', 'kv_host', 'kv_port', 'network_id', 'subnet_id']);
});

test('no resource, output or variable name is declared twice', () => {
  for (const [kind, names] of [['resource', resources], ['output', outputs], ['variable', variables]] as Array<[string, string[]]>) {
    assert.equal(new Set(names).size, names.length, kind + ' names repeat: ' + names.join(', '));
  }
});

test('every resource reference in the plan names a block declared above', () => {
  const declared = new Set(resources);
  const missing: string[] = [];
  for (const match of plan.matchAll(/(yandex_[a-z0-9_]+\.[a-z0-9_]+)/g)) {
    if (!declared.has(match[1])) missing.push(match[1]);
  }
  assert.deepEqual(missing, [], 'the plan points at a resource it does not declare');
});

test('the formatted output keeps every file under its own header', () => {
  const files = terraformFiles(parse(source, 'main.arc'), { environment: 'prod' });
  const text = formatTerraform(files);
  for (const file of files) assert.ok(text.includes('# ' + file.path + '\n'), file.path + ' has a header');
});

function tfvars(region: string): string {
  const spec = [
    'module s @0.1.0 {}',
    'service S : http {',
    '  uses store: kv',
    '  contract { public op get(id: uuid) -> string { route: "GET /v1/i/:id" } }',
    '}',
    'environment prod {',
    '  bind store -> redis()',
    '  deploy yandex(region: "' + region + '", folder: "f", service: "s")',
    '}',
  ].join('\n');
  return terraformFiles(parse(spec, 'main.arc'), { environment: 'prod' })
    .find((file) => file.path === 'terraform.tfvars.example')!.content;
}

test('a zone written as the region is not suffixed twice', () => {
  assert.match(tfvars('ru-central1'), /zone      = "ru-central1-a"/, 'a region gets the conventional suffix');
  assert.match(tfvars('ru-central1-b'), /zone      = "ru-central1-b"/, 'a zone is already a zone');
});
