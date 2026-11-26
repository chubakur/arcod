// The body a build bundles is always *.mjs today. A Go service with an .mjs
// body is the wrong runtime under a right label, and a flat impl/ in a module
// that mixes languages cannot say which service a body belongs to: both are
// errors, so the layout cannot drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const mixed = (front: string, worker: string): string => `module lanes @0.1.0 {}

service Front : http {
${front}
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
    }
  }
}

service Worker : http {
${worker}
  contract {
    public op tick() -> string {
      route: "GET /v1/tick"
    }
  }
}

environment dev {}
`;

function errors(source: string, impl: Record<string, string> | undefined) {
  return check(parse(source, 'main.arc'), { impl }).filter((item) => item.severity === 'error');
}

const BODY = 'export async function ping() { return { result: "pong" }; }';
const TICK = 'export async function tick() { return { result: "tock" }; }';

const single = (language: string): string => `module lanes @0.1.0 {}

service Front : http {
${language}
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
    }
  }
}

environment dev {}
`;

test('A105: an .mjs body for a Go service names the service and the file', () => {
  const diags = errors(single('  language: go'), { ping: BODY });
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.equal(diags[0].code, 'A105');
  assert.match(diags[0].message, /service Front is language go, but impl\/ping\.mjs is a node body/);
  assert.match(diags[0].hint ?? '', /impl\/ping\.go/);
});

test('A105: a node service keeps accepting impl/*.mjs', () => {
  assert.deepEqual(errors(mixed('  language: node', '  language: node'), { ping: BODY }), []);
  assert.deepEqual(errors(mixed('', ''), { ping: BODY }), []);
});

test('A106: a flat impl/ in a mixed-language module is refused once per body', () => {
  const diags = errors(mixed('  language: node', '  language: go'), { ping: BODY, tick: TICK });
  assert.deepEqual(diags.map((item) => item.code), ['A106', 'A106']);
  assert.match(diags[0].message, /flat impl\/ping\.mjs in a module with services in go and node/);
  assert.match(diags[0].hint ?? '', /impl\/<service>\/<op>/);
  assert.equal(diags[0].file, 'impl/ping.mjs');
});

test('A106: a module without bodies has nothing to place', () => {
  assert.deepEqual(errors(mixed('  language: node', '  language: go'), undefined), []);
  assert.deepEqual(errors(mixed('  language: node', '  language: go'), {}), []);
});
