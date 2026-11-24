// A body that calls io.chat must be able to branch on why the model failed
// without parsing our prose. The kind answers one question: did the endpoint
// run anything? rejected (4xx but 429) and limited (429) mean no; unknown
// (timeout, dropped connection, 5xx, unreadable 2xx body) means it might have,
// so a repeat is allowed but may create a second run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LLM_SOURCE } from '../src/emit/llm.ts';

async function llm(): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-llm-kind-'));
  const file = join(dir, 'llm.mjs');
  await writeFile(file, LLM_SOURCE + '\nexport { llmChat, llmEmbed };\n', 'utf8');
  return import(pathToFileURL(file).href);
}

function stubFetch(impl: (url: any, init: any) => Promise<any>): () => void {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  return () => { (globalThis as any).fetch = original; };
}

const ASK = [{ role: 'user', content: 'hi' }];

test('a 403 from the endpoint is kind rejected, with the status and body', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'rejected');
      assert.equal(error.status, 403);
      assert.match(error.body, /forbidden/);
      assert.match(error.message, /llm: 403/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a 400 is rejected too: the request never started a run', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 400, text: async () => '{"error":"bad model"}' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'rejected');
      return true;
    });
  } finally {
    restore();
  }
});

test('a 429 is kind limited, not rejected: repeating later is safe', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 429, text: async () => '{"error":"slow down"}' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'limited');
      assert.equal(error.status, 429);
      return true;
    });
  } finally {
    restore();
  }
});

test('a 503 is kind unknown: the upstream may have started the run', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 503, text: async () => 'upstream gone' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'unknown');
      assert.equal(error.status, 503);
      return true;
    });
  } finally {
    restore();
  }
});

test('an aborted request is kind unknown and still says timeout', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => { const error: any = new Error('aborted'); error.name = 'AbortError'; throw error; });
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'unknown');
      assert.match(error.message, /timeout/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a 200 with a truncated body is kind unknown, not a safe failure', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"mess' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'unknown');
      return true;
    });
  } finally {
    restore();
  }
});

test('an answer without choices is kind unknown', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => '{"choices":[]}' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'unknown');
      return true;
    });
  } finally {
    restore();
  }
});

test('a socket error is kind unknown, not an untagged throw', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'unknown');
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    restore();
  }
});

test('io.embed shares the kinds: a 429 is limited, a bad 2xx body is unknown', async () => {
  const { llmEmbed } = await llm();
  let restore = stubFetch(async () => ({ ok: false, status: 429, text: async () => '{"error":"slow down"}' }));
  try {
    await assert.rejects(llmEmbed(['a']), (error: any) => {
      assert.equal(error.kind, 'limited');
      return true;
    });
  } finally {
    restore();
  }
  restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => 'not json' }));
  try {
    await assert.rejects(llmEmbed(['a']), (error: any) => {
      assert.equal(error.kind, 'unknown');
      return true;
    });
  } finally {
    restore();
  }
});
