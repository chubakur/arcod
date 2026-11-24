import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeDocker } from './docker.ts';
import { parse, ParseError } from './parser.ts';
import { check } from './check.ts';
import { buildPlan, formatPlan } from './plan.ts';
import { BuildError, buildExample, implBodiesFor, implIgnoredFiles, resolveDialect } from './build.ts';
import { runExamples } from './test.ts';
import type { Diagnostic } from './diagnostics.ts';
import type { ModuleNode } from './ast.ts';
import { buildPrompts, formatPrompts, promptManifest, prunePromptFiles } from './prompts.ts';
import { formatPipeline, runPipeline } from './pipeline.ts';
import { DEFAULT_IMPL, formatImplReport, runImpl } from './impl.ts';
import { PROVIDERS, providerNames } from './providers.ts';
import { deployManifest, deployNames, deployProvider, formatDeploy } from './deploy.ts';
import { emitOpenapi } from './emit/openapi.ts';
import { graphqlSchema } from './emit/graphql.ts';
import { grpcProto } from './emit/grpc.ts';
import { pickService } from './emit/service.ts';
import { entitiesFromBodies, migrationPlan, formatMigrations } from './migrate.ts';
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

// parseFlags knows every flag, so `--out` reached `arcod build` and was
// silently ignored — the same no-op as a typo, only harder to notice. Each
// command declares the flags it actually reads; anything else is a usage
// error. The sets include flags the command forwards (`make --port`) and ones
// it reads indirectly (`migrate --dialect`).
export const COMMAND_FLAGS: Record<string, string[]> = {
  check: ['--json', '--env', '--strict'],
  ast: ['--json', '--check'],
  plan: ['--json'],
  openapi: ['--service', '--out'],
  graphql: ['--service', '--out'],
  grpc: ['--service', '--out'],
  migrate: ['--json', '--dialect'],
  build: ['--reference', '--impl', '--port', '--dialect', '--json'],
  test: ['--impl', '--reference', '--port', '--json'],
  make: ['--force', '--skip-impl', '--no-test', '--model', '--endpoint', '--max-tokens', '--allow-remote', '--reference', '--port', '--json'],
  run: ['--impl', '--scaffold', '--port', '--detach', '--down', '--json'],
  providers: ['--json', '--plugins'],
  deploy: ['--json', '--env'],
  k8s: ['--out', '--helm', '--image', '--host', '--namespace', '--replicas', '--ingress-class', '--env'],
  terraform: ['--out', '--env'],
  prompts: ['--json', '--full', '--max-tokens'],
  impl: ['--model', '--endpoint', '--dry-run', '--no-cache', '--allow-remote', '--json'],
  fmt: ['--check', '--write', '--to', '--json'],
  diff: [],
  adopt: [],
  upgrade: ['--to', '--write'],
  new: ['--force'],
  lsp: [],
};

// These commands read no path at all: `arcod version extra` printed the
// version and dropped the word the same way a second path was dropped for
// every other command. A path they never read is a usage error now.
export const NO_PATH_COMMANDS = new Set(['version', 'providers', 'lsp']);

function assertCommandFlags(command: string | undefined, args: string[]): void {
  const allowed = command ? COMMAND_FLAGS[command] : undefined;
  if (!allowed) return;
  const set = new Set(allowed);
  // One spelling map for both rules below: the shorthand is accepted under its
  // long name everywhere, so a rule written against `--write` must not miss
  // `-w` (and the error still quotes what the caller typed).
  const seen = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '-h' || arg === '--help') continue;
    const canonical = arg === '-d' ? '--detach' : arg === '-w' ? '--write' : arg;
    if (!set.has(canonical)) throw new UsageError('unknown flag: ' + arg);
    seen.add(canonical);
  }
  // The help writes `--reference | --impl`, but parsing both meant the second
  // one silently lost: a reference build answered for a request that asked for
  // impl bodies. Alternatives are now an error instead of a preference.
  if (set.has('--reference') && set.has('--impl') && seen.has('--reference') && seen.has('--impl')) {
    throw new UsageError('--reference and --impl are alternatives; pass one');
  }
  // Same shape for fmt's two modes: --check asks a question, --write answers it
  // by rewriting. Passing both used to pick the check branch and silently drop
  // the rewrite the caller asked for.
  if (set.has('--check') && set.has('--write') && seen.has('--check') && seen.has('--write')) {
    throw new UsageError('--check and --write are alternatives; pass one');
  }
}

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

    // `arcod help build` printed the main page and silently dropped the
    // command: the page already lists build at the top, so the argument looked
    // answered. It now resolves to the same page `arcod build --help` prints,
    // and a name the CLI does not have is refused instead of ignored. A flag
    // (`arcod help --json`, `arcod help -h`) still means the main page.
    if (command === 'help' && rest.length > 0 && !rest[0].startsWith('-')) {
      const usage = COMMAND_USAGE[rest[0]];
      if (!usage) {
        console.error('unknown command: ' + rest[0]);
        printHelp();
        process.exitCode = 2;
        return;
      }
      // help answers about one command; `arcod help build check` printed the
      // build page and dropped check — the same silent drop a second path got.
      if (rest.length > 1) {
        console.error('arcod: unexpected argument: ' + rest[1]);
        process.exitCode = 2;
        return;
      }
      console.log(usage);
      return;
    }

    assertCommandFlags(command, rest);
    flags = parseFlags(rest, command);
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
      const file = basename(flags?.spec ?? 'main.arc');
      // Every other refusal under --json is an object on stdout (check says
      // {error, diagnostics}), but a spec that does not parse used to leave
      // stdout empty and a prose line on stderr: a script had to scrape the
      // one shape the compiler would not hand it. The diagnostic carries the
      // same code the human form prints.
      if (flags?.json) {
        console.log(JSON.stringify({
          error: 'parse failed',
          diagnostics: [{
            code: 'parse',
            severity: 'error',
            file,
            message: error.message,
            range: { line: loc.line, col: loc.col },
          }],
        }, null, 2));
      } else {
        console.error(file + ':' + loc.line + ':' + loc.col + '  error  parse  ' + error.message);
      }
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
      // A project mistake the machine caller also has to read: the exit code
      // stays 2, but --json gets the reason as an object instead of a line it
      // would have to scrape off stderr.
      if (flags?.json) {
        console.log(JSON.stringify({ error: error.message }, null, 2));
      } else {
        console.error('arcod: ' + error.message);
      }
      process.exitCode = 2;
      return;
    }
    // The last refusal a machine meets is a path it cannot read: load() says
    // "cannot read <path>: no such file or directory" and that line used to be
    // the only answer under --json too. The message is unchanged, but stdout
    // now carries it as {error} like every other refusal, so a script does not
    // have to scrape stderr for the one case it cannot anticipate.
    const message = error instanceof Error ? error.message : String(error);
    if (flags?.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
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
      // A trailing ** means "every project at or below this directory". It used
      // to expand to nothing: the zero-level step returned at once (index was
      // past the end) and the recursion only ever descended, so
      // `arcod check 'projects/**'` said "no files match" and exited 2 for a
      // pattern that names every project below the directory.
      if (last) {
        const spec = await findSpec(dir).catch(() => null);
        if (spec) pushFile(spec);
      } else {
        await walk(dir, index + 1);
      }
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

// A pattern usually matches several projects that all name their spec
// main.arc: a bare basename would make their reports indistinguishable. Show
// the path relative to the working directory, and the absolute one only when
// the file lives outside it.
function specLabel(specPath: string): string {
  const rel = relative(process.cwd(), specPath);
  return rel !== '' && !rel.startsWith('..') ? rel : specPath;
}

async function runCheckPattern(flags: Flags, pattern: string): Promise<void> {
  const specs = await expandSpecs(pattern);
  if (specs.length === 0) {
    // A pattern that matches nothing is a refusal like the others: exit 2 says
    // the caller's command line is wrong, and --json carries the reason.
    if (flags.json) console.log(JSON.stringify({ error: 'no files match ' + pattern }, null, 2));
    else console.error('arcod: no files match ' + pattern);
    process.exitCode = 2;
    return;
  }
  let failed = 0;
  const reports: Array<{
    file: string;
    diagnostics: unknown[];
    error?: { message: string; line?: number; col?: number };
  }> = [];
  for (const specPath of specs) {
    const label = specLabel(specPath);
    const dir = join(specPath, '..');
    let mod: ModuleNode;
    try {
      mod = parse(await readFile(specPath, 'utf8'), label);
    } catch (error) {
      // One broken file must not abandon the other projects: report it with
      // its location, count it as failed and keep going.
      failed++;
      // A pattern keeps walking after one bad file, so this message is the
      // only report that file gets: the label already names it, so a read
      // failure should say "permission denied", not repeat the path inside a
      // syscall string.
      const message = fsReason(error);
      const loc = error instanceof ParseError ? error.loc : null;
      if (flags.json) {
        reports.push({ file: specPath, diagnostics: [], error: { message, line: loc?.line, col: loc?.col } });
      } else if (loc) {
        console.log(label + ':' + loc.line + ':' + loc.col + '  error  parse  ' + message);
      } else {
        console.log(label + '  error  ' + message);
      }
      continue;
    }
    const diags = check(mod, { environment: flags.env, strict: flags.strict, registry: loadRegistry(dir), impl: await implBodiesFor(dir), implIgnored: await implIgnoredFiles(dir) });
    if (diags.some((item) => item.severity === 'error')) failed++;
    if (flags.json) {
      reports.push({ file: specPath, diagnostics: diags });
    } else if (diags.length === 0) {
      console.log(label + ': ok');
    } else {
      printDiagnostics(diags, specPath, label);
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
  // The bodies are where an entity is named, so a typo there is checkable only
  // when check reads them; a project without impl simply has no such warning.
  const diags = check(loaded.mod, { environment: flags.env, strict: flags.strict, registry: loadRegistry(loaded.dir), impl: await implBodiesFor(loaded.dir), implIgnored: await implIgnoredFiles(loaded.dir) });
  if (flags.json) {
    console.log(JSON.stringify(diags, null, 2));
  } else {
    printDiagnostics(diags, loaded.specPath, specLabel(loaded.specPath));
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
      printDiagnostics(errors, loaded.specPath, specLabel(loaded.specPath));
      process.exitCode = 1;
      return;
    }
  }
  const { source, ...ast } = loaded.mod;
  console.log(JSON.stringify(ast, null, 2));
}

// fmt over a pattern is the shape a formatting gate needs: one line per file,
// one exit code. Printing several canonical specs to a single stdout would be
// ambiguous, so a pattern has to ask for --check or --write.
async function runFmtPattern(flags: Flags, pattern: string): Promise<void> {
  // A formatting gate wants the verdict as data: which file differs, how many
  // changed, whether anything failed. The human lines stay byte-identical, and
  // --json answers one object with the same words as each file's status.
  if (!flags.check && !flags.write) {
    const message = 'a pattern needs --check or --write; a single file prints its canonical form';
    if (flags.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error('arcod: ' + message);
    process.exitCode = 2;
    return;
  }
  const specs = await expandSpecs(pattern);
  if (specs.length === 0) {
    const message = 'no files match ' + pattern;
    if (flags.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error('arcod: ' + message);
    process.exitCode = 2;
    return;
  }
  let changed = 0;
  let failed = 0;
  const files: Array<{ file: string; status: string; error?: string; line?: number; col?: number }> = [];
  for (const specPath of specs) {
    const label = specLabel(specPath);
    let source: string;
    try {
      source = await readFile(specPath, 'utf8');
      // Parse first: formatSource on a broken spec would silently reformat a
      // half-understood file, and a gate must never hide its own input error.
      parse(source, label);
    } catch (error) {
      failed++;
      const loc = error instanceof ParseError ? error.loc : null;
      const message = error instanceof Error ? error.message : String(error);
      if (flags.json) files.push({ file: label, status: 'failed', error: message, ...(loc ? { line: loc.line, col: loc.col } : {}) });
      else console.log(loc
        ? label + ':' + loc.line + ':' + loc.col + '  error  parse  ' + message
        : label + '  error  ' + message);
      continue;
    }
    if (flags.to) {
      try {
        source = migrateSpec(source, declaredVersion(source, label), flags.to, label);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        if (flags.json) files.push({ file: label, status: 'failed', error: message });
        else console.log(label + ': ' + message);
        continue;
      }
    }
    const formatted = formatSource(source, label);
    if (formatted === source) {
      if (flags.json) files.push({ file: label, status: 'ok' });
      else console.log(label + ': ok');
      continue;
    }
    changed++;
    if (flags.write) {
      try {
        await writeFile(specPath, formatted, 'utf8');
      } catch (err) {
        failed++;
        if (flags.json) files.push({ file: label, status: 'failed', error: 'cannot write: ' + fsReason(err) });
        // A file the process could not write is an environment error; it is
        // already carried as a failed entry under --json, so the line stays
        // off the report stream and only the human form prints it.
        if (!flags.json) console.error('arcod: cannot write ' + specPath + ': ' + fsReason(err));
        continue;
      }
      if (flags.json) files.push({ file: label, status: 'formatted' });
      else console.log('formatted ' + label);
    } else {
      if (flags.json) files.push({ file: label, status: 'not formatted' });
      else console.log(label + ': not formatted');
    }
  }
  const ok = failed === 0 && (flags.write || changed === 0);
  if (flags.json) {
    console.log(JSON.stringify({ mode: flags.write ? 'write' : 'check', ok, files, changed, failed }, null, 2));
  } else if (!flags.write) {
    console.log('\n' + specs.length + ' file(s), ' + changed + ' not formatted, ' + failed + ' failed');
  }
  // A write that succeeded is not a failure; only a file we could not read,
  // parse or migrate is.
  process.exitCode = flags.write ? (failed > 0 ? 1 : 0) : (changed > 0 || failed > 0 ? 1 : 0);
}

async function runFmt(flags: Flags): Promise<void> {
  if (flags.spec && /[*?]/.test(flags.spec)) {
    await runFmtPattern(flags, flags.spec);
    return;
  }
  // One file answers with the same object a pattern does, so a gate that calls
  // fmt on a directory and on a single spec reads one shape. The canonical
  // text is what stdout carries by default; --json is the verdict, so it needs
  // a mode to be a verdict about something. Asked before the file is read, so
  // the refusal does not depend on what the path contains.
  if (flags.json && !flags.check && !flags.write) {
    console.log(JSON.stringify({ error: '--json needs --check or --write' }, null, 2));
    process.exitCode = 2;
    return;
  }
  const loaded = await load(flags.spec);
  // One file and a pattern must answer in the same shape: `arcod fmt
  // examples/x --check` used to print the absolute path here and a path
  // relative to the caller over a pattern, so a gate comparing the two saw two
  // formats for the same verdict.
  const label = specLabel(loaded.specPath);
  let source = loaded.mod.source;
  if (flags.to) {
    try {
      source = migrateSpec(source, declaredVersion(source, basename(loaded.specPath)), flags.to, basename(loaded.specPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A --json caller gets the same refusal a pattern gives per file: the
      // migration failed for this file, and the reason is data. It used to be
      // a prose line on stderr with empty stdout, the one shape the JSON
      // contract says a caller never has to scrape.
      if (flags.json) console.log(JSON.stringify({
        mode: flags.write ? 'write' : 'check',
        ok: false,
        files: [{ file: label, status: 'failed', error: message }],
        changed: 0,
        failed: 1,
      }, null, 2));
      else console.error(message);
      process.exitCode = 1;
      return;
    }
  }
  const formatted = formatSource(source, basename(loaded.specPath));
  const report = (status: string, extra: Record<string, unknown> = {}) => {
    const changedFiles = status === 'not formatted' || status === 'formatted' ? 1 : 0;
    console.log(JSON.stringify({
      mode: flags.write ? 'write' : 'check',
      ok: status === 'ok' || status === 'formatted',
      files: [{ file: label, status, ...extra }],
      changed: changedFiles,
      failed: status === 'failed' ? 1 : 0,
    }, null, 2));
  };
  if (flags.check) {
    const current = source;
    if (current === formatted) {
      if (flags.json) report('ok');
      else console.log(label + ': ok');
    } else {
      if (flags.json) report('not formatted');
      else console.log(label + ': not formatted');
      process.exitCode = 1;
    }
    return;
  }
  if (flags.write) {
    try {
      await writeFile(loaded.specPath, formatted, 'utf8');
    } catch (err) {
      if (flags.json) report('failed', { error: 'cannot write: ' + fsReason(err) });
      else console.error('arcod: cannot write ' + label + ': ' + fsReason(err));
      process.exitCode = 1;
      return;
    }
    if (flags.json) report(source === formatted ? 'ok' : 'formatted');
    else console.log('formatted ' + label);
    return;
  }
  process.stdout.write(formatted);
}

async function runDiff(args: string[]): Promise<void> {
  const paths = args.filter((x) => !x.startsWith('-'));
  const [a, b] = paths;
  if (!a || !b) {
    console.error('usage: arcod diff <a.arc|dir> <b.arc|dir>');
    process.exitCode = 2;
    return;
  }
  // diff reads exactly two paths; a third was dropped the way a second path
  // was for every other command.
  if (paths.length > 2) {
    console.error('arcod: unexpected argument: ' + paths[2]);
    process.exitCode = 2;
    return;
  }
  const left = await load(a);
  const right = await load(b);
  process.stdout.write(diffSpecs(left.mod.source, left.specPath, right.mod.source, right.specPath));
}

async function runAdopt(args: string[]): Promise<void> {
  // parseFlags already refused a second path for every command but diff, so
  // the one document here is the only argument adopt ever sees.
  const file = args.find((x) => !x.startsWith('-'));
  if (!file) {
    console.error('usage: arcod adopt <openapi.json>');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (err) {
    // `ENOENT: no such file or directory, open '...'` is a stack detail leaked
    // as a message. Say it the way load() does, so every command agrees.
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === 'ENOENT'
      ? 'cannot read ' + file + ': no such file or directory'
      : 'cannot read ' + file + ': ' + fsReason(err));
    process.exitCode = 1;
    return;
  }
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
  // One name; a second argument is refused by parseFlags before this runs.
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
    // The project the caller just named relative to the shell is named the same
    // way here, like every other path the CLI prints.
    console.log('created ' + specLabel(result.dir));
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
  // The file is named the way check and fmt name it: relative to the caller
  // when it lives inside the working directory, absolute only outside. upgrade
  // was the last command printing the absolute path of a file the caller had
  // just named relatively.
  const label = specLabel(loaded.specPath);
  if (from === to) {
    console.log(label + ': already at ' + from);
    return;
  }
  try {
    const migrated = migrateSpec(loaded.mod.source, from, to, basename(loaded.specPath));
    if (flags.write) {
      await writeFile(loaded.specPath, migrated, 'utf8');
      console.log('upgraded ' + label + ' ' + from + ' -> ' + to);
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
  if (!env) {
    // Name the alternatives (or the absence) instead of just refusing: a
    // --env typo and a module with no environments need different fixes.
    const declared = loaded.mod.environments.map((item) => item.name);
    const tail = declared.length
      ? ' — declared: ' + declared.join(', ')
      : ' — module ' + loaded.mod.name + ' declares none; add `environment staging { deploy docker }`';
    const message = 'no environment to deploy' + (flags.env ? ': ' + flags.env : '') + tail;
    // A --json caller gets no manifest here, so the refusal is the payload;
    // throwing left stdout empty and the reason on stderr.
    if (flags.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }
  if (!env.deploy) {
    // No target, no manifest: the note is prose, the refusal is data.
    if (flags.json) {
      console.log(JSON.stringify({ error: 'environment ' + env.name + ' declares no deploy target; docker is assumed by default' }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(env.name + ': deploy is not declared (docker is assumed by default)');
    console.log('available providers: ' + deployNames().join(', '));
    return;
  }
  const spec = deployProvider(env.deploy.provider);
  if (!spec) {
    const message = 'unknown deploy provider ' + env.deploy.provider + '; available: ' + deployNames().join(', ');
    if (flags.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }

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
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  // terraform and deploy refuse an environment the module does not declare;
  // k8s rendered the base topology for the same typo and exited 0, so a gate
  // accepted manifests for an environment that does not exist.
  if (flags.env && !loaded.mod.environments.some((item) => item.name === flags.env)) {
    const declared = loaded.mod.environments.map((item) => item.name);
    throw new Error('no environment to render: ' + flags.env + (declared.length
      ? ' — declared: ' + declared.join(', ')
      : ' — module ' + loaded.mod.name + ' declares none'));
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
      if (!(await writeOut(join(flags.out, file.path), file.content))) return;
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
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  const files = terraformFiles(loaded.mod, { environment: flags.env, registry: loadRegistry(loaded.dir) });
  if (flags.out) {
    for (const file of files) {
      if (!(await writeOut(join(flags.out, file.path), file.content))) return;
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

// Removes the migration files a plan no longer owns. Files that are not part of
// the artifact (a README, a scratch note) are left alone.
async function pruneMigrations(dir: string, owned: Set<string>): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (!entries) return;
  for (const name of entries) {
    if (owned.has(name)) continue;
    if (name !== 'changelog.json' && !/^\d{4}_.+\.(up|down)\.sql$/.test(name)) continue;
    await rm(join(dir, name), { force: true });
  }
}

async function runMigrate(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  const svc = pickService(loaded.mod);
  if (!svc) throw new Error('no service to migrate');
  // The DDL follows the same rule as the build: the bound database decides,
  // an explicit --dialect that disagrees is refused with the bind named.
  // Tables come from the bodies, so a DTO (an ack, a receipt) never becomes one
  // even when a store effect sits on the operation returning it.
  const entities = entitiesFromBodies(
    await implBodiesFor(loaded.dir),
    loaded.mod.types.filter((decl) => decl.type.kind === 'record').map((decl) => decl.name),
  );
  const plan = migrationPlan(loaded.mod, svc, { dialect: dialectNamed(resolveDialect(loaded.mod, dialectFlag(flags))), entities });
  if (plan.migrations.length === 0) {
    // A model that lost its last table must not leave the previous plan on
    // disk: nothing would ever rewrite or remove those files.
    const stale = join(loaded.dir, '.arcod', 'build', 'migrations');
    if (!(await artifactStep(flags, stale, () => pruneMigrations(stale, new Set())))) return;
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else console.log('no stored entities in ' + svc.name + ' — nothing to migrate');
    return;
  }

  const dir = join(loaded.dir, '.arcod', 'build', 'migrations');
  if (!(await artifactStep(flags, dir, () => mkdir(dir, { recursive: true })))) return;
  // Only the files this plan owns survive: a shrunken model renumbers and
  // renames migrations, and an orphan 0003_old.up.sql next to the new changelog
  // is SQL a runner could glob and apply.
  const owned = new Set(['changelog.json']);
  for (const migration of plan.migrations) {
    owned.add(migration.version + '_' + migration.name + '.up.sql');
    owned.add(migration.version + '_' + migration.name + '.down.sql');
  }
  if (!(await artifactStep(flags, dir, () => pruneMigrations(dir, owned)))) return;
  const files: Array<[string, string]> = [[join(dir, 'changelog.json'), JSON.stringify(plan.migrations, null, 2)]];
  for (const migration of plan.migrations) {
    files.push([join(dir, migration.version + '_' + migration.name + '.up.sql'), migration.up]);
    files.push([join(dir, migration.version + '_' + migration.name + '.down.sql'), migration.down]);
  }
  if (!(await writeArtifacts(flags, files))) return;

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatMigrations(plan));
    console.log('');
    console.log('artifact: .arcod/build/migrations/ — changelog.json + up/down .sql');
    console.log('the generated service applies them on boot (sql driver)');
  }
}

// A raw EISDIR/EACCES names the syscall, not what the user did. `adopt`
// already translates a missing input file and load() says "cannot read ...: no
// such file or directory", so every --out path answers the same way instead of
// leaking "EISDIR: illegal operation on a directory, open '...'".
function fsReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EISDIR') return 'is a directory (pass a file path)';
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'a parent path is a file, not a directory';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'no space left on device';
  return err instanceof Error ? err.message : String(err);
}

// prompts and migrate write into .arcod/build themselves, so a bad path
// there — a file where the folder goes, a read-only build tree — reached
// Node's mkdir/writeFile directly and printed "ENOTDIR: not a directory,
// mkdir '...'". Same wording as writeOut, and the summary line is skipped:
// a plan that is not on disk must not be reported as written.
async function artifactStep(flags: Flags, path: string, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    const message = 'cannot write ' + path + ': ' + fsReason(err);
    // A failed artifact write is a refusal too: under --json the reason belongs
    // on stdout as data, not as a line a caller has to scrape off stderr.
    if (flags.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error('arcod: ' + message);
    process.exitCode = 1;
    return false;
  }
}

async function writeArtifacts(flags: Flags, files: Array<[string, string]>): Promise<boolean> {
  for (const [path, text] of files) {
    if (!(await artifactStep(flags, path, () => writeFile(path, text)))) return false;
  }
  return true;
}

async function writeOut(path: string, text: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return true;
  } catch (err) {
    console.error('arcod: cannot write ' + path + ': ' + fsReason(err));
    process.exitCode = 1;
    return false;
  }
}

async function runOpenapi(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  const doc = emitOpenapi(loaded.mod, { service: flags.service });
  const target = flags.out;
  if (!target) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  // graphql and grpc already write a file (and create its directory); the
  // OpenAPI document is the same kind of artifact, so --out behaves the same.
  const path = isAbsolute(target) ? target : join(loaded.dir, target);
  if (!(await writeOut(path, JSON.stringify(doc, null, 2) + '\n'))) return;
  console.log('wrote ' + path);
}

async function runGraphql(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  const sdl = graphqlSchema(loaded.mod, { service: flags.service });
  const target = flags.out;
  if (!target) {
    console.log(sdl);
    return;
  }
  const path = isAbsolute(target) ? target : join(loaded.dir, target);
  // Writing a file into a fresh build directory is the normal case; k8s --out
  // already creates its tree, so the single-file emitters must too instead of
  // failing with a raw ENOENT.
  if (!(await writeOut(path, sdl))) return;
  console.log('wrote ' + path);
}

async function runGrpc(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  const proto = grpcProto(loaded.mod, { service: flags.service });
  const target = flags.out;
  if (!target) {
    console.log(proto);
    return;
  }
  const path = isAbsolute(target) ? target : join(loaded.dir, target);
  if (!(await writeOut(path, proto))) return;
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

  // A provider the runtime cannot drive is listed (compose still provisions it)
  // but never sold as usable: check rejects a service that relies on it.
  const notes = rows.filter((row) => row.noRuntime);
  if (notes.length > 0) {
    console.log('');
    for (const row of notes) {
      console.log('note: ' + row.provider + ' (' + row.capability + '): ' + row.noRuntime);
    }
  }
}

async function runPrompts(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const errors = check(loaded.mod, { registry: loadRegistry(loaded.dir) }).filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }

  const set = buildPrompts(loaded.mod, { budget: flags.maxTokens, format: flags.full ? 'full' : 'compact' });
  const artifactDir = join(loaded.dir, '.arcod', 'build');
  const dir = join(artifactDir, 'prompts');
  const manifest = promptManifest(set);

  // The prompt set is a projection of the contract, exactly like the
  // migrations: a removed operation must not leave its prompt on disk, and a
  // contract with no operations leaves no prompt and no manifest. Without this,
  // a model that shrank keeps feeding the agent a prompt for an operation that
  // no longer exists.
  if (set.tasks.length === 0) {
    if (!(await artifactStep(flags, dir, () => prunePromptFiles(dir, new Set())))) return;
    if (!(await artifactStep(flags, join(artifactDir, 'prompts.json'), () => rm(join(artifactDir, 'prompts.json'), { force: true })))) return;
    if (!(await artifactStep(flags, join(dir, 'manifest.json'), () => rm(join(dir, 'manifest.json'), { force: true })))) return;
    if (flags.json) console.log(JSON.stringify(manifest, null, 2));
    else console.log('no operations in ' + loaded.mod.name + ' — no prompts to build');
    return;
  }

  if (!(await artifactStep(flags, dir, () => mkdir(dir, { recursive: true })))) return;
  if (!(await artifactStep(flags, dir, () => prunePromptFiles(dir, set.tasks.map((task) => task.op + '.md'))))) return;
  const files: Array<[string, string]> = set.tasks.map((task) => [join(dir, task.op + '.md'), task.prompt]);
  files.push([join(artifactDir, 'prompts.json'), JSON.stringify(manifest, null, 2) + '\n']);
  // The build writes the same manifest inside the folder; refresh it here too,
  // so a `prompts` run after a build cannot leave the build's older task list.
  files.push([join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n']);
  if (!(await writeArtifacts(flags, files))) return;

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
    dialect: dialectFlag(flags),
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
    refuseCheckErrors(flags, errors, loaded.specPath);
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

// --dialect names a dialect the same way `arcod migrate` does. An unknown
// value is a usage error, not a silent fall back to mysql.
function dialectFlag(flags: Flags): 'mysql' | 'postgres' | undefined {
  if (flags.dialect === undefined) return undefined;
  if (flags.dialect === 'mysql') return 'mysql';
  if (flags.dialect === 'postgres' || flags.dialect === 'postgresql') return 'postgres';
  throw new UsageError('unknown dialect ' + flags.dialect + ' (mysql, postgres)');
}

// The demo handlers cover create/read only. Without a translation the emitter's
// internal wording ("got: ping") is what the user sees, naming neither the fix
// nor the flag that asked for it. build and test share the sentence, the verb.
interface ReferenceGap {
  line: string;
  missing: string[];
  advice: string;
}

// The same gap has to travel as data when --json asked for data: build and test
// each print a JSON object on success, so prose on the failure path is the one
// shape a parser cannot read. One function returns the parts, the callers pick
// the surface.
function referenceGap(error: unknown, firstLine: string): ReferenceGap | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/templates only for/.test(message)) return null;
  // The emitter names every operation it was given ("got: create, read, ping").
  // Naming the ones without a demo body is the difference between "write some
  // impl file" and "write impl/ping.mjs".
  const got = message.includes('got: ') ? message.slice(message.lastIndexOf('got: ') + 5) : '';
  const missing = got
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name !== 'create' && name !== 'read');
  const advice = missing.length > 0
    ? 'no demo body for ' + missing.join(', ') + ': run `arcod impl` (or `arcod make`) first, or add ' + missing.map((name) => 'impl/' + name + '.mjs').join(', ') + ' by hand.'
    : 'run `arcod impl` (or `arcod make`) first, or add impl/<op>.mjs by hand.';
  return { line: firstLine, missing, advice };
}

async function runBuild(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }
  try {
    const result = await buildExample(loaded.mod, loaded.dir, { port: flags.port, reference: flags.reference, implDir: flags.impl ? undefined : null, registry: loadRegistry(loaded.dir), dialect: dialectFlag(flags) });
    const mode = result.impl.length > 0 ? 'impl' : result.reference ? 'reference' : 'scaffold';
    // A build is the step CI wants to gate and script; the same facts the human
    // lines carry go out as one object, so no output has to be parsed.
    if (flags.json) {
      console.log(JSON.stringify({
        mode,
        dir: result.dir,
        dialect: result.dialect,
        port: result.port,
        reference: result.reference,
        files: result.files,
        images: result.images,
        bodies: result.impl,
      }, null, 2));
      return;
    }
    console.log('arcod build (' + mode + '): ' + result.files.length + ' files in ' + result.dir);
    // The tag is content-addressed: a changed body means a changed tag, which is
    // what makes a plain `docker compose up` pick the new image up.
    console.log('  images: ' + result.images.join(', '));
    console.log('  dialect: ' + result.dialect);
    if (mode === 'impl') {
      console.log('  bodies: ' + result.impl.join(', '));
    } else if (flags.impl) {
      console.log('  no bodies in impl/; run arcod impl first');
    } else if (mode === 'scaffold') {
      console.log('  operation bodies are TODO; use --reference or --impl for a runnable demo');
    }
    for (const file of result.files) console.log('  ' + file);
  } catch (error) {
    const gap = referenceGap(error, 'no operation bodies to build: --reference covers only create and read.');
    if (gap) {
      if (flags.json) {
        console.log(JSON.stringify({ error: gap.line, missing: gap.missing, advice: gap.advice }, null, 2));
      } else {
        console.error(gap.line);
        console.error(gap.advice);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function runTest(flags: Flags): Promise<void> {
  const loaded = await load(flags.spec);
  const diags = check(loaded.mod, { registry: loadRegistry(loaded.dir) });
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    // --json is a contract here too: a caller that parses stdout must not get
    // prose just because the spec has a check error. The report stays a
    // report, with the diagnostics under their own key.
    if (flags.json) {
      console.log(JSON.stringify({ examples: [], rules: [], diagnostics: errors }, null, 2));
      process.exitCode = 1;
      return;
    }
    refuseCheckErrors(flags, errors, loaded.specPath);
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
    // --json is a contract: a caller that parses stdout must not get prose.
    // An empty report is still a report, so both paths print the same shape.
    if (flags.json) console.log(JSON.stringify({ examples: [], rules: [] }, null, 2));
    else console.log('no examples or rules declared');
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
      dialect: dialectFlag(flags),
    });
  } catch (error) {
    const gap = referenceGap(error, 'no operation bodies to test: impl/ is empty and the demo handlers cover only create/read.');
    if (gap) {
      // A report is still a report: the arrays stay, the gap sits beside them.
      if (flags.json) {
        console.log(JSON.stringify({ examples: [], rules: [], error: gap.line, missing: gap.missing, advice: gap.advice }, null, 2));
      } else {
        console.error(gap.line);
        console.error(gap.advice);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const report = await runExamples(loaded.mod, result.dir);

  if (report.examples.length === 0 && report.rules.length === 0) {
    // --json is a contract: a caller that parses stdout must not get prose.
    // An empty report is still a report.
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else console.log('no examples or rules declared');
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
        const mark = rule.skipped ? 'skip  ' : rule.ok ? 'ok    ' : 'fail  ';
        console.log('  ' + mark + rule.rule + (rule.detail ? '  — ' + rule.detail : ''));
      }
    }

    const items = [...report.examples, ...report.rules];
    const failed = items.filter((item) => !item.ok).length;
    // A skipped rule is neither passed nor failed: count it apart so a green
    // summary never hides the predicate v0.1 did not run.
    const skipped = report.rules.filter((rule) => rule.skipped).length;
    console.log('');
    console.log((items.length - failed - skipped) + ' passed, ' + failed + ' failed' + (skipped > 0 ? ', ' + skipped + ' skipped' : ''));
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
  const docker = probeDocker();
  if (!docker.ok) {
    console.error(docker.message);
    return 1;
  }
  return compose({ composeFile, dir: buildDir }, ['down', '--remove-orphans'], flags);
}

async function runRun(flags: Flags): Promise<void> {
  // --json describes a project that was started. A foreground run streams
  // compose logs and never returns, so the object would be the first line of a
  // stream nobody can parse; --down starts nothing to describe. Both are
  // rejected where they are still a usage mistake, not silently ignored.
  if (flags.json && !flags.detach) {
    throw new UsageError(flags.down
      ? '--json describes a started project; --down only stops one'
      : '--json requires --detach: a foreground run streams logs and never returns');
  }
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
    // test answers a report of its own shape; every other reader answers the
    // shared refusal.
    refuseCheckErrors(flags, errors, loaded.specPath);
    return;
  }

  // The reference handlers cover create and read as a pair; a service that
  // declares only one of them never builds. Without this the user reads the
  // emitter's own wording ("templates only for create, read; got: ping"),
  // which names neither the missing body nor a flag that would start anyway.
  let result: Awaited<ReturnType<typeof buildExample>>;
  try {
    result = await buildExample(loaded.mod, loaded.dir, {
      port: flags.port,
      reference: !flags.scaffold && !flags.impl,
      implDir: flags.impl ? undefined : null,
      registry: loadRegistry(loaded.dir),
      dialect: dialectFlag(flags),
    });
  } catch (error) {
    const gap = referenceGap(error, 'arcod run: the demo handlers cover create and read only, and this service does not declare both.');
    if (gap) {
      if (flags.json) {
        console.log(JSON.stringify({ error: gap.line, missing: gap.missing, advice: gap.advice }, null, 2));
      } else {
        console.error(gap.line);
        console.error(gap.advice);
        console.error('or start with the stubs instead: arcod run ' + (flags.spec ?? '.') + ' --scaffold');
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const mode = result.impl.length > 0 ? 'impl' : result.reference ? 'reference' : 'scaffold';
  const docker = probeDocker();
  if (!docker.ok) {
    if (flags.json) console.log(JSON.stringify({ error: docker.message }, null, 2));
    else console.error(docker.message);
    process.exitCode = 1;
    return;
  }

  const url = 'http://localhost:' + result.port;
  const stop = 'arcod run --down';
  if (flags.json) {
    // One object for the facts the human lines carry: a script that starts a
    // service in the background needs the URL and how to stop it, not a regex.
    console.log(JSON.stringify({
      mode,
      name: loaded.mod.name,
      version: loaded.mod.version,
      build: result.dir,
      url,
      port: result.port,
      stop,
    }, null, 2));
  } else {
    if (mode === 'impl') console.log('arcod run: impl bodies (' + result.impl.join(', ') + ')');
    else if (result.reference) console.log('arcod run: reference implementation (operation bodies are templates)');
    else console.log('arcod run: scaffold (operations return 501 until implemented)');
    console.log('arcod run: ' + loaded.mod.name + '@' + loaded.mod.version);
    console.log('  build: ' + result.dir);
    console.log('  url:   ' + url);
    console.log('');
  }

  if (flags.detach) {
    const code = compose(result, ['up', '--build', '-d'], flags);
    if (code === 0 && !flags.json) {
      console.log('stop: ' + (flags.spec ? 'arcod run ' + flags.spec + ' --down' : stop));
    }
    process.exitCode = code;
    return;
  }

  const code = compose(result, ['up', '--build'], flags);
  process.exitCode = code;
}

function compose(result: { composeFile: string; dir: string }, args: string[], flags: Flags): number {
  // In --json mode stdout is the payload: compose's build log goes to stderr,
  // so the one object stays the only thing on stdout.
  const child = spawnSync('docker', ['compose', '-f', result.composeFile, ...args], {
    stdio: flags.json ? ['ignore', 2, 2] : 'inherit',
    cwd: result.dir,
    env: process.env,
  });
  if (child.error) {
    console.error(child.error.message);
    return 1;
  }
  return child.status ?? 1;
}

// Every command that reads a contract refuses a spec that does not check, and
// --json callers need that refusal as data. It lived in eight copies: build,
// test and run answered JSON while migrate, prompts and impl still printed
// prose, so a script that parsed stdout got nothing. One helper, one shape;
// commands without --json keep the human form through the same call.
function refuseCheckErrors(flags: Flags, errors: Diagnostic[], specPath: string): void {
  if (flags.json) {
    console.log(JSON.stringify({ error: 'check failed', diagnostics: errors }, null, 2));
  } else {
    printDiagnostics(errors, specPath, specLabel(specPath));
  }
  process.exitCode = 1;
}

function printDiagnostics(diags: Diagnostic[], specPath: string, label?: string): void {
  // The default is the bare file name, which is enough when one spec is on
  // the line. Every caller now passes `specLabel`, so one file and a pattern
  // name it the same way: a path relative to the caller when it is inside
  // the working directory.
  const name = label ?? specLabel(specPath);
  for (const d of diags) {
    // A diagnostic may live in a body, not in the spec: impl/*.mjs carries its
    // own name and lines, and printing the spec's name next to them pointed the
    // reader at the wrong file with a line number that did not exist there.
    const where = d.file && d.file !== specPath && d.file !== basename(specPath) ? d.file : name;
    console.log(where + ':' + d.range.line + ':' + d.range.col + '  ' + d.severity + '  ' + d.code + '  ' + d.message);
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

// A numeric flag that silently becomes NaN ends up in a manifest
// (replicas: NaN) or in a listen() call. Reject it at the boundary with the
// flag name and the accepted range instead.
// A flag that names a value must get one. `args[++i]` used to hand back
// undefined at the end of the line and `--env`/`--out` silently behaved as if
// they had never been typed; a following `--json` was even swallowed as the
// value. Both are a typo the CLI can name instead of dropping.
function valueFlag(name: string, args: string[], i: number): string {
  const value = args[i];
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new UsageError(name + ' needs a value');
  }
  return value;
}

function intFlag(name: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  const ok = raw !== undefined && raw.trim() !== '' && Number.isInteger(value) && value >= min && value <= max;
  if (!ok) {
    throw new UsageError('invalid value for ' + name + ': ' + JSON.stringify(raw ?? '') +
      ' (expected an integer ' + min + '..' + max + ')');
  }
  return value;
}

function parseFlags(args: string[], command?: string): Flags {
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
    else if (arg === '--env') flags.env = valueFlag('--env', args, ++i);
    else if (arg === '--service') flags.service = valueFlag('--service', args, ++i);
    else if (arg === '--port') flags.port = intFlag('--port', valueFlag('--port', args, ++i), 1, 65535);
    else if (arg === '--model') flags.model = valueFlag('--model', args, ++i);
    else if (arg === '--endpoint') flags.endpoint = valueFlag('--endpoint', args, ++i);
    else if (arg === '--max-tokens') flags.maxTokens = intFlag('--max-tokens', valueFlag('--max-tokens', args, ++i), 1, 1000000);
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
    else if (arg === '--to') flags.to = valueFlag('--to', args, ++i);
    else if (arg === '--helm') flags.helm = true;
    else if (arg === '--plugins') flags.plugins = true;
    else if (arg === '--dialect') flags.dialect = valueFlag('--dialect', args, ++i);
    else if (arg === '--image') flags.image = valueFlag('--image', args, ++i);
    else if (arg === '--host') flags.host = valueFlag('--host', args, ++i);
    else if (arg === '--namespace') flags.namespace = valueFlag('--namespace', args, ++i);
    else if (arg === '--replicas') flags.replicas = intFlag('--replicas', valueFlag('--replicas', args, ++i), 1, 1000);
    else if (arg === '--ingress-class') flags.ingressClass = valueFlag('--ingress-class', args, ++i);
    else if (arg === '--out') flags.out = valueFlag('--out', args, ++i);
    else if (!arg.startsWith('-')) {
      // Two paths on one line used to mean the second one: `arcod build a b`
      // built b and silently dropped a. `diff` is the one command that reads
      // two paths, and it takes them from the raw arguments.
      if (command && NO_PATH_COMMANDS.has(command)) {
        throw new UsageError('unexpected argument: ' + arg);
      }
      if (flags.spec !== undefined && command !== 'diff') {
        throw new UsageError('unexpected argument: ' + arg);
      }
      flags.spec = arg;
    }
    else throw new UsageError('unknown flag: ' + arg);
  }
  return flags;
}

async function load(target?: string): Promise<Loaded> {
  const resolved = resolve(target ?? '.');
  let specPath: string;
  let dir: string;

  const info = await stat(resolved).catch((err) => {
    // "no such file" is the one stat failure that means what it says; an
    // unreadable parent is a permission problem, not a typo.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('cannot read ' + resolved + ': ' + fsReason(err));
  });
  if (info?.isFile()) {
    specPath = resolved;
    dir = join(resolved, '..');
  } else {
    // A path that does not exist is not a directory without a spec. The old
    // branch answered a mistyped file name with "no .arc file found in
    // /typo.arc", which reads like a broken directory, not a typo.
    if (!info) throw new Error('cannot read ' + resolved + ': no such file or directory');
    dir = resolved;
    specPath = await findSpec(dir);
  }

  let source: string;
  try {
    source = await readFile(specPath, 'utf8');
  } catch (err) {
    throw new Error('cannot read ' + specPath + ': ' + fsReason(err));
  }
  const mod = parse(source, basename(specPath));
  return { mod, specPath, dir };
}

async function findSpec(dir: string): Promise<string> {
  const preferred = ['main.arc', 'spec.arc', 'arcod.arc'];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // load() only calls this for a directory it can stat, so failing here is a
    // permission problem; "no .arc file found" would send the user hunting
    // for a spec that is already there.
    throw new Error('cannot read ' + dir + ': ' + fsReason(err));
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.arc')).map((e) => e.name).sort();

  for (const name of preferred) {
    if (files.includes(name)) return join(dir, name);
  }
  if (files.length > 0) {
    // Several specs and no preferred name: the sort order decides, which is
    // deterministic but silent. Say which one was read and what else is there.
    if (files.length > 1) {
      console.error('note: ' + dir + ' holds ' + files.length + ' specs; reading ' + files[0] +
        ' (also: ' + files.slice(1).join(', ') + ') — pass a path or a quoted pattern to choose');
    }
    return join(dir, files[0]);
  }

  const specDir = join(dir, 'spec');
  const nested = await readdir(specDir, { withFileTypes: true }).catch(() => []);
  const nestedFiles = nested.filter((e) => e.isFile() && e.name.endsWith('.arc')).map((e) => e.name).sort();
  if (nestedFiles.length > 0) return join(specDir, nestedFiles[0]);

  throw new Error('no .arc file found in ' + dir);
}

// Every subcommand answers for itself: "arcod <cmd> --help" prints this
// string and exits 0, so a wrong flag never needs a guess from the full page.
export const COMMAND_USAGE: Record<string, string> = {
  check: `usage: arcod check [dir|spec.arc|pattern] [--json] [--env name] [--strict]

Parse the spec and print diagnostics. --json prints a JSON report,
--strict treats warnings as errors, --env checks one environment. A quoted
pattern is expanded here: 'examples/*/main.arc' checks every project.`,
  ast: `usage: arcod ast [dir|spec.arc] [--check] [--json]

Print the parsed module (canonical AST). --check also prints the diagnostics.`,
  plan: `usage: arcod plan [dir|spec.arc] [--json]

Print the build plan: services, routes, capabilities, emitted files.`,
  openapi: `usage: arcod openapi [dir|spec.arc] [--service name] [--out file]

Print the OpenAPI 3.1 document for the spec (or for one service).`,
  graphql: `usage: arcod graphql [dir|spec.arc] [--service name] [--out file]

Print the GraphQL schema (or write it with --out).`,
  grpc: `usage: arcod grpc [dir|spec.arc] [--service name] [--out file]

Print the gRPC .proto (or write it with --out).`,
  migrate: `usage: arcod migrate [dir|spec.arc] [--json] [--dialect mysql|postgres]

Print the migrations for the stored entities. --dialect picks the SQL dialect.`,
  fmt: `usage: arcod fmt [dir|spec.arc|pattern] [--check] [--write] [--to version] [--json]

Print the canonical form of the spec. --check fails when the file differs,
--write rewrites it in place, --to upgrades it across language versions.
A quoted pattern checks or rewrites every match and reports each file by path.
--json (with --check or --write) prints one object instead of the lines:
{mode, ok, files: [{file, status, error?, line?, col?}], changed, failed},
where status is "ok", "not formatted", "formatted" or "failed"; the exit code
is the same as the human form.`,
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
                 [--env name]

Render the topology as Kubernetes manifests; --helm wraps them in a chart.
--replicas sizes the app and web tiers; a provider workload stays at one
replica and rolls as Recreate.`,
  prompts: `usage: arcod prompts [dir|spec.arc] [--max-tokens 1600] [--full] [--json]

Write one deterministic prompt per operation into .arcod/build/prompts.
The compact form is the default; --full adds the task header, contract, io
list and storage shape (a larger prompt for the same body). A rerun removes
<op>.md files the contract no longer declares, refreshes prompts/manifest.json
and clears everything when the contract has no operations.`,
  impl: `usage: arcod impl [dir|spec.arc] [--model qwen2.5-coder:7b] [--endpoint URL]
                   [--dry-run] [--no-cache] [--allow-remote] [--json]

Ask a local Ollama-compatible model for the operation bodies.`,
  make: `usage: arcod make [dir|spec.arc] [--model m] [--force] [--skip-impl] [--no-test]
                   [--reference] [--port 8080] [--endpoint URL] [--max-tokens 1600]
                   [--allow-remote] [--json]

Run the loop: check, prompts, bodies, build, test. Stops at the first failure.`,
  build: `usage: arcod build [dir|spec.arc] [--reference | --impl] [--port 8080]
                     [--dialect mysql|postgres] [--json]

Emit the service, migrations, compose and pages into .arcod/build.`,
  test: `usage: arcod test [dir|spec.arc] [--impl] [--reference] [--port 8080]
                     [--json]

Run the examples and rules against the emitted service.`,
  run: `usage: arcod run [dir|spec.arc] [--impl] [--scaffold] [--port 8080] [--detach] [--down]
                    [--json]

Build and start the project with docker compose. --detach leaves it running,
--down stops what this project started (no rebuild, no cleanup of the build).
--json (with --detach) prints one object — mode, name, version, build, url,
port, stop — and sends the compose log to stderr.`,
  // The two built-ins answered `--help` with "unknown command: version":
  // --help sends every word through COMMAND_USAGE, so a command without an
  // entry was called unknown. They have one now.
  help: `usage: arcod help [command]

Print the main usage, or the usage of one subcommand — the same page
\`arcod <command> --help\` prints.`,
  version: `usage: arcod version

Print the compiler version.`,
};

export const MAIN_USAGE = `arcod ${VERSION} — specification compiler for agent-built services

usage:
  arcod check [dir|spec.arc|pattern] [--json] [--env name] [--strict]
  arcod ast   [dir|spec.arc] [--check] [--json]
  arcod plan  [dir|spec.arc] [--json]
  arcod openapi [dir|spec.arc] [--service name] [--out file]
  arcod graphql [dir|spec.arc] [--service name] [--out file]
  arcod grpc  [dir|spec.arc] [--service name] [--out file]
  arcod migrate [dir|spec.arc] [--json] [--dialect mysql|postgres]
  arcod fmt  [dir|spec.arc|pattern] [--check] [--write] [--to version] [--json]
  arcod diff <a.arc|dir> <b.arc|dir>
  arcod adopt <openapi.json>
  arcod upgrade [dir|spec.arc] [--to version] [--write]
  arcod new <name> [--force]
  arcod lsp
  arcod providers [--json] [--plugins]
  arcod deploy [dir|spec.arc] [--env name] [--json]
  arcod terraform [dir|spec.arc] [--env name] [--out dir]
  arcod k8s   [dir|spec.arc] [--helm] [--image ref] [--host host] [--env name]
                              [--namespace ns] [--replicas n] [--ingress-class c] [--out dir]
  arcod prompts [dir|spec.arc] [--max-tokens 1600] [--full] [--json]
  arcod impl  [dir|spec.arc] [--model qwen2.5-coder:7b] [--endpoint URL]
                              [--dry-run] [--no-cache] [--allow-remote] [--json]
  arcod make  [dir|spec.arc] [--model m] [--force] [--skip-impl] [--no-test]
                              [--reference] [--port 8080] [--endpoint URL]
                              [--max-tokens 1600] [--allow-remote] [--json]
  arcod build [dir|spec.arc] [--reference | --impl] [--port 8080] [--dialect mysql|postgres]
                              [--json]
  arcod test  [dir|spec.arc] [--impl] [--reference] [--port 8080] [--json]
  arcod run   [dir|spec.arc] [--impl] [--scaffold] [--port 8080] [--detach] [--down]
                              [--json]

make runs the whole loop: check, prompts, bodies, build, test. It stops at the
first failing step; --skip-impl and --no-test cut it short, --force regenerates
bodies even when impl/ is populated.

fmt prints the canonical AST form; diff structural-diffs two specs (canonicalized
first); adopt turns an OpenAPI 3.x JSON doc into a spec; upgrade migrates a spec
across language versions (--to, --write). fmt takes --check and --write; upgrade takes --to and --write.

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
A cloud environment (--env prod on a cloud deploy) is rendered from its own
binds: a managed endpoint is read from the <app>-endpoints Secret that the
comment names, and no database is started beside the one the plan creates.
--helm wraps the identical objects in a chart; --out writes files instead of
printing them. Nothing is applied: the output is text only.

examples:
  cd examples/onetimemessage && arcod run
  arcod check examples/onetimemessage
  arcod plan examples/onetimemessage --json`;

function printHelp(): void {
  console.log(MAIN_USAGE);
}
