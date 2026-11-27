// B119: an agent needs an allow-list and a structured answer instead of JSON
// mined out of prose. The body passes tools as a third argument to io.chat;
// the reply carries toolCalls next to content, and content stays a string ('')
// when the model answered with a call only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';
import { CAPABILITIES } from '../src/capabilities.ts';

const TOOL_SPEC = `module tools @0.1.0 {}

use capability arcod.std.llm @1

type ToolsReply = { content: string, model: string, count: int, firstName: string, firstArgs: string, secondArgs: string }

service Tools : http {
  uses model: llm(model: "fake-chat")

  effects {
    allow model.chat
  }

  contract {
    public op plan(question: string) -> ToolsReply {
      route: "POST /v1/plan"
      effects: model.chat
    }
  }
}

environment dev {
  bind model -> ollama(model: "fake-chat")
  deploy docker
}
`;

const TOOL_IMPL = {
  plan: `export async function plan(input, io) {
  const tools = [{ name: "lookup", description: "find a row", parameters: { type: "object", properties: { id: { type: "string" } } } }];
  const reply = await io.chat([{ role: "user", content: input.question }], "be brief", tools);
  const calls = reply.toolCalls;
  const first = calls.length > 0 ? calls[0] : null;
  const second = calls.length > 1 ? calls[1] : null;
  const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value));
  return { result: {
    content: reply.content,
    model: reply.model,
    count: calls.length,
    firstName: first ? first.name : "",
    firstArgs: first ? asText(first.arguments) : "",
    secondArgs: second ? asText(second.arguments) : "",
  } };
}`,
};

test('the chat signature names tools and toolCalls', () => {
  assert.match(CAPABILITIES.llm.effects.chat, /tools: list<\{ name: string/);
  assert.match(CAPABILITIES.llm.effects.chat, /toolCalls: list<\{ id: string, name: string, arguments: any \}>/);
  assert.match(CAPABILITIES.llm.short.chat, /toolCalls/);
});

test('io.chat sends the tool allow-list and returns structured tool calls', async () => {
  const llm = await mockHttp((req) => {
    if (req.url.endsWith('/chat/completions')) {
      return {
        status: 200,
        body: {
          model: 'fake-chat-2026',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":"42"}' } },
                { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: 'not json' } },
              ],
            },
          }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      };
    }
    return { status: 404, body: { error: 'no route' } };
  });
  const svc = await startService(TOOL_SPEC, { impl: TOOL_IMPL, env: { LLM_BASE_URL: llm.base, LLM_MODEL: 'fake-chat' } });
  try {
    const res = await fetch(svc.base + '/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'who is 42?' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    // arguments is an object when the model wrote JSON; broken JSON stays text
    // so the caller can log or retry instead of failing the whole operation.
    assert.deepEqual(body, {
      content: '',
      model: 'fake-chat-2026',
      count: 2,
      firstName: 'lookup',
      firstArgs: '{"id":"42"}',
      secondArgs: 'not json',
    });
    const call = llm.requests.find((req) => req.url.endsWith('/chat/completions'));
    assert.ok(call, 'the adapter called /chat/completions');
    const payload = JSON.parse(call.body);
    assert.equal(payload.tools.length, 1);
    assert.equal(payload.tools[0].type, 'function');
    assert.equal(payload.tools[0].function.name, 'lookup');
    assert.equal(payload.tools[0].function.description, 'find a row');
    assert.deepEqual(payload.tools[0].function.parameters.properties, { id: { type: 'string' } });
  } finally {
    await svc.stop();
    await llm.stop();
  }
});
