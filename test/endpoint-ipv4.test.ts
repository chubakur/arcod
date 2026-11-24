// Docker Desktop resolves host.docker.internal in both families. The service
// rewrites a localhost endpoint to that name, Node picked the AAAA record, the
// host listener is IPv4-only, and io.remote failed with `fetch failed` while
// `wget` in the same container answered (issue #42). A build that reaches the
// host by name now asks Node for IPv4 first; nothing else in the module changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emitService } from '../src/emit/service.ts';
import { parse } from '../src/parser.ts';

const paymentsUrl = new URL('../examples/payments/main.arc', import.meta.url);
const signupUrl = new URL('../examples/signup/main.arc', import.meta.url);

test('a build with a localhost endpoint resolves names IPv4 first', async () => {
  const mod = parse(await readFile(paymentsUrl, 'utf8'), 'main.arc');
  const source = emitService(mod, { impl: {} });
  assert.match(source, /^import dns from 'node:dns';$/m);
  assert.match(source, /^dns\.setDefaultResultOrder\('ipv4first'\);$/m);
  // The order matters: the call has to run before any request can be made.
  assert.ok(
    source.indexOf('ipv4first') < source.indexOf('const CONFIG ='),
    'the DNS order is set before the config is read',
  );
});

test('a build without a host endpoint keeps the runtime order', async () => {
  const mod = parse(await readFile(signupUrl, 'utf8'), 'main.arc');
  const source = emitService(mod, { impl: {} });
  assert.doesNotMatch(source, /node:dns/);
  assert.doesNotMatch(source, /ipv4first/);
});
