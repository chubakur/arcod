import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { describeViolation } from '../src/constraints.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { migrationPlan } from '../src/migrate.ts';
import { startService } from './harness.ts';

// A constrained type is one fact with three consumers: the OpenAPI schema
// (format/enum), the migration (still a string column) and the service
// boundary, which answers 400 for a client mistake instead of letting the
// body crash with a 500. These tests keep the three in step.

const signupUrl = new URL('../examples/signup/main.arc', import.meta.url);

async function load(): Promise<{ source: string; impl: Record<string, string> }> {
  const source = await readFile(signupUrl, 'utf8');
  return { source, impl: { create: await readFile(new URL('impl/create.mjs', signupUrl), 'utf8') } };
}

function specOf(mod: ReturnType<typeof parse>) {
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return svc;
}

test('OpenAPI publishes email/url as formats and enums as components', async () => {
  const { source } = await load();
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const schemas = (doc.components as { schemas: Record<string, any> }).schemas;
  assert.deepEqual(schemas.Plan, { type: 'string', enum: ['free', 'pro', 'team'] });
  assert.equal(schemas.Account.properties.email.format, 'email', 'email is format: email');
  assert.equal(schemas.Account.properties.website.anyOf[0].format, 'uri', 'url is format: uri');
  const create = (doc.paths as any)['/v1/accounts'].post;
  assert.equal(create.requestBody.content['application/json'].schema.properties.email.format, 'email');
});

test('a constrained column stays a string column in the migration', async () => {
  const { source } = await load();
  const mod = parse(source, 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const account = plan.migrations.find((m) => m.name === 'account');
  assert.ok(account, 'the account table is migrated');
  // A unique constrained field is indexed, so it stays a bounded VARCHAR.
  assert.match(account.up, /`email` VARCHAR\(191\) NOT NULL/);
  assert.match(account.up, /`website` TEXT/);
  assert.match(account.up, /DEFAULT 'free'/);
});

test('A060 rejects a default that violates the constrained type', () => {
  const base = `module m @0.1.0 {}
type Account = { id: uuid, email: email = "nope", plan: Plan = "trial" }
enum Plan { free, pro }
service S : http {
  contract { public op create(id: uuid) -> Account { route: "POST /v1/a" } }
}
`;
  const diags = check(parse(base, 'main.arc')).filter((item) => item.code === 'A060');
  assert.equal(diags.length, 2, 'both the email and the enum default are rejected');
  assert.ok(diags.some((item) => /must be an email/.test(item.message)));
  assert.ok(diags.some((item) => /must be one of free, pro/.test(item.message)));
});

test('A061 rejects an unknown string format', () => {
  const source = `module m @0.1.0 {}
type Account = { id: uuid, phone: string(format: phone) }
service S : http {
  contract { public op create(id: uuid) -> Account { route: "POST /v1/a" } }
}
`;
  const diags = check(parse(source, 'main.arc')).filter((item) => item.code === 'A061');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /unknown string format phone/);
});

test('the service answers 400 for a bad email, plan or url', async () => {
  const { source, impl } = await load();
  const svc = await startService(source, { impl });
  const send = (body: unknown) =>
    fetch(svc.base + '/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const badEmail = await send({ email: 'not-an-email' });
    assert.equal(badEmail.status, 400, 'a malformed email is a client error');
    assert.equal((await badEmail.json()).error, 'Invalid');

    const badPlan = await send({ email: 'a@example.com', plan: 'trial' });
    assert.equal(badPlan.status, 400, 'a value outside the enum is a client error');
    assert.match((await badPlan.json()).message, /must be one of free, pro, team/);

    const badUrl = await send({ email: 'a@example.com', website: 'example.com' });
    assert.equal(badUrl.status, 400, 'a url without a scheme is a client error');

    const ok = await send({ email: 'a@example.com', website: 'https://example.com', plan: 'pro' });
    assert.equal(ok.status, 201, 'a matching body is accepted');
    const created = await ok.json();
    assert.equal(created.email, 'a@example.com');
    assert.equal(created.plan, 'pro');
  } finally {
    await svc.stop();
  }
});

test('an omitted optional constrained field is not a violation', async () => {
  const { source, impl } = await load();
  const svc = await startService(source, { impl });
  try {
    const created = await fetch(svc.base + '/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'b@example.com' }),
    });
    assert.equal(created.status, 201);
    const account = await created.json();
    assert.equal(account.website, null);
    assert.equal(account.plan, 'free', 'the schema default fills the enum');
  } finally {
    await svc.stop();
  }
});

// The url rule had no test through describeViolation: the service test above
// exercises the copy inlined into the emitter, so a drift between the two
// would go unnoticed until a default hit it. Pin the rule itself.
test('describeViolation enforces a url scheme and rejects non-strings', () => {
  const uri = { format: 'uri' as const, enumValues: null };
  assert.equal(describeViolation(uri, 'https://example.com/a?b=c'), null);
  assert.equal(describeViolation(uri, 'ftp://files.example.com'), null, 'any scheme is a url');
  assert.equal(describeViolation(uri, 'example.com'), 'must be a url', 'a bare host has no scheme');
  assert.equal(describeViolation(uri, 'https://exa mple.com'), 'must be a url', 'spaces are not a url');
  assert.equal(describeViolation(uri, 42), 'must be a url', 'a non-string is not a url');
  assert.equal(describeViolation(uri, null), null, 'absence is required-ness, not a violation');
});

// A default is the one place check() and the boundary read the same rule, so a
// bad url default is a model error before it can ever reach a request.
test('A060 rejects a url default without a scheme and accepts one with it', () => {
  const source = `module urls @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
  }
}

type Site = {
  bad: string(format: uri) = "example.com",
  good: string(format: url) = "https://example.com",
  alias: uri = "ftp://files.example.com"
}

service api : http {
  contract {
    public op add(site: Site) -> Site {
      route: "POST /v1/sites"
    }
  }
}
`;
  const diags = check(parse(source, 'main.arc'));
  const a060 = diags.filter((item) => item.code === 'A060');
  assert.equal(a060.length, 1, 'only the bad default is reported');
  assert.equal(a060[0].path, 'types.Site.bad');
  assert.match(a060[0].message, /must be a url/);
});
