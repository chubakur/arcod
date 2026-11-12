// arcod new: scaffold a minimal, valid service so a new project starts from a
// spec that parses and checks clean, not from an empty directory.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parser.ts';
import { check } from './check.ts';

export function isValidName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name);
}

export function serviceName(name: string): string {
  const camel = name.split(/[-_]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return camel || 'Service';
}

// Arcod identifiers are [A-Za-z_][A-Za-z0-9_]* — hyphens are not allowed, so a
// slug like todo-list becomes the module name todo_list.
export function moduleName(name: string): string {
  return name.replace(/-/g, '_');
}

export function specSource(name: string, since: string): string {
  const svc = serviceName(name);
  const mod = moduleName(name);
  return `module ${mod} @0.1.0 {
  meta {
    owner: "@you"
    status: draft
    since: "${since}"
  }
}

error NotFound

service ${svc} : http {
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      post: result == "pong"
    }

    public op echo(text: string) -> string {
      route: "POST /v1/echo"
      post: result == text
    }
  }

  examples {
    example ping_ok {
      when {
        let r = ping()
      }
      then {
        r == "pong"
      }
    }
  }
}

environment dev {
  deploy docker
}
`;
}

const GITIGNORE = `node_modules/
.arcod/
dist/
*.log
.DS_Store
`;

const IMPL_README = [
  '# Operation bodies',
  '',
  'Write one file per operation here, e.g. ping.mjs:',
  '',
  '    export async function ping(input, io) {',
  '      return "pong";',
  '    }',
  '',
  'Run "arcod build --impl" to generate bodies with a local model, or hand-write',
  'them. Bodies only see the io adapter (no imports, no raw network/fs/exec).',
  '',
].join('\n');

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

export async function scaffold(name: string, target: string): Promise<ScaffoldResult> {
  const dir = join(target, name);
  const files: string[] = [];

  await mkdir(join(dir, 'impl'), { recursive: true });

  const spec = specSource(name, new Date().toISOString().slice(0, 10));

  // The scaffold must itself be a valid spec: catch template drift here, not at
  // the user's first check.
  const diags = check(parse(spec, 'main.arc'));
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error('scaffold template is broken: ' + errors.map((d) => d.code + ' ' + d.message).join('; '));
  }

  await writeFile(join(dir, 'main.arc'), spec, 'utf8');
  files.push('main.arc');
  await writeFile(join(dir, '.gitignore'), GITIGNORE, 'utf8');
  files.push('.gitignore');
  await writeFile(join(dir, 'impl', 'README.md'), IMPL_README, 'utf8');
  files.push('impl/README.md');

  return { dir, files };
}
