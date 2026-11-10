import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleNode } from '../ast.ts';
import { emitService, maxBodyBytes } from './emit/service.ts';
import { emitWeb } from './emit/web.ts';
import { composeYaml, nginxConf, serviceDockerfile, webDockerfile } from './emit/compose.ts';

export interface BuildOptions {
  port?: number;
}

export interface BuildResult {
  dir: string;
  composeFile: string;
  port: number;
  files: string[];
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
  const service = emitService(mod);

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

  for (const [path, content] of files) {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o644 });
  }

  return { dir, composeFile: join(dir, 'docker-compose.yml'), port, files: files.map(([path]) => path) };
}
