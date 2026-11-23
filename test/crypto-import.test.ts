// The generated service imports its crypto helpers from a single line built by
// cryptoImportFor(). That line is a function of the capabilities and the
// dialect, while the sources it has to feed are fixed strings: the postgres
// wire client always compares the SCRAM server signature with timingSafeEqual,
// whether or not the service hashes passwords itself. #29 is exactly that gap —
// the build succeeded, the container started, and the first connection died on
// 'ReferenceError: timingSafeEqual is not defined'.
//
// These tests pair the two sides instead of trusting them: every crypto name
// the emitted code calls must appear in its own import line, for every shape
// that ships a different source (kv, sql, guarded bodies, postgres, blobs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from '../src/parser.ts';
import { emitService } from '../src/emit/service.ts';

const run = promisify(execFile);
const examples = new URL('../examples/', import.meta.url);

// Names node:crypto exports and the emitter may reach for. A name is "used"
// when it is called (createHash(`...`) or read as a namespace (constants.X).
const CRYPTO_NAMES = [
  'randomUUID',
  'randomBytes',
  'scryptSync',
  'timingSafeEqual',
  'createHash',
  'createHmac',
  'pbkdf2Sync',
  'createPublicKey',
  'publicEncrypt',
  'createPrivateKey',
  'sign',
  'verify',
  'createCipheriv',
  'createDecipheriv',
  'constants',
];

function cryptoUsed(code: string): string[] {
  return CRYPTO_NAMES.filter((name) => {
    if (name === 'constants') return new RegExp('\\bconstants\\s*\\.').test(code);
    // A dot in front means a method on some object (res.sign, socket.verify);
    // a name after 'async' or 'function' is a declaration (async verify(...)
    // is io.verify's body, not node:crypto).
    return new RegExp('(?<![.\\w])(?<!async )(?<!function )' + name + '\\s*\\(').test(code);
  });
}

function cryptoImported(code: string): Set<string> {
  const match = /import \{([^}]*)\} from 'node:crypto';/.exec(code);
  if (!match) return new Set();
  return new Set(match[1].split(',').map((name) => name.trim()).filter(Boolean));
}

async function emitExample(name: string, options: { dialect?: 'postgres'; impl?: boolean } = {}) {
  const dir = join(examples.pathname, name);
  const mod = parse(await readFile(join(dir, 'main.arc'), 'utf8'), 'main.arc');
  let impl: Record<string, string> | undefined;
  if (options.impl) {
    impl = {};
    for (const file of await readdir(join(dir, 'impl'))) {
      if (!file.endsWith('.mjs')) continue;
      impl[file.slice(0, -'.mjs'.length)] = await readFile(join(dir, 'impl', file), 'utf8');
    }
  }
  return emitService(mod, impl ? { impl, dialect: options.dialect } : { dialect: options.dialect });
}

test('a postgres build imports timingSafeEqual even without guarded bodies', async () => {
  // examples/tasks-sql has no password parameter, so the guarded branch of
  // cryptoImportFor() is not what supplies the name — the wire client needs it.
  const code = await emitExample('tasks-sql', { dialect: 'postgres' });
  assert.match(code, /(?<![.\w])timingSafeEqual\(/, 'the pg client compares the server signature');
  assert.ok(
    cryptoImported(code).has('timingSafeEqual'),
    'the import line names every crypto helper the pg client calls: ' + [...cryptoImported(code)].join(', '),
  );
});

test('every crypto name the emitted service calls is imported', async () => {
  const shapes: Array<{ name: string; impl?: boolean; dialect?: 'postgres' }> = [
    { name: 'tasks' },
    { name: 'tasks', dialect: 'postgres' },
    { name: 'tasks-sql' },
    { name: 'tasks-sql', dialect: 'postgres' },
    { name: 'onetimemessage-pwd', impl: true },
    { name: 'onetimemessage-pwd', impl: true, dialect: 'postgres' },
    { name: 'files', impl: true },
    { name: 'files', impl: true, dialect: 'postgres' },
    { name: 'chat', impl: true },
    { name: 'chat', impl: true, dialect: 'postgres' },
  ];
  for (const shape of shapes) {
    const code = await emitExample(shape.name, shape);
    const imported = cryptoImported(code);
    const missing = cryptoUsed(code).filter((name) => !imported.has(name));
    assert.deepEqual(missing, [], shape.name + ' (' + (shape.dialect ?? 'mysql') + ') calls unimported: ' + missing.join(', '));
  }
});

test('the crypto import line resolves in node', async () => {
  // A typo in a name is not a build error either: the module loads and the
  // call throws at handshake time. Ask node itself whether each name exists.
  const code = await emitExample('onetimemessage-pwd', { impl: true, dialect: 'postgres' });
  const line = /import \{[^}]*\} from 'node:crypto';/.exec(code);
  assert.ok(line, 'the emitted service has a crypto import');
  const names = [...cryptoImported(code)];
  const probe = line[0] + '\n' + names.map((name) => 'if (' + name + ' === undefined) throw new Error("missing ' + name + '");').join('\n');
  const { stderr } = await run(process.execPath, ['--input-type=module', '-e', probe], { cwd: examples.pathname });
  assert.equal(stderr, '');
});
