import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ModuleNode } from './ast.ts';
import { buildPrompts, estimateTokens, type PromptTask } from './prompts.ts';

export interface ImplOptions {
  endpoint: string;
  model: string;
  temperature: number;
  seed: number;
  numCtx: number;
  numPredict: number;
  cache: boolean;
  dryRun: boolean;
  timeoutMs: number;
}

export const DEFAULT_IMPL: ImplOptions = {
  endpoint: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  temperature: 0,
  seed: 42,
  numCtx: 4096,
  numPredict: 700,
  cache: true,
  dryRun: false,
  timeoutMs: 120000,
};

export interface ImplResult {
  id: string;
  file: string;
  ok: boolean;
  cached: boolean;
  tokens: number;
  bytes: number;
  error?: string;
}

const SYSTEM = 'You write a single JavaScript file for an existing service. Reply only with the code.';

export function extractCode(text: string): string {
  const fenced = text.match(/\`\`\`(?:js|javascript|mjs)?\s*\n([\s\S]*?)\`\`\`/);
  if (fenced) return fenced[1].trim();
  const bare = text.trim();
  if (bare.startsWith('export ') && !bare.includes('\`\`\`')) return bare;
  throw new Error('no code block in the model reply');
}

export function validateBody(code: string, op: string): string | null {
  if (/^\s*import\s/m.test(code)) return 'body must not import anything';
  if (/\brequire\s*\(/.test(code)) return 'body must not use require';
  const expected = new RegExp('export\\s+async\\s+function\\s+' + op + '\\s*\\(');
  if (!expected.test(code)) return 'expected export async function ' + op + '(input, io)';
  if (/res\.|res\.writeHead|sendError\(/.test(code)) return 'body must not write HTTP responses';
  return null;
}

function cacheKey(prompt: string, options: ImplOptions): string {
  return createHash('sha256')
    .update(options.model + '\u0000' + options.temperature + '\u0000' + options.seed + '\u0000' + options.numCtx + '\u0000' + prompt)
    .digest('hex');
}

async function generate(prompt: string, options: ImplOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const url = options.endpoint.replace(/\/$/, '') + '/api/generate';
    let response: Response;
    try {
      response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        system: SYSTEM,
        prompt,
        stream: false,
        options: {
          temperature: options.temperature,
          seed: options.seed,
          num_ctx: options.numCtx,
          num_predict: options.numPredict,
        },
      }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error('cannot reach ' + options.endpoint + ' (is ollama running?): ' + reason);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error('ollama ' + response.status + ' ' + text.slice(0, 200));
    }
    const data = (await response.json()) as { response?: string };
    if (!data.response) throw new Error('ollama returned an empty response');
    return data.response;
  } finally {
    clearTimeout(timer);
  }
}

export async function runImpl(mod: ModuleNode, dir: string, partial: Partial<ImplOptions> = {}): Promise<{ results: ImplResult[]; options: ImplOptions }> {
  const options: ImplOptions = { ...DEFAULT_IMPL, ...partial };
  const set = buildPrompts(mod);
  const outDir = join(dir, '.arcod', 'impl');
  const cacheDir = join(dir, '.arcod', 'cache');
  await mkdir(outDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const results: ImplResult[] = [];
  for (const task of set.tasks) {
    results.push(await runTask(task, outDir, cacheDir, options));
  }
  return { results, options };
}

async function runTask(task: PromptTask, outDir: string, cacheDir: string, options: ImplOptions): Promise<ImplResult> {
  const target = join(outDir, task.op + '.mjs');
  const key = cacheKey(task.prompt, options);
  const cachePath = join(cacheDir, key + '.mjs');
  const base: ImplResult = {
    id: task.id,
    file: target,
    ok: false,
    cached: false,
    tokens: task.tokens,
    bytes: 0,
  };

  let code: string;
  if (options.cache && existsSync(cachePath)) {
    code = await readFile(cachePath, 'utf8');
    base.cached = true;
  } else if (options.dryRun) {
    return { ...base, error: 'dry run: prompt not sent' };
  } else {
    try {
      const reply = await generate(task.prompt, options);
      code = extractCode(reply);
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
    if (options.cache) await writeFile(cachePath, code, 'utf8');
  }

  const problem = validateBody(code, task.op);
  if (problem) return { ...base, error: problem };

  await writeFile(target, code, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (syntax.status !== 0) {
    return { ...base, bytes: Buffer.byteLength(code), error: (syntax.stderr || 'syntax error').split('\n').slice(0, 3).join(' ') };
  }

  return { ...base, ok: true, bytes: Buffer.byteLength(code) };
}

export function formatImplReport(results: ImplResult[], options: ImplOptions): string {
  const ok = results.filter((item) => item.ok).length;
  const lines = [
    'impl: ' + ok + '/' + results.length + ' bodies, model ' + options.model,
    'context: num_ctx=' + options.numCtx + ', temperature=' + options.temperature + ', seed=' + options.seed,
  ];
  for (const item of results) {
    const mark = item.ok ? 'ok  ' : 'fail';
    const cached = item.cached ? ' cached' : '';
    const detail = item.error ? '  ' + item.error : '  ' + item.bytes + ' bytes, ' + estimateTokens(String(item.bytes)) + '~ tokens out';
    lines.push('  ' + mark + ' ' + item.id + cached + detail);
  }
  return lines.join('\n');
}
