import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { loadRegistry } from '../src/registry.ts';
import { buildExample, implBodiesFor } from '../src/build.ts';
import { runExamples } from '../src/test.ts';
import { main } from '../src/cli.ts';

// examples/ is the project's promise: every file there is a working service.
// Nothing enforced that across the whole directory — a change to the checker
// or an emitter could quietly rot one example while the suites covering the
// others stayed green.

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

async function examples(): Promise<Array<{ name: string; spec: string; source: string }>> {
  const names = (await readdir(examplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const out: Array<{ name: string; spec: string; source: string }> = [];
  for (const name of names) {
    const spec = join(examplesDir, name, 'main.arc');
    const source = await readFile(spec, 'utf8').catch(() => null);
    if (source !== null) out.push({ name, spec, source });
  }
  return out;
}

// A warning a demo carries on purpose, with the item that owns it. This is a
// ratchet: the entry goes away when the item does, and a new warning is red.
// An undocumented W041 (an example calling an op with a parameter missing) and
// the orders W046 both sat green in this suite until they were named here.
const DOCUMENTED_WARNINGS: Record<string, Record<string, string>> = {
  'tasks-sql': { W046: 'prod keeps mysql so the missing managed resource stays visible' },
  nightly: { W022: 'workflows are declarative in v0.1: the graph lands in the deploy manifest, no runner yet' },
};

test('every example parses and checks with no errors and only documented warnings', async () => {
  const list = await examples();
  assert.ok(list.length >= 10, 'the examples directory is populated (found ' + list.length + ')');
  const broken: string[] = [];
  for (const example of list) {
    const dir = join(examplesDir, example.name);
    const mod = parse(example.source, example.name + '/main.arc');
    // Implementation bodies are read: without them W018 would fire on every
    // demo that ships impl/ and the ratchet would mean nothing.
    const diags = check(mod, { registry: loadRegistry(dir), impl: await implBodiesFor(dir) });
    const allowed = DOCUMENTED_WARNINGS[example.name] ?? {};
    for (const item of diags) {
      if (item.severity === 'error') {
        broken.push(example.name + ': error ' + item.code + ' ' + item.message);
      } else if (!allowed[item.code]) {
        broken.push(example.name + ': warning ' + item.code + ' ' + item.message);
      }
    }
  }
  assert.deepEqual(broken, [], 'examples must check clean (documented warnings only)');
});

// docs/examples.md is the index a reader lands on. A demo that is not listed
// there is a demo nobody finds; a list entry with no directory is a lie.
test('docs/examples.md lists every demo and nothing else', async () => {
  const doc = await readFile(join(examplesDir, '..', 'docs', 'examples.md'), 'utf8');
  const list = await examples();
  const missing = list.filter((example) => !doc.includes('examples/' + example.name) && !doc.includes('`' + example.name + '`'));
  assert.deepEqual(missing.map((example) => example.name), [], 'every demo is named in docs/examples.md');
  const named = [...doc.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((match) => match[1]);
  const dirs = new Set(list.map((example) => example.name));
  assert.deepEqual(named.filter((name) => !dirs.has(name)), [], 'every table row names a real demo');
});

test('every example builds in place, with its own inputs', async () => {
  const list = await examples();
  const failed: string[] = [];
  for (const example of list) {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-example-'));
    try {
      // Copy the directory and build inside it: an example may carry inputs
      // beyond main.arc (files/realm.json), and the build resolves those
      // relative to the project, exactly as a user's in-place build would.
      await cp(join(examplesDir, example.name), dir, { recursive: true });
      const mod = parse(example.source, example.name + '/main.arc');
      const built = await buildExample(mod, dir, {});
      const files = await readdir(join(built.dir, 'service'));
      assert.ok(files.includes('index.mjs'), example.name + ' produced a service entry point');
    } catch (error) {
      failed.push(example.name + ': ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failed, [], 'every example compiles');
});

// The examples block is an example's own acceptance test: arcod test builds the
// service and calls it over HTTP. Nothing ran the shipped blocks, so a demo
// could keep examples that no longer pass — and examples/saga declared none at
// all while being the demo of a saga.
test('every shipped example runs the examples it declares', async () => {
  const list = await examples();
  const failed: string[] = [];
  let ran = 0;
  for (const example of list) {
    const mod = parse(example.source, example.name + '/main.arc');
    const declared = mod.services.reduce((total, service) => total + service.examples.length, 0);
    if (declared === 0) continue;
    const dir = await mkdtemp(join(tmpdir(), 'arcod-example-run-'));
    try {
      await cp(join(examplesDir, example.name), dir, { recursive: true });
      const built = await buildExample(mod, dir, {});
      const report = await runExamples(mod, built.dir);
      ran += report.examples.length;
      for (const item of report.examples) {
        if (!item.ok) failed.push(example.name + ': ' + item.example + ' - ' + item.error);
      }
      if (report.examples.length !== declared) {
        failed.push(example.name + ': declared ' + declared + ', ran ' + report.examples.length);
      }
    } catch (error) {
      failed.push(example.name + ': ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failed, [], failed.join('\n'));
  assert.ok(ran >= 15, 'the shipped examples still declare runnable examples: ' + ran);
});

// check() defaults to one environment. A cloud environment is where the new
// k8s/terraform wiring lives, so each of them is checked on its own: an example
// must not only be clean at home.
test('every environment of every example checks without errors', async () => {
  const list = await examples();
  const broken: string[] = [];
  let checked = 0;
  for (const example of list) {
    const mod = parse(example.source, example.name + '/main.arc');
    for (const env of mod.environments) {
      checked += 1;
      const errors = check(mod, { environment: env.name }).filter((item) => item.severity === 'error');
      if (errors.length > 0) {
        broken.push(example.name + ' ' + env.name + ': ' + errors.map((item) => item.code + ' ' + item.message).join('; '));
      }
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'));
  assert.ok(checked >= 20, 'the examples still declare environments: ' + checked);
});

// `arcod check 'examples/**'` is the one command that is supposed to cover the
// whole directory. It expanded to no file at all for a long time, and a green
// exit for zero projects reads exactly like a green exit for sixteen.
test('a ** pattern reaches every shipped example', async () => {
  const out: string[] = [];
  const realLog = console.log;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((item) => String(item)).join(' ')); };
  let code = 0;
  try {
    await main(['check', join(examplesDir, '**')]);
    code = Number(process.exitCode ?? 0);
  } finally {
    console.log = realLog;
    process.exitCode = before;
  }
  const printed = out.join('\n');
  assert.equal(code, 0, printed);
  for (const example of await examples()) {
    assert.match(printed, new RegExp(example.name + '[/\\\\]main\\.arc'), example.name + ' was not checked');
  }
});
