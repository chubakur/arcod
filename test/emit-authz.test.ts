import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse, ParseError } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService, pickService, routeOf, statusForError } from '../src/emit/service.ts';
import { checksumOf, migrationPlan } from '../src/migrate.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml, nginxConf } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { deployManifest } from '../src/deploy.ts';
import { providersForCapability } from '../src/providers.ts';
import { runExamples } from '../src/test.ts';
import { runPipeline } from '../src/pipeline.ts';
import { buildPrompts } from '../src/prompts.ts';
import { planBody } from '../src/plan-body.ts';
import { extractCode, validateBody, sandboxViolation } from '../src/impl.ts';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specUrl = new URL('../examples/onetimemessage/main.arc', import.meta.url);
const source = await readFile(specUrl, 'utf8');
const ast = parse(source, 'main.arc');

const mysqlUrl = new URL('../examples/project1-mysql/main.arc', import.meta.url);
const mysqlAst = parse(await readFile(mysqlUrl, 'utf8'), 'main.arc');

const filesUrl = new URL('../examples/files/main.arc', import.meta.url);
const filesAst = parse(await readFile(filesUrl, 'utf8'), 'main.arc');

// --- AuthZ guard (M0.2) ---

const AUTHZ_SPEC = `module authz @0.1.0 {
}

use capability arcod.std.identity @1

error Unauthorized
error Forbidden
error NotFound

service Vault : http {
  uses auth: identity

  roles: admin, support

  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      errors: none
    }

    auth op whoami() -> string {
      route: "GET /v1/whoami"
      errors: Unauthorized
      on error Unauthorized: result != null
    }

    auth op adminOnly() -> string {
      route: "GET /v1/admin"
      roles: admin
      errors: Unauthorized, Forbidden
      on error Unauthorized: result != null
      on error Forbidden: result != null
    }

    auth op mine(id: string) -> string {
      route: "GET /v1/mine/:id"
      owner: id
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }
  }

  effects {
    allow auth.actor
    deny net, fs, exec
  }
}

environment dev {
  bind auth -> keycloak(host: "idp", port: 8080)
  deploy docker
}
`;

const authzAst = () => parse(AUTHZ_SPEC, 'main.arc');

test('authz: auth op, roles and owner parse into the AST', () => {
  const mod = authzAst();
  const svc = mod.services[0];
  assert.deepEqual(svc.roles, ['admin', 'support']);
  const [ping, whoami, adminOnly, mine] = svc.contract;
  assert.equal(ping.isPublic, true);
  assert.equal(ping.auth, false);
  assert.equal(whoami.auth, true);
  assert.equal(whoami.isPublic, false);
  const roles = adminOnly.clauses.find((clause) => clause.kind === 'roles');
  assert.ok(roles && roles.kind === 'roles' && roles.names.join(',') === 'admin');
  const owner = mine.clauses.find((clause) => clause.kind === 'owner');
  assert.ok(owner && owner.kind === 'owner' && owner.param === 'id');
});

test('authz: public and auth are mutually exclusive', () => {
  assert.throws(() => parse(AUTHZ_SPEC.replace('auth op whoami', 'public auth op whoami'), 'main.arc'));
});

test('authz: a guarded operation needs an actor source (A046)', () => {
  const broken = parse(AUTHZ_SPEC.replace('  uses auth: identity\n', ''), 'main.arc');
  assert.ok(check(broken).some((d) => d.code === 'A046' && d.message.includes('whoami')));
  assert.ok(!check(authzAst()).some((d) => d.severity === 'error'));
});

test('authz: a role must exist in the service vocabulary (A047)', () => {
  const broken = parse(AUTHZ_SPEC.replace('      roles: admin\n', '      roles: root\n'), 'main.arc');
  const diags = check(broken).filter((d) => d.code === 'A047');
  assert.equal(diags.length, 1);
  assert.ok(diags[0].message.includes('root'));
});

test('authz: a public operation must not require an actor (A048)', () => {
  const withOwner = parse(AUTHZ_SPEC.replace('auth op mine', 'public op mine'), 'main.arc');
  assert.ok(check(withOwner).some((d) => d.code === 'A048' && d.message.includes('mine')));
  const withEffect = parse(AUTHZ_SPEC.replace(
    '      route: "GET /v1/ping"\n      errors: none',
    '      route: "GET /v1/ping"\n      errors: none\n      effects: auth.actor',
  ), 'main.arc');
  const diags = check(withEffect).filter((d) => d.code === 'A048');
  assert.ok(diags.some((d) => d.message.includes('ping')), JSON.stringify(diags));
});

test('authz: owner must name a real parameter (A049)', () => {
  const broken = parse(AUTHZ_SPEC.replace('owner: id', 'owner: ghost'), 'main.arc');
  const diags = check(broken).filter((d) => d.code === 'A049');
  assert.equal(diags.length, 1);
  assert.ok(diags[0].message.includes('ghost'));
});

test('authz: capability-level deny stays a warning, native deny is enforced (W016)', () => {
  assert.ok(!check(authzAst()).some((d) => d.code === 'W016'));
  const withDeny = parse(AUTHZ_SPEC + `
service Other : http {
  uses auth: identity
  effects {
    allow auth.actor
    deny auth
  }
  contract {
    auth op ping2() -> string {
      route: "GET /v2/ping"
      errors: none
    }
  }
}
`, 'main.arc');
  const diags = check(withDeny).filter((d) => d.code === 'W016');
  assert.equal(diags.length, 1, JSON.stringify(check(withDeny)));
  assert.ok(diags[0].message.includes('auth'));
});

test('authz: the runtime emits the guard before the body', () => {
  const code = emitService(authzAst(), { impl: { whoami: 'export async function whoami(input, io) { return { result: "x" }; }' } });
  assert.ok(code.includes('const AUTHZ = '));
  assert.ok(code.includes('"whoami": {\n    "auth": true'));
  assert.ok(code.includes('"adminOnly": {\n    "auth": true,\n    "roles": [\n      "admin"'));
  assert.ok(code.includes('"owner": "id"'));
  assert.ok(code.includes('async function authorize(spec, io, input)'));
  assert.ok(code.includes('const denied = await authorize(AUTHZ[opName], io, input);'));
});

test('authz: validateBody closes the native deny hole', () => {
  assert.ok(validateBody('export async function read(input, io) { await fetch("http://x"); }', 'read'));
  assert.ok(validateBody('export async function read(input, io) { return import("node:fs"); }', 'read'));
  assert.equal(validateBody('export async function read(input, io) { return { result: 1 }; }', 'read'), null);
});
