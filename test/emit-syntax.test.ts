// Every emitted module must be valid JavaScript. The emitter builds its service
// from template strings, so an escaping slip is invisible in src/: a regex added
// to a template kept a single backslash level and shipped /^[^s@]+@/ -- the
// service was assembled, the build reported success, and the failure only
// appeared when the file was loaded. node --check on the built tree catches that
// class before a test ever starts a service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';

const run = promisify(execFile);

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a demo without web pages has no web/ tree at all
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

const root = new URL('../examples/', import.meta.url).pathname;
const examples = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('the examples list is not empty', () => {
  assert.ok(examples.length >= 10, 'expected the demo set, got ' + examples.join(', '));
});

for (const name of examples) {
  test(name + ': every emitted module parses', async () => {
    const source = await readFile(join(root, name, 'main.arc'), 'utf8');
    const dir = await mkdtemp(join(tmpdir(), 'arcod-syntax-'));
    try {
      // The build copies the project's own files (realm.json for identity, impl
      // bodies, assets), so the demo is built from a copy instead of polluting
      // the repository with .arcod/build.
      await cp(join(root, name), join(dir, 'demo'), { recursive: true });
      const built = await buildExample(parse(source, 'main.arc'), join(dir, 'demo'));
      const files = await sources(join(built.dir, 'service'));
      const web = await sources(join(built.dir, 'web'));
      const all = files.concat(web);
      assert.ok(all.length > 0, 'a build emits at least the service entry');
      for (const file of all) {
        try {
          await run(process.execPath, ['--check', file]);
        } catch (error: any) {
          assert.fail(file.slice(built.dir.length + 1) + ' does not parse: ' + String(error.stderr || error.message).split('\n').slice(0, 4).join(' '));
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
