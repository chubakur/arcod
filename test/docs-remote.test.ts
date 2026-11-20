import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


// io.remote returns { status, body }. The README example used to assign the
// call to `out` and read it as the body, so `out.accepted` was always
// undefined and the branch silently never ran while the prose below said the
// opposite. The emitter keeps returning the envelope; the docs now match it.

test('the io.remote examples read the envelope, not the body', async () => {
  for (const file of ['README.md', 'README_rus.md']) {
    const text = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    const at = text.indexOf("io.remote('Ledger', 'record'");
    assert.ok(at > 0, file + ': the remote example is missing');
    const block = text.slice(at, at + 300);
    assert.match(block, /out\.body/, file + ': the example reads out as the body');
    assert.match(block, /\{ status, body \}/, file + ': the example names the envelope');
    assert.match(text, /(non-2xx|не-2xx)/i, file + ': the throw on a non-2xx answer is not stated');
  }
});

test('the emitted remote call returns { status, body }', async () => {
  // The signature stays: the caller needs the status, and a body-only return
  // would make the README example right for the wrong reason.
  const service = await readFile(new URL('../src/emit/service.ts', import.meta.url), 'utf8');
  assert.ok(service.includes("if (!response.ok) throw new Error('remote: "), 'a non-2xx answer must throw');
  assert.match(service, /return \{ status: response\.status, body: data \};/);
});
