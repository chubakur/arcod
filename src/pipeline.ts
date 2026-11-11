import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleNode } from './ast.ts';
import { check } from './check.ts';
import { buildPrompts } from './prompts.ts';
import { runImpl } from './impl.ts';
import { buildExample } from './build.ts';
import { runExamples } from './test.ts';

export interface PipelineOptions {
  model?: string;
  endpoint?: string;
  force?: boolean;
  skipImpl?: boolean;
  noTest?: boolean;
  reference?: boolean;
  port?: number;
  allowRemote?: boolean;
  budget?: number;
}

export interface PipelineStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
  error?: string;
  skipped?: boolean;
}

export interface PipelineResult {
  steps: PipelineStep[];
  ok: boolean;
  dir: string;
  buildDir: string | null;
}

// One command for the whole loop: check -> prompts -> bodies -> build -> test.
// Every step is the same function the standalone command uses, so the pipeline
// can never drift from them.
export async function runPipeline(
  mod: ModuleNode,
  dir: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const steps: PipelineStep[] = [];
  const buildDir: string | null = join(dir, '.arcod', 'build');

  const step = async (name: string, run: () => Promise<{ detail: string; ok?: boolean; skipped?: boolean; error?: string }>) => {
    const started = Date.now();
    try {
      const result = await run();
      steps.push({ name, ok: result.ok !== false, detail: result.detail, skipped: result.skipped, error: result.error, ms: Date.now() - started });
      return steps[steps.length - 1];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ name, ok: false, detail: message, error: message, ms: Date.now() - started });
      return steps[steps.length - 1];
    }
  };

  const diags = check(mod, { environment: undefined });
  const errors = diags.filter((item) => item.severity === 'error');
  const failedCheck = await step('check', async () => {
    if (errors.length > 0) {
      return { detail: errors.length + ' error(s)', ok: false, error: errors.map((item) => item.code + ' ' + item.message).join('; ') };
    }
    return { detail: '0 error(s), ' + diags.length + ' warning(s)' };
  });
  if (!failedCheck.ok) return { steps, ok: false, dir, buildDir };

  const ops = mod.services.flatMap((svc) => svc.contract.filter((op) => op.kind === 'op').map((op) => op.name));
  const existing = new Set(
    (await readdir(join(dir, 'impl')).catch(() => [] as string[]))
      .filter((name: string) => name.endsWith('.mjs'))
      .map((name: string) => name.slice(0, -4)),
  );
  const bodiesReady = ops.length > 0 && ops.every((name) => existing.has(name));

  // Prompts exist to produce bodies. When every operation already has one and
  // the caller did not ask for regeneration, there is nothing to ask the model.
  if (bodiesReady && !options.force) {
    steps.push({
      name: 'prompts',
      ok: true,
      detail: 'skipped · ' + existing.size + '/' + ops.length + ' bodies already in impl/',
      skipped: true,
      ms: 0,
    });
  } else {
  const set = buildPrompts(mod, { budget: options.budget });
  const promptStep = await step('prompts', async () => {
    const promptDir = join(buildDir!, 'prompts');
    await mkdir(promptDir, { recursive: true });
    for (const task of set.tasks) {
      await writeFile(join(promptDir, task.op + '.md'), task.prompt, 'utf8');
    }
    const manifest = {
      module: set.module,
      version: set.version,
      modelHash: set.modelHash,
      budget: set.budget,
      tasks: set.tasks.map((task) => ({ id: task.id, op: task.op, file: task.file, tokens: task.tokens, sha256: task.sha256, unresolved: task.unresolved })),
    };
    await writeFile(join(buildDir!, 'prompts.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const tokens = set.tasks.map((task) => task.tokens).join('/');
    if (set.unresolved.length > 0) {
      return { detail: set.unresolved.join('; '), ok: false, error: 'cannot derive a procedure for: ' + set.unresolved.join(', ') };
    }
    return { detail: set.tasks.length + ' prompt(s) · ' + tokens + ' tokens' };
  });
  if (!promptStep.ok) return { steps, ok: false, dir, buildDir };
  }

  const missing = ops.filter((name) => !existing.has(name));
  const implStep = await step('impl', async () => {
    if (options.skipImpl) return { detail: 'skipped (--skip-impl)', skipped: true };
    if (!options.force && missing.length === 0 && existing.size > 0) {
      return { detail: existing.size + '/' + ops.length + ' bodies already in impl/ (use --force to regenerate)', skipped: true };
    }
    const { results, options: applied } = await runImpl(mod, dir, {
      endpoint: options.endpoint,
      model: options.model,
      allowRemote: options.allowRemote,
      cache: true,
    });
    const failed = results.filter((item) => !item.ok);
    if (failed.length > 0) {
      return { detail: failed.length + ' failed', ok: false, error: failed.map((item) => item.op + ': ' + item.error).join('; ') };
    }
    const cached = results.filter((item) => item.cached).length;
    return {
      detail: results.length + '/' + ops.length + ' bodies · ' + applied.model + (cached > 0 ? ' · ' + cached + ' cached' : ''),
    };
  });
  if (!implStep.ok) return { steps, ok: false, dir, buildDir };

  const hasBodies = (await readdir(join(dir, 'impl')).catch(() => [] as string[])).some((name) => name.endsWith('.mjs'));
  const built = await step('build', async () => {
    const result = await buildExample(mod, dir, {
      port: options.port,
      reference: options.reference === true,
      implDir: options.reference || !hasBodies ? null : undefined,
    });
    const mode = result.impl.length > 0 ? 'impl' : result.reference ? 'reference' : 'scaffold';
    return { detail: mode + ' · ' + result.files.length + ' files' };
  });
  if (!built.ok) return { steps, ok: false, dir, buildDir };

  const testStep = await step('test', async () => {
    if (options.noTest) return { detail: 'skipped (--no-test)', skipped: true };
    const report = await runExamples(mod, buildDir!);
    const all = [...report.examples, ...report.rules];
    if (all.length === 0) return { detail: 'nothing to check (no examples or rules)', skipped: true };
    const failed = all.filter((item) => !item.ok);
    const detail = all.length - failed.length + ' passed' + (failed.length > 0 ? ', ' + failed.length + ' failed' : '');
    if (failed.length > 0) {
      return { detail, ok: false, error: failed.map((item) => (item.example ?? item.rule) + ': ' + item.error).join('; ') };
    }
    return { detail };
  });

  return { steps, ok: steps.every((item) => item.ok), dir, buildDir };
}

export function formatPipeline(result: PipelineResult, label: string): string {
  const lines = ['arcod make: ' + label];
  for (const step of result.steps) {
    const status = step.skipped ? 'skip' : step.ok ? 'ok' : 'fail';
    lines.push('  ' + step.name.padEnd(8) + status.padEnd(5) + step.detail);
    if (step.error && !step.ok) lines.push('           ' + step.error);
  }
  const ms = result.steps.reduce((total, item) => total + item.ms, 0);
  lines.push(result.ok ? 'done in ' + ms + ' ms' : 'stopped in ' + ms + ' ms');
  return lines.join('\n');
}
