// `arcod build examples/hello --env` used to exit 0: `args[++i]` was undefined
// and the flag behaved as if it had never been typed. A typo or a forgotten
// value is a usage error the CLI can name, not a silent no-op — and a following
// `--json` must not be swallowed as the value either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

interface Result {
  out: string;
  err: string;
  code: number;
}

async function run(argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

const cases: Array<[string, string[]]> = [
  ['--env', ['check', join(examplesDir, 'chat'), '--env']],
  ['--to', ['fmt', join(examplesDir, 'chat'), '--to']],
  ['--out', ['openapi', join(examplesDir, 'chat'), '--service', 'Chat', '--out']],
  ['--service', ['openapi', join(examplesDir, 'chat'), '--service']],
  ['--model', ['impl', join(examplesDir, 'chat'), '--model']],
  ['--ingress-class', ['k8s', join(examplesDir, 'chat'), '--ingress-class']],
  ['--port', ['build', join(examplesDir, 'chat'), '--port']],
  ['--max-tokens', ['prompts', join(examplesDir, 'chat'), '--max-tokens']],
  ['--replicas', ['k8s', join(examplesDir, 'chat'), '--replicas']],
];

for (const [flag, argv] of cases) {
  test(flag + ' with no value is a usage error, not a no-op', async () => {
    const result = await run(argv);
    assert.equal(result.code, 2);
    assert.match(result.err, new RegExp('^arcod: ' + flag + ' needs a value$', 'm'));
    assert.equal(result.out, '');
  });
}

test('a following flag is not taken as the value', async () => {
  const result = await run(['check', join(examplesDir, 'chat'), '--env', '--json']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^arcod: --env needs a value$/m);
  assert.equal(result.out, '');
});

test('a value is still accepted and used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-value-'));
  const result = await run(['openapi', join(examplesDir, 'chat'), '--service', 'Chat', '--out', join(dir, 'openapi.json')]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /wrote .*openapi\.json$/);
});
