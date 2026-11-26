// A multi-service module has one address per service, so `arcod test --url`
// cannot guess whose examples to run: --service names it. These tests pin the
// gate, the unknown name, and that a named service is the one tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const TWO = `module duo @0.1.0 {}

service Store : http {
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
    }
  }
  examples {
    example ping_ok {
      when {
        let v = ping()
      }
      then {
        v == "pong"
      }
    }
  }
}

service Cache : http {
  contract {
    public op get() -> string {
      route: "GET /v1/cache"
    }
  }
  examples {
    example get_ok {
      when {
        let v = get()
      }
      then {
        v == "hit"
      }
    }
  }
}
`;

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

test('test --url: a module with two services needs --service and names both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-url-two-'));
  try {
    await writeFile(join(dir, 'main.arc'), TWO, 'utf8');
    const result = await run(['test', dir, '--url', 'http://127.0.0.1:9']);
    assert.equal(result.code, 2);
    assert.match(result.err, /--url needs --service <name>: this module declares examples for Store, Cache/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('test --url: --service with a name that declares nothing is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-url-ghost-'));
  try {
    await writeFile(join(dir, 'main.arc'), TWO, 'utf8');
    const result = await run(['test', dir, '--url', 'http://127.0.0.1:9', '--service', 'Ghost']);
    assert.equal(result.code, 2);
    assert.match(result.err, /--service Ghost declares no examples or rules/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('test --url: a named service passes the gate and asks its own address', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-url-named-'));
  try {
    await writeFile(join(dir, 'main.arc'), TWO, 'utf8');
    const result = await run(['test', dir, '--url', 'http://127.0.0.1:9', '--service', 'Store']);
    // Nothing listens on port 9: the named service reached the reachability
    // probe, which is what --service selects.
    assert.equal(result.code, 2);
    assert.match(result.err, /cannot reach http:\/\/127\.0\.0\.1:9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
