import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// scripts/e2e-local-model.mjs is the documented "from zero to a service with a
// local model" path. The one thing CI can check without a model installed is
// the offline contract: a clear SKIP line and exit 0, never a red run.

const script = fileURLToPath(new URL('../scripts/e2e-local-model.mjs', import.meta.url));

function runScript(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('without Ollama the local-model e2e skips instead of failing', async () => {
  const result = await runScript({ OLLAMA_ENDPOINT: 'http://127.0.0.1:1' });
  assert.equal(result.code, 0, 'a missing model is not a failure');
  assert.match(result.out, /SKIP e2e-local-model: Ollama is not reachable at http:\/\/127\.0\.0\.1:1/);
  assert.match(result.out, /OLLAMA_ENDPOINT/, 'the message says how to point it elsewhere');
});
