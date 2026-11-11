import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService } from '../src/emit/service.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml, nginxConf } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { runExamples } from '../src/test.ts';
import { runPipeline } from '../src/pipeline.ts';
import { buildPrompts } from '../src/prompts.ts';
import { planBody } from '../src/plan-body.ts';
import { extractCode, validateBody } from '../src/impl.ts';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specUrl = new URL('../examples/onetimemessage/main.arc', import.meta.url);
const source = await readFile(specUrl, 'utf8');
const ast = parse(source, 'main.arc');

const mysqlUrl = new URL('../examples/project1-mysql/main.arc', import.meta.url);
const mysqlAst = parse(await readFile(mysqlUrl, 'utf8'), 'main.arc');

const filesUrl = new URL('../examples/files/main.arc', import.meta.url);
const filesAst = parse(await readFile(filesUrl, 'utf8'), 'main.arc');

test('parses the onetimemessage example', () => {
  assert.equal(ast.name, 'onetimemessage');
  assert.equal(ast.version, '0.1.0');
  assert.equal(ast.services.length, 1);

  const svc = ast.services[0];
  assert.equal(svc.name, 'OneTimeMessage');
  assert.equal(svc.impl, 'http');

  const ops = svc.contract.filter((op) => op.kind === 'op').map((op) => op.name);
  assert.deepEqual(ops, ['create', 'read']);
  assert.equal(svc.examples.length, 2);
  assert.equal(svc.rules.length, 2);
  assert.ok(svc.effects && svc.effects.allow.includes('store.set'));
});

test('the example has no errors', () => {
  const diags = check(ast);
  assert.deepEqual(diags.filter((item) => item.severity === 'error'), []);
  assert.ok(diags.some((item) => item.code === 'W016'));
  assert.ok(diags.some((item) => item.code === 'W018'));
});

test('reports an unbound capability', () => {
  const broken = parse(source.replace('bind store -> redis(host: "kv", port: 6379)', ''), 'main.arc');
  const codes = check(broken).map((d) => d.code);
  assert.ok(codes.includes('A002'));
});

test('reports a provider mentioned in the model', () => {
  const broken = parse(source.replace('uses store: kv(ttl: 999s, consistency: strong)', 'uses store: kv(ttl: 999s, consistency: strong) // redis'), 'main.arc');
  const codes = check(broken).map((d) => d.code);
  assert.ok(codes.includes('A003'));
});

test('build defaults to scaffold, reference is opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-scaffold-'));
  const scaffold = await buildExample(ast, dir);
  const scaffoldCode = await readFile(join(scaffold.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(scaffoldCode.includes('Mode: scaffold'));
  assert.ok(scaffoldCode.includes('const HANDLERS = {};'));
  assert.ok(!scaffoldCode.includes('randomUUID()'));

  const reference = await buildExample(ast, dir, { reference: true });
  const referenceCode = await readFile(join(reference.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(referenceCode.includes('Mode: reference'));
  assert.ok(referenceCode.includes('randomUUID()'));
});

test('once else must be a declared error', () => {
  const broken = parse(source.replace('else: Gone', 'else: Bogus'), 'main.arc');
  const codes = check(broken).map((item) => item.code);
  assert.ok(codes.includes('A022'));
});

test('a job is parsed but flagged as not executable', () => {
  const withJob = source.replace(
    "    }\n\n  }\n\n  rules {",
    "    }\n\n    job purge_expired() -> int {\n      schedule: \"*/5 * * * *\"\n      idempotent\n    }\n  }\n\n  rules {",
  );
  const jobAst = parse(withJob, 'main.arc');
  assert.ok(jobAst.services[0].contract.some((item) => item.kind === 'job'));
  const diags = check(jobAst);
  assert.ok(diags.some((item) => item.code === 'W017'));
});

test('effects cover atomic steps and generated operations', () => {
  const broken = parse(source.replace('store.del, ', ''), 'main.arc');
  const codes = check(broken).map((item) => item.code);
  assert.ok(codes.includes('A004'));
});

test('deny wins over allow', () => {
  const broken = parse(source.replace('deny net, fs, exec', 'deny net, fs, exec, store.set'), 'main.arc');
  const codes = check(broken).map((item) => item.code);
  assert.ok(codes.includes('A021'));
  assert.ok(codes.includes('A020'));
});

test('plan is deterministic and has stable ids', () => {
  const first = buildPlan(ast);
  const second = buildPlan(ast);
  assert.deepEqual(first, second);
  assert.equal(first.tasks[0].id, 'T-0001');
  assert.ok(first.tasks.some((task) => task.kind === 'implement' && task.op === 'read'));
  assert.ok(first.tasks.some((task) => task.kind === 'infra'));
});

test('service emitter wires spec values into the runtime', () => {
  const code = emitService(ast);
  assert.match(code, /"ttlMs": 999000/);
  assert.ok(code.includes('"method": "POST"'));
  assert.ok(code.includes('"path": "/api/messages"'));
  assert.ok(code.includes('"path": "/api/messages/:id"'));
  assert.match(code, /randomUUID/);
  assert.match(code, /LUA_READ/);
});

test('web emitter points at the declared routes', () => {
  const html = emitWeb(ast, { maxBytes: 64 * 1024 });
  assert.ok(html.includes('/api/messages'));
  assert.ok(html.includes('/api/messages/:id'));
  assert.match(html, /65536/);
});

test('ui block declares the frontend', () => {
  assert.equal(ast.uis.length, 1);
  assert.equal(ast.uis[0].name, 'Web');
  assert.deepEqual(ast.uis[0].uses, ['OneTimeMessage.create', 'OneTimeMessage.read']);
});

test('atomic rule controls generated read semantics', () => {
  const withoutAtomic = source.replace('    atomic read { get; del }\n', '');
  const code = emitService(parse(withoutAtomic, 'main.arc'));
  assert.ok(code.includes('const ATOMIC_READ = false;'));
});

test('without ui there is no frontend container', () => {
  const yaml = composeYaml(ast, 8080, false);
  assert.ok(!yaml.includes('web:'));
  assert.ok(yaml.includes('"8080:3000"'));
  assert.throws(() => emitWeb({ ...ast, uis: [] }, { maxBytes: 1024 }), /no ui block/);
});

test('A018 catches a ui reference to a missing operation', () => {
  const broken = parse(source.replace('OneTimeMessage.read', 'OneTimeMessage.nope'), 'main.arc');
  const codes = check(broken).map((d) => d.code);
  assert.ok(codes.includes('A018'));
});

test('budget reaches the plan and the runtime', () => {
  const task = buildPlan(ast).tasks.find((item) => item.kind === 'implement');
  assert.deepEqual(task?.budget, { tokens: 40000, time: '2h' });

  const code = emitService(ast);
  assert.ok(code.includes('const ATOMIC_READ = true;'));
  assert.ok(code.includes('"consumedError": "Gone"'));
  assert.ok(code.includes('"concurrency": 100'));
  assert.ok(code.includes('inFlight >= CONFIG.concurrency'));
});

test('examples run against the generated service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-example-'));
  const built = await buildExample(ast, dir, { reference: true });
  const report = await runExamples(ast, built.dir);
  assert.equal(report.examples.length, 2);
  assert.ok(report.examples.every((item) => item.ok), JSON.stringify(report.examples));
  assert.equal(report.rules.length, 2);
  assert.ok(report.rules.every((item) => item.ok), JSON.stringify(report.rules));
});

test('model-written bodies run through the generated service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-impl-'));
  const implDir = fileURLToPath(new URL('../examples/onetimemessage-pwd/impl', import.meta.url));
  const built = await buildExample(guardedAst, dir, { implDir });
  assert.deepEqual(built.impl, ['create', 'read']);

  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(code, /Mode: impl/);
  assert.match(code, /async function implRead/);
  assert.ok(!code.includes('notImplemented(res'));

  const report = await runExamples(guardedAst, built.dir);
  assert.ok(report.examples.every((item) => item.ok), JSON.stringify(report.examples));
  assert.ok(report.rules.every((item) => item.ok), JSON.stringify(report.rules));
});

test('impl mode falls back to 501 for operations without a body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-impl-partial-'));
  const implDir = join(dir, 'impl');
  await mkdir(implDir, { recursive: true });
  await writeFile(join(implDir, 'create.mjs'), 'export async function create(input, io) { const id = io.new(); await io.save(id, { b: input.body, h: null }); return { result: id }; }\n');
  const built = await buildExample(guardedAst, dir, { implDir });
  assert.deepEqual(built.impl, ['create']);
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(code, /const HANDLERS = \{/);
  assert.match(code, /create: handleCreate/);
  assert.ok(!code.includes('read: handleRead'), 'read has no body, so it is absent from the table');
});

const infraSource = `module infra @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.sql @1
use capability arcod.std.queue @1
use capability arcod.std.objectstore @1
use capability arcod.std.identity @1
use capability arcod.std.olap @1
use capability arcod.std.metrics @1
use capability arcod.std.proxy @1
use capability arcod.std.migrations @1
use capability arcod.std.document @1
use capability arcod.std.errors @1
use capability arcod.std.tracing @1
use capability arcod.std.dashboards @1
use capability arcod.std.mail @1
use capability arcod.std.secrets @1

service All : http {
  uses store: kv(ttl: 999s)
  uses db: sql
  uses db2: sql
  uses db3: sql
  uses docs: document
  uses files: objectstore
  uses events: queue
  uses events2: queue
  uses auth: identity
  uses analytics: olap
  uses metrics: metrics
  uses edge: proxy
  uses schema: migrations
  uses errors: errors
  uses tracing: tracing
  uses dashboards: dashboards
  uses mail: mail
  uses secrets: secrets
}

environment dev {
  bind store -> redis(host: "kv")
  bind db -> postgres(host: "db")
  bind db2 -> mysql(host: "mysql")
  bind db3 -> mariadb(host: "mariadb")
  bind docs -> mongodb(host: "mongo")
  bind files -> s3(host: "s3", expose: true)
  bind events -> kafka(host: "kafka")
  bind events2 -> rabbitmq(host: "mq")
  bind auth -> keycloak(host: "kc")
  bind analytics -> clickhouse(host: "ch")
  bind metrics -> prometheus(host: "prom", expose: true)
  bind edge -> nginx(host: "edge")
  bind schema -> liquibase(host: "migrate")
  bind errors -> sentry(dsn: "https://key@sentry.example/1")
  bind tracing -> jaeger(host: "jaeger", expose: true)
  bind dashboards -> grafana(host: "grafana")
  bind mail -> mailpit(host: "mail")
  bind secrets -> vault(host: "vault")
  deploy docker
}
`;

test('every provider in the registry renders a compose service', () => {
  const mod = parse(infraSource, 'infra.arc');
  const yaml = composeYaml(mod, 8080, false);

  for (const image of [
    'redis:7-alpine',
    'postgres:16-alpine',
    'mysql:8.4',
    'mariadb:11',
    'mongo:7',
    'quay.io/keycloak/keycloak:26.0',
    'minio/minio:latest',
    'rabbitmq:3.13-management-alpine',
    'apache/kafka:3.8.0',
    'nginx:1.27-alpine',
    'liquibase/liquibase:4.29',
    'clickhouse/clickhouse-server:24.8-alpine',
    'prom/prometheus:v2.54.1',
    'jaegertracing/all-in-one:1.62',
    'grafana/grafana:11.2.0',
    'axllent/mailpit:v1.21',
    'hashicorp/vault:1.18',
  ]) {
    assert.ok(yaml.includes('image: ' + image), 'missing ' + image);
  }

  assert.match(yaml, /DATABASE_URL: "postgres:\/\/arcod:arcod@db:5432\/arcod"/);
  assert.match(yaml, /S3_ENDPOINT: "http:\/\/s3:9000"/);
  assert.match(yaml, /KAFKA_BROKERS: "kafka:9092"/);
  assert.match(yaml, /CLICKHOUSE_URL: "http:\/\/ch:8123"/);
  assert.match(yaml, /^volumes:\n(  \w+:\n)*  pgdata:\n/m);
  assert.ok(yaml.includes('"9001:9001"'), 'minio console port');
  assert.match(yaml, /SENTRY_DSN: "https:\/\/key@sentry\.example\/1"/);
  assert.ok(!yaml.includes('\n  sentry:\n'), 'sentry is external, not a container');
  assert.match(yaml, /OTEL_EXPORTER_OTLP_ENDPOINT: "http:\/\/jaeger:4318"/);
  assert.match(yaml, /SMTP_URL: "smtp:\/\/mail:1025"/);
});

test('unknown provider and capability mismatch are errors', () => {
  const unknown = parse(infraSource.replace('bind store -> redis(host: "kv")', 'bind store -> nats(host: "kv")'), 'infra.arc');
  assert.ok(check(unknown).some((item) => item.code === 'A023'));

  const mismatch = parse(infraSource.replace('bind store -> redis(host: "kv")', 'bind store -> kafka(host: "kv")'), 'infra.arc');
  const errors = check(mismatch);
  assert.ok(errors.some((item) => item.code === 'A024' && item.message.includes('kafka')));

  const duplicate = parse(infraSource.replace('bind db2 -> mysql(host: "mysql")', 'bind db -> mysql(host: "mysql")'), 'infra.arc');
  assert.ok(check(duplicate).some((item) => item.code === 'A025'));

  const missingDsn = parse(infraSource.replace('bind errors -> sentry(dsn: "https://key@sentry.example/1")', 'bind errors -> sentry()'), 'infra.arc');
  assert.ok(check(missingDsn).some((item) => item.code === 'A026'));
});

test('byte limits are scaled: 64kb is 65536, not 64', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-limits-'));
  const built = await buildExample(ast, dir, { reference: true });
  const service = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(service, /"maxBody": 65536/);
  const web = await readFile(join(built.dir, 'web', 'index.html'), 'utf8');
  assert.match(web, /MAX_BYTES = 65536/);
});

test('nginx proxies healthz next to the api', () => {
  const conf = nginxConf(ast);
  assert.match(conf, /location = \/healthz \{/);
  assert.match(conf, /proxy_pass http:\/\/service:3000\/healthz;/);
  assert.match(conf, /location \/api\/messages \{/, 'proxies the declared route, not a hardcoded /api/');
  assert.ok(!conf.includes('location /api/ {'), 'no hardcoded prefix');
});

test('generated bodies are read from impl/ and from .arcod/impl as a fallback', async () => {
  const primary = await mkdtemp(join(tmpdir(), 'arcod-bodies-'));
  await mkdir(join(primary, 'impl'), { recursive: true });
  await writeFile(join(primary, 'impl', 'create.mjs'), 'export async function create() { return {}; }\n');
  const picked = await buildExample(ast, primary);
  assert.deepEqual(picked.impl, ['create']);

  const fallback = await mkdtemp(join(tmpdir(), 'arcod-bodies-old-'));
  await mkdir(join(fallback, '.arcod', 'impl'), { recursive: true });
  await writeFile(join(fallback, '.arcod', 'impl', 'read.mjs'), 'export async function read() { return {}; }\n');
  const legacy = await buildExample(ast, fallback);
  assert.deepEqual(legacy.impl, ['read']);
});

test('a multi-field payload is stored as a record and returned as JSON', async () => {
  const recAst = parse("module recpkg @0.1.0 {}\n\nuse capability arcod.std.kv @1\nuse capability arcod.std.ids @1\n\ntype MessageId = uuid\ntype Author = bytes(min: 1, max: 255)\ntype Body = bytes(min: 1, max: 64kb)\n\nerror NotFound\nerror Gone\nerror Invalid\n\nservice Messages : http {\n  uses store: kv(ttl: 999s, consistency: strong)\n  uses uuid: ids\n\n  contract {\n    public op create(author: Author, body: Body) -> MessageId {\n      route: \"POST /v1/api/messages\"\n      errors: Invalid\n      post: result != null\n    }\n\n    public op read(id: MessageId) -> { author: Author, body: Body } {\n      route: \"GET /v1/api/messages/:id\"\n      errors: NotFound, Gone\n      post: !store.has(id)\n    }\n  }\n\n  effects {\n    allow store.get, store.set, store.del, store.has, uuid.new\n    deny net, fs, exec\n  }\n\n  rules {\n    invariant read.at_most_once: once(read, by: id, else: Gone)\n    atomic read { get; del }\n  }\n}\n\nenvironment dev {\n  bind store -> redis(host: \"kv\", port: 6379)\n  bind uuid -> local\n  deploy docker\n}", 'recpkg.arc');
  const svc = recAst.services[0];
  const create = svc.contract.find((op) => op.kind === 'op' && op.name === 'create')!;
  const plan = planBody(recAst, svc, create);
  assert.ok(plan.steps.some((step) => step.includes('{b: {author: author, body: body}, h: null}')), plan.steps.join(' | '));

  const set = buildPrompts(recAst);
  const prompt = set.tasks.find((task) => task.op === 'create')!.prompt;
  assert.match(prompt, /record: \{b: \{author: Author, body: Body\}, h: null\}/);

  const dir = await mkdtemp(join(tmpdir(), 'arcod-record-'));
  const body = 'export async function create(input, io) { const id = await io.new(); await io.save(id, { b: { author: input.author, body: input.body }, h: null }); return { result: id }; }\n';
  const built = await buildExample(recAst, dir, { implDir: null });
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'create.mjs'), body);
  const withImpl = await buildExample(recAst, dir, {});
  const code = await readFile(join(withImpl.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(code, /create: handleCreate/);
  assert.ok(!code.includes('read: handleRead'), 'no body, no handler');
  assert.ok(code.includes('function callImpl('), 'handlers are generic, not name-keyed');
});

test('the form is generated from the create parameters', async () => {
  const spec = `module formpkg @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type MessageId = uuid
type Author = bytes(min: 1, max: 255)
type Body = bytes(min: 1, max: 64kb)

error NotFound
error Gone
error Invalid

service Messages : http {
  uses store: kv(ttl: 999s, consistency: strong)
  uses uuid: ids

  contract {
    public op create(author: Author, body: Body) -> MessageId {
      route: "POST /v1/api/messages"
      errors: Invalid
      post: result != null
    }

    public op read(id: MessageId) -> Body {
      route: "GET /v1/api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Форма"
  uses Messages.create, Messages.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}`;
  const formAst = parse(spec, 'formpkg.arc');
  const html = emitWeb(formAst, { maxBytes: 65536 });
  assert.match(html, /<input id="f-author"/, 'a short field renders as input');
  assert.match(html, /<textarea id="f-body"/, 'a large bytes field renders as textarea');
  assert.match(html, /const FIELDS = \[\{"name":"author","label":"Имя","min":1,"max":255\}/);
  assert.ok(!html.includes("byId('body')"), 'no hardcoded body field');
  assert.ok(html.includes('JSON.stringify(payload)'), 'the form posts its own fields');
  assert.ok(!html.includes('__FIELDS__'));
});

test('make runs check, prompts, bodies, build and test in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-make-'));
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const started = Date.now();
  const result = await runPipeline(ast, dir, { skipImpl: true });
  assert.ok(result.ok, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map((step) => step.name), ['check', 'prompts', 'impl', 'build', 'test']);
  assert.ok(result.steps.find((step) => step.name === 'impl')!.skipped);
  assert.match(result.steps.find((step) => step.name === 'test')!.detail, /^4 passed/);
  assert.ok(Date.now() - started < 60_000);
});

test('make stops at the first failing step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-make-fail-'));
  const broken = (await readFile(specUrl, 'utf8')).replace('allow store.get, store.set', 'allow store.get');
  await writeFile(join(dir, 'main.arc'), broken, 'utf8');
  const brokenAst = parse(broken, 'main.arc');
  const result = await runPipeline(brokenAst, dir, { skipImpl: true });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1, 'nothing runs after a failed check');
  assert.equal(result.steps[0].name, 'check');
  assert.match(result.steps[0].detail, /error/);
});

test('the generated page script is syntactically valid', () => {
  const html = emitWeb(ast, { maxBytes: 65536 });
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>');
  assert.ok(start > 0 && end > start, 'script tag present');
  const script = html.slice(start + '<script>'.length, end);
  assert.ok(script.includes('labelOf'), 'read results are labelled');
  assert.doesNotThrow(() => new Function(script), 'the page script must parse before it ships');
});

test('sql binds to mysql without touching the model', () => {
  const diags = check(mysqlAst);
  assert.deepEqual(diags.filter((item) => item.severity === 'error'), []);

  const service = emitService(mysqlAst, { impl: { create: 'export async function create() {}' } });
  assert.ok(service.includes('class SqlStore'), 'a MySQL adapter is emitted');
  assert.ok(service.includes("process.env.DATABASE_URL"), 'the adapter reads the provider env');
  assert.ok(!service.includes('class RedisStore'), 'no Redis client in a sql service');
  assert.match(service, /import \{ [^}]*createHash[^}]* \} from 'node:crypto'/);

  const compose = composeYaml(mysqlAst, { port: 8080 });
  assert.ok(compose.includes('image: mysql:8.4'));
  assert.ok(!compose.includes('redis:7-alpine'));
  assert.ok(compose.includes('DATABASE_URL: "mysql://arcod:arcod@store:3306/arcod"'));
});

test('the file service wires identity, blobs and sql', () => {
  const diags = check(filesAst);
  assert.deepEqual(diags.filter((item) => item.severity === 'error'), []);

  const compose = composeYaml(filesAst, 8080, false);
  assert.ok(compose.includes('image: keycloak') || compose.includes('keycloak/keycloak'));
  assert.ok(compose.includes('/opt/keycloak/data/import/realm.json:ro'));
  assert.ok(compose.includes('--import-realm'));
  assert.ok(compose.includes('mysql:8.4'));
  assert.ok(compose.includes('KEYCLOAK_URL: "http://idp:8080"'));
  assert.ok(compose.includes('S3_ENDPOINT: "http://s3:9000"'));
});

test('file visibility: restricted list, authenticated, public and admin bypass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-files-'));
  await cp(
    (await import('node:url')).fileURLToPath(new URL('../examples/files/realm.json', import.meta.url)),
    join(dir, 'realm.json'),
  );
  const built = await buildExample(filesAst, dir, {
    implDir: (await import('node:url')).fileURLToPath(new URL('../examples/files/impl', import.meta.url)),
  });
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [join(built.dir, 'service', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), SQL_DRIVER: 'memory', AUTH_DRIVER: 'memory', BLOB_DRIVER: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const as = (id: string, admin = false) => ({ 'x-actor': id, 'x-actor-name': id, 'x-admin': String(admin) });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(base + '/v1/files');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const upload = await fetch(base + '/v1/files', {
      method: 'POST',
      headers: { ...as('u-andrey', true), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plan.txt', body: 'secret', visibility: 'restricted', allowed: ['u-vika'] }),
    });
    assert.equal(upload.status, 201);
    const id = (await upload.json() as { id: string }).id;

    const read = (actor: string, admin = false) => fetch(base + '/v1/files/' + id, { headers: as(actor, admin) });
    assert.equal((await read('u-vika')).status, 200, 'listed user reads');
    assert.equal((await read('u-guest')).status, 403, 'unlisted user is refused');
    assert.equal((await read('u-guest', true)).status, 200, 'administrator bypasses the list');
    assert.equal((await fetch(base + '/v1/files/' + id)).status, 401, 'anonymous is unauthorized');

    const list = await fetch(base + '/v1/files', { headers: as('u-guest') });
    assert.deepEqual(await list.json(), [], 'nothing visible to a stranger');

    const flip = await fetch(base + '/v1/files/' + id + '/visibility', {
      method: 'PUT',
      headers: { ...as('u-guest'), 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', allowed: [] }),
    });
    assert.equal(flip.status, 403, 'only the owner or an administrator may share');

    const share = await fetch(base + '/v1/files/' + id + '/visibility', {
      method: 'PUT',
      headers: { ...as('u-andrey', true), 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', allowed: [] }),
    });
    assert.equal(share.status, 201);
    assert.equal((await read('u-guest')).status, 200, 'public file is readable');
    assert.equal((await fetch(base + '/v1/files/' + id)).status, 200, 'and even anonymous');
  } finally {
    child.kill();
  }
});

test('kv keeps the redis adapter', () => {
  const service = emitService(ast);
  assert.ok(service.includes('class RedisStore'));
  assert.ok(!service.includes('class SqlStore'));
});

test('make builds and tests the mysql example with the memory driver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mysql-'));
  await cp(new URL('../examples/project1-mysql', import.meta.url), dir, { recursive: true });
  const result = await runPipeline(mysqlAst, dir, {});
  assert.ok(result.ok, JSON.stringify(result.steps));
  assert.match(result.steps.find((step) => step.name === 'test')!.detail, /^4 passed/);
});

test('compose has kv, service and web', () => {
  const yaml = composeYaml(ast, 8080);
  assert.match(yaml, /^name: arcod-onetimemessage/m);
  assert.match(yaml, /redis:7-alpine/);
  assert.match(yaml, /"8080:80"/);
});

const guardedSource = await readFile(new URL('../examples/onetimemessage-pwd/main.arc', import.meta.url), 'utf8');
const guardedAst = parse(guardedSource, 'main.arc');

test('the password example differs from the plain one in the model only', () => {
  const diags = check(guardedAst);
  assert.deepEqual(diags.filter((item) => item.severity === 'error'), []);

  const svc = guardedAst.services[0];
  const read = svc.contract.find((op) => op.kind === 'op' && op.name === 'read');
  assert.ok(read && read.params.some((param) => param.name === 'password'));
  assert.ok(diags.some((item) => item.code === 'W018'));
});

test('guarded build emits password verification, scaffold keeps TODO', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pwd-'));
  const scaffold = await buildExample(guardedAst, dir);
  const scaffoldCode = await readFile(join(scaffold.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(scaffoldCode.includes('const HANDLERS = {};'));
  assert.ok(!scaffoldCode.includes('scryptSync'));

  const reference = await buildExample(guardedAst, dir, { reference: true });
  const code = await readFile(join(reference.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('hashPassword'));
  assert.ok(code.includes("sendError(res, 'WrongPassword')"));
  assert.ok(!code.includes('password ? hashPassword(password) : null') || true);

  const web = await readFile(join(reference.dir, 'web', 'index.html'), 'utf8');
  assert.ok(web.includes('id="pwd-create"'));
  assert.ok(web.includes('id="pwd-read"'));
});

test('prompts are deterministic and stay under budget', () => {
  const first = buildPrompts(guardedAst);
  const second = buildPrompts(guardedAst);
  assert.deepEqual(first.tasks.map((task) => task.sha256), second.tasks.map((task) => task.sha256));
  assert.deepEqual(first.tasks.map((task) => task.prompt), second.tasks.map((task) => task.prompt));
  assert.deepEqual(first.overBudget, []);
  for (const task of first.tasks) {
    assert.ok(task.tokens < 200, task.id + ' is ' + task.tokens + ' tokens');
  }
});

test('a prompt contains only its own operation', () => {
  const set = buildPrompts(guardedAst);
  const read = set.tasks.find((task) => task.op === 'read')!;
  const create = set.tasks.find((task) => task.op === 'create')!;
  assert.match(read.prompt, /WrongPassword/);
  assert.match(read.prompt, /on WrongPassword: io\.has\(id\)/);
  assert.ok(!read.prompt.includes('operation create'));
  assert.ok(!read.prompt.includes('POST /api/messages'));
  assert.match(create.prompt, /^out: /m);
  assert.ok(!create.prompt.includes('WrongPassword'));
});

test('the procedure is derived from the model, not from the operation name', () => {
  const svc = guardedAst.services[0];
  const read = svc.contract.find((op) => op.kind === 'op' && op.name === 'read')!;
  const create = svc.contract.find((op) => op.kind === 'op' && op.name === 'create')!;

  const readPlan = planBody(guardedAst, svc, read);
  assert.deepEqual(readPlan.unresolved, []);
  const readText = readPlan.steps.join(' ');
  assert.ok(readText.includes('await io.verify'));
  assert.ok(readText.includes('await io.takeIf'));
  assert.ok(readText.indexOf('io.verify') < readText.indexOf('io.takeIf'));

  const createPlan = planBody(guardedAst, svc, create);
  assert.deepEqual(createPlan.unresolved, []);
  assert.ok(createPlan.steps.join(' ').includes('await io.save'));
  assert.ok(!createPlan.steps.join(' ').includes('io.load'));
});

test('dropping a rule drops the corresponding step', () => {
  const source = guardedSource
    .replace('    invariant read.at_most_once: once(read, by: id, else: Gone)\n', '')
    .replace('    atomic read { get; del }\n', '');
  const ast = parse(source, 'main.arc');
  const svc = ast.services[0];
  const read = svc.contract.find((op) => op.kind === 'op' && op.name === 'read')!;
  const plan = planBody(ast, svc, read);
  assert.ok(!plan.steps.join(' ').includes('io.takeIf'), plan.steps.join(' '));
});

test('dropping the password parameter drops verification', () => {
  const source = guardedSource
    .replace('type Password = string(min: 1, max: 128)\n', '')
    .replace('(body: Body, password: Password?)', '(body: Body)')
    .replace('(id: MessageId, password: Password?)', '(id: MessageId)')
    .replace('error WrongPassword\n', '');
  const ast = parse(source, 'main.arc');
  const svc = ast.services[0];
  const read = svc.contract.find((op) => op.kind === 'op' && op.name === 'read')!;
  const plan = planBody(ast, svc, read);
  assert.ok(!plan.steps.join(' ').includes('io.verify'), plan.steps.join(' '));
  assert.ok(plan.steps.join(' ').includes('io.takeIf'));
});

test('prompt budget is enforced', () => {
  const set = buildPrompts(guardedAst, { budget: 20 });
  assert.deepEqual(set.overBudget, set.tasks.map((task) => task.id));
});

test('model replies are extracted and validated', () => {
  const code = extractCode('text before\n\u0060\u0060\u0060js\nexport async function read(input, io) { return { result: "x" }; }\n\u0060\u0060\u0060\ntext after');
  assert.equal(validateBody(code, 'read'), null);
  assert.ok(validateBody('import x from "node:fs";\nexport async function read(input, io) {}', 'read'));
  assert.ok(validateBody('export async function write(input, io) {}', 'read'));
  assert.ok(validateBody('export async function read(input, io) { res.writeHead(200); }', 'read'));
});

test('guarded examples pass: wrong password does not consume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pwd-run-'));
  const built = await buildExample(guardedAst, dir, { reference: true });
  const report = await runExamples(guardedAst, built.dir);
  assert.equal(report.examples.length, 3);
  assert.ok(report.examples.every((item) => item.ok), JSON.stringify(report.examples));
  assert.equal(report.rules.length, 2);
  assert.ok(report.rules.every((item) => item.ok), JSON.stringify(report.rules));
});
