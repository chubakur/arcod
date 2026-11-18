import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';

// HEAD is an explicit route method (A070 accepts it). Its answer is a GET
// answer without a body, so the status must be 200 — a 201 would tell a
// monitor that a read created something.
const SPEC = `module probe @0.1.0 {}

service Probe : http {
  contract {
    public op health() -> string {
      route: "HEAD /healthz"
    }
  }
}
`;

test('a HEAD route answers 200 and no body', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);
  const service = await startService(SPEC, {
    impl: { health: "export async function health() { return { result: 'ok' }; }" },
  });
  try {
    const response = await fetch(service.base + '/healthz', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  } finally {
    await service.stop();
  }
});

test('openapi: a HEAD operation is documented as 200', () => {
  const doc = emitOpenapi(parse(SPEC, 'main.arc')) as Record<string, any>;
  const operation = doc.paths['/healthz'].head;
  assert.ok(operation.responses['200'], '200 is the success status');
  assert.equal(operation.responses['201'], undefined);
  assert.equal(operation.responses['200'].content['text/plain'].schema.type, 'string');
});

// A HEAD probe may carry a cache-buster or a tag; the runtime puts it in the
// query string and never reads a body. The document said otherwise: every
// method other than GET/DELETE was documented as a JSON requestBody, which for
// HEAD describes a request that cannot be sent.
const PARAM_SPEC = [
  'module probeparam @0.1.0 {}',
  '',
  'service Probe : http {',
  '  contract {',
  '    public op peek(tag: string) -> { ok: bool } {',
  '      route: "HEAD /v1/peek"',
  '    }',
  '  }',
  '}',
].join('\n');

test('openapi: a HEAD parameter is a query parameter, not a body', () => {
  const doc = emitOpenapi(parse(PARAM_SPEC, 'main.arc')) as Record<string, any>;
  const operation = doc.paths['/v1/peek'].head;
  assert.deepEqual(
    (operation.parameters ?? []).map((param: any) => [param.name, param.in]),
    [['tag', 'query']],
  );
  assert.equal(operation.requestBody, undefined, 'HEAD has no request body');
});
