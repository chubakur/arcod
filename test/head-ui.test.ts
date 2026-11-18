// The SPA builds its request from the operation table: a name that is not a
// path capture goes to the query for GET/DELETE and to the payload otherwise.
// HEAD was in the payload group, so the page would try to send a body that the
// browser and the server both refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

const SPEC = [
  'module probeui @0.1.0 {',
  '}',
  '',
  'service Probe : http {',
  '  contract {',
  '    public op peek(tag: string) -> { ok: bool } {',
  '      route: "HEAD /v1/peek"',
  '    }',
  '  }',
  '}',
  '',
  'ui ProbeUi {',
  '  kind: spa',
  '  route: "/"',
  '  uses Probe.peek',
  '}',
].join('\n');

function opTable(source: string): any[] {
  const marker = 'var OPS = ';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'the page carries an operation table');
  const end = source.indexOf(';', start);
  return JSON.parse(source.slice(start + marker.length, end));
}

test('a HEAD operation in the SPA keeps its parameter in the query', () => {
  const page = emitWeb(parse(SPEC, 'main.arc'), { maxBytes: 4096 });
  const peek = opTable(page).find((op: any) => op.name === 'peek');
  assert.ok(peek, 'peek is in the table');
  assert.deepEqual(peek.params.map((param: any) => [param.name, param.where]), [['tag', 'query']]);
});

test('the SPA submit sends no body for HEAD', () => {
  const page = emitWeb(parse(SPEC, 'main.arc'), { maxBytes: 4096 });
  assert.ok(page.includes("op.method !== 'HEAD'"), 'HEAD is excluded from the body branch');
});
