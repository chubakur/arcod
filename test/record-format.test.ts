// A field declared email or url holds a value of that format. The op boundary
// validates an input, but a record built inside a body is the other way in, and
// both stores used to keep "not-an-email" in an email column: the declaration
// promised a shape the row did not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module formats @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type Contact = { id: uuid, mail: email, site: url? }',
    'error Invalid',
    'error NotFound',
    'service Formats : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.update, store.find, uuid.new }',
    '  contract {',
    '    public op put(mail: string, site: string?) -> Contact {',
    '      route: "POST /v1/contacts"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op patch(id: uuid, mail: string) -> Contact {',
    '      route: "PATCH /v1/contacts/:id"',
    '      effects: store.update',
    '      errors: Invalid, NotFound',
    '      on error NotFound: id != null',
    '    }',
    '  }',
    '}',
    'environment dev {',
    '  bind store -> ' + bind,
    '  bind uuid -> local',
    '}',
    '',
  ].join('\n');
}

// The two operands are declared string so the boundary's own format check passes
// them through: what is under test is the record check, not the boundary one.
const impl = {
  put: [
    'export async function put(input, io) {',
    '  const contact = { id: io.new(), mail: String(input.mail) };',
    '  if (input.site != null) contact.site = String(input.site);',
    "  return { result: await io.insert('Contact', contact) };",
    '}',
    '',
  ].join('\n'),
  patch: [
    'export async function patch(input, io) {',
    "  return { result: await io.update('Contact', input.id, { mail: String(input.mail) }) };",
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patch = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const stores: Array<'kv' | 'sql'> = ['kv', 'sql'];

for (const store of stores) {
  test(store + ': an email or url field keeps its declared format', async () => {
    const svc = await startService(sourceOf(store), { impl });
    try {
      const ok = await post(svc.base, '/v1/contacts', { mail: 'alice@example.com', site: 'https://example.com/a' });
      assert.equal(ok.status, 201, 'a valid contact is stored');
      const contact = await ok.json();
      assert.equal(contact.mail, 'alice@example.com');

      const bare = await post(svc.base, '/v1/contacts', { mail: 'alice' });
      assert.equal(bare.status, 400, 'a string without @ is not an email');
      assert.match(String((await bare.json()).message), /insert Contact: mail must be an email/);

      const host = await post(svc.base, '/v1/contacts', { mail: 'alice@example' });
      assert.equal(host.status, 400, 'a host without a dot is not an email');

      const site = await post(svc.base, '/v1/contacts', { mail: 'alice@example.com', site: 'example.com' });
      assert.equal(site.status, 400, 'a url needs a scheme');
      assert.match(String((await site.json()).message), /insert Contact: site must be a url/);

      const moved = await patch(svc.base, '/v1/contacts/' + contact.id, { mail: 'bob@example.com' });
      assert.equal(moved.status, 201, 'a valid update still lands');

      const broken = await patch(svc.base, '/v1/contacts/' + contact.id, { mail: 'bob at example' });
      assert.equal(broken.status, 400, 'an update cannot store a non-email');
      assert.match(String((await broken.json()).message), /update Contact: mail must be an email/);
    } finally {
      await svc.stop();
    }
  });
}
