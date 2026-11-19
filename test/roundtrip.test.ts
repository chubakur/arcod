import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { adoptOpenapi } from '../src/adopt.ts';
import { formatSource } from '../src/fmt.ts';
import { diffSpecs } from '../src/diff.ts';

// Two promises the toolchain makes about itself: an emitted OpenAPI document
// can be adopted back into a spec that still checks, and formatting a spec
// twice changes nothing. Both are round trips, and neither had a test.

const example = (name: string) => new URL('../examples/' + name + '/main.arc', import.meta.url);
const examplesDir = new URL('../examples/', import.meta.url);

async function allExamples(): Promise<Array<{ name: string; source: string }>> {
  const names = (await readdir(examplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const out: Array<{ name: string; source: string }> = [];
  for (const name of names) {
    const source = await readFile(example(name), 'utf8').catch(() => null);
    if (source !== null) out.push({ name, source });
  }
  return out;
}

test('openapi -> adopt -> check closes the loop on every example', async () => {
  const list = await allExamples();
  assert.ok(list.length >= 10);
  for (const { name, source } of list) {
    const mod = parse(source, name + '/main.arc');
    const doc = emitOpenapi(mod);
    const adopted = adoptOpenapi(doc);
    const back = parse(adopted, name + '/adopted.arc');
    const errors = check(back).filter((item) => item.severity === 'error');
    assert.deepEqual(errors.map((item) => item.code + ' ' + item.message), [], name + ' survives the round trip');
  }
});

test('formatting is idempotent for every example', async () => {
  for (const { name, source } of await allExamples()) {
    const once = formatSource(source, 'main.arc');
    const twice = formatSource(once, 'main.arc');
    assert.equal(twice, once, name + ' is stable under a second fmt');
  }
});


test('comments above enum values and example statements survive fmt', () => {
  const source = [
    'module probe @0.1.0 {}',
    '',
    'enum Color {',
    '  // the warm one',
    '  red,',
    '  blue',
    '}',
    '',
    'use capability arcod.std.kv @1',
    'type Note = { id: uuid, text: string }',
    'error Invalid',
    'service Notes : http {',
    '  uses store: kv(ttl: 1h)',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(text: string) -> Note {',
    '      route: "POST /v1/n"',
    '      effects: store.insert',
    '      errors: Invalid',
    '      on error Invalid: text != null',
    '    }',
    '  }',
    '  examples {',
    '    example one {',
    '      when {',
    '        // the first statement',
    '        let note = create("hi")',
    '      }',
    '      then {',
    '        note.id != null',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const once = formatSource(source, 'main.arc');
  assert.match(once, /\/\/ the warm one\n  red/);
  assert.match(once, /\/\/ the first statement\n {8}let note/);
  assert.equal(formatSource(once, 'main.arc'), once, 'a second fmt changes nothing');
});

test('a spec never differs from itself, and a diff is symmetric in existence', async () => {
  const a = await readFile(example('signup'), 'utf8');
  const b = await readFile(example('onetimemessage'), 'utf8');
  // A semantic diff keeps its two header lines by design (they say which files
  // were compared); what must not appear is a hunk.
  const self = diffSpecs(a, 'a.arc', a, 'a.arc');
  assert.match(self, /^--- a\.arc\n\+\+\+ a\.arc/);
  assert.equal(self.split('\n').slice(2).join('\n').trim(), '', 'no hunks for an identical spec');
  assert.ok(diffSpecs(a, 'a.arc', b, 'b.arc').length > 0, 'different specs differ');
  assert.ok(diffSpecs(b, 'b.arc', a, 'a.arc').length > 0, 'and differ in both directions');
});

test('adopt: an OpenAPI capture becomes an arcod path parameter', async () => {
  const mod = parse(await readFile(example('onetimemessage'), 'utf8'), 'main.arc');
  const adopted = adoptOpenapi(emitOpenapi(mod));

  assert.match(adopted, /route: "GET \/api\/messages\/:id"/);
  assert.equal(adopted.includes('{id}'), false, 'no literal braces left in a route');

  const errors = check(parse(adopted, 'adopted.arc')).filter((item) => item.severity === 'error');
  assert.deepEqual(errors.map((item) => item.code + ' ' + item.message), []);
});

test('adopt: a bearer requirement comes back as auth ops', () => {
  const source = `module guarded @0.1.0 {}

service Vault : http {
  uses auth: identity

  contract {
    public op status() -> string {
      route: "GET /v1/status"
    }

    auth op peek(id: uuid) -> string {
      route: "GET /v1/secret/:id"
    }
  }
}

environment dev {
  bind auth -> keycloak(host: "idp", port: 8080)
}
`;
  const adopted = adoptOpenapi(emitOpenapi(parse(source, 'main.arc')));

  assert.match(adopted, /use capability arcod.std.identity @1/);
  assert.match(adopted, /uses auth: identity/);
  assert.match(adopted, /auth op Vault_peek/);
  assert.match(adopted, /public op Vault_status/);
  assert.match(adopted, /bind auth -> keycloak\n/);
  assert.match(adopted, /public op Vault_status\(\) -> string/);

  const errors = check(parse(adopted, 'adopted.arc')).filter((item) => item.severity === 'error');
  assert.deepEqual(errors.map((item) => item.code + ' ' + item.message), []);
});

// The security pass is only useful if it classifies every operation the same
// way the model did, on every example — not just on the fixture written for it.
function routeAuth(mod: ReturnType<typeof parse>, only?: string): string[] {
  const out: string[] = [];
  for (const svc of mod.services) {
    if (only && svc.name !== only) continue;
    for (const op of svc.contract) {
      const route = op.clauses.find((clause) => clause.kind === 'route');
      if (!route || route.kind !== 'route') continue;
      const [method, path] = route.value.split(' ');
      const normalized = path.replace(/:[^/]+/g, ':param');
      out.push(method.toUpperCase() + ' ' + normalized + ' ' + (op.auth ? 'auth' : 'public'));
    }
  }
  return out.sort();
}

test('adopt: an inline enum collapses to string, a single-variant union keeps its type', () => {
  // A document written by hand (or by another tool) may put an enum right in a
  // property and wrap one $ref in anyOf. Neither is a declaration arcod can
  // name, so the inline enum becomes string while the single variant stays the
  // named type instead of a one-arm union.
  const doc = {
    openapi: '3.1.0',
    info: { title: 'probe' },
    paths: {
      '/v1/ping': {
        get: {
          operationId: 'ping',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      color: { type: 'string', enum: ['red', 'blue'] },
                      note: { anyOf: [{ $ref: '#/components/schemas/Note' }] },
                    },
                    required: ['color'],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Note: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    },
  };
  const adopted = adoptOpenapi(doc);
  assert.match(adopted, /type Note = \{ text: string \}/);
  assert.match(adopted, /public op ping\(\) -> \{ color: string, note: Note\? \}/);
  assert.equal(adopted.includes('enum'), false, 'an inline enum is not promoted to a declaration');
  const errors = check(parse(adopted, 'adopted.arc')).filter((item) => item.severity === 'error');
  assert.deepEqual(errors.map((item) => item.code + ' ' + item.message), []);
});

test('adopt: every example keeps its auth/public classification', async () => {
  for (const { name, source } of await allExamples()) {
    const original = parse(source, 'main.arc');
    for (const svc of original.services) {
      // emitOpenapi defaults to one service; an external contract is its own
      // document and has to be adopted on its own too.
      const adopted = parse(adoptOpenapi(emitOpenapi(original, { service: svc.name })), name + '/adopted.arc');
      assert.deepEqual(routeAuth(adopted), routeAuth(original, svc.name), name + '/' + svc.name);
    }
  }
});
