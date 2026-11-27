import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { EnvironmentNode, ModuleNode } from './ast.ts';
import { emitService, maxBodyBytes, pickService } from './emit/service.ts';
import { emitWeb, ssrFirstScreenOp } from './emit/web.ts';
import { goDockerfile, goMain, goMod, goOps, goUnsupported } from './emit/go.ts';
import { composeYaml, localEnvironment, localImage, nginxConf, serviceDockerfile, webDockerfile } from './emit/compose.ts';
import { buildPrompts, promptManifest, promptPath } from './prompts.ts';
import { deployManifest, deployProvider, literalMap } from './deploy.ts';
import { entitiesFromBodies, migrationPlan } from './migrate.ts';
import { dialectNamed } from './dialects.ts';
import { kebab } from './plan.ts';
import { helmChart, k8sManifests, type K8sOptions } from './emit/k8s.ts';
import { implCollisions, implSignatureProblems, sandboxViolation, topLevelDeclarations } from './impl.ts';

export { topLevelDeclarations };
import { providerFor } from './providers.ts';
import type { ProviderRegistry } from './registry.ts';
import { createHash } from 'node:crypto';

export interface BuildOptions {
  port?: number;
  reference?: boolean;
  // The sql dialect the emitted service speaks: mysql unless the deployment
  // targets postgres.
  dialect?: 'mysql' | 'postgres';
  // The environment whose binds decide the dialect. Without it the local one
  // decides; with it a prod build speaks what prod binds, not what dev does.
  env?: string;
  implDir?: string | null;
  // impl/lib.mjs, when the caller already read it; null means the project has
  // none and the build should not look.
  implLib?: string | null;
  // Same registry check() uses: a plugin provider's runtime adapter travels
  // with the build instead of being imported from the package at runtime.
  registry?: ProviderRegistry;
}

export interface BuildResult {
  dir: string;
  composeFile: string;
  port: number;
  reference: boolean;
  // The dialect the generated store and migrations actually speak.
  dialect: 'mysql' | 'postgres';
  impl: string[];
  files: string[];
  // Plugin providers whose runtime adapter was copied into this build.
  plugins: string[];
  // Content-addressed image names: compose rebuilds when a tag changes.
  images: string[];
}

// The tag of a generated container follows the content of its build context, so
// a stale image cannot survive `arcod build --impl` followed by a plain
// `docker compose up`: a new body means a new tag and therefore a build.
function imageRevision(files: Array<[string, string]>, dir: string): string {
  const hash = createHash('sha256');
  const contexts = [join(dir, 'service') + sep, join(dir, 'web') + sep];
  const inside = files
    .filter(([path]) => contexts.some((prefix) => path.startsWith(prefix)))
    .map(([path, content]) => [relative(dir, path).split(sep).join('/'), content] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [path, content] of inside) hash.update(path).update('\0').update(content).update('\0');
  return hash.digest('hex').slice(0, 12);
}

async function implDirFor(exampleDir: string): Promise<string> {
  const primary = join(exampleDir, 'impl');
  const entries = await readdir(primary, { withFileTypes: true }).catch(() => null);
  return entries ? primary : join(exampleDir, '.arcod', 'impl');
}

// A body of an operation, with the file the reader found it in.
export interface ImplFile {
  op: string;
  file: string;
  content: string;
}

// One operation, two bodies. The build keys bodies by operation name (that is
// the name the emitter calls), so two files for the same operation cannot both
// win: the scan reports them instead of picking one by directory order.
export interface ImplDuplicate {
  op: string;
  files: string[];
}

export interface ImplScan {
  bodies: Record<string, string> | undefined;
  duplicates: ImplDuplicate[];
}

// Body layout (B109): one language in a module keeps the flat `impl/<op>.mjs`;
// a module with several services files each body under its service, so
// `impl/api/totals.mjs` and `impl/worker/totals.mjs` never look like the same
// body. Only a directory named after a declared internal service is a body
// folder: `impl/ops/` stays an ignored directory (W051), not a service.
export async function scanImplFiles(dir: string, serviceNames: string[] = []): Promise<ImplFile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const files: ImplFile[] = [];
  const read = async (name: string, file: string): Promise<void> => {
    if (!name.endsWith('.mjs')) return;
    const op = name.slice(0, -'.mjs'.length);
    if (op === LIB_BODY) return;
    files.push({ op, file, content: await readFile(join(dir, file), 'utf8') });
  };
  for (const entry of entries) {
    if (entry.isFile()) await read(entry.name, entry.name);
  }
  const services = new Set(serviceNames);
  for (const entry of entries) {
    if (!entry.isDirectory() || !services.has(entry.name)) continue;
    const inner = await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => null);
    if (!inner) continue;
    for (const item of inner) {
      if (item.isFile()) await read(item.name, entry.name + '/' + item.name);
    }
  }
  return files;
}

// Go bodies live at impl/<op>.go (one service) or impl/<service>/<op>.go
// (B109) and are spliced into the generated ops.go verbatim. A file that
// repeats the package clause would produce a second package inside one file,
// so it is refused with the file name rather than producing a broken build.
async function readGoBodies(
  dir: string,
  serviceNames: string[],
  single: boolean,
): Promise<{ bodies: Record<string, string>; files: string[] }> {
  const bodies: Record<string, string> = {};
  const files: string[] = [];
  const read = async (file: string, display: string): Promise<void> => {
    const text = await readFile(join(dir, file), 'utf8');
    if (text.trim().length === 0) throw new BuildError('Go body ' + display + ' is empty');
    if (/^\s*package\s+/m.test(text)) {
      throw new BuildError(
        'Go body ' + display + ' declares a package; arcod splices the function into ops.go, so leave the package clause out',
      );
    }
    if (!/func\s+op[A-Za-z0-9_]*\s*\(/.test(text)) {
      throw new BuildError('Go body ' + display + ' has no func op<Name>(in map[string]any) (any, error) signature');
    }
    const op = file.slice(file.lastIndexOf('/') + 1, -'.go'.length);
    if (bodies[op] !== undefined) throw new BuildError('operation ' + op + ' has two Go bodies: ' + display);
    bodies[op] = text.trimEnd() + '\n';
    files.push(display);
  };
  const visit = async (base: string, prefix: string): Promise<void> => {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.go')) continue;
      await read(prefix + entry.name, 'impl/' + prefix + entry.name);
    }
  };
  if (single) await visit(dir, '');
  for (const name of serviceNames) await visit(join(dir, name), name + '/');
  return { bodies, files };
}

function duplicatesIn(files: ImplFile[]): ImplDuplicate[] {
  const placed = new Map<string, string[]>();
  for (const item of files) {
    placed.set(item.op, [...(placed.get(item.op) ?? []), 'impl/' + item.file]);
  }
  return [...placed]
    .filter(([, found]) => found.length > 1)
    .map(([op, found]) => ({ op, files: found.sort() }));
}

export async function implScanFor(exampleDir: string, serviceNames: string[] = []): Promise<ImplScan> {
  const files = await scanImplFiles(await implDirFor(exampleDir), serviceNames);
  const bodies: Record<string, string> = {};
  for (const item of files) {
    if (!(item.op in bodies)) bodies[item.op] = item.content;
  }
  return { bodies: Object.keys(bodies).length > 0 ? bodies : undefined, duplicates: duplicatesIn(files) };
}

// The bodies the build reads are also the evidence `arcod migrate` uses to
// tell an entity from a DTO: both commands must name the same tables.
export async function implBodiesFor(exampleDir: string, serviceNames: string[] = []): Promise<Record<string, string> | undefined> {
  return (await implScanFor(exampleDir, serviceNames)).bodies;
}

// The same operation filed twice is a build error and a check error, so both
// callers see the same evidence: the operation and both files.
export async function implDuplicatesFor(exampleDir: string, serviceNames: string[] = []): Promise<ImplDuplicate[]> {
  return (await implScanFor(exampleDir, serviceNames)).duplicates;
}

// readImpl bundles only *.mjs, so a body saved as impl/totals.js was invisible:
// nothing named it, nothing warned, and the route answered 501 NotImplemented.
// The check can only warn about files the caller lists, so the CLI asks for the
// names the build skipped.
export async function implIgnoredFiles(exampleDir: string, serviceNames: string[] = []): Promise<string[]> {
  const dir = await implDirFor(exampleDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.mjs')) found.push(entry.name);
  }
  // A body folder is read now (B109), so a wrong extension inside it is just as
  // invisible as a flat one: impl/Store/create.js was bundled by nobody. The
  // file is reported with its folder, the same spelling the check prints.
  const services = new Set(serviceNames);
  for (const entry of entries) {
    if (!entry.isDirectory() || !services.has(entry.name)) continue;
    const inner = await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => null);
    if (!inner) continue;
    for (const item of inner) {
      if (item.isFile() && !item.name.startsWith('.') && !item.name.endsWith('.mjs')) found.push(entry.name + '/' + item.name);
    }
  }
  return found.sort();
}

// readImpl reads impl/ one level deep, so a body filed under impl/ops/totals.mjs
// (or a helper library in impl/lib/) was dropped without a word -- the same
// silence W051 closes for a wrong extension. An empty directory is harmless, so
// only a directory that actually holds .mjs files is worth naming.
export async function implIgnoredDirs(exampleDir: string, serviceNames: string[] = []): Promise<Array<{ name: string; bodies: number }>> {
  const dir = await implDirFor(exampleDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  // A folder named after a service is not ignored: scanImplFiles reads it
  // (B109), so it must not be reported as dead weight.
  const services = new Set(serviceNames);
  const found: Array<{ name: string; bodies: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || services.has(entry.name)) continue;
    const inner = await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => null);
    if (!inner) continue;
    const bodies = inner.filter((item) => item.isFile() && !item.name.startsWith('.') && item.name.endsWith('.mjs')).length;
    if (bodies > 0) found.push({ name: entry.name, bodies });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// impl/lib.mjs is not the body of an operation called "lib": it is the shared
// module every body sees, bundled once before the bodies (issue #39). It is
// read separately, so it never looks like an orphan body to W049.
const LIB_BODY = 'lib';

async function readImpl(dir: string, serviceNames: string[] = []): Promise<Record<string, string> | undefined> {
  const files = await scanImplFiles(dir, serviceNames);
  const impl: Record<string, string> = {};
  for (const item of files) {
    if (!(item.op in impl)) impl[item.op] = item.content;
  }
  return Object.keys(impl).length > 0 ? impl : undefined;
}

// The lib sits in the impl directory itself, so a caller that names that
// directory (build --impl, tests) reads the same file as one that names the
// project.
async function readImplLibIn(dir: string): Promise<string | undefined> {
  return readFile(join(dir, LIB_BODY + '.mjs'), 'utf8').catch(() => undefined);
}

export async function implLibFor(exampleDir: string): Promise<string | undefined> {
  return readImplLibIn(await implDirFor(exampleDir));
}


// A usage-level build failure (bad impl bodies, conflicting names in them) is
// the caller's fault: the CLI prints one line and exits 2, no stack trace.
export class BuildError extends Error {}

// The dialect a build speaks follows the bound database: a spec that binds
// `store -> postgres` cannot run on a MySQL client, and a build that silently
// shipped one died on start with "this build speaks mysql but DATABASE_URL uses
// postgres://". An explicit --dialect still wins when the spec binds nothing;
// when it disagrees with a bind the build refuses and names the bind.
export function resolveDialect(mod: ModuleNode, explicit?: 'mysql' | 'postgres', env?: string): 'mysql' | 'postgres' {
  const sqlBinds = (environment: EnvironmentNode | undefined) => (environment?.binds ?? []).flatMap((bind) => {
    const spec = providerFor(bind.provider);
    if (!spec || spec.capability !== 'sql') return [];
    const dialect: 'mysql' | 'postgres' = spec.name === 'postgres' ? 'postgres' : 'mysql';
    return [{ alias: bind.alias, provider: bind.provider, dialect }];
  });
  // One build produces one store, so the local environment — the one compose
  // and `arcod run` use — decides. A spec that only binds the database in
  // another environment still gets its dialect, as long as those agree.
  let bound: Array<{ alias: string; provider: string; dialect: 'mysql' | 'postgres' }>;
  if (env) {
    const named = mod.environments.find((item) => item.name === env);
    if (!named) {
      const declared = mod.environments.map((item) => item.name);
      throw new BuildError(
        'unknown environment ' + env + (declared.length > 0 ? '; declared: ' + declared.join(', ') : '; the module declares no environments'),
      );
    }
    bound = sqlBinds(named);
  } else {
    bound = sqlBinds(localEnvironment(mod));
  }
  if (bound.length === 0 && !env) {
    for (const env of mod.environments) {
      for (const item of sqlBinds(env)) {
        if (!bound.some((seen) => seen.dialect === item.dialect)) bound.push(item);
      }
    }
  }
  const dialects = [...new Set(bound.map((item) => item.dialect))];
  if (dialects.length > 1) {
    throw new BuildError(
      'sql binds disagree on the dialect: ' + bound.map((item) => 'bind ' + item.alias + ' -> ' + item.provider).join(', ') +
      '; keep one database per service',
    );
  }
  const inferred = dialects[0];
  if (explicit && inferred && explicit !== inferred) {
    const item = bound.find((item) => item.dialect === inferred)!;
    throw new BuildError(
      '--dialect ' + explicit + ' conflicts with bind ' + item.alias + ' -> ' + item.provider + ', which speaks ' + inferred,
    );
  }
  return explicit ?? inferred ?? 'mysql';
}

// A top-level name declared in two bodies is a SyntaxError in the bundled
// module; the scanner lives in impl.ts so check reports the same collision
// before a build is ever started.
function checkImplDeclarations(impl: Record<string, string>, lib?: string): void {
  const collision = implCollisions(lib ? { ...impl, [LIB_BODY]: lib } : impl)[0];
  if (collision) {
    throw new BuildError('duplicate top-level name "' + collision.name + '" in ' + collision.firstFile + ' and ' + collision.file);
  }
  // The signature is the contract between the emitter and the body: the
  // handler calls implFn(input, io). A body that exports another name, or that
  // reads io.* from the first parameter, builds clean and answers 500 at
  // request time (issue #34), so the build refuses it with the file and line.
  const signature = implSignatureProblems(impl)[0];
  if (signature) {
    throw new BuildError(signature.message + ' (' + signature.file + ':' + signature.line + '); ' + signature.hint);
  }
}

// A build must never publish a half-written tree, and a failed rebuild must
// not destroy the last good one. Everything is emitted into a sibling staging
// directory and swapped in only after the last file is written.
export async function buildExample(mod: ModuleNode, exampleDir: string, options: BuildOptions = {}): Promise<BuildResult> {
  // `language:` picks the emitter. Node and Go have one; Python (B108) does
  // not, and generating Node for a service that asked for Python would be
  // exactly the silent wrong-runtime bug the clause is meant to prevent.
  const unsupported = mod.services.find((svc) => !svc.external && svc.language && svc.language !== 'node' && svc.language !== 'go');
  if (unsupported) {
    throw new BuildError(
      'service ' + unsupported.name + ' asks for language: ' + unsupported.language +
      ', but this build emits node and go only; drop the clause or wait for the ' + unsupported.language + ' emitter',
    );
  }
  const dir = join(exampleDir, '.arcod', 'build');
  const staging = dir + '.tmp-' + process.pid;
  await cleanAbandonedTrees(dir);
  await rm(staging, { recursive: true, force: true });
  try {
    const result = await buildInto(mod, exampleDir, staging, options);
    await publishTree(staging, dir);
    // The staging prefix never escapes: callers see the paths they will use.
    const rebase = (path: string): string =>
      path === staging ? dir : path.startsWith(staging + sep) ? join(dir, path.slice(staging.length + 1)) : path;
    return { ...result, dir, composeFile: join(dir, 'docker-compose.yml'), files: result.files.map(rebase) };
  } catch (error) {
    // Nothing half-written survives a failed build; the previous tree (if any)
    // is still in place, so a rebuild that fails is a no-op on disk.
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// A build killed mid-way leaves its staging (or the previous tree it was
// replacing) behind, and nobody will ever publish it. Sweep siblings whose
// owner process is gone; a live pid is another build of the same project and
// is left alone.
async function cleanAbandonedTrees(target: string): Promise<void> {
  const parent = dirname(target);
  const base = target.slice(parent.length + 1) + '.';
  const entries = await readdir(parent).catch(() => null);
  if (!entries) return;
  for (const name of entries) {
    if (!name.startsWith(base + 'tmp-') && !name.startsWith(base + 'old-')) continue;
    const pid = Number(name.slice(name.lastIndexOf('-') + 1));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (alive(pid)) continue;
    await rm(join(parent, name), { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function publishTree(staging: string, target: string): Promise<void> {
  const old = target + '.old-' + process.pid;
  await rm(old, { recursive: true, force: true });
  let moved = false;
  try {
    await rename(target, old);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, target);
  } catch (error) {
    if (moved) await rename(old, target).catch(() => {});
    throw error;
  }
  if (moved) await rm(old, { recursive: true, force: true });
}

async function buildInto(mod: ModuleNode, exampleDir: string, dir: string, options: BuildOptions = {}): Promise<BuildResult> {
  const port = options.port ?? 8080;
  const webDir = join(dir, 'web');

  // One build context per internal service. A module with one service keeps
  // the historical "service/" directory; the second and later services get
  // their own context beside it, so no service can be silently dropped.
  const ownServices = mod.services.filter((item) => !item.external);
  const serviceBuilds = ownServices.length === 0
    ? [{ service: null, dirName: 'service' }]
    : ownServices.map((svc, index) => ({ service: svc, dirName: index === 0 ? 'service' : 'service-' + kebab(svc.name) }));
  const serviceDirs = serviceBuilds.map((item) => join(dir, item.dirName));

  await rm(dir, { recursive: true, force: true });
  for (const serviceDir of serviceDirs) await mkdir(serviceDir, { recursive: true });
  if (mod.uis.length > 0) await mkdir(webDir, { recursive: true });

  const hasUi = mod.uis.length > 0;
  const reference = options.reference === true;
  // The store, the migrations and the compose provider all follow one dialect,
  // so they are resolved once, before anything is emitted.
  const dialect = resolveDialect(mod, options.dialect, options.env);
  // Per-service body folders are read for declared internal services only.
  const bodyServices = mod.services.filter((svc) => !svc.external).map((svc) => svc.name);
  const implDir = options.implDir ?? (await implDirFor(exampleDir));
  const impl =
    options.implDir === null ? undefined : await readImpl(implDir, bodyServices);
  // One operation, two bodies: the emitter keys bodies by operation name, so
  // choosing one by directory order would run a body nobody asked for. The
  // check names the same pair before a build starts (A107).
  if (options.implDir !== null) {
    const duplicates = duplicatesIn(await scanImplFiles(implDir, bodyServices));
    if (duplicates.length > 0) {
      throw new BuildError('operation ' + duplicates[0].op + ' has two bodies: ' + duplicates[0].files.join(' and '));
    }
  }
  // options.implDir names the impl directory itself, not the project.
  const implLib = options.implLib === null
    ? undefined
    : options.implLib ?? (options.implDir === null
      ? undefined
      : await readImplLibIn(options.implDir ?? (await implDirFor(exampleDir))));

  // Bodies are part of the model, not an anonymous blob: every impl/ body is
  // checked against the sandbox (no raw network/fs/exec/process, only io) and
  // hashed into a provenance manifest next to the build output.
  const implManifest: Record<string, { sha256: string; bytes: number; source: string }> = {};
  // The lib is bundled too, so it is held to the same sandbox and shares the
  // top-level namespace the collision scan guards.
  if (implLib) {
    const violation = sandboxViolation(implLib);
    if (violation) throw new Error('impl/lib.mjs violates the sandbox: ' + violation);
    implManifest[LIB_BODY] = {
      sha256: createHash('sha256').update(implLib).digest('hex'),
      bytes: Buffer.byteLength(implLib),
      source: 'impl',
    };
  }
  if (impl) {
    checkImplDeclarations(impl, implLib);
    for (const op of Object.keys(impl).sort()) {
      const violation = sandboxViolation(impl[op]);
      if (violation) throw new Error('impl body ' + op + '.mjs violates the sandbox: ' + violation);
      implManifest[op] = {
        sha256: createHash('sha256').update(impl[op]).digest('hex'),
        bytes: Buffer.byteLength(impl[op]),
        source: 'impl',
      };
    }
  }

  const webHtml = hasUi ? emitWeb(mod, { maxBytes: maxBodyBytes(mod) }) : null;
  // render: ssr means the service serves the page; build still writes the web
  // container so a deployment can pick either front door.
  const firstUi = mod.uis[0];
  const pages = webHtml && firstUi && firstUi.render === 'ssr'
    ? [{ route: firstUi.route, html: webHtml, dataOp: ssrFirstScreenOp(mod) }]
    : [];
  const files: Array<[string, string]> = [];
  for (const [index, build] of serviceBuilds.entries()) {
    const serviceDir = serviceDirs[index]!;
    if ((build.service?.language ?? 'node') === 'go') {
      const svc = build.service!;
      const missing = goUnsupported(mod, svc);
      if (missing.length > 0) {
        throw new BuildError(
          'service ' + svc.name + ' is language: go, but the Go kit does not carry ' + missing.join(', ') +
          ' yet; keep the service in node or wait for the next Go slice',
        );
      }
      const { bodies } = await readGoBodies(implDir, [svc.name], ownServices.length === 1);
      files.push(
        [join(serviceDir, 'main.go'), goMain(mod, svc)],
        [join(serviceDir, 'ops.go'), goOps(mod, svc, bodies)],
        [join(serviceDir, 'go.mod'), goMod(svc)],
        [join(serviceDir, 'Dockerfile'), goDockerfile()],
      );
      continue;
    }
    const service = emitService(mod, {
      reference,
      impl,
      implLib,
      registry: options.registry,
      dialect,
      // An ssr page is served by the service the ui names; only the first
      // service carries it today, so the page cannot be emitted twice.
      pages: index === 0 ? pages : [],
      service: build.service?.name,
    });
    files.push(
      [join(serviceDir, 'index.mjs'), service],
      [join(serviceDir, 'Dockerfile'), serviceDockerfile()],
    );
  }

  if (hasUi && webHtml) {
    // The static copy has no service behind it, so the data slot it cannot
    // fill is null — a marker left in a served file would be invalid script.
    files.push(
      [join(webDir, 'index.html'), webHtml.replaceAll('__ARC_SSR_DATA__', 'null')],
      [join(webDir, 'nginx.conf'), nginxConf(mod)],
      [join(webDir, 'Dockerfile'), webDockerfile()],
    );
  }

  // render: ssr serves the page from the service, so compose needs no nginx
  // sidecar for the first screen.
  const webContainer = hasUi && firstUi?.render !== 'ssr';
  // The tag is computed from the very files written below, so compose derives
  // `up` behaviour from content, not from a timestamp or a cache.
  const revision = imageRevision(files, dir);
  files.push([join(dir, 'docker-compose.yml'), composeYaml(mod, port, webContainer, options.registry, dialect, revision)]);

  // Deterministic prompts are part of the build output: one per operation,
  // each carrying only its own contract and the capability signatures.
  const prompts = buildPrompts(mod);
  const promptDir = join(dir, 'prompts');
  await mkdir(promptDir, { recursive: true });
  for (const task of prompts.tasks) {
    const path = join(promptDir, promptPath(prompts, task));
    files.push([path, task.prompt]);
  }
  const promptManifestJson = JSON.stringify(promptManifest(prompts), null, 2) + '\n';
  files.push([join(promptDir, 'manifest.json'), promptManifestJson]);
  // The loose prompts.json is what `arcod prompts` writes and what scripts
  // read; a build publishes the same manifest, so the wrapper commands cannot
  // lose the file when they rebuild the tree.
  files.push([join(dir, 'prompts.json'), promptManifestJson]);

  // Migrations travel with the build. The service embeds the same plan and
  // applies it on boot, so the .sql artifact beside it is written from the same
  // call: a rebuild cannot leave a stale copy behind and the two cannot
  // disagree. The entity set is the one the bodies prove, so a DTO stays a DTO.
  // Migrations travel with the build. The service embeds the same plan and
  // applies it on boot, so the .sql artifact beside it is written from the same
  // call: a rebuild cannot leave a stale copy behind and the two cannot
  // disagree. The entity set is the one the bodies prove, so a DTO stays a DTO.
  // A module may declare several services, each with its own store: the first
  // keeps the historical migrations/ directory, a later one gets
  // migrations-<key>/ beside it, the same key its build context uses.
  const declaredRecords = mod.types.filter((decl) => decl.type.kind === 'record').map((decl) => decl.name);
  const entities = entitiesFromBodies(impl, declaredRecords);
  for (const [index, svcNode] of mod.services.filter((svc) => !svc.external).entries()) {
    const plan = migrationPlan(mod, svcNode, { dialect: dialectNamed(dialect), entities });
    if (plan.migrations.length === 0) continue;
    const migrationDir = join(dir, index === 0 ? 'migrations' : 'migrations-service-' + kebab(svcNode.name));
    await mkdir(migrationDir, { recursive: true });
    files.push([join(migrationDir, 'changelog.json'), JSON.stringify(plan.migrations, null, 2)]);
    for (const migration of plan.migrations) {
      files.push([join(migrationDir, migration.version + '_' + migration.name + '.up.sql'), migration.up]);
      files.push([join(migrationDir, migration.version + '_' + migration.name + '.down.sql'), migration.down]);
    }
  }

  // Body provenance: which ops have impl bodies, their hashes, and the emit
  // mode. Together with the sandbox check above this makes a body part of the
  // auditable build, not a hidden file next to the model.
  files.push([
    join(dir, 'impl-manifest.json'),
    JSON.stringify(
      {
        mode: impl ? 'impl' : reference ? 'reference' : 'scaffold',
        bodies: implManifest,
      },
      null,
      2,
    ) + '\n',
  ]);

  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: 'utf8', mode: 0o644 });
  }

  // Cloud environments are packaged as a manifest next to the local compose
  // build. The manifest is declarative: nothing is uploaded or called.
  for (const environment of mod.environments) {
    const deploy = environment.deploy;
    if (!deploy) continue;
    const spec = deployProvider(deploy.provider);
    if (!spec) continue;
    if (spec.artifacts === 'manifest') {
      await writeFile(
        join(dir, 'deploy.' + environment.name + '.json'),
        JSON.stringify(deployManifest(mod, environment), null, 2) + '\n',
        { encoding: 'utf8', mode: 0o644 },
      );
      continue;
    }
    if (spec.artifacts === 'k8s' || spec.artifacts === 'helm') {
      const args = literalMap(deploy.args);
      const k8sOptions: K8sOptions = {
        // The manifests belong to this environment: its binds decide the
        // providers, so prod cannot be rendered as the docker view.
        environment: environment.name,
        image: args.image,
        namespace: args.namespace,
        replicas: args.replicas !== undefined ? Number(args.replicas) : undefined,
        host: args.host,
        ingressClass: args.ingressClass,
        dialect,
      };
      const emitted = spec.artifacts === 'helm' ? helmChart(mod, k8sOptions) : k8sManifests(mod, k8sOptions);
      // One environment keeps the plain directory; several get a suffix so
      // their manifests never overwrite each other.
      const base = join(dir, spec.artifacts + (mod.environments.length > 1 ? '-' + environment.name : ''));
      for (const file of emitted) {
        const path = join(base, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, { encoding: 'utf8', mode: 0o644 });
        files.push([path, file.content]);
      }
    }
  }

  // A plugin provider's adapter is a file inside its package, not a dependency
  // of the generated service: copy it in and record where it landed. The
  // service does not import it yet (B11.3b wires the dispatch).
  const pluginEntries: Array<{ provider: string; package: string; source: string; target: string; export?: string }> = [];
  for (const environment of mod.environments) for (const bind of environment.binds) {
    const spec = options.registry?.get(bind.provider);
    const runtime = spec?.runtime;
    if (!spec || !runtime) continue;
    if (pluginEntries.some((entry) => entry.provider === spec.name)) continue;
    const source = join(runtime.dir, runtime.adapter);
    const target = join(dir, 'plugins', spec.name + '.mjs');
    await mkdir(dirname(target), { recursive: true });
    // A declared adapter that is not in the package would only fail when the
    // container starts, far from the manifest that lied; fail the build.
    try {
      await cp(source, target);
    } catch (error) {
      throw new Error(
        'plugin ' + (options.registry?.origin[spec.name] ?? spec.name) + ' declares runtime.adapter ' + runtime.adapter +
        ' but it cannot be read: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
    pluginEntries.push({
      provider: spec.name,
      package: options.registry?.origin[spec.name] ?? '',
      source: runtime.adapter,
      target: join('plugins', spec.name + '.mjs'),
      export: runtime.export,
    });
  }
  if (pluginEntries.length > 0) {
    await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: pluginEntries }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o644,
    });
  }

  // Files a provider imports (a Keycloak realm, for instance) travel with the
  // build, so the compose file only refers to its own directory.
  for (const bind of mod.environments[0]?.binds ?? []) {
    const file = bind.args.import;
    if (!file || file.kind !== 'literal' || typeof file.value !== 'string') continue;
    const name = file.value.split('/').pop()!;
    await cp(join(exampleDir, file.value), join(dir, name));
  }

  return {
    dir,
    composeFile: join(dir, 'docker-compose.yml'),
    port,
    reference,
    dialect,
    impl: impl ? Object.keys(impl).sort() : [],
    files: files.map(([path]) => path),
    plugins: pluginEntries.map((entry) => entry.provider),
    images: [
      localImage(mod, 'service', revision),
      ...(webContainer ? [localImage(mod, 'web', revision)] : []),
    ],
  };
}
