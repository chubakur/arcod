// A body that calls io.chat must be able to branch on why the model failed
// without parsing our prose. The refusal (upstream answered 403), the deadline
// (endpoint took the request and never answered) and the garbage answer were
// three different incidents behind one exception whose message was the only
// clue - and that message is ours to rewrite.
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
  await writeFile(file, LLM_SOURCE + '\nexport { llmChat };\n', 'utf8');
  return import(pathToFileURL(file).href);
}

function stubFetch(impl: (url: any, init: any) => Promise<any>): () => void {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  return () => { (globalThis as any).fetch = original; };
}

test('a 403 from the endpoint is kind refused, with the status and body', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' }));
  try {
    await assert.rejects(llmChat([{ role: 'user', content: 'hi' }]), (error: any) => {
      assert.equal(error.kind, 'refused');
      assert.equal(error.status, 403);
      assert.match(error.body, /forbidden/);
      assert.match(error.message, /llm: 403/);
      return true;
    });
  } finally {
    restore();
  }
});

test('an aborted request is kind timeout', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => { const error: any = new Error('aborted'); error.name = 'AbortError'; throw error; });
  try {
    await assert.rejects(llmChat([{ role: 'user', content: 'hi' }]), (error: any) => {
      assert.equal(error.kind, 'timeout');
      assert.match(error.message, /timeout/);
      return true;
    });
  } finally {
    restore();
  }
});

test('an answer without choices is kind failed', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => '{"choices":[]}' }));
  try {
    await assert.rejects(llmChat([{ role: 'user', content: 'hi' }]), (error: any) => {
      assert.equal(error.kind, 'failed');
      return true;
    });
  } finally {
    restore();
  }
});

test('a socket error is kind failed, not an untagged throw', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  try {
    await assert.rejects(llmChat([{ role: 'user', content: 'hi' }]), (error: any) => {
      assert.equal(error.kind, 'failed');
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    restore();
  }
});
