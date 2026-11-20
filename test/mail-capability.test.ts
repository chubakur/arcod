import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { providerRows, builtinRegistry } from '../src/registry.ts';

// mail was listed as a provider (and started a container) while the capability
// had no effects and no adapter: the sentence `uses mail: mail` ended in A076.
// The registry no longer promises it, and the hint names the path that works.

const spec = [
  'module mailer @0.1.0 {}',
  '',
  'use capability arcod.std.mail @1',
  '',
  'type Note = { id: string, to: string }',
  '',
  'service Notify : http {',
  '  uses mail: mail',
  '',
  '  contract {',
  '    public op ping() -> { ok: bool } {',
  '      route: "GET /v1/ping"',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  deploy docker',
  '}',
  '',
].join(String.fromCharCode(10));

test('the provider table no longer lists a mail provider', () => {
  const rows = providerRows(builtinRegistry());
  assert.equal(rows.filter((row) => row.capability === 'mail').length, 0);
  assert.equal(rows.filter((row) => row.provider === 'mailpit').length, 0);
});

test('A076 names io.remote as the path for a capability without effects', () => {
  const diags = check(parse(spec, 'mailer.arc')).filter((item) => item.code === 'A076');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /capability mail has no effects and no adapter/);
  assert.match(diags[0].hint ?? '', /io\.remote/);
});
