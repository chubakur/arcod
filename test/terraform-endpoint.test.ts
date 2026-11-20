import { test } from 'node:test';
import assert from 'node:assert/strict';
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
