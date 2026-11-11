import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapDiagnostics } from '../out/model.js';

const repo = new URL('../../..', import.meta.url).pathname;

const broken = [
  'module broken @0.1.0 {',
  '  meta {',
  '    owner: "@andrey"',
  '    status: draft',
  '  }',
  '}',
  '',
  'use capability arcod.std.kv @1',
  '',
  'service Broken : http {',
  '  uses store: kv(ttl: 999s)',
  '',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '      effects: store.scan',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

test('real CLI diagnostics map onto editor lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcod-ext-'));
  const file = join(dir, 'main.arc');
  writeFileSync(file, broken, 'utf8');

  let raw = '';
  try {
    raw = execFileSync('node', [join(repo, 'bin', 'arcod.mjs'), 'check', 'main.arc', '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });
  } catch (error) {
    raw = String(error.stdout || '');
  }

  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, 'the CLI returns diagnostics');
  const lines = broken.split('\n');
  const mapped = mapDiagnostics(parsed, lines);

  assert.equal(mapped.length, parsed.length);
  for (const item of mapped) {
    assert.ok(item.line >= 0 && item.line < lines.length, 'line in range');
    assert.ok(item.col >= 0 && item.col <= lines[item.line].length, 'column in range');
    assert.ok(item.endLine >= item.line);
    assert.ok(item.endCol <= lines[item.endLine].length, 'end column in range');
    if (item.endLine === item.line) assert.ok(item.endCol >= item.col);
    assert.ok(item.code.length > 0);
    assert.ok(item.severity === 'error' || item.severity === 'warning');
  }
  assert.ok(mapped.some((item) => item.code === 'A002'), 'unbound capability is reported');
  assert.ok(mapped.some((item) => item.code === 'W016' || item.code === 'W012' || item.code === 'W013'), 'warnings survive');
});

test('a stale range is clamped instead of crashing', () => {
  const mapped = mapDiagnostics([{
    code: 'A999',
    severity: 'error',
    message: 'далеко',
    file: 'main.arc',
    range: { line: 500, col: 900, endLine: 700, endCol: 1000 },
  }], ['module x @0.1.0 {', '}']);

  assert.equal(mapped[0].line, 1);
  assert.equal(mapped[0].endLine, 1);
  assert.equal(mapped[0].col, 1);
  assert.equal(mapped[0].endCol, 1);
});
