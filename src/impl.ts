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
  allowRemote: boolean;
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
  allowRemote: false,
};

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export interface ImplResult {
  id: string;
  file: string;
  ok: boolean;
  cached: boolean;
  tokens: number;
  bytes: number;
  error?: string;
}

const SYSTEM =
  'You write one JavaScript function for an existing service. ' +
  'Reply with only one js code block containing the file. ' +
  'No imports, no HTTP, no statuses: the caller handles them. ' +
  'The caller also validates input limits before calling you. ' +
  'Return { result } on success or { error: "Name" } for a declared error.';

export function extractCode(text: string): string {
  const fenced = text.match(/\`\`\`(?:js|javascript|mjs)?\s*\n([\s\S]*?)\`\`\`/);
  if (fenced) return fenced[1].trim();
  const bare = text.trim();
  if (bare.startsWith('export ') && !bare.includes('\`\`\`')) return bare;
  throw new Error('no code block in the model reply');
}

export function normalizeBody(code: string, op: string): string {
  const trimmed = code.trim();
  const bare = new RegExp('^(async\\s+)?function\\s+' + op + '\\s*\\(');
  if (bare.test(trimmed)) return 'export ' + trimmed;
  return trimmed;
}

export function sandboxViolation(code: string): string | null {
  if (/^\s*import\s/m.test(code)) return 'body must not import anything';
  if (/\brequire\s*\(/.test(code)) return 'body must not use require';
  if (/\bimport\s*\(/.test(code)) return 'body must not use dynamic import';
  if (/\bfetch\s*\(/.test(code)) return 'body must not use raw network (deny net)';
  if (/\bWebSocket\b/.test(code)) return 'body must not use raw network (deny net)';
  if (/\bXMLHttpRequest\b/.test(code)) return 'body must not use raw network (deny net)';
  if (/\bprocess\.env\b/.test(code)) return 'body must not read the environment';
  if (/\bprocess\.exit\b/.test(code)) return 'body must not control the process';
  if (/\bprocess\.kill\b/.test(code)) return 'body must not control the process';
  if (/\bchild_process\b/.test(code)) return 'body must not spawn processes (deny exec)';
  if (/\bexecSync\b/.test(code)) return 'body must not spawn processes (deny exec)';
  if (/\bspawnSync\b/.test(code)) return 'body must not spawn processes (deny exec)';
  if (/\bfs\b\./.test(code)) return 'body must not touch the filesystem (deny fs)';
  if (/\beval\s*\(/.test(code)) return 'body must not use eval';
  if (/\bnew\s+Function\s*\(/.test(code)) return 'body must not use the Function constructor';
  return null;
}

export function validateBody(code: string, op: string): string | null {
  const deny = sandboxViolation(code);
  if (deny) return deny;
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
  if (!options.allowRemote && !isLocalEndpoint(options.endpoint)) {
    throw new Error(
      'refusing to send prompts to ' + options.endpoint + ': only a local model is used by default. ' +
        'Pass --allow-remote if you really mean it.',
    );
  }
  const set = buildPrompts(mod);
  // Bodies live next to the spec so they can be committed and reviewed; the
  // cache keeps the model responses separately.
  const outDir = join(dir, 'impl');
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
      code = normalizeBody(extractCode(reply), task.op);
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
    if (options.cache) await writeFile(cachePath, code, 'utf8');
  }

  const problem = validateBody(code, task.op);
  if (problem) return { ...base, error: problem };

  // Provenance travels with the body: the prompt hash and model name pin what
  // generated this file, so an impl/ body is never an anonymous blob.
  const promptHash = createHash('sha256').update(task.prompt).digest('hex').slice(0, 12);
  const header = '// @arcod generated: op ' + task.op + ' · prompt ' + promptHash + ' · model ' + options.model + '\n';
  await writeFile(target, header + code, 'utf8');
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
