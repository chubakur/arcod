#!/usr/bin/env node
// The end-to-end proof that a local model can build a service from zero:
//   arcod new -> arcod impl (Ollama) -> arcod build --impl -> arcod test --impl
//
// Ollama is optional: when it is not reachable the run prints one SKIP line and
// exits 0, because "no model installed on this machine" is a configuration
// fact, not a failing test. CI and agents can tell the two apart by the line.
// See README "From zero to a service with a local model".

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arcod = join(root, 'bin', 'arcod.mjs');
const endpoint = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
const model = process.env.ARC_MODEL || 'qwen2.5-coder:7b';

process.stdout.write('e2e-local-model: endpoint ' + endpoint + ', model ' + model + '\n');

async function reachable(url) {
  try {
    const response = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await reachable(endpoint))) {
  process.stdout.write(
    'SKIP e2e-local-model: Ollama is not reachable at ' + endpoint +
      ' — install it and pull the model, or set OLLAMA_ENDPOINT.\n',
  );
  process.exit(0);
}

function run(step, args, cwd) {
  return new Promise((resolve) => {
    process.stdout.write('\n== ' + step + '\n');
    const child = spawn(process.execPath, [arcod, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const dir = await mkdtemp(join(tmpdir(), 'arcod-e2e-'));
let failed = false;
try {
  const steps = [
    ['create the spec', ['new', 'demo'], dir],
    ['generate bodies with the local model', ['impl', 'demo', '--endpoint', endpoint, '--model', model], dir],
    ['build with the generated bodies', ['build', 'demo', '--impl'], dir],
    ['run the examples against the service', ['test', 'demo', '--impl'], dir],
  ];
  for (const [step, args, cwd] of steps) {
    const result = await run(step, args, cwd);
    if (result.code !== 0) {
      failed = true;
      process.stdout.write('\nFAILED at: ' + step + ' (exit ' + result.code + ')\n');
      break;
    }
  }
} finally {
  if (!process.env.ARC_E2E_KEEP) await rm(dir, { recursive: true, force: true });
  else process.stdout.write('\nkept: ' + dir + '\n');
}

process.exit(failed ? 1 : 0);
