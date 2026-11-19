import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { CAPABILITIES } from '../src/capabilities.ts';
import { PROVIDERS } from '../src/providers.ts';
import { composeYaml } from '../src/emit/compose.ts';

// Embeddings are a declared llm effect, not a homemade hashing function inside
// the body: io.embed rides the same OpenAI-compatible endpoint, and vectors
// come back in request order even when the endpoint reorders them.

const SPEC = "module search @0.1.0 {}\n\nuse capability arcod.std.llm @1\n\ntype Texts = { items: list<string> }\ntype Shape = { count: int, dim: int, first: float }\n\nservice Search : http {\n  uses model: llm(model: \"fake-embed\")\n\n  effects {\n    allow model.embed\n  }\n\n  contract {\n    public op embed(items: list<string>) -> Shape {\n      route: \"POST /v1/embed\"\n      effects: model.embed\n    }\n  }\n}\n\nenvironment dev {\n  bind model -> ollama(model: \"fake-embed\")\n  deploy docker\n}\n";

const IMPL = { embed: "export async function embed(input, io) {\n  const vectors = await io.embed(input.items);\n  const first = vectors[0] || [];\n  return { result: { count: vectors.length, dim: first.length, first: first[0] === undefined ? 0 : first[0] } };\n}\n" };

test('llm declares embed next to chat and model', () => {
  const spec = CAPABILITIES.llm;
  assert.ok(spec.effects.embed, 'embed is a declared effect');
  assert.match(spec.effects.embed, /list<list<float>>/);
  assert.deepEqual(check(parse(SPEC, 'main.arc')).filter((d) => d.severity === 'error'), []);
});

test('io.embed asks the endpoint and returns vectors in request order', async () => {
  const llm = await mockHttp((req) => {
    if (req.url.endsWith('/embeddings')) {
      return {
        status: 200,
        body: {
          data: [
            { index: 1, embedding: [0.3, 0.2] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        },
      };
    }
    return { status: 404, body: { error: 'no route' } };
  });
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base } });
  try {
    const res = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['alpha', 'beta'] }),
    });
    const body = await res.json();
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(body));
    assert.equal(body.count, 2);
    assert.equal(body.dim, 2);
    assert.equal(body.first, 0.1, 'index 0 is first even when the endpoint reorders');
    const call = llm.requests.find((req) => req.url.endsWith('/embeddings'));
    assert.ok(call, 'the adapter called /embeddings');
    assert.deepEqual(JSON.parse(call.body).input, ['alpha', 'beta']);
  } finally {
    await svc.stop();
    await llm.stop();
  }
});

test('an endpoint without embeddings fails the operation, not the process', async () => {
  const llm = await mockHttp(() => ({ status: 500, body: { error: 'down' } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base } });
  try {
    const res = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['alpha'] }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'Internal');
  } finally {
    await svc.stop();
    await llm.stop();
  }
});

// dim is the declared width of every vector a binding returns. The spec names
// it once (bind model -> ollama(model: "fake-embed", dim: 2)); check rejects a
// non-integer, and the runtime refuses a vector of another size before a
// caller can store it next to the rest.
const SPEC_DIM = SPEC.replace('ollama(model: "fake-embed")', 'ollama(model: "fake-embed", dim: 2)');

test('bind dim is a declared width and reaches the service as env', () => {
  assert.deepEqual(check(parse(SPEC_DIM, 'main.arc')).filter((d) => d.severity === 'error'), []);
  const env = PROVIDERS.ollama.appEnv!({ host: 'llm', port: 11434, alias: 'model', args: { model: 'fake-embed', dim: 2 } });
  assert.equal(env.LLM_EMBED_DIM, '2');
  const none = PROVIDERS.ollama.appEnv!({ host: 'llm', port: 11434, alias: 'model', args: {} });
  assert.equal('LLM_EMBED_DIM' in none, false, 'no dim, no promise in env');
  const yaml = composeYaml(parse(SPEC_DIM, 'main.arc'), 8080, false);
  assert.match(yaml, /LLM_EMBED_DIM: "2"/, 'compose carries the declared width');
});

test('A077 rejects a dim that is not a positive integer', () => {
  for (const bad of ['0', '"768"', '-1']) {
    const source = SPEC.replace('ollama(model: "fake-embed")', 'ollama(model: "fake-embed", dim: ' + bad + ')');
    const found = check(parse(source, 'main.arc')).filter((d) => d.code === 'A077');
    assert.equal(found.length, 1, 'dim: ' + bad);
    assert.equal(found[0].severity, 'error');
    assert.equal(found[0].path, 'environments.dev.binds.model');
    assert.match(found[0].message, /dim must be a positive integer/);
  }
});

test('a vector of another width fails the operation, not the process', async () => {
  const llm = await mockHttp(() => ({
    status: 200,
    body: { data: [{ index: 0, embedding: [0.1, 0.2] }] },
  }));
  const svc = await startService(SPEC_DIM, { impl: IMPL, env: { LLM_BASE_URL: llm.base, LLM_EMBED_DIM: '3' } });
  try {
    const res = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['alpha'] }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'Internal');
    const again = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['alpha'] }),
    });
    assert.equal(again.status, 500, 'the process survives a rejected width');
  } finally {
    await svc.stop();
    await llm.stop();
  }
});

test('without a declared dim, vectors of different widths are still rejected', async () => {
  const llm = await mockHttp(() => ({
    status: 200,
    body: {
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3] },
      ],
    },
  }));
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base } });
  try {
    const res = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['alpha', 'beta'] }),
    });
    assert.equal(res.status, 500);
  } finally {
    await svc.stop();
    await llm.stop();
  }
});

test('an empty batch returns no vectors and asks nobody', async () => {
  // OpenAI-compatible endpoints reject input: [] with 400; an indexer with
  // nothing to embed should get [], not a failed operation.
  const llm = await mockHttp(() => ({ status: 400, body: { error: 'empty input' } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base } });
  try {
    const res = await fetch(svc.base + '/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    const body = await res.json();
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(body));
    assert.equal(body.count, 0);
    assert.equal(llm.requests.filter((req) => req.url.endsWith('/embeddings')).length, 0,
      'an empty batch is not sent to the endpoint');
  } finally {
    await svc.stop();
    await llm.stop();
  }
});
