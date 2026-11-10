import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService } from '../src/emit/service.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { runExamples } from '../src/test.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specUrl = new URL('../examples/onetimemessage/main.arc', import.meta.url);
const source = await readFile(specUrl, 'utf8');
const ast = parse(source, 'main.arc');

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
  const built = await buildExample(ast, dir);
  const report = await runExamples(ast, built.dir);
  assert.equal(report.examples.length, 2);
  assert.ok(report.examples.every((item) => item.ok), JSON.stringify(report.examples));
  assert.equal(report.rules.length, 2);
  assert.ok(report.rules.every((item) => item.ok), JSON.stringify(report.rules));
});

test('compose has kv, service and web', () => {
  const yaml = composeYaml(ast, 8080);
  assert.match(yaml, /^name: arcod-onetimemessage/m);
  assert.match(yaml, /redis:7-alpine/);
  assert.match(yaml, /"8080:80"/);
});
