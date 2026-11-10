import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleNode } from '../ast.ts';
import { emitService, maxBodyBytes } from './emit/service.ts';
import { emitWeb } from './emit/web.ts';
import { composeYaml, nginxConf, serviceDockerfile, webDockerfile } from './emit/compose.ts';
import { buildPrompts } from './prompts.ts';

export interface BuildOptions {
  port?: number;
  reference?: boolean;
  implDir?: string | null;
}

export interface BuildResult {
  dir: string;
  composeFile: string;
  port: number;
  reference: boolean;
  impl: string[];
  files: string[];
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
  const impl = options.implDir === null ? undefined : await readImpl(options.implDir ?? join(exampleDir, 'impl'));
  const service = emitService(mod, { reference, impl });

  const files: Array<[string, string]> = [
    [join(serviceDir, 'index.mjs'), service],
    [join(serviceDir, 'Dockerfile'), serviceDockerfile()],
  ];

  if (hasUi) {
    const web = emitWeb(mod, { maxBytes: maxBodyBytes(mod) });
    files.push(
      [join(webDir, 'index.html'), web],
      [join(webDir, 'nginx.conf'), nginxConf()],
      [join(webDir, 'Dockerfile'), webDockerfile()],
    );
  }

  files.push([join(dir, 'docker-compose.yml'), composeYaml(mod, port, hasUi)]);

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

  for (const [path, content] of files) {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o644 });
  }

  return {
    dir,
    composeFile: join(dir, 'docker-compose.yml'),
    port,
    reference,
    impl: impl ? Object.keys(impl).sort() : [],
    files: files.map(([path]) => path),
  };
}
