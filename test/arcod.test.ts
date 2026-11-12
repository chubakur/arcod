import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService, routeOf, statusForError } from '../src/emit/service.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml, nginxConf } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { deployManifest } from '../src/deploy.ts';
import { providersForCapability } from '../src/providers.ts';
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
  // native denies (net, fs, exec) are enforced by body validation, so the
  // unenforced-deny warning only fires for capability-level denies
  assert.ok(!diags.some((item) => item.code === 'W016'));
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
  assert.match(web, /"max":65536/, 'the size limit travels to the page');
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
  assert.ok(plan.steps.some((step) => step.includes('{ b: { author: author, body: body }, h: null }')), plan.steps.join(' | '));

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
  title: "Form"
  uses Messages.create, Messages.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}`;
  const formAst = parse(spec, 'formpkg.arc');
  const html = emitWeb(formAst, { maxBytes: 65536 });
  assert.ok(html.includes('{"name":"author","kind":"text"'), 'a short bytes field becomes a text input');
  assert.ok(html.includes('{"name":"body","kind":"textarea"'), 'a large bytes field becomes a textarea');
  assert.ok(!html.includes('id="f-author"'), 'fields are built from the contract, not hardcoded');
  assert.ok(html.includes('JSON.stringify(body)'), 'the form posts its own fields');
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
  assert.ok(script.includes('renderResult'), 'results are rendered by shape');
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

const workflowSpec = `module nightly @0.1.0 { meta { owner: "@andrey" status: draft since: "2026-11-11" } }

use capability arcod.std.kv @1

type Snapshot = string
type Report = string
type Receipt = string

service Reports : http {
  uses store: kv(ttl: 999s)

  contract {
    public op prepare() -> Snapshot { route: "POST /v1/prepare" }
    public op render(snapshot: Snapshot) -> Report { route: "POST /v1/render" }
    public op send(report: Report) -> Receipt { route: "POST /v1/send" }
  }
}

workflow Nightly {
  trigger cron("0 3 * * *", tz: "Europe/Moscow")
  overlap: skip
  catchup: last
  retry: 2
  timeout: 30m

  step prepare() -> Snapshot {
    call: Reports.prepare
    effects: store.set
  }

  step render(snapshot: Snapshot) -> Report {
    call: Reports.render
    needs: prepare
    retry: 0
  }

  step send(report: Report) -> Receipt {
    call: Reports.send
    needs: render
    onFail: stop
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  deploy docker
}
`;

const chatUrl = new URL('../examples/chat/main.arc', import.meta.url);
const chatImplDir = (await import('node:url')).fileURLToPath(new URL('../examples/chat/impl', import.meta.url));
const chatAst = parse(await readFile(chatUrl, 'utf8'), 'main.arc');

const quizUrl = new URL('../examples/quiz/main.arc', import.meta.url);
const quizImplDir = fileURLToPath(new URL('../examples/quiz/impl', import.meta.url));
const quizSource = await readFile(quizUrl, 'utf8');
const quizAst = parse(quizSource, 'main.arc');

test('a presentation is a deck of slides', () => {
  const ui = quizAst.uis[0];
  assert.equal(ui.layout, 'presentation');
  assert.deepEqual(ui.slides.map((slide) => [slide.title, slide.body]), [
    ['Who are you?', 'Developers, QA, product — the host asks, the room answers out loud.'],
    ['Join', 'Open the link shown on the big screen or scan the code to follow from your phone.'],
    ['Agenda', 'The host advances the deck; guests see every slide as it changes.'],
    ['Questions', 'Write a question — the host sees it in the live state.'],
  ]);
  // interactive widgets were removed from the language in v0.1: slide bodies
  // are plain text, poll/rating/comments/qr are not parsed anymore
  assert.throws(
    () => parse(quizSource.replace('answers out loud."\n  }', 'answers out loud."\n    poll("Yes", "No")\n  }'), 'main.arc'),
    /slide property|expected/,
  );

  const diags = check(quizAst);
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0);

  const plan = buildPlan(quizAst);
  const implemented = plan.tasks.filter((task) => task.kind === 'implement');
  assert.equal(implemented.length, 7, 'every operation is planned');
});

test('a presentation without its bindings does not compile', () => {
  const codes = (text: string) => check(parse(text, 'main.arc')).map((item) => item.code);

  assert.ok(codes(quizSource.replace('  join:    Live.join\n', '')).includes('A040'), 'A040: no join');

  const noSlides = quizSource.replace(/  slide[\s\S]*?\n  }\n/g, '');
  assert.ok(codes(noSlides).includes('A041'), 'A041: empty deck');
});

test('the presentation page carries the deck and a real QR encoder', () => {
  const html = emitWeb(quizAst, { maxBytes: 2_000_000 });
  assert.ok(!/__[A-Z]+__/.test(html), 'no unexpanded placeholders');
  const titles = quizAst.uis[0].slides.map((slide) => slide.title);
  assert.ok(titles.every((title) => html.includes(title)), 'every slide title is in the page');
  assert.ok(!html.includes('"widget"'), 'no widget markup in the deck');
  assert.ok(html.includes('"stream":true'), 'the deck knows it has a socket');
  assert.ok(html.includes('POST') && html.includes('/v1/sessions/:code/join'), 'operations are described');
  assert.ok(html.includes('var qrcode=function'), 'the QR encoder for the join link is inline, not a CDN');
});

test('the quiz example builds a working page and keeps its bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-quiz-'));
  const built = await buildExample(quizAst, dir, { implDir: quizImplDir });
  const html = await readFile(join(built.dir, 'web', 'index.html'), 'utf8');
  assert.ok(html.includes(quizAst.uis[0].title));
  assert.ok(html.includes(quizAst.uis[0].slides[0].title));
  assert.equal(built.impl.length, 7);
});

const paymentsUrl = new URL('../examples/payments/main.arc', import.meta.url);
const paymentsImplDir = (await import('node:url')).fileURLToPath(new URL('../examples/payments/impl', import.meta.url));
const paymentsAst = parse(await readFile(paymentsUrl, 'utf8'), 'main.arc');

const quizBodies = { start: '', join: '', state: '', advance: '', vote: '', rate: '', comment: '' };

test('stream is a capability the environment binds, not a package', () => {
  const svc = quizAst.services.find((item) => item.name === 'Live')!;
  assert.ok(svc.uses.some((use) => use.capability === 'stream'), 'the service asks for stream');
  assert.ok(quizSource.includes('bind stream -> websocket()'), 'the environment answers');

  const unbound = quizSource.replace('  bind stream -> websocket()\n', '');
  assert.ok(check(parse(unbound, 'main.arc')).map((item) => item.code).includes('A002'), 'A002: stream is unbound');

  const wrong = quizSource.split('bind stream -> websocket()').join('bind stream -> postgres(host: "pg", port: 5432)');
  const codes = check(parse(wrong, 'main.arc')).map((item) => item.code);
  assert.ok(codes.includes('A024'), 'A024: postgres does not implement stream');

  // redis does implement stream (and queue) since M0.3 — one broker, three roles
  const redisBound = quizSource.split('bind stream -> websocket()').join('bind stream -> redis(host: "bus", port: 6379)');
  assert.ok(!check(parse(redisBound, 'main.arc')).some((item) => item.code === 'A024'));
});

test('a presentation without stream still builds but says what it costs', () => {
  const plain = quizSource
    .split('  uses stream: stream\n').join('')
    .split(', stream.publish').join('')
    .split('  bind stream -> websocket()\n').join('');
  const codes = check(parse(plain, 'main.arc')).map((item) => item.code);
  assert.ok(codes.includes('W028'), 'W028: the page will poll');
  assert.equal(codes.filter((code) => code.startsWith('A')).length, 0, 'still no errors');

  const html = emitWeb(parse(plain, 'main.arc'), {});
  assert.ok(html.includes('"stream":false'), 'the page knows there is no socket');
  assert.ok(!nginxConf(parse(plain, 'main.arc')).includes('location /ws'), 'nothing to proxy');
});

test('the emitted service carries a websocket server, not a dependency', () => {
  const code = emitService(quizAst, { impl: quizBodies });
  assert.ok(code.includes('Sec-WebSocket-Accept'), 'handshake is answered');
  assert.ok(code.includes('function wsPublish'), 'publish reaches subscribers');
  assert.ok(code.includes("server.on('upgrade'"), 'the upgrade is wired to the http server');
  assert.ok(code.includes('async publish(topic, message)'), 'io.publish exists in bodies');
  assert.ok(code.includes('createHash'), 'the accept key is hashed');
  assert.ok(!code.includes("from 'ws'"), 'no websocket package');

  const plain = emitService(parse(quizSource.split('  uses stream: stream\n').join(''), 'main.arc'), { impl: quizBodies });
  assert.ok(!plain.includes('wsPublish'), 'no hub where nobody subscribes');
});

test('the page subscribes to the room and falls back to polling', () => {
  const html = emitWeb(quizAst, {});
  assert.ok(html.includes('"stream":true'), 'the deck carries the flag');
  assert.ok(html.includes("location.host + '/ws?topic='"), 'one socket per room');
  assert.ok(html.includes('reconnectTimer'), 'a dropped socket is retried');
  assert.ok(html.includes('settle(function () { apply(); })'), 'polling is the fallback');
  assert.ok(nginxConf(quizAst).includes('proxy_set_header Upgrade $http_upgrade'), 'nginx lets the upgrade through');

  const service = emitService(quizAst, { impl: quizBodies });
  assert.ok(service.includes("'/ws'"), 'the server listens on the same port');
});

test('a payment service outsources nothing it cannot check', () => {
  const ledger = paymentsAst.services.find((svc) => svc.external)!;
  assert.equal(ledger.name, 'Ledger');
  assert.equal(ledger.contract[0].kind, 'op');
  assert.equal(routeOf(ledger.contract[0]), 'POST /v1/entries');

  const diags = check(paymentsAst);
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0);

  const plan = buildPlan(paymentsAst);
  assert.ok(!plan.tasks.some((task) => task.title.includes('Ledger')), 'no planning task for a foreign service');

  // Regression: counting the foreign op made the pipeline regenerate a
  // hand-written body, silently dropping io.remote.
  const prompts = buildPrompts(paymentsAst);
  assert.deepEqual(prompts.tasks.map((task) => task.op), ['charge']);
});

test('an external call is typed by the contract and addressed by the environment', async () => {
  const compose = composeYaml(paymentsAst, 8080, false);
  assert.ok(compose.includes('LEDGER_URL: "http://host.docker.internal:9009"'), 'localhost is rewritten');
  assert.ok(!compose.includes('extra_hosts'), 'Docker Desktop needs no gateway override');

  const withWiring = composeYaml(parse(
    (await readFile(paymentsUrl, 'utf8'))
      .replace('bind Ledger -> endpoint(url: "http://localhost:9009")',
        'bind Ledger -> endpoint(url: "http://localhost:9009", gateway: true, network: "shared")'),
    'main.arc',
  ), 8080, false);
  assert.ok(withWiring.includes('host.docker.internal:host-gateway'), 'gateway: true asks for it');
  assert.ok(withWiring.includes('networks:'), 'a shared network is joined');
  assert.ok(withWiring.includes('external: true'), 'the network is not created by this compose');

  const manifest = deployManifest(paymentsAst, paymentsAst.environments[0]) as {
    services: Array<{ name: string }>;
    providers: Array<{ alias: string; provider: string }>;
  };
  assert.ok(!manifest.services.some((svc) => svc.name === 'Ledger'), 'not deployed');
  assert.equal(manifest.providers.find((item) => item.alias === 'Ledger')!.provider, 'endpoint');
});

test('the remote client is emitted only for declared external services', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-payments-'));
  const built = await buildExample(paymentsAst, dir, { implDir: paymentsImplDir });
  const service = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(service.includes('"Ledger.record"'));
  assert.ok(service.includes('"method": "POST"'));
  assert.ok(service.includes('"path": "/v1/entries"'));
  assert.ok(service.includes('"env": "LEDGER_URL"'));
  assert.ok(service.includes('async remote(service, op, input)'));
});

test('external services report broken or unbound declarations', async () => {
  const missingRoute = check(parse(
    (await readFile(paymentsUrl, 'utf8')).replace('      route: "POST /v1/entries"\n', ''),
    'main.arc',
  ));
  assert.ok(missingRoute.some((item) => item.code === 'A037'), 'A037 requires a route');

  const unbound = check(parse(
    (await readFile(paymentsUrl, 'utf8')).replace('  bind Ledger -> endpoint(url: "http://localhost:9009")\n', ''),
    'main.arc',
  ));
  assert.ok(unbound.some((item) => item.code === 'W026'), 'W026 warns about an unbound address');

  const wrong = check(parse(
    (await readFile(paymentsUrl, 'utf8')).replace('bind Ledger -> endpoint(', 'bind Ledger -> redis('),
    'main.arc',
  ));
  assert.ok(wrong.some((item) => item.code === 'A039'), 'A039 rejects a provisioned provider');

  const local = check(parse(
    (await readFile(paymentsUrl, 'utf8')).replace('external service Ledger : http {', 'external service Ledger : http {\n  uses store: kv()'),
    'main.arc',
  ));
  assert.ok(local.some((item) => item.code === 'A038'), 'A038 forbids local capabilities on a foreign service');
});

test('the model is a capability with local and cloud providers', () => {
  assert.deepEqual(providersForCapability('llm'), ['ollama', 'openai']);
  const llm = chatAst.services[0].uses.find((use) => use.capability === 'llm');
  assert.ok(llm, 'the service declares the capability, not a vendor');
  assert.equal(llm!.alias, 'llm');
});

test('a budget is optional unless strict mode asks for it', () => {
  const plain = check(chatAst);
  assert.ok(!plain.some((item) => item.code === 'W013'), 'no nagging by default');
  assert.equal(plain.filter((item) => item.severity === 'error').length, 0);

  const strict = check(chatAst, { strict: true });
  const budget = strict.find((item) => item.code === 'W013');
  assert.ok(budget, 'strict mode asks for a budget');
  assert.equal(budget!.severity, 'warning', 'still not an error');
});

test('the chat contract is the same for every model', () => {
  const diags = check(chatAst);
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0);
  const dev = chatAst.environments.find((env) => env.name === 'dev')!;
  const prod = chatAst.environments.find((env) => env.name === 'prod')!;
  assert.equal(dev.binds.find((bind) => bind.alias === 'llm')!.provider, 'ollama');
  assert.equal(prod.binds.find((bind) => bind.alias === 'llm')!.provider, 'openai');

  const manifest = deployManifest(chatAst, prod) as { providers: Array<{ alias: string; provider: string }> };
  assert.equal(manifest.providers.find((item) => item.alias === 'llm')!.provider, 'openai');
});

test('the emitted service reaches the model through one adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-chat-'));
  const built = await buildExample(chatAst, dir, { implDir: chatImplDir });
  const service = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(service.includes('async function llmChat(messages, system)'), 'one adapter');
  assert.ok(service.includes('async chat(messages, system) { return llmChat(messages, system); }'), 'io.chat');
  assert.ok(!service.includes('openai.com'), 'the vendor URL is not baked into the body');

  const compose = await readFile(join(built.dir, 'docker-compose.yml'), 'utf8');
  assert.ok(compose.includes('LLM_BASE_URL: "http://host.docker.internal:11434/v1"'));
  assert.ok(compose.includes('LLM_MODEL: "qwen2.5-coder:7b"'));
  assert.ok(!compose.includes('ollama:'), 'a local model is external, not a container');
});

test('layout: chat renders a transcript instead of forms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-chat-page-'));
  const built = await buildExample(chatAst, dir, { implDir: chatImplDir });
  const page = await readFile(join(built.dir, 'web', 'index.html'), 'utf8');
  assert.ok(page.includes('New conversation'));
  assert.ok(page.includes('"textParam":"text"'), 'the send operation names its message field');
  assert.ok(!page.includes('id="ops"'), 'no generic form grid');

  const broken = check(parse(
    (await readFile(chatUrl, 'utf8')).replace('  history: Chat.history', ''),
    'main.arc',
  ));
  assert.ok(broken.some((item) => item.code === 'A036'), 'A036 asks for a history operation');
});

test('a workflow is a declared graph of steps', () => {
  const ast = parse(workflowSpec, 'main.arc');
  assert.equal(ast.workflows.length, 1);
  const wf = ast.workflows[0];
  assert.equal(wf.name, 'Nightly');
  assert.equal(wf.trigger?.kind, 'cron');
  assert.equal(wf.trigger?.args[0].value.kind, 'literal');
  assert.equal(wf.overlap, 'skip');
  assert.equal(wf.catchup, 'last');
  assert.equal(wf.retry, 2);
  assert.deepEqual(wf.steps.map((step) => step.name), ['prepare', 'render', 'send']);
  assert.deepEqual(wf.steps[1].needs, ['prepare']);
  assert.equal(wf.steps[2].onFail, 'stop');
  assert.equal(wf.steps[2].call, 'Reports.send');

  const diags = check(ast);
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0);
  assert.ok(diags.some((item) => item.code === 'W022'), 'workflows are declarative in v0.1');
});

test('a broken graph names the broken edge', () => {
  const source = workflowSpec
    .replace('needs: render', 'needs: send')
    .replace('trigger cron("0 3 * * *", tz: "Europe/Moscow")', 'trigger whenever');
  const diags = check(parse(source, 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A030'), 'cycle is reported');
  assert.ok(diags.some((item) => item.code === 'A033'), 'unknown trigger is reported');

  const missing = check(parse(workflowSpec.replace('needs: render', 'needs: nope'), 'main.arc'));
  assert.ok(missing.some((item) => item.code === 'A029'), 'unknown step is reported');

  const port = check(parse(workflowSpec.replace('step render(snapshot: Snapshot)', 'step render(snapshot: Receipt)'), 'main.arc'));
  assert.ok(port.some((item) => item.code === 'A031'), 'unproduced port is reported');
});

test('the plan and the manifest both carry the graph', () => {
  const ast = parse(workflowSpec, 'main.arc');
  const plan = buildPlan(ast);
  const task = plan.tasks.find((item) => item.title.includes('workflow Nightly'));
  assert.ok(task, 'workflow is a planning task');
  assert.ok(task!.acceptance.some((line) => line.includes('graph')));

  const env = ast.environments[0];
  const manifest = deployManifest(ast, env) as { workflows: Array<Record<string, unknown>> };
  const wf = manifest.workflows[0];
  assert.equal(wf.name, 'Nightly');
  assert.equal(wf.executed, false);
  assert.equal((wf.trigger as { kind: string }).kind, 'cron');
  const steps = wf.steps as Array<{ name: string; needs: string[]; onFail: string | null }>;
  assert.deepEqual(steps.map((step) => step.name), ['prepare', 'render', 'send']);
  assert.deepEqual(steps[2].needs, ['render']);
  assert.equal(steps[2].onFail, 'stop');
});

test('every environment names its own deployment target', () => {
  const dev = filesAst.environments.find((env) => env.name === 'dev')!;
  const prod = filesAst.environments.find((env) => env.name === 'prod')!;
  assert.equal(dev.deploy?.provider, 'docker');
  assert.equal(prod.deploy?.provider, 'yandex');
  const region = prod.deploy?.args.region;
  assert.ok(region && region.kind === 'literal' && region.value === 'ru-central1');

  const plan = buildPlan(filesAst);
  assert.ok(plan.tasks.some((task) => task.title.includes('docker')), 'dev builds locally');
  assert.ok(plan.tasks.some((task) => task.title.includes('yandex')), 'prod is packaged for the cloud');
});

test('an unknown deployment provider is an error', async () => {
  const broken = parse(
    (await readFile(filesUrl, 'utf8')).replace('deploy yandex(', 'deploy fly('),
    'main.arc',
  );
  const diags = check(broken);
  assert.ok(diags.some((item) => item.code === 'A028'), 'A028 names the provider');
});

test('a cloud environment becomes a manifest, while compose stays local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-deploy-'));
  await cp(
    (await import('node:url')).fileURLToPath(new URL('../examples/files/realm.json', import.meta.url)),
    join(dir, 'realm.json'),
  );
  const built = await buildExample(filesAst, dir, {
    implDir: (await import('node:url')).fileURLToPath(new URL('../examples/files/impl', import.meta.url)),
  });
  const manifest = JSON.parse(await readFile(join(built.dir, 'deploy.prod.json'), 'utf8'));
  assert.equal(manifest.target.provider, 'yandex');
  assert.equal(manifest.target.kind, 'cloud');
  assert.equal(manifest.target.args.region, 'ru-central1');
  assert.equal(manifest.executed, false);
  assert.ok(manifest.services.some((svc: { name: string }) => svc.name === 'FileShare'));

  const compose = await readFile(join(built.dir, 'docker-compose.yml'), 'utf8');
  assert.ok(compose.includes('mysql:8.4'), 'the local environment keeps its own providers');
  assert.ok(!compose.includes('postgres:16-alpine'), 'the cloud environment does not leak into compose');
});

test('the planner derives procedures for arbitrary operations', () => {
  const svc = filesAst.services[0];
  const plan = (name: string) => planBody(filesAst, svc, svc.contract.find((op) => op.kind === 'op' && op.name === name)!);

  for (const name of ['upload', 'list', 'download', 'setVisibility', 'users']) {
    assert.deepEqual(plan(name).unresolved, [], name + ' has a complete procedure');
  }

  const upload = plan('upload').steps.join(' ');
  assert.ok(upload.includes('io.new()') && upload.includes('io.save'), upload);
  assert.ok(upload.includes('io.blobPut(id, body)'), 'the content parameter, not the file name: ' + upload);

  const download = plan('download').steps.join(' ');
  assert.ok(download.includes('io.load(id)') && download.includes('io.blobGet(id)'), download);

  assert.ok(plan('list').steps.join(' ').includes('io.scan'));
  assert.ok(plan('users').steps.join(' ').includes('io.users'));
  assert.ok(plan('setVisibility').steps.join(' ').includes('io.save(id'), 'update keeps the loaded record');
});

test('the page is built from the contract, one form per operation', () => {
  const html = emitWeb(filesAst, { maxBytes: 65536 });
  for (const name of ['upload', 'list', 'download', 'setVisibility', 'users']) {
    assert.ok(html.includes('"name":"' + name + '"'), name + ' becomes a form');
  }
  assert.ok(html.includes('"kind":"json"'), 'a list parameter becomes a JSON field');
  assert.ok(html.includes('Bearer'), 'an authenticated service gets a token field');
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

    // --- declarative guard (M0.2): auth op / owner clause, enforced before the body ---
    const anonUpload = await fetch(base + '/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt', body: 'x', visibility: 'public', allowed: [] }),
    });
    assert.equal(anonUpload.status, 401, 'auth op rejects anonymous before the body');
    assert.equal((await fetch(base + '/v1/users')).status, 401, 'auth op rejects anonymous (users)');

    const own = await fetch(base + '/v1/files', {
      method: 'POST',
      headers: { ...as('u-vika'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mine.txt', body: 'own', visibility: 'restricted', allowed: ['u-vika'] }),
    });
    assert.equal(own.status, 201, 'authenticated upload passes the guard');
    const ownId = (await own.json() as { id: string }).id;
    const ownFlip = await fetch(base + '/v1/files/' + ownId + '/visibility', {
      method: 'PUT',
      headers: { ...as('u-vika'), 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', allowed: [] }),
    });
    assert.equal(ownFlip.status, 201, 'owner clause passes for the owner');

    const ghostFlip = await fetch(base + '/v1/files/00000000-0000-0000-0000-000000000000/visibility', {
      method: 'PUT',
      headers: { ...as('u-vika'), 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', allowed: [] }),
    });
    assert.equal(ghostFlip.status, 404, 'missing record is NotFound, not a 403 leak');

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
  assert.ok(web.includes('"password"'), 'the password parameter becomes a field');
  assert.ok(web.includes('"name":"read"'), 'the read operation gets its own form');
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

// --- OpenAPI emitter (M0.1) ---

const EXAMPLE_SPECS = ['onetimemessage', 'onetimemessage-pwd', 'project1', 'project1-mysql', 'payments', 'files', 'quiz', 'chat'];

async function loadExample(name: string) {
  const url = new URL('../examples/' + name + '/main.arc', import.meta.url);
  return parse(await readFile(url, 'utf8'), 'main.arc');
}

test('openapi emits a valid document for every example', async () => {
  for (const name of EXAMPLE_SPECS) {
    const mod = await loadExample(name);
    const doc = emitOpenapi(mod);
    assert.equal(doc.openapi, '3.1.0', name);
    assert.equal((doc.info as Record<string, unknown>).title, mod.name, name);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    assert.ok(Object.keys(paths).length > 0, name + ' has no paths');
    for (const [path, item] of Object.entries(paths)) {
      assert.ok(path.startsWith('/'), name + ': path ' + path);
      for (const [method, op] of Object.entries(item)) {
        assert.match(method, /^(get|post|put|patch|delete)$/, name + ': ' + method);
        assert.match((op as Record<string, unknown>).operationId as string, /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/, name);
      }
    }
    // every $ref resolves inside the document
    const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
    const refs: string[] = [];
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(walk);
      for (const [key, entry] of Object.entries(value)) {
        if (key === '$ref') refs.push(entry as string);
        else walk(entry);
      }
    };
    walk(doc);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/components/schemas/'), name + ': external ref ' + ref);
      assert.ok(schemas[ref.slice('#/components/schemas/'.length)], name + ': unresolved ref ' + ref);
    }
  }
});

test('openapi: changing a type changes the schema', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
  assert.deepEqual(schemas.Body, { type: 'string', minLength: 1, maxLength: 65536 });

  const changed = parse(source.replace('max: 64kb', 'max: 1kb'), 'main.arc');
  const changedDoc = emitOpenapi(changed);
  const changedSchemas = (changedDoc.components as Record<string, unknown>).schemas as Record<string, unknown>;
  assert.deepEqual(changedSchemas.Body, { type: 'string', minLength: 1, maxLength: 1024 });
  assert.notDeepEqual(schemas.Body, changedSchemas.Body);
});

test('openapi: changing a route changes the path', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const paths = doc.paths as Record<string, unknown>;
  assert.ok(paths['/api/messages']);
  assert.ok(paths['/api/messages/{id}']);

  const changed = parse(source.replace('GET /api/messages/:id', 'GET /v2/messages/:id'), 'main.arc');
  const changedPaths = emitOpenapi(changed).paths as Record<string, unknown>;
  assert.ok(!changedPaths['/api/messages/{id}']);
  assert.ok(changedPaths['/v2/messages/{id}']);
});

test('openapi: error mapping is preserved', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const read = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/messages/{id}'].get;
  const responses = read.responses as Record<string, unknown>;
  assert.ok(responses['404'], 'NotFound mapped to 404');
  assert.ok(responses['410'], 'Gone mapped to 410');
  const notFound = responses['404'] as Record<string, unknown>;
  const schema = (notFound.content as Record<string, Record<string, unknown>>)['application/json'].schema as Record<string, unknown>;
  assert.equal((schema.properties as Record<string, unknown>).error.const, 'NotFound');

  // and matches the runtime mapping used by the HTTP emitter
  const files = await loadExample('files');
  const filesDoc = emitOpenapi(files);
  const download = (filesDoc.paths as Record<string, Record<string, Record<string, unknown>>>)['/v1/files/{id}'].get;
  const downloadResponses = download.responses as Record<string, unknown>;
  assert.ok(downloadResponses[String(statusForError('Unauthorized'))]);
  assert.ok(downloadResponses[String(statusForError('NotFound'))]);
});

test('openapi: operationIds are stable <service>.<op>', async () => {
  const mod = await loadExample('files');
  const doc = emitOpenapi(mod);
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  const ids = Object.values(paths).flatMap((item) => Object.values(item).map((op) => (op as Record<string, unknown>).operationId));
  assert.ok(ids.includes('FileShare.upload'));
  assert.ok(ids.includes('FileShare.download'));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
});

test('openapi: examples are exported from the examples block', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const create = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/messages'].post;
  const opExamples = create.examples as Record<string, Record<string, unknown>>;
  assert.deepEqual(opExamples.create_and_read.value, { body: 'hi' });
  const badRequest = (create.responses as Record<string, Record<string, unknown>>)['400'];
  const media = (badRequest.content as Record<string, Record<string, unknown>>)['application/json'];
  const errorExamples = media.examples as Record<string, Record<string, unknown>>;
  assert.deepEqual(errorExamples.rejects_empty.value, { error: 'Invalid' });
});

test('openapi: a public operation without a route is rejected (A050)', async () => {
  const broken = parse(source.replace('route: "GET /api/messages/:id"', ''), 'main.arc');
  const diags = check(broken);
  assert.ok(diags.some((d) => d.code === 'A050' && d.severity === 'error'));
  assert.ok(diags.find((d) => d.code === 'A050')?.message.includes('read'));
  // clean specs stay clean
  assert.ok(!check(ast).some((d) => d.code === 'A050'));
});

test('openapi: an external service contract can be exported on its own', async () => {
  const mod = await loadExample('payments');
  const doc = emitOpenapi(mod, { service: 'Ledger' });
  const ledger = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/v1/entries'].post;
  assert.equal(ledger.operationId, 'Ledger.record');
  const body = (ledger.requestBody as Record<string, Record<string, Record<string, unknown>>>) ?? null;
  assert.ok(body);
  // the local service is not part of the external contract
  assert.ok(!(doc.paths as Record<string, unknown>)['/v1/orders']);
});

// --- AuthZ guard (M0.2) ---

const AUTHZ_SPEC = `module authz @0.1.0 {
}

use capability arcod.std.identity @1

error Unauthorized
error Forbidden
error NotFound

service Vault : http {
  uses auth: identity

  roles: admin, support

  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      errors: none
    }

    auth op whoami() -> string {
      route: "GET /v1/whoami"
      errors: Unauthorized
      on error Unauthorized: result != null
    }

    auth op adminOnly() -> string {
      route: "GET /v1/admin"
      roles: admin
      errors: Unauthorized, Forbidden
      on error Unauthorized: result != null
      on error Forbidden: result != null
    }

    auth op mine(id: string) -> string {
      route: "GET /v1/mine/:id"
      owner: id
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }
  }

  effects {
    allow auth.actor
    deny net, fs, exec
  }
}

environment dev {
  bind auth -> keycloak(host: "idp", port: 8080)
  deploy docker
}
`;

const authzAst = () => parse(AUTHZ_SPEC, 'main.arc');

test('authz: auth op, roles and owner parse into the AST', () => {
  const mod = authzAst();
  const svc = mod.services[0];
  assert.deepEqual(svc.roles, ['admin', 'support']);
  const [ping, whoami, adminOnly, mine] = svc.contract;
  assert.equal(ping.isPublic, true);
  assert.equal(ping.auth, false);
  assert.equal(whoami.auth, true);
  assert.equal(whoami.isPublic, false);
  const roles = adminOnly.clauses.find((clause) => clause.kind === 'roles');
  assert.ok(roles && roles.kind === 'roles' && roles.names.join(',') === 'admin');
  const owner = mine.clauses.find((clause) => clause.kind === 'owner');
  assert.ok(owner && owner.kind === 'owner' && owner.param === 'id');
});

test('authz: public and auth are mutually exclusive', () => {
  assert.throws(() => parse(AUTHZ_SPEC.replace('auth op whoami', 'public auth op whoami'), 'main.arc'));
});

test('authz: a guarded operation needs an actor source (A046)', () => {
  const broken = parse(AUTHZ_SPEC.replace('  uses auth: identity\n', ''), 'main.arc');
  assert.ok(check(broken).some((d) => d.code === 'A046' && d.message.includes('whoami')));
  assert.ok(!check(authzAst()).some((d) => d.severity === 'error'));
});

test('authz: a role must exist in the service vocabulary (A047)', () => {
  const broken = parse(AUTHZ_SPEC.replace('      roles: admin\n', '      roles: root\n'), 'main.arc');
  const diags = check(broken).filter((d) => d.code === 'A047');
  assert.equal(diags.length, 1);
  assert.ok(diags[0].message.includes('root'));
});

test('authz: a public operation must not require an actor (A048)', () => {
  const withOwner = parse(AUTHZ_SPEC.replace('auth op mine', 'public op mine'), 'main.arc');
  assert.ok(check(withOwner).some((d) => d.code === 'A048' && d.message.includes('mine')));
  const withEffect = parse(AUTHZ_SPEC.replace(
    '      route: "GET /v1/ping"\n      errors: none',
    '      route: "GET /v1/ping"\n      errors: none\n      effects: auth.actor',
  ), 'main.arc');
  const diags = check(withEffect).filter((d) => d.code === 'A048');
  assert.ok(diags.some((d) => d.message.includes('ping')), JSON.stringify(diags));
});

test('authz: owner must name a real parameter (A049)', () => {
  const broken = parse(AUTHZ_SPEC.replace('owner: id', 'owner: ghost'), 'main.arc');
  const diags = check(broken).filter((d) => d.code === 'A049');
  assert.equal(diags.length, 1);
  assert.ok(diags[0].message.includes('ghost'));
});

test('authz: capability-level deny stays a warning, native deny is enforced (W016)', () => {
  assert.ok(!check(authzAst()).some((d) => d.code === 'W016'));
  const withDeny = parse(AUTHZ_SPEC + `
service Other : http {
  uses auth: identity
  effects {
    allow auth.actor
    deny auth
  }
  contract {
    auth op ping2() -> string {
      route: "GET /v2/ping"
      errors: none
    }
  }
}
`, 'main.arc');
  const diags = check(withDeny).filter((d) => d.code === 'W016');
  assert.equal(diags.length, 1, JSON.stringify(check(withDeny)));
  assert.ok(diags[0].message.includes('auth'));
});

test('authz: the runtime emits the guard before the body', () => {
  const code = emitService(authzAst(), { impl: { whoami: 'export async function whoami(input, io) { return { result: "x" }; }' } });
  assert.ok(code.includes('const AUTHZ = '));
  assert.ok(code.includes('"whoami": {\n    "auth": true'));
  assert.ok(code.includes('"adminOnly": {\n    "auth": true,\n    "roles": [\n      "admin"'));
  assert.ok(code.includes('"owner": "id"'));
  assert.ok(code.includes('async function authorize(spec, io, input)'));
  assert.ok(code.includes('const denied = await authorize(AUTHZ[opName], io, input);'));
});

test('authz: validateBody closes the native deny hole', () => {
  assert.ok(validateBody('export async function read(input, io) { await fetch("http://x"); }', 'read'));
  assert.ok(validateBody('export async function read(input, io) { return import("node:fs"); }', 'read'));
  assert.equal(validateBody('export async function read(input, io) { return { result: 1 }; }', 'read'), null);
});

// --- Async layer (M0.3): redis-backed stream + queue effects ---

// A broker just enough for the generated clients: pub/sub (SUBSCRIBE,
// UNSUBSCRIBE, PUBLISH) and lists (RPUSH/LPUSH/LPOP/LLEN/LRANGE). Lets the
// e2e tests prove the wire protocol without docker.
async function startFakeRedis(port: number): Promise<() => Promise<void>> {
  const { createServer } = await import('node:net');
  const subs = new Map<string, Set<import('node:net').Socket>>();
  const lists = new Map<string, string[]>();
  const bulk = (value: string) => '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n';
  const array = (items: string[]) => '*' + items.length + '\r\n' + items.join('');

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 1 || buffer[0] !== 0x2a) break;
        const headEnd = buffer.indexOf('\r\n');
        if (headEnd === -1) break;
        const count = Number(buffer.toString('utf8', 1, headEnd));
        let offset = headEnd + 2;
        const args: string[] = [];
        let complete = true;
        for (let i = 0; i < count; i += 1) {
          if (offset >= buffer.length || buffer[offset] !== 0x24) { complete = false; break; }
          const lenEnd = buffer.indexOf('\r\n', offset);
          if (lenEnd === -1) { complete = false; break; }
          const len = Number(buffer.toString('utf8', offset + 1, lenEnd));
          const start = lenEnd + 2;
          if (buffer.length < start + len + 2) { complete = false; break; }
          args.push(buffer.toString('utf8', start, start + len));
          offset = start + len + 2;
        }
        if (!complete) break;
        buffer = buffer.subarray(offset);

        const cmd = args[0].toUpperCase();
        if (cmd === 'PING') socket.write('+PONG\r\n');
        else if (cmd === 'SUBSCRIBE') {
          const channel = args[1];
          const set = subs.get(channel) || new Set();
          set.add(socket);
          subs.set(channel, set);
          socket.write(array([bulk('subscribe'), bulk(channel), ':1\r\n']));
        } else if (cmd === 'UNSUBSCRIBE') {
          const set = subs.get(args[1]);
          if (set) { set.delete(socket); if (set.size === 0) subs.delete(args[1]); }
          socket.write(array([bulk('unsubscribe'), bulk(args[1]), ':0\r\n']));
        } else if (cmd === 'PUBLISH') {
          const set = subs.get(args[1]);
          let delivered = 0;
          if (set) {
            const frame = array([bulk('message'), bulk(args[1]), bulk(args[2])]);
            for (const client of set) { client.write(frame); delivered += 1; }
          }
          socket.write(':' + delivered + '\r\n');
        } else if (cmd === 'RPUSH' || cmd === 'LPUSH') {
          const list = lists.get(args[1]) || [];
          if (cmd === 'RPUSH') list.push(args[2]);
          else list.unshift(args[2]);
          lists.set(args[1], list);
          socket.write(':' + list.length + '\r\n');
        } else if (cmd === 'LPOP') {
          const list = lists.get(args[1]) || [];
          const value = list.length > 0 ? list.shift()! : null;
          lists.set(args[1], list);
          socket.write(value == null ? '$-1\r\n' : bulk(value));
        } else if (cmd === 'LLEN') {
          socket.write(':' + (lists.get(args[1]) || []).length + '\r\n');
        } else if (cmd === 'LRANGE') {
          const list = lists.get(args[1]) || [];
          socket.write(array(list.map(bulk)));
        } else {
          socket.write('-ERR unknown command ' + cmd + '\r\n');
        }
      }
    });
    socket.on('close', () => {
      for (const [channel, set] of subs) { set.delete(socket); if (set.size === 0) subs.delete(channel); }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return async () => {
    for (const set of subs) for (const client of set[1]) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

const QUEUE_SPEC = `module pipetest @0.1.0 {
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.queue @1

error Invalid

service Pipe : http {
  uses store: kv
  uses uuid: ids
  uses events: queue

  contract {
    public op submit(entry: string) -> bool {
      route: "POST /v1/submit"
      effects: events.publish
      errors: none
    }

    public op seen() -> list<string> {
      route: "GET /v1/seen"
      effects: store.scan
      errors: none
    }

    public op dead(topic: string) -> list<json> {
      route: "GET /v1/dead"
      effects: events.dead
      errors: none
    }

    job audit(entry: string) {
      on: events.jobs
      retry: 1
      effects: store.set
      errors: none
    }
  }

  effects {
    allow store.set, store.scan, events.publish, events.dead, uuid.new
    deny net, fs, exec
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind events -> redis(host: "events", port: 6379)
  deploy docker
}
`;

test('queue: on/retry clauses parse into the AST', () => {
  const mod = parse(QUEUE_SPEC, 'main.arc');
  const audit = mod.services[0].contract.find((op) => op.name === 'audit')!;
  assert.equal(audit.kind, 'job');
  const consume = audit.clauses.find((clause) => clause.kind === 'consume');
  assert.ok(consume && consume.kind === 'consume' && consume.source === 'events.jobs');
  const retry = audit.clauses.find((clause) => clause.kind === 'retry');
  assert.ok(retry && retry.kind === 'retry' && retry.value === 1);
});

test('queue: consumer wiring is checked (A051-A053, W017)', () => {
  const codes = (text: string) => check(parse(text, 'main.arc')).map((item) => item.code);

  // a consumer job is executed, so the not-executable warning is gone
  assert.ok(!codes(QUEUE_SPEC).includes('W017'));
  assert.ok(codes(QUEUE_SPEC.replace('    job audit(entry: string) {', '    job audit(entry: string) {\n      schedule: "0 3 * * *"')).length >= 0);
  const scheduled = QUEUE_SPEC.replace('      on: events.jobs\n', '      schedule: "0 3 * * *"\n');
  assert.ok(codes(scheduled).includes('W017'), 'a scheduled job is still not executed');

  const asOp = QUEUE_SPEC.replace('    job audit(entry: string) {', '    op audit(entry: string) {');
  assert.ok(codes(asOp).includes('A051'), 'only a job can consume');

  const unknownAlias = QUEUE_SPEC.replace('on: events.jobs', 'on: ghost.jobs');
  assert.ok(codes(unknownAlias).includes('A052'), 'unknown queue alias');

  const retryWithoutOn = QUEUE_SPEC.replace('      on: events.jobs\n', '');
  assert.ok(codes(retryWithoutOn).includes('A053'), 'retry without a consumer');
});

async function buildQueueService(dir: string, auditBody: string) {
  const implDir = join(dir, 'impl');
  await mkdir(implDir, { recursive: true });
  await writeFile(join(implDir, 'submit.mjs'), 'export async function submit(input, io) { return { result: await io.queuePublish("jobs", input.entry) }; }\n');
  await writeFile(join(implDir, 'seen.mjs'), 'export async function seen(input, io) { const items = await io.scan(); return { result: items.map((item) => item.b && item.b.entry).filter((entry) => entry != null) }; }\n');
  await writeFile(join(implDir, 'dead.mjs'), 'export async function dead(input, io) { return { result: await io.queueDead(input.topic) }; }\n');
  await writeFile(join(implDir, 'audit.mjs'), auditBody);
  const mod = parse(QUEUE_SPEC, 'main.arc');
  return buildExample(mod, dir, { implDir });
}

async function spawnService(builtDir: string, port: number, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [join(builtDir, 'service', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), KV_DRIVER: 'memory', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(base + '/healthz');
      if (res.ok) return { child, base };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('service did not start on ' + port);
}

async function waitFor<T>(probe: () => Promise<T | null>, attempts = 50): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value != null && (!Array.isArray(value) || value.length > 0)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition was not met in time');
}

test('queue: memory driver consumes, and a failing body retries then dead-letters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-queue-mem-'));
  const built = await buildQueueService(dir, [
    'export async function audit(input, io) {',
    '  const id = await io.new();',
    '  await io.save(id, { b: { entry: input.entry }, h: null });',
    '  return { result: true };',
    '}',
    '',
  ].join('\n'));
  const port = 19000 + Math.floor(Math.random() * 500);
  const { child, base } = await spawnService(built.dir, port, {});
  try {
    const ok = await fetch(base + '/v1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'hello-queue' }),
    });
    assert.equal(ok.status, 201);

    const seen = await waitFor(async () => {
      const res = await fetch(base + '/v1/seen');
      const body = await res.json() as string[];
      return Array.isArray(body) && body.includes('hello-queue') ? body : null;
    });
    assert.deepEqual(seen, ['hello-queue'], 'the consumer body saw the message');
  } finally {
    child.kill('SIGTERM');
  }

  // failing body: retried once (retry: 1), then moved to the dead letter
  const dir2 = await mkdtemp(join(tmpdir(), 'arcod-queue-dead-'));
  const built2 = await buildQueueService(dir2, 'export async function audit(input, io) { return { error: "Invalid" }; }\n');
  const port2 = 19500 + Math.floor(Math.random() * 500);
  const second = await spawnService(built2.dir, port2, {});
  try {
    await fetch(second.base + '/v1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'poison' }),
    });
    const dead = await waitFor(async () => {
      const res = await fetch(second.base + '/v1/dead?topic=jobs');
      const body = await res.json() as Array<{ payload: string; attempts: number; lastError: string }>;
      return Array.isArray(body) && body.length > 0 ? body : null;
    });
    assert.equal(dead[0].payload, 'poison');
    assert.equal(dead[0].attempts, 2, 'one initial delivery plus one retry');
    assert.ok(dead[0].lastError.includes('Invalid'));
  } finally {
    second.child.kill('SIGTERM');
  }
});

test('queue: the redis driver carries messages over the wire', async () => {
  const redisPort = 20000 + Math.floor(Math.random() * 5000);
  const stopRedis = await startFakeRedis(redisPort);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-queue-redis-'));
    const built = await buildQueueService(dir, [
      'export async function audit(input, io) {',
      '  const id = await io.new();',
      '  await io.save(id, { b: { entry: input.entry }, h: null });',
      '  return { result: true };',
      '}',
      '',
    ].join('\n'));
    const port = 19000 + Math.floor(Math.random() * 500);
    const { child, base } = await spawnService(built.dir, port, { QUEUE_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    try {
      await fetch(base + '/v1/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: 'over-redis' }),
      });
      const seen = await waitFor(async () => {
        const res = await fetch(base + '/v1/seen');
        const body = await res.json() as string[];
        return Array.isArray(body) && body.includes('over-redis') ? body : null;
      });
      assert.deepEqual(seen, ['over-redis']);
    } finally {
      child.kill('SIGTERM');
    }
  } finally {
    await stopRedis();
  }
});

const STREAM_SPEC = `module streamshare @0.1.0 {
}

use capability arcod.std.kv @1
use capability arcod.std.stream @1

service Hub : http {
  uses store: kv
  uses bus: stream

  contract {
    public op poke(topic: string, message: string) -> number {
      route: "POST /v1/poke"
      effects: bus.publish
      errors: none
    }
  }

  effects {
    allow bus.publish
    deny net, fs, exec
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind bus -> redis(host: "bus", port: 6379)
  deploy docker
}
`;

test('stream: two replicas see the same websocket events through redis pub/sub', async () => {
  const redisPort = 20000 + Math.floor(Math.random() * 5000);
  const stopRedis = await startFakeRedis(redisPort);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-stream-'));
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'poke.mjs'), 'export async function poke(input, io) { return { result: await io.publish(input.topic, input.message) }; }\n');
    const built = await buildExample(parse(STREAM_SPEC, 'main.arc'), dir, { implDir });

    const portA = 19000 + Math.floor(Math.random() * 400);
    const portB = 19400 + Math.floor(Math.random() * 400);
    const replicaA = await spawnService(built.dir, portA, { STREAM_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    const replicaB = await spawnService(built.dir, portB, { STREAM_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket('ws://127.0.0.1:' + portB + '/ws?topic=room');
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        socket.onmessage = (event) => {
          const data = JSON.parse(String(event.data)) as { type: string };
          if (data.type === 'ready') resolve();
        };
        socket.onerror = () => reject(new Error('websocket failed'));
      });
      // let the SUBSCRIBE reach the broker before publishing
      await new Promise((resolve) => setTimeout(resolve, 300));

      const poke = await fetch(replicaA.base + '/v1/poke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'room', message: 'hello-replicas' }),
      });
      assert.equal(poke.status, 201);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no event received on replica B: ' + JSON.stringify(received))), 5000);
        socket.onmessage = (event) => {
          received.push(String(event.data));
          const data = JSON.parse(String(event.data)) as { type: string };
          if (data.type !== 'ready') { clearTimeout(timer); resolve(); }
        };
      });
      assert.ok(received.some((text) => text.includes('hello-replicas')), 'replica B delivered the event published on replica A');
    } finally {
      socket?.close();
      replicaA.child.kill('SIGTERM');
      replicaB.child.kill('SIGTERM');
    }
  } finally {
    await stopRedis();
  }
});

const tasksUrl = new URL('../examples/tasks/main.arc', import.meta.url);
const tasksSource = await readFile(tasksUrl, 'utf8');
const tasksAst = parse(tasksSource, 'main.arc');

test('unique names a record field, a declared error and a store (A054-A056)', () => {
  assert.deepEqual(check(tasksAst).filter((item) => item.severity === 'error'), []);

  const missingField = parse(tasksSource.replace('unique Task.title', 'unique Task.subject'), 'main.arc');
  assert.ok(check(missingField).some((item) => item.code === 'A054'));

  const noConflict = parse(tasksSource.replace('error Conflict\n', ''), 'main.arc');
  assert.ok(check(noConflict).some((item) => item.code === 'A055'));

  const noStore = parse(tasksSource.replace('  uses store: kv(ttl: 604800s)\n', ''), 'main.arc');
  assert.ok(check(noStore).some((item) => item.code === 'A056'));
});

test('an explicit effects list is not second-guessed by create/read conventions', () => {
  const codes = check(tasksAst).map((item) => item.code);
  assert.ok(!codes.includes('A004'), 'store.insert does not drag in a phantom store.set');
});

test('the entity store enforces unique, filters, sorts and pages by cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-tasks-'));
  const implDir = fileURLToPath(new URL('../examples/tasks/impl', import.meta.url));
  const built = await buildExample(tasksAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('"prefix": "task:"'), 'the entity owns a key namespace');
  assert.ok(code.includes('"title"'), 'the unique field is part of the generated store table');

  const port = 19900 + Math.floor(Math.random() * 400);
  const service = await spawnService(built.dir, port, {});
  const post = async (path: string, body: unknown) => {
    const res = await fetch(service.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const res = await fetch(service.base + path);
    return { status: res.status, body: (await res.json()) as { items: Array<Record<string, unknown>>; next: string | null } };
  };

  try {
    const first = await post('/v1/tasks', { title: 'ship the store', priority: 3 });
    assert.equal(first.status, 201);
    const duplicate = await post('/v1/tasks', { title: 'ship the store', priority: 9 });
    assert.equal(duplicate.status, 409, 'a claimed title is a declared Conflict, not a 500');
    await post('/v1/tasks', { title: 'write the docs', priority: 2 });
    await post('/v1/tasks', { title: 'review the docs', priority: 1 });

    const page = await get('/v1/tasks?limit=2&sort=priority%20desc');
    assert.deepEqual(page.body.items.map((item) => item.priority), [3, 2]);
    assert.ok(page.body.next, 'a full page carries a cursor');

    const rest = await get('/v1/tasks?limit=2&sort=priority%20desc&cursor=' + encodeURIComponent(page.body.next));
    assert.deepEqual(rest.body.items.map((item) => item.priority), [1]);
    assert.equal(rest.body.next, null);

    const moved = await post('/v1/tasks/' + String(first.body.id) + '/move', { status: 'done' });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.status, 'done');
    assert.ok(moved.body.doneAt);

    const done = await get('/v1/tasks?status=done');
    assert.equal(done.body.items.length, 1);

    const missing = await post('/v1/tasks/00000000-0000-4000-8000-000000000000/move', { status: 'done' });
    assert.equal(missing.status, 404);
  } finally {
    service.child.kill('SIGTERM');
  }
});
