// `use capability arcod.std.hash` with `bind sig -> local` passed check (A068
// deliberately lets `local` serve ids and hash) and built, but io.hash existed
// only when the service was guarded, i.e. when some operation took a password.
// A service hashing an API key of its own got `TypeError: io.hash is not a
// function` on its first call (issue #44). The capability now answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';
import { startService } from './harness.ts';

const SPEC = `module hashing @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-24"
  }
}

use capability arcod.std.hash @1

type Sealed = { digest: string }

service Vault : http {
  uses sig: hash

  effects {
    allow sig.hash, sig.verify
  }

  contract {
    public op seal(secret: string) -> Sealed {
      route: "POST /v1/seal"
      effects: sig.hash
    }

    public op open(secret: string, digest: string) -> bool {
      route: "POST /v1/open"
      effects: sig.verify
    }
  }
}

environment dev {
  bind sig -> local
}
`;

// io.hash/io.verify are the async pair the guarded bodies already use, so a
// body awaits them like any other driver call.
const IMPL = {
  seal: 'export async function seal(input, io) { return { result: { digest: await io.hash(String(input.secret)) } }; }\n',
  open: 'export async function open(input, io) { return { result: await io.verify(String(input.secret), String(input.digest)) }; }\n',
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const SCRYPT = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

test('a hash capability without a password body still answers io.hash and io.verify', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const sealed = await post(svc.base + '/v1/seal', { secret: 'a|b' });
    assert.ok(sealed.status === 200 || sealed.status === 201, 'seal answers ' + sealed.status);
    const { digest } = (await sealed.json()) as { digest: string };
    assert.match(digest, SCRYPT);

    // A second seal of the same secret salts again, so the strings differ and
    // both verify: a hash is not a lookup key.
    const second = (await (await post(svc.base + '/v1/seal', { secret: 'a|b' })).json()) as { digest: string };
    assert.match(second.digest, SCRYPT);
    assert.notEqual(second.digest, digest);

    const right = await post(svc.base + '/v1/open', { secret: 'a|b', digest });
    assert.ok(right.status === 200 || right.status === 201, 'open answers ' + right.status);
    assert.equal(await right.json(), true);

    const wrong = await post(svc.base + '/v1/open', { secret: 'a|c', digest });
    assert.equal(await wrong.json(), false);

    // A digest that is not ours is a false, not a throw.
    assert.equal(await (await post(svc.base + '/v1/open', { secret: 'a|b', digest: 'scrypt$x$y' })).json(), false);
  } finally {
    await svc.stop();
  }
});
