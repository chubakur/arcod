import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModuleNode } from './ast.ts';
import { emitService, maxBodyBytes } from './emit/service.ts';
import { emitWeb, ssrFirstScreenOp } from './emit/web.ts';
import { composeYaml, nginxConf, serviceDockerfile, webDockerfile } from './emit/compose.ts';
import { buildPrompts } from './prompts.ts';
import { deployManifest, deployProvider, literalMap } from './deploy.ts';
import { helmChart, k8sManifests, type K8sOptions } from './emit/k8s.ts';
import { sandboxViolation } from './impl.ts';
import type { ProviderRegistry } from './registry.ts';
import { createHash } from 'node:crypto';

export interface BuildOptions {
  port?: number;
  reference?: boolean;
  // The sql dialect the emitted service speaks: mysql unless the deployment
  // targets postgres.
  dialect?: 'mysql' | 'postgres';
  implDir?: string | null;
  // Same registry check() uses: a plugin provider's runtime adapter travels
  // with the build instead of being imported from the package at runtime.
  registry?: ProviderRegistry;
}

export interface BuildResult {
  dir: string;
  composeFile: string;
  port: number;
  reference: boolean;
  impl: string[];
  files: string[];
  // Plugin providers whose runtime adapter was copied into this build.
  plugins: string[];
}

async function implDirFor(exampleDir: string): Promise<string> {
  const primary = join(exampleDir, 'impl');
  const entries = await readdir(primary, { withFileTypes: true }).catch(() => null);
  return entries ? primary : join(exampleDir, '.arcod', 'impl');
}

async function readImpl(dir: string): Promise<Record<string, string> | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return undefined;
  const impl: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const op = entry.name.slice(0, -'.mjs'.length);
    impl[op] = await readFile(join(dir, entry.name), 'utf8');
  }
  return Object.keys(impl).length > 0 ? impl : undefined;
}


// A usage-level build failure (bad impl bodies, conflicting names in them) is
// the caller's fault: the CLI prints one line and exits 2, no stack trace.
export class BuildError extends Error {}

// impl/*.mjs bodies are concatenated into one module. A top-level name declared
// in two files is a SyntaxError only when the container starts, so buildExample
// scans the bodies first. This is a declaration scanner, not a full parser:
// comments and string/template literals are skipped, brackets track depth, and
// only depth-zero const/let/var/function/class names are collected.
export function topLevelDeclarations(source: string): string[] {
  const names: string[] = [];
  const text = String(source);
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) {
      index = skipQuoted(text, index, ch);
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0) {
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(index, index + 64));
      if (word) {
        const keyword = word[0];
        if (keyword === 'const' || keyword === 'let' || keyword === 'var' || keyword === 'class' || keyword === 'function') {
          const after = /^\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text.slice(index + keyword.length));
          if (after) names.push(after[1]);
        }
        index += keyword.length;
        continue;
      }
    }
    index += 1;
  }
  return names;
}

function skipQuoted(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function checkImplDeclarations(impl: Record<string, string>): void {
  const declared = new Map<string, { file: string; name: string }>();
  for (const op of Object.keys(impl).sort()) {
    const file = 'impl/' + op + '.mjs';
    const inFile = new Set<string>();
    for (const name of topLevelDeclarations(impl[op])) {
      // The op's own exported function is renamed to impl<Op>, so that is the
      // name that actually lands in the bundled module.
      const effective = name === op ? 'impl' + op.charAt(0).toUpperCase() + op.slice(1) : name;
      if (inFile.has(effective)) continue;
      inFile.add(effective);
      const previous = declared.get(effective);
      if (previous) {
        throw new BuildError('duplicate top-level name "' + name + '" in ' + previous.file + ' and ' + file);
      }
      declared.set(effective, { file, name });
    }
  }
}

export async function buildExample(mod: ModuleNode, exampleDir: string, options: BuildOptions = {}): Promise<BuildResult> {
  const port = options.port ?? 8080;
  const dir = join(exampleDir, '.arcod', 'build');
  const serviceDir = join(dir, 'service');
  const webDir = join(dir, 'web');

  await rm(dir, { recursive: true, force: true });
  await mkdir(serviceDir, { recursive: true });
  if (mod.uis.length > 0) await mkdir(webDir, { recursive: true });

  const hasUi = mod.uis.length > 0;
  const reference = options.reference === true;
  const impl =
    options.implDir === null ? undefined : await readImpl(options.implDir ?? (await implDirFor(exampleDir)));

  // Bodies are part of the model, not an anonymous blob: every impl/ body is
  // checked against the sandbox (no raw network/fs/exec/process, only io) and
  // hashed into a provenance manifest next to the build output.
  const implManifest: Record<string, { sha256: string; bytes: number; source: string }> = {};
  if (impl) {
    checkImplDeclarations(impl);
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
  const service = emitService(mod, { reference, impl, registry: options.registry, dialect: options.dialect, pages });

  const files: Array<[string, string]> = [
    [join(serviceDir, 'index.mjs'), service],
    [join(serviceDir, 'Dockerfile'), serviceDockerfile()],
  ];

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
  files.push([join(dir, 'docker-compose.yml'), composeYaml(mod, port, webContainer, options.registry, options.dialect)]);

  // Deterministic prompts are part of the build output: one per operation,
  // each carrying only its own contract and the capability signatures.
  const prompts = buildPrompts(mod);
  const promptDir = join(dir, 'prompts');
  await mkdir(promptDir, { recursive: true });
  for (const task of prompts.tasks) {
    const path = join(promptDir, task.op + '.md');
    files.push([path, task.prompt]);
  }
  files.push([
    join(promptDir, 'manifest.json'),
    JSON.stringify(
      {
        module: prompts.module,
        version: prompts.version,
        modelHash: prompts.modelHash,
        budget: prompts.budget,
        tasks: prompts.tasks.map((task) => ({
          id: task.id,
          op: task.op,
          file: task.file,
          tokens: task.tokens,
          sha256: task.sha256,
          unresolved: task.unresolved,
        })),
      },
      null,
      2,
    ) + '\n',
  ]);

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
        image: args.image,
        namespace: args.namespace,
        replicas: args.replicas !== undefined ? Number(args.replicas) : undefined,
        host: args.host,
        ingressClass: args.ingressClass,
        dialect: options.dialect,
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
    impl: impl ? Object.keys(impl).sort() : [],
    files: files.map(([path]) => path),
    plugins: pluginEntries.map((entry) => entry.provider),
  };
}
