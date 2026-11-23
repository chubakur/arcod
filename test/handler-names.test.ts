// An operation may be called anything in the model, including `request`.
// The generated module has its own dispatcher `handleRequest`, and the per-op
// wrapper used to be built as 'handle' + Op -- so `op request` declared
// `handleRequest` twice. check and build were both green while the service
// died at load with `Identifier 'handleRequest' has already been declared`.
// The wrappers carry the arcod prefix now, which no runtime name can meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';

const run = promisify(execFile);

// Two ops whose old wrapper names were both plausible runtime words: `request`
// is the real dispatcher, `send`/`finish` are helpers every request uses.
const SPEC = `module handlers @0.1.0 {
  meta {
    owner: \"@test\"
    status: \"draft\"
    since: \"2026-11-23\"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type NoteId = uuid
type Note = { id: NoteId, name: string }

error Invalid

service Notes : http {
  uses store: sql
  uses uuid: ids

  effects {
    allow store.insert, uuid.new
  }

  contract {
    public op request(name: string) -> Note {
      route: \"POST /v1/notes\"
      effects: store.insert, uuid.new
      errors: Invalid
      post: result != null
      on error Invalid: result == null
    }

    public op send(name: string) -> Note {
      route: \"POST /v1/notes/send\"
      effects: store.insert, uuid.new
      errors: Invalid
      post: result != null
      on error Invalid: result == null
    }
  }
}

environment dev {
  bind store -> mysql
  bind uuid -> local
  deploy docker
}
`;

const BODY = (name: string) =>
  'export async function ' + name + '(input, io) {\n' +
  "  const name = String(input.name || '');\n" +
  "  if (!name) return { error: 'Invalid' };\n" +
  '  return { id: io.new(), name };\n' +
  '}\n';

test('op request and op send: the module parses and dispatches its own handlers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-handler-'));
  try {
    await writeFile(join(dir, 'main.arc'), SPEC);
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'request.mjs'), BODY('request'));
    await writeFile(join(dir, 'impl', 'send.mjs'), BODY('send'));
    const built = await buildExample(parse(await readFile(join(dir, 'main.arc'), 'utf8'), 'main.arc'), dir);
    const file = join(built.dir, 'service', 'index.mjs');
    const source = await readFile(file, 'utf8');

    // The failure this test exists for is a load-time SyntaxError, which
    // buildExample cannot see: only node --check on the artifact can.
    await run(process.execPath, ['--check', file]);

    assert.match(source, /^async function arcodHandleRequest\(req, res, params\) \{/m);
    assert.match(source, /^async function arcodHandleSend\(req, res, params\) \{/m);
    assert.match(source, /^  request: arcodHandleRequest,$/m);
    assert.match(source, /^  send: arcodHandleSend,$/m);

    // The dispatcher stays the single handleRequest declaration in the module.
    const declarations = [...source.matchAll(/^async function (handle\w+)\(/gm)].map((match) => match[1]);
    assert.deepEqual(declarations, ['handleRequest']);

    // No top-level function may be declared twice, whatever the op is called.
    const names = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)].map((match) => match[1]);
    assert.equal(names.length, new Set(names).size, 'duplicate top-level function: ' + names.join(', '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
