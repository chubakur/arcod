import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, ParseError } from './parser.ts';
import { check } from './check.ts';
import { buildPlan, formatPlan } from './plan.ts';
import { buildExample } from './build.ts';
import { runExamples } from './test.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { ModuleNode } from './ast.ts';
import { buildPrompts, formatPrompts } from './prompts.ts';
import { formatPipeline, runPipeline } from './pipeline.ts';
import { DEFAULT_IMPL, formatImplReport, runImpl } from './impl.ts';
import { PROVIDERS, providerNames } from './providers.ts';
import { deployManifest, deployNames, deployProvider, formatDeploy } from './deploy.ts';

const VERSION = '0.1.0';

interface Loaded {
  mod: ModuleNode;
  specPath: string;
  dir: string;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        return;
      case 'check':
        await runCheck(flags);
        return;
      case 'ast':
        await runAst(flags);
        return;
      case 'plan':
        await runPlan(flags);
        return;
      case 'build':
        await runBuild(flags);
        return;
      case 'test':
        await runTest(flags);
        return;
      case 'run':
        await runRun(flags);
        return;
      case 'providers':
        runProviders(flags);
        return;
      case 'deploy':
        await runDeploy(flags);
        return;
      case 'prompts':
        await runPrompts(flags);
        return;
      case 'impl':
        await runImplCmd(flags);
        return;
      case 'make':
        await runMake(flags);
        return;
      case 'fmt':
        console.error('arcod fmt: not implemented in v0.1 (use the source formatter of your editor)');
        process.exitCode = 2;
        return;
      default:
        console.error('unknown command: ' + command);
        printHelp();
        process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof ParseError) {
      const loc = error.loc;
      console.error(basename(flags.spec ?? 'main.arc') + ':' + loc.line + ':' + loc.col + '  error  parse  ' + error.message);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runCheck(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod, { environment: flags.env });
  if (flags.json) {
    console.log(JSON.stringify(diags, null, 2));
  } else {
    printDiagnostics(diags, loaded.specPath);
  }
  const errors = diags.filter((d) => d.severity === 'error').length;
  process.exitCode = errors > 0 ? 1 : 0;
}

async function runAst(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  if (!flags.json && flags.check) {
    const diags = check(loaded.mod);
    const errors = diags.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      printDiagnostics(errors, loaded.specPath);
      process.exitCode = 1;
      return;
    }
  }
  const { source, ...ast } = loaded.mod;
  console.log(JSON.stringify(ast, null, 2));
}

async function runDeploy(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const env = flags.env
    ? loaded.mod.environments.find((item) => item.name === flags.env)
    : loaded.mod.environments[0];
  if (!env) throw new Error('no environment to deploy' + (flags.env ? ': ' + flags.env : ''));
  if (!env.deploy) {
    console.log(env.name + ': deploy не объявлен (по умолчанию считается docker)');
    console.log('доступные провайдеры: ' + deployNames().join(', '));
    return;
  }
  const spec = deployProvider(env.deploy.provider);
  if (!spec) throw new Error('unknown deploy provider ' + env.deploy.provider + '; available: ' + deployNames().join(', '));

  if (flags.json) {
    console.log(JSON.stringify(deployManifest(loaded.mod, env), null, 2));
    return;
  }

  console.log(formatDeploy(loaded.mod, env));
  console.log('');
  if (spec.artifacts === 'compose') {
    console.log('артефакт: docker-compose.yml — локальная сборка');
    console.log('запуск: arcod run ' + (flags.spec ?? '.'));
    return;
  }
  console.log('артефакт: deploy.' + env.name + '.json — манифест, пишется при arcod build');
  console.log('провайдер пока декларативный: ни кредов, ни вызовов API');
}

async function runPlan(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const plan = buildPlan(loaded.mod);
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(formatPlan(plan));
}

function runProviders(flags: Flags): void {
  const rows = providerNames().map((name) => {
    const spec = PROVIDERS[name];
    return {
      capability: spec.capability,
      provider: spec.name,
      image: spec.image ?? '(external)',
      port: spec.port ?? null,
      env: spec.appEnv ? Object.keys(spec.appEnv({ host: 'host', port: spec.port ?? 0, args: { dsn: 'x' } })).sort() : [],
      oneShot: spec.oneShot === true,
      external: spec.external === true,
      requires: spec.requires ?? [],
    };
  });

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const header = ['capability', 'provider', 'image', 'port', 'env'];
  const width = [12, 10, 32, 5, 46];
  const cell = (value: string, size: number) =>
    (value.length > size ? value.slice(0, size - 1) + '…' : value).padEnd(size);
  console.log(header.map((item, index) => cell(item, width[index])).join(' '));
  for (const row of rows) {
    const cols = [row.capability, row.provider, row.image, String(row.port ?? '-'), row.env.join(', ')];
    console.log(cols.map((item, index) => cell(item, width[index])).join(' '));
  }
}

async function runPrompts(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod).filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }

  const set = buildPrompts(loaded.mod, { budget: flags.maxTokens, format: flags.full ? 'full' : 'compact' });
  const dir = join(loaded.dir, '.arcod', 'build', 'prompts');
  await mkdir(dir, { recursive: true });
  for (const task of set.tasks) {
    await writeFile(join(dir, task.op + '.md'), task.prompt, 'utf8');
  }

  const manifest = {
    module: set.module,
    version: set.version,
    modelHash: set.modelHash,
    budget: set.budget,
    tasks: set.tasks.map((task) => ({
      id: task.id,
      op: task.op,
      file: task.file,
      tokens: task.tokens,
      sha256: task.sha256,
      unresolved: task.unresolved,
    })),
  };
  await writeFile(join(loaded.dir, '.arcod', 'build', 'prompts.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (flags.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(formatPrompts(set));
    console.log('  written to ' + dir);
  }
  if (set.overBudget.length > 0) {
    console.error('over budget (' + set.budget + '): ' + set.overBudget.join(', '));
    process.exitCode = 1;
  }
  if (set.unresolved.length > 0) {
    console.error('cannot derive a procedure from the model:');
    for (const item of set.unresolved) console.error('  ' + item);
    process.exitCode = 1;
  }
}

async function runMake(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const result = await runPipeline(loaded.mod, loaded.dir, {
    model: flags.model,
    endpoint: flags.endpoint,
    force: flags.force,
    skipImpl: flags.skipImpl,
    noTest: flags.noTest,
    reference: flags.reference,
    port: flags.port,
    allowRemote: flags.allowRemote,
    budget: flags.maxTokens,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatPipeline(result, loaded.mod.name + '@' + loaded.mod.version));
  }
  if (!result.ok) process.exitCode = 1;
}

async function runImplCmd(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod).filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }

  const { results, options } = await runImpl(loaded.mod, loaded.dir, {
    endpoint: flags.endpoint,
    model: flags.model,
    dryRun: flags.dryRun,
    cache: !flags.noCache,
    allowRemote: flags.allowRemote,
  });

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatImplReport(results, options));
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
}

async function runBuild(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod);
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port, reference: flags.reference, implDir: flags.impl ? undefined : null });
  const mode = result.impl.length > 0 ? 'impl' : result.reference ? 'reference' : 'scaffold';
  console.log('arcod build (' + mode + '): ' + result.files.length + ' files in ' + result.dir);
  if (mode === 'impl') {
    console.log('  bodies: ' + result.impl.join(', '));
  } else if (flags.impl) {
    console.log('  no bodies in impl/; run arcod impl first');
  } else if (mode === 'scaffold') {
    console.log('  operation bodies are TODO; use --reference or --impl for a runnable demo');
  }
  for (const file of result.files) console.log('  ' + file);
}

async function runTest(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod);
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }

  const result = await buildExample(loaded.mod, loaded.dir, {
    port: flags.port,
    reference: !flags.impl,
    implDir: flags.impl ? undefined : null,
  });
  const report = await runExamples(loaded.mod, result.dir);

  if (report.examples.length === 0 && report.rules.length === 0) {
    console.log('no examples or rules declared');
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (report.examples.length > 0) {
      console.log('examples:');
      for (const example of report.examples) {
        console.log('  ' + (example.ok ? 'ok    ' : 'fail  ') + example.example + (example.error ? '  — ' + example.error : ''));
      }
    }
    if (report.rules.length > 0) {
      console.log('rules:');
      for (const rule of report.rules) {
        console.log('  ' + (rule.ok ? 'ok    ' : 'fail  ') + rule.rule + (rule.detail ? '  — ' + rule.detail : ''));
      }
    }

    const items = [...report.examples, ...report.rules];
    const failed = items.filter((item) => !item.ok).length;
    console.log('');
    console.log(items.length - failed + ' passed, ' + failed + ' failed');
  }

  const all = [...report.examples, ...report.rules];
  process.exitCode = all.every((item) => item.ok) ? 0 : 1;
}

async function runRun(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod);
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }

  const result = await buildExample(loaded.mod, loaded.dir, {
    port: flags.port,
    reference: !flags.scaffold && !flags.impl,
    implDir: flags.impl ? undefined : null,
  });
  if (result.impl.length > 0) {
    console.log('arcod run: impl bodies (' + result.impl.join(', ') + ')');
  } else if (result.reference) {
    console.log('arcod run: reference implementation (operation bodies are templates)');
  } else {
    console.log('arcod run: scaffold (operations return 501 until implemented)');
  }
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.status !== 0) {
    console.error('docker не запущен или недоступен');
    process.exitCode = 1;
    return;
  }

  if (flags.down) {
    compose(result, ['down', '--remove-orphans'], flags);
    return;
  }

  console.log('arcod run: ' + loaded.mod.name + '@' + loaded.mod.version);
  console.log('  build: ' + result.dir);
  console.log('  url:   http://localhost:' + result.port);
  console.log('');

  if (flags.detach) {
    const code = compose(result, ['up', '--build', '-d'], flags);
    if (code === 0) {
      console.log('остановить: ' + (flags.spec ? 'arcod run ' + flags.spec + ' --down' : 'arcod run --down'));
    }
    process.exitCode = code;
    return;
  }

  const code = compose(result, ['up', '--build'], flags);
  process.exitCode = code;
}

function compose(result: { composeFile: string; dir: string }, args: string[], flags: Flags): number {
  const child = spawnSync('docker', ['compose', '-f', result.composeFile, ...args], {
    stdio: 'inherit',
    cwd: result.dir,
    env: process.env,
  });
  if (child.error) {
    console.error(child.error.message);
    return 1;
  }
  return child.status ?? 1;
}

function printDiagnostics(diags: Diagnostic[], specPath: string): void {
  const name = basename(specPath);
  for (const d of diags) {
    console.log(name + ':' + d.range.line + ':' + d.range.col + '  ' + d.severity + '  ' + d.code + '  ' + d.message);
    if (d.hint) console.log('    hint: ' + d.hint);
  }
  if (diags.length === 0) {
    console.log('ok — ' + name + ' is clean');
    return;
  }
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.length - errors;
  console.log('');
  console.log(errors + ' error(s), ' + warnings + ' warning(s)');
}

interface Flags {
  spec?: string;
  json: boolean;
  check: boolean;
  detach: boolean;
  down: boolean;
  reference: boolean;
  scaffold: boolean;
  env?: string;
  port: number;
  model: string;
  endpoint: string;
  dryRun: boolean;
  noCache: boolean;
  maxTokens: number;
  full: boolean;
  impl: boolean;
  allowRemote: boolean;
  force: boolean;
  skipImpl: boolean;
  noTest: boolean;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    json: false,
    check: false,
    detach: false,
    down: false,
    reference: false,
    scaffold: false,
    port: 8080,
    model: DEFAULT_IMPL.model,
    endpoint: DEFAULT_IMPL.endpoint,
    dryRun: false,
    noCache: false,
    maxTokens: 1600,
    full: false,
    impl: false,
    allowRemote: false,
    force: false,
    skipImpl: false,
    noTest: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--detach' || arg === '-d') flags.detach = true;
    else if (arg === '--down') flags.down = true;
    else if (arg === '--reference') flags.reference = true;
    else if (arg === '--scaffold') flags.scaffold = true;
    else if (arg === '--env') flags.env = args[++i];
    else if (arg === '--port') flags.port = Number(args[++i] ?? 8080);
    else if (arg === '--model') flags.model = args[++i] ?? DEFAULT_IMPL.model;
    else if (arg === '--endpoint') flags.endpoint = args[++i] ?? DEFAULT_IMPL.endpoint;
    else if (arg === '--max-tokens') flags.maxTokens = Number(args[++i] ?? 1600);
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--no-cache') flags.noCache = true;
    else if (arg === '--full') flags.full = true;
    else if (arg === '--impl') flags.impl = true;
    else if (arg === '--allow-remote') flags.allowRemote = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--skip-impl') flags.skipImpl = true;
    else if (arg === '--no-test') flags.noTest = true;
    else if (!arg.startsWith('-')) flags.spec = arg;
    else throw new Error('unknown flag: ' + arg);
  }
  return flags;
}

async function load(target?: string): Promise<Loaded> {
  const resolved = resolve(target ?? '.');
  let specPath: string;
  let dir: string;

  const info = await stat(resolved).catch(() => null);
  if (info?.isFile()) {
    specPath = resolved;
    dir = join(resolved, '..');
  } else {
    dir = resolved;
    specPath = await findSpec(dir);
  }

  const source = await readFile(specPath, 'utf8');
  const mod = parse(source, basename(specPath));
  return { mod, specPath, dir };
}

async function findSpec(dir: string): Promise<string> {
  const preferred = ['main.arc', 'spec.arc', 'arcod.arc'];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.arc')).map((e) => e.name).sort();

  for (const name of preferred) {
    if (files.includes(name)) return join(dir, name);
  }
  if (files.length > 0) return join(dir, files[0]);

  const specDir = join(dir, 'spec');
  const nested = await readdir(specDir, { withFileTypes: true }).catch(() => []);
  const nestedFiles = nested.filter((e) => e.isFile() && e.name.endsWith('.arc')).map((e) => e.name).sort();
  if (nestedFiles.length > 0) return join(specDir, nestedFiles[0]);

  throw new Error('no .arc file found in ' + dir);
}

function printHelp(): void {
  console.log(`arcod ${VERSION} — specification compiler for agent-built services

usage:
  arcod check [dir|spec.arc] [--json] [--env name]
  arcod ast   [dir|spec.arc] [--check]
  arcod plan  [dir|spec.arc] [--json]
  arcod providers [--json]
  arcod deploy [dir|spec.arc] [--env name] [--json]
  arcod prompts [dir|spec.arc] [--max-tokens 1600] [--full] [--json]
  arcod impl  [dir|spec.arc] [--model qwen2.5-coder:7b] [--endpoint URL]
                              [--dry-run] [--no-cache] [--allow-remote]
  arcod make  [dir|spec.arc] [--model m] [--force] [--skip-impl] [--no-test]
                              [--reference] [--port 8080] [--json]
  arcod build [dir|spec.arc] [--reference | --impl] [--port 8080]
  arcod test  [dir|spec.arc] [--impl] [--json]
  arcod run   [dir|spec.arc] [--impl] [--scaffold] [--port 8080] [--detach] [--down]

make runs the whole loop: check, prompts, bodies, build, test. It stops at the
first failing step; --skip-impl and --no-test cut it short, --force regenerates
bodies even when impl/ is populated.

build defaults to a scaffold: contracts, routes, adapters and infra, with TODO handlers.
--reference additionally emits the built-in demo bodies (create/read over kv).

prompts writes one deterministic prompt per operation into .arcod/build/prompts,
plus prompts.json with sha256 of each prompt. A prompt contains only the
operation contract, the allowed capability signatures and the storage format.
impl sends those prompts to an Ollama-compatible endpoint and validates the
returned body (no imports, no HTTP, syntax check). Only a local endpoint is
allowed unless --allow-remote is passed: the tool never needs paid tokens.

examples:
  cd examples/onetimemessage && arcod run
  arcod check examples/onetimemessage
  arcod plan examples/onetimemessage --json`);
}
