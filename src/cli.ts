import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, ParseError } from './parser.ts';
import { check } from './check.ts';
import { buildPlan, formatPlan } from './plan.ts';
import { buildExample } from './build.ts';
import { runExamples } from './test.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { ModuleNode } from './ast.ts';

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

async function runPlan(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const plan = buildPlan(loaded.mod);
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(formatPlan(plan));
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
  const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port });
  console.log('arcod build: ' + result.files.length + ' files in ' + result.dir);
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

  const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port });
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

  const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port });
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
  env?: string;
  port: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, check: false, detach: false, down: false, port: 8080 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--detach' || arg === '-d') flags.detach = true;
    else if (arg === '--down') flags.down = true;
    else if (arg === '--env') flags.env = args[++i];
    else if (arg === '--port') flags.port = Number(args[++i] ?? 8080);
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
  arcod build [dir|spec.arc] [--port 8080]
  arcod test  [dir|spec.arc] [--json]
  arcod run   [dir|spec.arc] [--port 8080] [--detach] [--down]

examples:
  cd examples/onetimemessage && arcod run
  arcod check examples/onetimemessage
  arcod plan examples/onetimemessage --json`);
}
