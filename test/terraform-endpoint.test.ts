import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { terraformFiles } from '../src/emit/terraform.ts';

// A managed service has no container to address: the cloud assigns the host
// and the service listens on its own port. A bind copied from the docker
// environment therefore carries `host` and `port` the plan cannot honor, and
// the operator used to get a cluster with no exported endpoint at all — the
// deployed service read DATABASE_URL with the compose host name. The plan now
// exports what the cloud assigned and names the arguments it ignored, and
// check() says the same thing before anyone applies it.

function spec(bind: string, deploy = 'deploy yandex(region: "ru-central1", folder: "f", service: "shop")') {
  return [
    'module shop @0.2.0 {}',
    'use capability arcod.std.sql @1',
    'type Item = { id: uuid, name: string }',
    'service Shop : http {',
    '  uses db: sql(ttl: 1h)',
    '  contract { public op create(id: uuid, name: string) -> Item { route: "POST /v1/i" } }',
    '}',
    'environment prod {',
    '  bind ' + bind,
    '  ' + deploy,
    '}',
  ].join('\n');
}

function main(source: string): string {
  const mod = parse(source, 'main.arc');
  return terraformFiles(mod, { environment: 'prod' }).find((file) => file.path === 'main.tf')!.content;
}

test('a managed postgres exports the endpoint the cloud assigns', () => {
  const plan = main(spec('db -> postgres(version: "16", host: "pg", port: 5432)'));
  assert.match(plan, /output "db_host" \{\n  value = yandex_mdb_postgresql_cluster\.db\.host\[0\]\.fqdn\n\}/);
  assert.match(plan, /output "db_port" \{\n  value = 6432\n\}/, 'the managed port, not the container port');
  assert.doesNotMatch(plan, /value = 5432/, 'the docker port never lands in the cloud plan');
  assert.match(plan, /# Container arguments on a managed service are not honored: db \(postgres\): host, port/);
});

test('a managed redis exports its endpoint too', () => {
  const plan = main(spec('kv -> redis(host: "kv", port: 6379)'));
  assert.match(plan, /output "kv_host" \{/);
  assert.match(plan, /value = yandex_mdb_redis_cluster\.kv\.host\[0\]\.fqdn/);
  assert.match(plan, /output "kv_port" \{\n  value = 6379\n\}/);
});

test('outputs appear even when the bind names no container arguments', () => {
  const plan = main(spec('db -> postgres()'));
  assert.match(plan, /output "db_host" \{/);
  assert.doesNotMatch(plan, /cannot honor/, 'nothing was ignored, so nothing is claimed');
});

test('W044 names the dropped arguments and the outputs that replace them', () => {
  const diags = check(parse(spec('db -> postgres(host: "pg", port: 5432)'), 'main.arc'));
  const found = diags.filter((item) => item.code === 'W044');
  assert.equal(found.length, 1, JSON.stringify(diags.map((item) => item.code)));
  assert.equal(found[0].path, 'environments.prod.binds.db');
  assert.match(found[0].message, /managed postgres assigns its own endpoint: host, port ignored by/);
  assert.match(found[0].hint ?? '', /db_host and db_port/);
});

test('W044 stays quiet when the endpoint is not managed or not asked for', () => {
  const docker = check(parse(spec('db -> postgres(host: "pg", port: 5432)', 'deploy docker'), 'main.arc'));
  assert.deepEqual(docker.filter((item) => item.code === 'W044'), [], 'docker hosts are containers and honor both');
  const clean = check(parse(spec('db -> postgres(version: "16")'), 'main.arc'));
  assert.deepEqual(clean.filter((item) => item.code === 'W044'), [], 'no argument, no warning');
  const bucket = check(parse(spec('files -> s3(expose: public)'), 'main.arc'));
  assert.deepEqual(bucket.filter((item) => item.code === 'W044'), [], 'a bucket has no host or port to export');
});

// One managed resource per provider: terraform refuses two blocks with the
// same name, and the cloud assigns one endpoint anyway. Two redis binds used
// to render `resource "yandex_mdb_redis_cluster" "kv"` twice — a plan no
// `terraform init` accepts — and the second binding looked provisioned.

const twoRedis = [
  'module shop @0.2.0 {}',
  'use capability arcod.std.kv @1',
  'service Shop : http {',
  '  uses store: kv',
  '  uses cache: kv',
  '  contract { public op get(id: uuid) -> string { route: "GET /v1/i/:id" } }',
  '}',
  'environment prod {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind cache -> redis(host: "kv", port: 6380)',
  '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
  '}',
].join('\n');

test('two binds to one managed provider render one cluster, not a duplicate', () => {
  const plan = main(twoRedis);
  const blocks = plan.split('\n').filter((line) => line.startsWith('resource "yandex_mdb_redis_cluster"'));
  assert.equal(blocks.length, 1, 'a duplicate resource name is a plan terraform refuses');
  assert.equal(plan.split('\n').filter((line) => line.startsWith('output "kv_host"')).length, 1);
  assert.ok(plan.includes('no separate resource for cache (redis)'), 'the second bind is named');
});

test('W045 names both aliases that share one managed resource', () => {
  const diags = check(parse(twoRedis, 'main.arc'));
  const found = diags.filter((item) => item.code === 'W045');
  assert.equal(found.length, 1, JSON.stringify(diags.map((item) => item.code)));
  assert.equal(found[0].path, 'environments.prod.binds.cache', 'the second bind is the one that shares');
  assert.match(found[0].message, /binds store and cache both become one managed redis resource/);
  assert.match(found[0].hint ?? '', /drop one bind or give the second its own environment/);
});

test('W045 stays quiet where two containers are two containers', () => {
  const docker = check(parse(twoRedis.replace('deploy yandex(region: "ru-central1", folder: "f", service: "shop")', 'deploy docker'), 'main.arc'));
  assert.deepEqual(docker.filter((item) => item.code === 'W045'), [], 'compose tells the ports apart');
});

test('two s3 binds share the one bucket resource', () => {
  const source = [
    'module shop @0.2.0 {}',
    'use capability arcod.std.objects @1',
    'service Shop : http {',
    '  uses files: objects',
    '  uses backup: objects',
    '  contract { public op get(id: uuid) -> string { route: "GET /v1/i/:id" } }',
    '}',
    'environment prod {',
    '  bind files -> s3()',
    '  bind backup -> s3()',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
    '}',
  ].join('\n');
  const plan = main(source);
  assert.equal(plan.split('\n').filter((line) => line.startsWith('resource "yandex_storage_bucket"')).length, 1);
  assert.ok(plan.includes('no separate resource for backup (s3)'), 'the second bucket bind is named');
});

// W044 was written for a prod bind copied from the docker environment: it
// repeats host/port that the plan cannot honor. The shipped examples were that
// case and have since dropped the container address from their cloud bindings
// (a project should not warn at its own README), so the branch is pinned here
// on a spec instead of on examples/files — and the examples get their own
// guard below.
test('a docker-style bind still gets W044 in a cloud environment', () => {
  const found = check(parse(spec('db -> postgres(host: "pg", port: 5432)'), 'main.arc'))
    .filter((item) => item.code === 'W044');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'environments.prod.binds.db');
  assert.match(found[0].message, /managed postgres assigns its own endpoint/);
});

test('no shipped example points a cloud binding at a container address', async () => {
  const dir = fileURLToPath(new URL('../examples', import.meta.url));
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const offenders: string[] = [];
  for (const name of names) {
    const source = await readFile(join(dir, name, 'main.arc'), 'utf8').catch(() => null);
    if (source === null) continue;
    const found = check(parse(source, name + '/main.arc')).filter((item) => item.code === 'W044');
    for (const item of found) offenders.push(name + ': ' + item.path + ' ' + item.message);
  }
  assert.deepEqual(offenders, [], 'the examples are the documentation; they should not warn about their own bindings');
});

// mysql and mariadb sit in terraform's managed set but have no yandex resource,
// so a cloud environment that bound them got a plan that looked complete and
// created nothing for the bind. The plan now lists them, and check() names the
// alias before anyone applies it.
test('W046 names a cloud bind the plan cannot provision', () => {
  const diags = check(parse(spec('db -> mysql'), 'main.arc'));
  const found = diags.filter((item) => item.code === 'W046');
  assert.equal(found.length, 1, JSON.stringify(diags.map((item) => item.code)));
  assert.equal(found[0].path, 'environments.prod.binds.db');
  assert.match(found[0].message, /provisions no mysql resource/);
  assert.match(found[0].hint ?? '', /bind postgres/);
});

test('the plan lists mysql instead of looking complete', () => {
  const plan = main(spec('db -> mysql'));
  assert.match(plan, /# No managed equivalent rendered for: mysql/);
  assert.doesNotMatch(plan, /yandex_mdb_postgresql_cluster/);
});

test('W046 stays quiet when the plan provisions the provider or the target is docker', () => {
  const managed = check(parse(spec('db -> postgres()'), 'main.arc'));
  assert.deepEqual(managed.filter((item) => item.code === 'W046'), []);
  const docker = check(parse(spec('db -> mysql', 'deploy docker'), 'main.arc'));
  assert.deepEqual(docker.filter((item) => item.code === 'W046'), [], 'a container is provisioned by compose');
});

test('W046 covers mariadb and the plan names it too', () => {
  const diags = check(parse(spec('db -> mariadb'), 'main.arc'));
  assert.equal(diags.filter((item) => item.code === 'W046').length, 1);
  assert.match(main(spec('db -> mariadb')), /# No managed equivalent rendered for: mariadb/);
});

test('W044 sends the author to the endpoints Secret, not just to "drop it"', () => {
  const diags = check(parse(spec('db -> postgres(host: "pg", port: 5432)'), 'main.arc'));
  const found = diags.filter((item) => item.code === 'W044');
  assert.match(found[0].hint ?? '', /endpoints Secret/, 'the hint names where the k8s manifest gets the address');
});
