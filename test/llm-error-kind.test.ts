// A body that calls io.chat must be able to branch on why the model failed
// without parsing our prose. The kind names what to do next: rejected means a
// repeat will not help until the configuration changes; limited means repeat
// later and honour retryAfterMs; unknown means there is no hint and the service
// decides. No kind claims the first attempt left no trace -- a proxy, a quota
// or a gateway queue can answer 429 after the run started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

// A header bag shaped like fetch's Headers: only Retry-After answers.
function headers(value: string) {
  return { get: (name: string) => name.toLowerCase() === 'retry-after' ? value : null };
}

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

test('a 429 is kind limited and carries Retry-After seconds as the moment to repeat', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 429, headers: headers('7'), text: async () => '{"error":"slow down"}' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'limited');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 7000, 'the header is the only deadline the caller gets');
      return true;
    });
  } finally {
    restore();
  }
});

test('an HTTP-date Retry-After in the past says now, not never', async () => {
  const { llmChat } = await llm();
  const past = new Date(Date.now() - 3000).toUTCString();
  const restore = stubFetch(async () => ({ ok: false, status: 429, headers: headers(past), text: async () => 'slow down' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.retryAfterMs, 0);
      return true;
    });
  } finally {
    restore();
  }
});

test('a Retry-After without a usable value leaves the field absent, not zero', async () => {
  const { llmChat } = await llm();
  const restore = stubFetch(async () => ({ ok: false, status: 429, headers: headers('soon'), text: async () => 'slow down' }));
  try {
    await assert.rejects(llmChat(ASK), (error: any) => {
      assert.equal(error.kind, 'limited');
      assert.equal('retryAfterMs' in error, false, 'a guess would be worse than a missing field');
      return true;
    });
  } finally {
    restore();
  }
});

// The pair from the thread that opened this: the same 429 and the same
// Retry-After, once refused before the gateway forwarded anything and once
// refused after the run completed. The two errors must look identical -- the
// header says when to ask again, never whether the first attempt left a trace
// -- and the adapter must make exactly one request upstream per call.
test('a 429 after a completed run looks like a 429 before it, and neither is retried', async () => {
  const { llmChat } = await llm();
  for (const phase of ['before', 'after']) {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls += 1;
      return { ok: false, status: 429, headers: headers('3'), text: async () => '{\"error\":\"quota\",\"phase\":\"' + phase + '\"}' };
    });
    try {
      await assert.rejects(llmChat(ASK), (error: any) => {
        assert.equal(error.kind, 'limited');
        assert.equal(error.retryAfterMs, 3000);
        assert.equal(error.body.includes(phase), true, 'the body still tells the operator what happened');
        return true;
      });
      assert.equal(calls, 1, 'the adapter asks once; repeating is the service decision');
    } finally {
      restore();
    }
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

// The docs are the promise a body author reads. Both used to say a repeat of
// limited was safe, which the wire cannot support; the deadline is the only
// thing the endpoint actually says.
test('the READMEs describe limited by its deadline, not as a safe kind', async () => {
  const en = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const ru = await readFile(new URL('../README_rus.md', import.meta.url), 'utf8');
  assert.equal(/repeating later is safe/.test(en), false, 'a 429 does not prove the first try was clean');
  assert.equal(/второй — позже и безопасно/.test(ru), false);
  for (const text of [en, ru]) {
    assert.equal(text.includes('retryAfterMs'), true, 'the reader is told where the deadline lands');
  }
});
