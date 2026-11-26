// `language:` is a property of the service, not of a command: one module may
// build a Node front and a Go worker. This slice parses and checks the clause,
// prints it in the canonical form and names it in `build --json`; the Go and
// Python emitters are B107/B108, so a build refuses them instead of silently
// generating the wrong runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { formatSource } from '../src/fmt.ts';
import { buildExample } from '../src/build.ts';
import { main } from '../src/cli.ts';

const spec = (languages: string): string => `module lanes @0.1.0 {}

service Front : http {
${languages}
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
    }
  }
}

service Worker : http {
  contract {
    public op tick() -> string {
      route: "GET /v1/tick"
    }
  }
}

external service Ledger : http {
  contract {
    public op record() -> string {
      route: "POST /v1/record"
    }
  }
}

environment dev {}
`;

function problems(source: string) {
  return check(parse(source, 'main.arc')).filter((item) => item.severity === 'error');
}

test('language: is parsed and kept on the service', () => {
  const mod = parse(spec('  language: go'), 'main.arc');
  assert.equal(mod.services[0].language, 'go');
  assert.equal(mod.services[1].language, undefined, 'the default stays implicit');
});

test('check accepts node, go and python', () => {
  for (const name of ['node', 'go', 'python']) {
    assert.deepEqual(problems(spec('  language: ' + name)), [], name);
  }
});

test('check refuses an unknown language and names the supported ones', () => {
  const errors = problems(spec('  language: rust'));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].code, 'A103');
  assert.match(errors[0].message, /rust/);
  assert.match(errors[0].hint ?? '', /node, go, python/);
});

test('check refuses language: on an external service', () => {
  const source = spec('  language: node').replace('external service Ledger : http {', 'external service Ledger : http {\n  language: node');
  const errors = problems(source);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].code, 'A104');
  assert.match(errors[0].message, /Ledger is external/);
});

test('fmt keeps the clause in the canonical form', () => {
  const formatted = formatSource(spec('  language:  go'), 'main.arc');
  assert.match(formatted, /^  language: go$/m);
});

test('build --json names the language per service, and refuses a non-node one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-lang-'));
  try {
    const file = join(dir, 'main.arc');
    await writeFile(file, spec('  language: node'), 'utf8');
    const out: string[] = [];
    const realLog = console.log;
    const before = process.exitCode;
    process.exitCode = 0;
    console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    try {
      await main(['build', file, '--json']);
      assert.equal(Number(process.exitCode ?? 0), 0);
    } finally {
      console.log = realLog;
      process.exitCode = before;
    }
    const report = JSON.parse(out.join('\n')) as { services?: Array<{ name: string; language: string }> };
    assert.deepEqual(report.services, [
      { name: 'Front', language: 'node' },
      { name: 'Worker', language: 'node' },
    ]);

    const go = parse(spec('  language: go'), 'main.arc');
    await assert.rejects(
      buildExample(go, dir, { reference: true, implDir: null }),
      /service Front asks for language: go, but this build emits node only/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('impl refuses a non-node service before calling the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-impl-lang-'));
  try {
    const file = join(dir, 'main.arc');
    await writeFile(file, spec('  language: go'), 'utf8');
    const err: string[] = [];
    const realError = console.error;
    const before = process.exitCode;
    process.exitCode = 0;
    console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    try {
      await main(['impl', file, '--dry-run']);
      assert.equal(Number(process.exitCode ?? 0), 2);
    } finally {
      console.error = realError;
      process.exitCode = before;
    }
    assert.match(err.join('\n'), /service Front is language: go; impl writes node bodies only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
