// B118: a provider bills by tokens, so io.chat must carry the usage it
// reports. The body gets { prompt, completion, total } in the same result as
// the content, and an endpoint that sends no usage answers zeros instead of
// undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { CAPABILITIES } from '../src/capabilities.ts';

const SPEC = [
  'module chat @0.1.0 {}',
  '',
  'use capability arcod.std.llm @1',
  '',
  'type Reply = { content: string, model: string, prompt: int, completion: int, total: int }',
  '',
  'service Chat : http {',
  '  uses model: llm(model: "fake-chat")',
  '',
  '  effects {',
  '    allow model.chat',
  '  }',
  '',
  '  contract {',
  '    public op ask(question: string) -> Reply {',
  '      route: "POST /v1/ask"',
  '      effects: model.chat',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind model -> ollama(model: "fake-chat")',
  '  deploy docker',
  '}',
  '',
].join('\n');

const IMPL = {
  ask: [
    'export async function ask(input, io) {',
    '  const reply = await io.chat([{ role: "user", content: input.question }], "be brief");',
    '  return { result: {',
    '    content: reply.content,',
    '    model: reply.model,',
    '    prompt: reply.usage.prompt,',
    '    completion: reply.usage.completion,',
    '    total: reply.usage.total,',
    '  } };',
    '}',
  ].join('\n'),
};

test('the chat signature carries usage next to content and model', () => {
  const spec = CAPABILITIES.llm;
  assert.match(spec.effects.chat, /usage: \{ prompt: int, completion: int, total: int \}/);
  assert.deepEqual(check(parse(SPEC, 'main.arc')).filter((d) => d.severity === 'error'), []);
});

test('io.chat returns the usage the provider reported', async () => {
  const llm = await mockHttp((req) => {
    if (req.url.endsWith('/chat/completions')) {
      return {
        status: 200,
        body: {
          model: 'fake-chat-2026',
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        },
      };
    }
    return { status: 404, body: { error: 'no route' } };
  });
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base, LLM_MODEL: 'fake-chat' } });
  try {
    const res = await fetch(svc.base + '/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hi' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.deepEqual(body, { content: 'hello', model: 'fake-chat-2026', prompt: 11, completion: 4, total: 15 });
    const call = llm.requests.find((req) => req.url.endsWith('/chat/completions'));
    assert.ok(call, 'the adapter called /chat/completions');
    const payload = JSON.parse(call.body);
    assert.equal(payload.model, 'fake-chat');
    assert.deepEqual(payload.messages[0], { role: 'system', content: 'be brief' });
    assert.deepEqual(payload.messages[1], { role: 'user', content: 'hi' });
  } finally {
    await svc.stop();
    await llm.stop();
  }
});

test('an endpoint without usage answers zeros, not undefined', async () => {
  const llm = await mockHttp(() => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: 'bare' } }] },
  }));
  const svc = await startService(SPEC, { impl: IMPL, env: { LLM_BASE_URL: llm.base, LLM_MODEL: 'fake-chat' } });
  try {
    const res = await fetch(svc.base + '/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hi' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.deepEqual(body, { content: 'bare', model: 'fake-chat', prompt: 0, completion: 0, total: 0 });
  } finally {
    await svc.stop();
    await llm.stop();
  }
});
