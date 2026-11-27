// A Go body is spliced into ops.go, and Go imports are per file: without the
// kit's import injection a body cannot call json.Marshal or strconv.Itoa, and
// the service fails to compile with "undefined: json". These tests pin the
// narrow allowlist and the two ways it must not guess: no import for an
// identifier the body never spells (an unused import is a compile error), and
// no net/fs/exec, which the contract denies.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { goOps } from '../src/emit/go.ts';

const spec = `module shop @0.1.0 {}

use capability arcod.std.kv @1

service Shop : http {
  language: go
  uses store: kv

  contract {
    public op place(id: string) -> string {
      route: "POST /v1/items"
    }
    public op echo(id: string) -> string {
      route: "GET /v1/items/:id"
    }
  }
}
`;

function ops(body: string, other = ''): string {
  const mod = parse(spec, 'main.arc');
  const svc = mod.services[0]!;
  return goOps(mod, svc, { place: body, echo: other });
}

test('a body that spells json and strconv gets exactly those imports', () => {
  const text = ops(`func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	return strconv.Itoa(len(raw)), nil
}`);
  assert.match(text, /import \(\n\t"encoding\/json"\n\t"strconv"\n\n\tarcodio /);
  assert.doesNotMatch(text, /"time"/);
});

test('a body with no stdlib call keeps the single-line import', () => {
  const text = ops(`func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	if _, err := io.KV.Del(id); err != nil {
		return nil, err
	}
	return id, nil
}`);
  assert.match(text, /\nimport arcodio "arcod\/shop\/arcodio"\n/);
  assert.doesNotMatch(text, /import \(/);
});

test('net and os stay out: the contract denies those effects', () => {
  const text = ops(`func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	_ = os.Getenv("HOME")
	return in, nil
}`);
  assert.doesNotMatch(text, /"os"/);
  // A local variable named like the package must not pull an import in either.
  const shadow = ops(`func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	return map[string]any{"a": in["time"], "b": in["json"]}, nil
}`);
  assert.doesNotMatch(shadow, /import \(/);
});

test('a body that declares its own import is refused by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-goimport-'));
  try {
    await writeFile(
      join(dir, 'place.go'),
      'import "time"\n\nfunc opPlace(io *arcodio.IO, in map[string]any) (any, error) { return time.Now(), nil }\n',
      'utf8',
    );
    await assert.rejects(
      buildExample(parse(spec, 'main.arc'), join(dir, 'out'), { implDir: dir }),
      /place\.go declares its own import/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
