import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, ParseError } from './parser.ts';
import { check } from './check.ts';
import { buildPlan, formatPlan } from './plan.ts';
import { BuildError, buildExample } from './build.ts';
import { runExamples } from './test.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { ModuleNode } from './ast.ts';
import { buildPrompts, formatPrompts } from './prompts.ts';
import { formatPipeline, runPipeline } from './pipeline.ts';
import { DEFAULT_IMPL, formatImplReport, runImpl } from './impl.ts';
import { PROVIDERS, providerNames } from './providers.ts';
import { deployManifest, deployNames, deployProvider, formatDeploy } from './deploy.ts';
import { emitOpenapi } from './emit/openapi.ts';
import { graphqlSchema } from './emit/graphql.ts';
import { grpcProto } from './emit/grpc.ts';
import { pickService } from './emit/service.ts';
import { migrationPlan, formatMigrations } from './migrate.ts';
import { dialectNamed } from './dialects.ts';
import { formatSource } from './fmt.ts';
import { diffSpecs } from './diff.ts';
import { adoptOpenapi } from './adopt.ts';
import { helmChart, k8sManifests } from './emit/k8s.ts';
import { terraformFiles, formatTerraform } from './emit/terraform.ts';
import { scanPlugins } from './plugins.ts';
import { loadRegistry, providerRows, resetRegistryCache } from './registry.ts';
import { LANG_VERSION, declaredVersion, migrateSpec, VersionError } from './versions.ts';
import { scaffold, isValidName } from './new.ts';
import { serve as serveLsp } from './lsp-server.ts';

const VERSION = '0.1.0';

interface Loaded {
  mod: ModuleNode;
  specPath: string;
  dir: string;
}

// A usage mistake (unknown flag, bad arity) is the caller's fault: print one
// line and exit 2 instead of a stack trace from an uncaught rejection.
export class UsageError extends Error {}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  let flags: Flags | undefined;

  try {
    // `arcod <cmd> --help` answers before flags are parsed, so no command has
    // to declare --help itself and a missing argument cannot get in the way.
    if (rest.includes('--help') || rest.includes('-h')) {
      if (!command || command === 'help') {
        printHelp();
        return;
      }
      const usage = COMMAND_USAGE[command];
      if (!usage) {
        console.error('unknown command: ' + command);
        printHelp();
        process.exitCode = 2;
        return;
      }
      console.log(usage);
      return;
    }

    flags = parseFlags(rest);
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
      case 'openapi':
        await runOpenapi(flags);
        return;
      case 'graphql':
        await runGraphql(flags);
        return;
      case 'grpc':
        await runGrpc(flags);
        return;
      case 'migrate':
        await runMigrate(flags);
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
      case 'k8s':
        await runK8s(flags);
        return;
      case 'terraform':
        await runTerraform(flags);
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
        await runFmt(flags);
        return;
      case 'diff':
        await runDiff(rest);
        return;
      case 'adopt':
        await runAdopt(rest);
        return;
      case 'upgrade':
        await runUpgrade(flags);
        return;
      case 'new':
        await runNew(rest, flags);
        return;
      case 'lsp':
        serveLsp();
        return;
      default:
        console.error('unknown command: ' + command);
        printHelp();
        process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof ParseError) {
      const loc = error.loc;
      console.error(basename(flags?.spec ?? 'main.arc') + ':' + loc.line + ':' + loc.col + '  error  parse  ' + error.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof UsageError) {
      console.error('arcod: ' + error.message);
      console.error('hint: arcod ' + (command && command !== 'help' ? command : '<command>') + ' --help');
      process.exitCode = 2;
      return;
    }
    // A build refusal (for example two impl bodies declaring the same name) is
    // a mistake in the project, not a crash: one line and exit 2.
    if (error instanceof BuildError) {
      console.error('arcod: ' + error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// A pattern is expanded here, not by the shell, so a quoted argument works
// from a script and from CI. Only * and ? are wildcards, ** spans directories;
// everything else is literal.
function wildcardSource(part: string): string {
  const escape = (ch: string) => (/[A-Za-z0-9 _.\-*?]/.test(ch) ? ch : '\\' + ch);
  return '^' + part.split('').map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escape(ch))).join('') + '$';
}

async function expandSpecs(pattern: string): Promise<string[]> {
  const absolute = resolve(pattern);
  const parts = absolute.split('/').filter((part) => part.length > 0);
  const root = absolute.startsWith('/') ? '/' : '.';
  const results: string[] = [];

  const pushFile = (path: string): void => {
    if (!results.includes(path)) results.push(path);
  };

  const walk = async (dir: string, index: number): Promise<void> => {
    if (index >= parts.length) return;
    const part = parts[index];
    const last = index === parts.length - 1;
    if (part === '**') {
      await walk(dir, index + 1);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), index);
      }
      return;
    }
    if (!/[*?]/.test(part)) {
      const next = join(dir, part);
      if (last) {
        const info = await stat(next).catch(() => null);
        if (info?.isFile()) pushFile(next);
        if (info?.isDirectory()) {
          const spec = await findSpec(next).catch(() => null);
          if (spec) pushFile(spec);
        }
      } else {
        await walk(next, index + 1);
      }
      return;
    }
    const matcher = new RegExp(wildcardSource(part));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!matcher.test(entry.name)) continue;
      const next = join(dir, entry.name);
      if (last) {
        if (entry.isFile()) {
          pushFile(next);
        } else if (entry.isDirectory()) {
          const spec = await findSpec(next).catch(() => null);
          if (spec) pushFile(spec);
        }
      } else if (entry.isDirectory()) {
        await walk(next, index + 1);
      }
    }
  };

  // parts[] came from splitting an absolute path, so it is already relative to
  // the root: the first segment is a real directory name, not the leading slash.
  await walk(root, 0);
  return results.sort();
}

async function runCheckPattern(flags: Flags, pattern: string): Promise<void> {
  const specs = await expandSpecs(pattern);
  if (specs.length === 0) {
    console.error('arcod: no files match ' + pattern);
    process.exitCode = 2;
    return;
  }
  let failed = 0;
  const reports: Array<{ file: string; diagnostics: unknown[] }> = [];
  for (const specPath of specs) {
    const dir = join(specPath, '..');
    const mod = parse(await readFile(specPath, 'utf8'), basename(specPath));
    const diags = check(mod, { environment: flags.env, strict: flags.strict, registry: loadRegistry(dir) });
    if (diags.some((item) => item.severity === 'error')) failed++;
    if (flags.json) {
      reports.push({ file: specPath, diagnostics: diags });
    } else if (diags.length === 0) {
      console.log(basename(specPath) + ': ok');
    } else {
      printDiagnostics(diags, specPath);
    }
  }
  if (flags.json) console.log(JSON.stringify(reports, null, 2));
  else console.log('\n' + specs.length + ' file(s), ' + failed + ' with errors');
  process.exitCode = failed > 0 ? 1 : 0;
}

async function runCheck(flags: Flags): Promise<void> {
  if (flags.spec && /[*?]/.test(flags.spec)) {
    await runCheckPattern(flags, flags.spec);
    return;
  }
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod, { environment: flags.env, strict: flags.strict, registry: loadRegistry(loaded.dir) });
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
    const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
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

async function runFmt(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  let source = loaded.mod.source;
  if (flags.to) {
    try {
      source = migrateSpec(source, declaredVersion(source, basename(loaded.specPath)), flags.to, basename(loaded.specPath));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  const formatted = formatSource(source, basename(loaded.specPath));
  if (flags.check) {
    const current = source;
    if (current === formatted) {
      console.log(loaded.specPath + ': ok');
    } else {
      console.log(loaded.specPath + ': not formatted');
      process.exitCode = 1;
    }
    return;
  }
  if (flags.write) {
    await writeFile(loaded.specPath, formatted, 'utf8');
    console.log('formatted ' + loaded.specPath);
    return;
  }
  process.stdout.write(formatted);
}

async function runDiff(args: string[]): Promise<void> {
  const [a, b] = args.filter((x) => !x.startsWith('-'));
  if (!a || !b) {
    console.error('usage: arcod diff <a.arc|dir> <b.arc|dir>');
    process.exitCode = 2;
    return;
  }
  const left = await load(a);
  const right = await load(b);
  process.stdout.write(diffSpecs(left.mod.source, left.specPath, right.mod.source, right.specPath));
}

async function runAdopt(args: string[]): Promise<void> {
  const file = args.find((x) => !x.startsWith('-'));
  if (!file) {
    console.error('usage: arcod adopt <openapi.json>');
    process.exitCode = 2;
    return;
  }
  const source = await readFile(file, 'utf8');
  let doc: any;
  try {
    doc = JSON.parse(source);
  } catch {
    console.error('arcod adopt: only JSON OpenAPI documents are supported (convert YAML first)');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(adoptOpenapi(doc));
}

async function runNew(args: string[], flags: Flags): Promise<void> {
  const name = args.find((x) => !x.startsWith('-'));
  if (!name) {
    console.error('usage: arcod new <name>');
    process.exitCode = 2;
    return;
  }
  if (!isValidName(name)) {
    console.error('arcod new: name must match [a-z][a-z0-9_-]* (got ' + JSON.stringify(name) + ')');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await scaffold(name, process.cwd(), { force: flags.force });
    console.log('created ' + result.dir);
    for (const f of result.files) console.log('  ' + f);
    console.log('');
    console.log('next: cd ' + name + ' && arcod check . && arcod make .');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function runUpgrade(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const from = declaredVersion(loaded.mod.source, basename(loaded.specPath));
  const to = flags.to ?? LANG_VERSION;
  if (from === to) {
    console.log(loaded.specPath + ': already at ' + from);
    return;
  }
  try {
    const migrated = migrateSpec(loaded.mod.source, from, to, basename(loaded.specPath));
    if (flags.write) {
      await writeFile(loaded.specPath, migrated, 'utf8');
      console.log('upgraded ' + loaded.specPath + ' ' + from + ' -> ' + to);
    } else {
      process.stdout.write(migrated);
    }
  } catch (err) {
    if (err instanceof VersionError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function runDeploy(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const env = flags.env
    ? loaded.mod.environments.find((item) => item.name === flags.env)
    : loaded.mod.environments[0];
  if (!env) throw new Error('no environment to deploy' + (flags.env ? ': ' + flags.env : ''));
  if (!env.deploy) {
    console.log(env.name + ': deploy is not declared (docker is assumed by default)');
    console.log('available providers: ' + deployNames().join(', '));
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
    console.log('artifact: docker-compose.yml — local build');
    console.log('run: arcod run ' + (flags.spec ?? '.'));
    return;
  }
  if (spec.artifacts === 'k8s' || spec.artifacts === 'helm') {
    console.log('artifact: ' + spec.artifacts + '/ — manifests written by arcod build');
    console.log('preview: arcod k8s ' + (flags.spec ?? '.') + (spec.artifacts === 'helm' ? ' --helm' : ''));
    console.log('provider is declarative for now: no credentials, no API calls');
    return;
  }
  console.log('artifact: deploy.' + env.name + '.json — manifest, written by arcod build');
  console.log('provider is declarative for now: no credentials, no API calls');
}

async function runK8s(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const options = {
    environment: flags.env,
    image: flags.image,
    namespace: flags.namespace,
    replicas: flags.replicas,
    host: flags.host,
    ingressClass: flags.ingressClass,
  };
  const emitted = flags.helm ? helmChart(loaded.mod, options) : k8sManifests(loaded.mod, options);
  if (flags.out) {
    for (const file of emitted) {
      const path = join(flags.out, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { encoding: 'utf8', mode: 0o644 });
    }
    console.log('wrote ' + emitted.length + ' file(s) to ' + flags.out);
    return;
  }
  console.log(emitted.map((file) => '# ' + file.path + '\n' + file.content).join('\n---\n'));
}

async function runTerraform(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const files = terraformFiles(loaded.mod, { environment: flags.env, registry: loadRegistry(loaded.dir) });
  if (flags.out) {
    for (const file of files) {
      const path = join(flags.out, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { encoding: 'utf8', mode: 0o644 });
    }
    console.log('wrote ' + files.length + ' file(s) to ' + flags.out);
    return;
  }
  console.log(formatTerraform(files));
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

async function runMigrate(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const svc = pickService(loaded.mod);
  if (!svc) throw new Error('no service to migrate');
  const plan = migrationPlan(loaded.mod, svc, { dialect: dialectNamed(flags.dialect) });
  if (plan.migrations.length === 0) {
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else console.log('no stored entities in ' + svc.name + ' — nothing to migrate');
    return;
  }

  const dir = join(loaded.dir, '.arcod', 'build', 'migrations');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'changelog.json'), JSON.stringify(plan.migrations, null, 2));
  for (const migration of plan.migrations) {
    await writeFile(join(dir, migration.version + '_' + migration.name + '.up.sql'), migration.up);
    await writeFile(join(dir, migration.version + '_' + migration.name + '.down.sql'), migration.down);
  }

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatMigrations(plan));
    console.log('');
    console.log('artifact: .arcod/build/migrations/ — changelog.json + up/down .sql');
    console.log('the generated service applies them on boot (sql driver)');
  }
}

async function runOpenapi(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const doc = emitOpenapi(loaded.mod, { service: flags.service });
  console.log(JSON.stringify(doc, null, 2));
}

async function runGraphql(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const sdl = graphqlSchema(loaded.mod, { service: flags.service });
  const target = flags.out;
  if (!target) {
    console.log(sdl);
    return;
  }
  const path = isAbsolute(target) ? target : join(loaded.dir, target);
  await writeFile(path, sdl);
  console.log('wrote ' + path);
}

async function runGrpc(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const proto = grpcProto(loaded.mod, { service: flags.service });
  const target = flags.out;
  if (!target) {
    console.log(proto);
    return;
  }
  const path = isAbsolute(target) ? target : join(loaded.dir, target);
  await writeFile(path, proto);
  console.log('wrote ' + path);
}

function runProviders(flags: Flags): void {
  if (flags.plugins) {
    const scan = scanPlugins(process.cwd());
    if (flags.json) {
      console.log(JSON.stringify({ plugins: scan.plugins, issues: scan.issues }, null, 2));
      return;
    }
    if (scan.plugins.length === 0) {
      console.log('no plugins found: ARC_PLUGIN_PATH, ./.arcod/plugins, ~/.arcod/plugins are empty');
    }
    for (const plugin of scan.plugins) {
      console.log(plugin.package + '@' + plugin.version + '  api ' + plugin.pluginApi + '  ' + plugin.path);
      for (const capability of plugin.capabilities) {
        console.log('  capability ' + capability.name + (capability.summary ? ' — ' + capability.summary : ''));
      }
      for (const provider of plugin.providers) {
        console.log('  provider   ' + provider.name + ' -> ' + provider.capability);
      }
    }
    for (const issue of scan.issues) console.log(issue.severity + '  ' + issue.path + ': ' + issue.message);
    return;
  }

  // A plugin-declared provider is listed with the package that declared it;
  // built-ins have no origin.
  const rows = providerRows(loadRegistry(process.cwd()));

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // origin says who declared a provider: '-' for a built-in, the package for a
  // plugin. The JSON form carries the same field.
  const header = ['capability', 'provider', 'image', 'port', 'env', 'origin'];
  const width = [12, 10, 32, 5, 46, 24];
  const cell = (value: string, size: number) =>
    (value.length > size ? value.slice(0, size - 1) + '…' : value).padEnd(size);
  console.log(header.map((item, index) => cell(item, width[index])).join(' '));
  for (const row of rows) {
    const cols = [row.capability, row.provider, row.image, String(row.port ?? '-'), row.env.join(', '), row.origin ?? '-'];
    console.log(cols.map((item, index) => cell(item, width[index])).join(' '));
  }
}

async function runPrompts(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((item) => item.severity === 'error');
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
    dialect: flags.dialect === 'postgres' ? 'postgres' : undefined,
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
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((item) => item.severity === 'error');
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
  const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }
  const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port, reference: flags.reference, implDir: flags.impl ? undefined : null, registry: loadRegistry(loaded.dir), dialect: flags.dialect === 'postgres' ? 'postgres' : undefined });
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
  const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    printDiagnostics(errors, loaded.specPath);
    process.exitCode = 1;
    return;
  }

  // `arcod test` runs real bodies when impl/ has them (same as `arcod make`);
  // it falls back to the built-in reference handlers only when there is no impl.
  // `--impl` forces impl, `--reference` forces the demo handlers.
  // Nothing to run means nothing to build: say it once, before paying for a
  // build and a service spawn that can only report the same thing.
  const own = loaded.mod.services.filter((svc) => !svc.external);
  const declared = own.reduce((total, svc) => total + svc.examples.length + svc.rules.length, 0);
  if (declared === 0) {
    console.log('no examples or rules declared');
    return;
  }

  const hasBodies = (await readdir(join(loaded.dir, 'impl')).catch(() => [] as string[])).some((name) => name.endsWith('.mjs'));
  const useImpl = flags.impl || (!flags.reference && hasBodies);
  let result: Awaited<ReturnType<typeof buildExample>>;
  try {
    result = await buildExample(loaded.mod, loaded.dir, {
      port: flags.port,
      reference: !useImpl,
      implDir: useImpl ? undefined : null,
      registry: loadRegistry(loaded.dir),
      dialect: flags.dialect === 'postgres' ? 'postgres' : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The demo handlers only cover create/read. Anything else without bodies
    // needs the model or a hand-written file, and the user should hear that
    // instead of the emitter's internal wording.
    if (/templates only for/.test(message)) {
      console.error('no operation bodies to test: impl/ is empty and the demo handlers cover only create/read.');
      console.error('run `arcod impl` (or `arcod make`) first, or add impl/<op>.mjs by hand.');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
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

async function stopProject(flags: Flags): Promise<number> {
  const target = resolve(flags.spec ?? '.');
  const info = await stat(target).catch(() => null);
  const dir = info?.isFile() ? join(target, '..') : target;
  const buildDir = join(dir, '.arcod', 'build');
  const composeFile = join(buildDir, 'docker-compose.yml');
  const exists = await stat(composeFile).catch(() => null);
  if (!exists) {
    console.log('arcod run: nothing to stop — no .arcod/build/docker-compose.yml');
    return 0;
  }
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.status !== 0) {
    console.error('docker is not running or unavailable');
    return 1;
  }
  return compose({ composeFile, dir: buildDir }, ['down', '--remove-orphans'], flags);
}

async function runRun(flags: Flags): Promise<void> {
  // --down is the stop button: it must work even when the project no longer
  // builds (an operation the emitters do not template yet) and must leave the
  // artifacts of the last build alone. So it never parses the spec.
  if (flags.down) {
    process.exitCode = await stopProject(flags);
    return;
  }

  const loaded = await load(flags.spec);
  const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
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
    registry: loadRegistry(loaded.dir),
    dialect: flags.dialect === 'postgres' ? 'postgres' : undefined,
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
    console.error('docker is not running or unavailable');
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
      console.log('stop: ' + (flags.spec ? 'arcod run ' + flags.spec + ' --down' : 'arcod run --down'));
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
  service?: string;
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
  strict: boolean;
  force: boolean;
  skipImpl: boolean;
  noTest: boolean;
  write: boolean;
  to?: string;
  helm: boolean;
  plugins: boolean;
  dialect?: string;
  image?: string;
  host?: string;
  namespace?: string;
  replicas?: number;
  ingressClass?: string;
  out?: string;
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
    strict: false,
    force: false,
    skipImpl: false,
    noTest: false,
    write: false,
    helm: false,
    plugins: false,
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
    else if (arg === '--service') flags.service = args[++i];
    else if (arg === '--port') flags.port = Number(args[++i] ?? 8080);
    else if (arg === '--model') flags.model = args[++i] ?? DEFAULT_IMPL.model;
    else if (arg === '--endpoint') flags.endpoint = args[++i] ?? DEFAULT_IMPL.endpoint;
    else if (arg === '--max-tokens') flags.maxTokens = Number(args[++i] ?? 1600);
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--no-cache') flags.noCache = true;
    else if (arg === '--full') flags.full = true;
    else if (arg === '--impl') flags.impl = true;
    else if (arg === '--allow-remote') flags.allowRemote = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--skip-impl') flags.skipImpl = true;
    else if (arg === '--no-test') flags.noTest = true;
    else if (arg === '--write' || arg === '-w') flags.write = true;
    else if (arg === '--to') flags.to = args[++i];
    else if (arg === '--helm') flags.helm = true;
    else if (arg === '--plugins') flags.plugins = true;
    else if (arg === '--dialect') flags.dialect = args[++i];
    else if (arg === '--image') flags.image = args[++i];
    else if (arg === '--host') flags.host = args[++i];
    else if (arg === '--namespace') flags.namespace = args[++i];
    else if (arg === '--replicas') flags.replicas = Number(args[++i]);
    else if (arg === '--ingress-class') flags.ingressClass = args[++i];
    else if (arg === '--out') flags.out = args[++i];
    else if (!arg.startsWith('-')) flags.spec = arg;
    else throw new UsageError('unknown flag: ' + arg);
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

// Every subcommand answers for itself: "arcod <cmd> --help" prints this
// string and exits 0, so a wrong flag never needs a guess from the full page.
const COMMAND_USAGE: Record<string, string> = {
  check: `usage: arcod check [dir|spec.arc|pattern] [--json] [--env name] [--strict]

Parse the spec and print diagnostics. --json prints a JSON report,
--strict treats warnings as errors, --env checks one environment. A quoted
pattern is expanded here: 'examples/*/main.arc' checks every project.`,
  ast: `usage: arcod ast [dir|spec.arc] [--check] [--json]

Print the parsed module (canonical AST). --check also prints the diagnostics.`,
  plan: `usage: arcod plan [dir|spec.arc] [--json]

Print the build plan: services, routes, capabilities, emitted files.`,
  openapi: `usage: arcod openapi [dir|spec.arc] [--service name]

Print the OpenAPI 3.1 document for the spec (or for one service).`,
  graphql: `usage: arcod graphql [dir|spec.arc] [--service name] [--out file]

Print the GraphQL schema (or write it with --out).`,
  grpc: `usage: arcod grpc [dir|spec.arc] [--service name] [--out file]

Print the gRPC .proto (or write it with --out).`,
  migrate: `usage: arcod migrate [dir|spec.arc] [--json] [--dialect mysql|postgres]

Print the migrations for the stored entities. --dialect picks the SQL dialect.`,
  fmt: `usage: arcod fmt [dir|spec.arc] [--check] [--write] [--to version]

Print the canonical form of the spec. --check fails when the file differs,
--write rewrites it in place, --to upgrades it across language versions.`,
  diff: `usage: arcod diff <a.arc|dir> <b.arc|dir>

Structurally diff two specs (canonicalized first, so formatting is not a change).`,
  adopt: `usage: arcod adopt <openapi.json>

Turn an OpenAPI 3.x document into an arcod spec.`,
  upgrade: `usage: arcod upgrade [dir|spec.arc] [--to version] [--write]

Migrate a spec across language versions; --write rewrites the file.`,
  new: `usage: arcod new <name> [--force]

Scaffold a new project in ./<name>. Refuses to overwrite without --force.`,
  lsp: `usage: arcod lsp

Serve the language server over stdio.`,
  providers: `usage: arcod providers [--json] [--plugins]

List the capability providers the build can bind. --plugins adds the ones an
external package declares.`,
  deploy: `usage: arcod deploy [dir|spec.arc] [--env name] [--json]

Print the deploy manifest (services, images, env) for one environment.`,
  terraform: `usage: arcod terraform [dir|spec.arc] [--env name] [--out dir]

Print (or write) Terraform HCL for the topology.`,
  k8s: `usage: arcod k8s [dir|spec.arc] [--helm] [--image ref] [--host host]
                 [--namespace ns] [--replicas n] [--ingress-class c] [--out dir]

Render the topology as Kubernetes manifests; --helm wraps them in a chart.`,
  prompts: `usage: arcod prompts [dir|spec.arc] [--max-tokens 1600] [--full]

Write one deterministic prompt per operation into .arcod/build/prompts.`,
  impl: `usage: arcod impl [dir|spec.arc] [--model qwen2.5-coder:7b] [--endpoint URL]
                   [--dry-run] [--no-cache] [--allow-remote]

Ask a local Ollama-compatible model for the operation bodies.`,
  make: `usage: arcod make [dir|spec.arc] [--model m] [--force] [--skip-impl] [--no-test]
                   [--reference] [--port 8080] [--json]

Run the loop: check, prompts, bodies, build, test. Stops at the first failure.`,
  build: `usage: arcod build [dir|spec.arc] [--reference | --impl] [--port 8080]
                     [--dialect mysql|postgres]

Emit the service, migrations, compose and pages into .arcod/build.`,
  test: `usage: arcod test [dir|spec.arc] [--impl] [--json]

Run the examples and rules against the emitted service.`,
  run: `usage: arcod run [dir|spec.arc] [--impl] [--scaffold] [--port 8080] [--detach] [--down]

Build and start the project with docker compose. --detach leaves it running,
--down stops what this project started (no rebuild, no cleanup of the build).`,
};

function printHelp(): void {
  console.log(`arcod ${VERSION} — specification compiler for agent-built services

usage:
  arcod check [dir|spec.arc|pattern] [--json] [--env name] [--strict]
  arcod ast   [dir|spec.arc] [--check]
  arcod plan  [dir|spec.arc] [--json]
  arcod openapi [dir|spec.arc] [--service name]
  arcod graphql [dir|spec.arc] [--service name] [--out file]
  arcod grpc  [dir|spec.arc] [--service name] [--out file]
  arcod migrate [dir|spec.arc] [--json] [--dialect mysql|postgres]
  arcod fmt  [dir|spec.arc] [--check] [--write] [--to version]
  arcod diff <a.arc|dir> <b.arc|dir>
  arcod adopt <openapi.json>
  arcod upgrade [dir|spec.arc] [--to version] [--write]
  arcod new <name>
  arcod lsp
  arcod providers [--json] [--plugins]
  arcod deploy [dir|spec.arc] [--env name] [--json]
  arcod terraform [dir|spec.arc] [--env name] [--out dir]
  arcod k8s   [dir|spec.arc] [--helm] [--image ref] [--host host]
                              [--namespace ns] [--replicas n] [--ingress-class c] [--out dir]
  arcod prompts [dir|spec.arc] [--max-tokens 1600] [--full] [--json]
  arcod impl  [dir|spec.arc] [--model qwen2.5-coder:7b] [--endpoint URL]
                              [--dry-run] [--no-cache] [--allow-remote]
  arcod make  [dir|spec.arc] [--model m] [--force] [--skip-impl] [--no-test]
                              [--reference] [--port 8080] [--json]
  arcod build [dir|spec.arc] [--reference | --impl] [--port 8080] [--dialect mysql|postgres]
  arcod test  [dir|spec.arc] [--impl] [--json]
  arcod run   [dir|spec.arc] [--impl] [--scaffold] [--port 8080] [--detach] [--down]

make runs the whole loop: check, prompts, bodies, build, test. It stops at the
first failing step; --skip-impl and --no-test cut it short, --force regenerates
bodies even when impl/ is populated.

fmt prints the canonical AST form; diff structural-diffs two specs (canonicalized
first); adopt turns an OpenAPI 3.x JSON doc into a spec; upgrade migrates a spec
across language versions (--to, --write). fmt/upgrade share --check and --write.

build defaults to a scaffold: contracts, routes, adapters and infra, with TODO handlers.
--reference additionally emits the built-in demo bodies (create/read over kv).
--dialect postgres emits the postgres wire client and store plus postgres
migrations instead of the MySQL ones; mysql is the default.

prompts writes one deterministic prompt per operation into .arcod/build/prompts,
plus prompts.json with sha256 of each prompt. A prompt contains only the
operation contract, the allowed capability signatures and the storage format.
impl sends those prompts to an Ollama-compatible endpoint and validates the
returned body (no imports, no HTTP, syntax check). Only a local endpoint is
allowed unless --allow-remote is passed: the tool never needs paid tokens.

k8s draws the same topology compose runs locally as Kubernetes objects:
a Namespace, a ConfigMap for the service env, one Deployment+Service per
bound provider (redis, postgres, ...), the service itself with /healthz
probes, the web Deployment behind an Ingress, and a PVC for providers that
keep state. Provider credentials land in a Secret, never in the ConfigMap; bind
a secrets capability and the Secret becomes an ExternalSecret from Vault.
--helm wraps the identical objects in a chart; --out writes files instead of
printing them. Nothing is applied: the output is text only.

examples:
  cd examples/onetimemessage && arcod run
  arcod check examples/onetimemessage
  arcod plan examples/onetimemessage --json`);
}
